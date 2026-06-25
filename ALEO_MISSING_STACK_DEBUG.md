# Debugging Aleo "Missing stack for program 'gmp_lib_v1.aleo'"

Broadcast 500 seen on `asset_manager_core_v1.aleo/transfer_native_public`:

```
Debug node error: "Invalid transaction — Execution verification failed -
Missing stack for program 'gmp_lib_v1.aleo'"
```

## The question

> Print the call graph and which Aleo transition / which snarkVM function we're in when the
> error surfaces — the same message is emitted from many places.

## Why the message can't localize itself

An Aleo execution is a **tree of transitions**, one per program *crossed* by a call. To verify it,
snarkVM resolves a `Stack` for every program a transition touches — both the program that owns the
transition and the **external stacks** it imports. The lookup helpers `Process::get_stack` /
`Stack::get_external_stack` are a shared chokepoint called from synthesis (`execute`), authorization,
and `verify_execution`. They all bail with the same "missing stack" wording, so the string alone
can't tell you which stage or which program tripped it.

## How we traced it

Added a read-only diagnostics pass to `AleoWalletProvider.execute`, gated by env flags (never alters
the real broadcast path):

- `ALEO_DEBUG=1` — dump the import graph, per-program on-chain deployment, the static call graph, and
  the **actual transition trace** (via a local `buildAuthorization`).
- `ALEO_DEBUG_VERIFY=1` — Layer-2 probe: locally prove, then run `verifyExecution`
  (= snarkVM `Process::verify_execution`) with and without the suspect program.

```
ALEO_DEBUG=1 ALEO_DEBUG_VERIFY=1 pnpm aleo deposit <token> <amount>
```

## What the run showed

**1. gmp_lib is fine on-chain.** All 7 imports of `asset_manager_core_v1.aleo` are DEPLOYED,
including `gmp_lib_v1.aleo` (27192 chars, on-chain length matches). → **not a deployment problem.**

**2. The 5 actual transitions** (call-graph order):

| # | program / function |
|---|---|
| 0 | `asset_manager_helper_v1.aleo / transfer_message_external` |
| 1 | `credits.aleo / transfer_public_as_signer` |
| 2 | `credits.aleo / transfer_public_as_signer` |
| 3 | `connection_v1.aleo / send_message` |
| 4 | `asset_manager_core_v1.aleo / transfer_native_public` |

**3. `gmp_lib_v1.aleo` is NOT a transition.** It is an imported *library*: it's added to the process
during synthesis, but it's consumed inline (closures/lib calls) and produces no transition of its
own. It is imported by `core`, `helper`, `connection`, and `rate_limit`.

**4. Stage localization:**

| Stage | snarkVM function | Result |
|---|---|---|
| Authorization / synthesis | `Process::authorize` | ✅ passes — gmp_lib added to the process |
| Local prove | `Process::execute` ("Executing program") | ❌ `RuntimeError: unreachable` (snarkVM panic, `wasm-function[5005]`) — aborts the process before verify runs |
| Broadcast node | `Process::verify_execution` → `get_stack`/`get_external_stack` | ❌ original 500 "Missing stack for program 'gmp_lib_v1.aleo'" |

## The answer

- **Which transition?** None is a `gmp_lib` transition — there is no such transition. The missing
  stack is for an imported **library** needed to *verify other* transitions. Verifying
  `connection_v1.aleo/send_message` and `asset_manager_helper_v1.aleo/transfer_message_external`
  requires `gmp_lib_v1.aleo` as an **external stack**; that's the lookup that fails on the node.
- **Which snarkVM function?** The broadcast error is raised in `Process::verify_execution`, via
  `get_stack` / `get_external_stack`, while resolving the external stacks of the `helper`/`connection`
  transitions. Locally we never reach verify — the prove stage panics first in `Process::execute`
  (`unreachable`).

## Reading of the root cause

gmp_lib is deployed and synthesis loads it, yet (a) the **node** can't resolve it as an external stack
at verify, and (b) the **local prove** panics in `execute`. Together this points away from
"library missing on-chain" and toward the **execution/transaction the prover built** — the broadcast
tx isn't carrying gmp_lib's stack/verifying key for the importing transitions, and the same call graph
trips a snarkVM `unreachable` locally. (Original failures used the remote DPS delegate; the local
`unreachable` is the lightest reproduction of a problem in the same call graph.)

## Limits of the JS-side probe / next step for file:line

- The Layer-2 verify probe's `verifyExecution(with/without gmp_lib)` contrast did **not** complete:
  `ProgramManager.run` panicked (`unreachable`) on a proving worker thread, which escapes the JS
  `try/catch` and aborts the process. To exercise the verify contrast, feed a **pre-built** execution
  straight to `verifyExecution` instead of proving first.
- For exact Rust `file:line` and the caller chain, the only authoritative routes are:
  1. **Patch `@provablehq/wasm`** — tag each `get_stack`/`get_external_stack` `bail!` by caller
     (`[verify_execution]` vs `[execute]`) and/or capture a backtrace (the WASM already embeds a
     `stack backtrace:` channel). Swap in via `pnpm patch`.
  2. **Native snarkVM repro** — run `Process::verify_execution` / `execute` on this call graph with
     `RUST_BACKTRACE=full RUST_LOG=snarkvm_synthesizer=trace`, pinned to the node's snarkVM version.

## Where the instrumentation lives

`packages/wallet-sdk-core/src/wallet-providers/aleo/AleoWalletProvider.ts` —
`logExecutionDiagnostics` (call graph + transitions) and `runVerifyProbe` (Layer-2), both gated by the
env flags above and removable once the issue is closed.
