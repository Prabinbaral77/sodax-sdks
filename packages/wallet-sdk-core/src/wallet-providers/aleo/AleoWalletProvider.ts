import type {
  IAleoWalletProvider,
  AleoExecuteOptions,
  AleoExecutionResult,
  AleoTransactionReceipt,
  AleoWaitForReceiptOptions,
  AleoNetworkEnv,
} from '@sodax/types';

import type { TransactionOptions as ProvableTransactionOptions } from '@provablehq/aleo-types';

import { BaseWalletProvider } from '../BaseWalletProvider.js';
import type {
  AleoSDK,
  AleoWallet,
  AleoWalletConfig,
  AleoWalletDefaults,
  BrowserExtensionAleoWallet,
  BrowserExtensionAleoWalletConfig,
  PkAleoWallet,
  PrivateKeyAleoWalletConfig,
} from './types.js';

// Lazy-load @provablehq/sdk to avoid pulling 43MB WASM into the webpack bundle graph at import time.
// The WASM module uses top-level await which breaks SSR and causes OOM during Next.js builds.
// The SDK default export resolves to testnet — we must import the network-specific build.
// NOTE: this loader is duplicated in @sodax/sdk and @sodax/wallet-sdk-react on purpose — the
// dynamic import must live in each package's own bundle graph. Do NOT hoist it into @sodax/types
// (zero-runtime-dependency contract); @sodax/libs is the only valid shared home if ever centralized.
function loadAleoSDK(network: AleoNetworkEnv): Promise<AleoSDK> {
  // Both builds export the same API surface — the cast is safe.
  if (network === 'testnet') return import('@provablehq/sdk/testnet.js') as unknown as Promise<AleoSDK>;
  return import('@provablehq/sdk/mainnet.js') as unknown as Promise<AleoSDK>;
}

/** Priority fee for private key wallets — 0 means only the base fee (calculated by ProgramManager) */
const DEFAULT_PK_PRIORITY_FEE = 0;
/** Minimum fee for browser extension wallets — 0.001 ALEO to ensure transaction acceptance */
const DEFAULT_BROWSER_FEE = 0.001;

/**
 * Opt-in execution diagnostics. Set `ALEO_DEBUG=1` (Node) to dump the import graph, per-program
 * on-chain deployment status, and the actual transition trace before an execute/broadcast. Used to
 * localize errors like "Missing stack for program '…'" — see logExecutionDiagnostics. Guarded against
 * `process` being undefined so the platform-neutral browser bundle stays unaffected.
 */
function isAleoDebugEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    (process.env?.ALEO_DEBUG === '1' || process.env?.ALEO_DEBUG === 'true')
  );
}

/**
 * Opt-in Layer-2 verify probe (`ALEO_DEBUG_VERIFY=1`, implies ALEO_DEBUG). Locally proves the execution
 * (`ProgramManager.run`) then re-runs `ProgramManager.verifyExecution` — which IS snarkVM's
 * `Process::verify_execution` — twice: once with the full import set and once with the suspect program
 * (gmp_lib) stripped. The stripped run reproduces the "stack" error inside the verify path, proving which
 * snarkVM function emits it and which program is missing. Heavier than the call-graph dump (it proves), so
 * it is gated separately.
 */
function isAleoVerifyProbeEnabled(): boolean {
  return (
    typeof process !== 'undefined' &&
    (process.env?.ALEO_DEBUG_VERIFY === '1' || process.env?.ALEO_DEBUG_VERIFY === 'true')
  );
}

export function isPrivateKeyConfig(config: AleoWalletConfig): config is PrivateKeyAleoWalletConfig {
  return config.type === 'privateKey';
}

export function isBrowserExtensionConfig(config: AleoWalletConfig): config is BrowserExtensionAleoWalletConfig {
  return config.type === 'browserExtension';
}

export function isPkAleoWallet(wallet: AleoWallet): wallet is PkAleoWallet {
  return wallet.type === 'privateKey';
}

export function isBrowserExtensionAleoWallet(wallet: AleoWallet): wallet is BrowserExtensionAleoWallet {
  return wallet.type === 'browserExtension';
}

// Internal state created lazily when the SDK finishes loading
type InitializedState = {
  networkClient: InstanceType<Awaited<AleoSDK>['AleoNetworkClient']>;
  wallet: AleoWallet;
  programManager: InstanceType<Awaited<AleoSDK>['ProgramManager']>;
};

export class AleoWalletProvider extends BaseWalletProvider<AleoWalletDefaults> implements IAleoWalletProvider {
  public readonly chainType = 'ALEO' as const;
  private readonly config: AleoWalletConfig;
  private initPromise: Promise<InitializedState> | null = null;
  private state: InitializedState | null = null;

  constructor(config: AleoWalletConfig) {
    super(config.defaults);
    if (!isPrivateKeyConfig(config) && !isBrowserExtensionConfig(config)) {
      throw new Error('Invalid wallet configuration');
    }
    this.config = config;
  }

  /** Lazily loads the SDK and initialises networkClient / wallet / programManager on first call. */
  private async ensureInitialized(): Promise<InitializedState> {
    if (this.state) return this.state;

    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    this.state = await this.initPromise;
    return this.state;
  }

  private async initialize(): Promise<InitializedState> {
    const network = isPrivateKeyConfig(this.config) ? this.config.network : (this.config.network ?? 'mainnet');
    const { Account, AleoNetworkClient, ProgramManager, AleoKeyProvider, NetworkRecordProvider } =
      await loadAleoSDK(network);

    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);

    if (isPrivateKeyConfig(this.config)) {
      const networkClient = new AleoNetworkClient(this.config.rpcUrl);
      const account = new Account({ privateKey: this.config.privateKey });
      const wallet: PkAleoWallet = { type: 'privateKey', account };
      const recordProvider = new NetworkRecordProvider(account, networkClient);
      const programManager = new ProgramManager(this.config.rpcUrl, keyProvider, recordProvider);
      programManager.setAccount(account);

      return { networkClient, wallet, programManager };
    }

    const browserConfig = this.config as BrowserExtensionAleoWalletConfig;
    const networkClient = new AleoNetworkClient(browserConfig.rpcUrl);
    const wallet: BrowserExtensionAleoWallet = {
      type: 'browserExtension',
      adapter: browserConfig.provableAdapter,
    };
    const programManager = new ProgramManager(
      browserConfig.rpcUrl,
      keyProvider,
      undefined, // No record provider for browser wallets
    );

    return { networkClient, wallet, programManager };
  }

  async executeAndWait(
    options: AleoExecuteOptions,
    receiptOptions?: AleoWaitForReceiptOptions,
  ): Promise<{ result: AleoExecutionResult; receipt: AleoTransactionReceipt }> {
    const result = await this.execute(options);
    const receipt = await this.waitForTransactionReceipt(result.transactionId, receiptOptions);

    return { result, receipt };
  }

  async getWalletAddress(): Promise<string> {
    const { wallet } = await this.ensureInitialized();

    if (isPkAleoWallet(wallet)) {
      return wallet.account.address().to_string();
    }

    if (isBrowserExtensionAleoWallet(wallet)) {
      if (!wallet.adapter.connected || !wallet.adapter.account) {
        throw new Error('Browser wallet not connected');
      }
      return wallet.adapter.account.address;
    }

    throw new Error('Invalid wallet configuration');
  }

  private getDefaultDelegateUrl(): string {
    const network = isPrivateKeyConfig(this.config) ? this.config.network : undefined;
    return network === 'testnet'
      ? 'https://api.provable.com/prove/testnet'
      : 'https://api.provable.com/prove/mainnet';
  }

  async execute(options: AleoExecuteOptions): Promise<AleoExecutionResult> {
    const state = await this.ensureInitialized();
    const { wallet, programManager } = state;
    const { programName, functionName, inputs } = options;
    const privateFee = options.privateFee ?? this.defaults.privateFee ?? false;
    const delegateConfig = isPrivateKeyConfig(this.config) ? this.config.delegate : undefined;

    // Read-only call-graph / stack diagnostics (ALEO_DEBUG=1; ALEO_DEBUG_VERIFY=1 adds the verify probe).
    // Never throws — must not affect the real execute/broadcast path; it only prints what the verifier
    // will later walk.
    const runVerifyProbe = isAleoVerifyProbeEnabled();
    if (isAleoDebugEnabled() || runVerifyProbe) {
      await this.logExecutionDiagnostics(state, { programName, functionName, inputs }, { runVerifyProbe });
    }

    if (isPkAleoWallet(wallet)) {
      const pkPriorityFee = options.priorityFee ?? this.defaults.priorityFee ?? DEFAULT_PK_PRIORITY_FEE;
      try {
        if (delegateConfig) {
          const provingRequest = await programManager.provingRequest({
            programName,
            functionName,
            inputs,
            priorityFee: pkPriorityFee,
            privateFee,
            broadcast: true,
          });

          const provingResponse = await programManager.networkClient.submitProvingRequest({
            provingRequest,
            url: delegateConfig.url ?? this.defaults.delegateUrl ?? this.getDefaultDelegateUrl(),
            apiKey: delegateConfig.apiKey,
            consumerId: delegateConfig.consumerId,
            dpsPrivacy: true,
          });
          return {
            transactionId: provingResponse.transaction.id,
          };
        }

        const txId = await programManager.execute({
          programName,
          functionName,
          priorityFee: pkPriorityFee,
          privateFee,
          inputs,
        });
        return {
          transactionId: txId,
        };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    }

    if (isBrowserExtensionAleoWallet(wallet)) {
      if (!wallet.adapter.connected || !wallet.adapter.account) {
        throw new Error('Browser wallet not connected');
      }

      try {
        const browserFee = options.priorityFee ?? this.defaults.priorityFee ?? DEFAULT_BROWSER_FEE;
        const provableOptions: ProvableTransactionOptions = {
          program: programName,
          function: functionName,
          inputs,
          fee: browserFee,
          privateFee,
        };

        const result = await wallet.adapter.executeTransaction(provableOptions);

        if (!result?.transactionId) {
          throw new Error('No transaction ID returned from browser wallet');
        }

        return {
          transactionId: result.transactionId,
          outputs: undefined,
        };
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : 'Browser wallet execution failed');
      }
    }

    throw new Error('Invalid wallet configuration');
  }

  /**
   * Read-only diagnostics for the "Missing stack for program '…'" class of execution-verification
   * failures. Aleo bundles one transition PER program crossed in a call (root + every imported program
   * it `call`s, e.g. asset_manager_core_v1.aleo → gmp_lib_v1.aleo). The validating node walks each
   * transition and resolves a Stack per program; a missing one bails with that message, raised from many
   * snarkVM call sites so the message alone can't localize it. This dumps, before the real broadcast:
   *   1. the root program source + its declared `import` lines,
   *   2. the transitive import map, each program's on-chain deployment status, and its declared imports,
   *   3. the static call graph (by declared imports),
   *   4. the ACTUAL transition trace via a local authorization — the lightest stage that resolves the full
   *      call graph (no proof). If that throws, local synthesis stopped at the missing program, proving the
   *      failure is import-resolution/synthesis-side rather than chain-verify-side.
   *   5. (opts.runVerifyProbe) a Layer-2 verify probe: locally proves the execution, then runs
   *      `verifyExecution` (= snarkVM `Process::verify_execution`) once with the full import set and once
   *      with the suspect program stripped — localizing the snarkVM function that emits the stack error and
   *      which program is missing, and revealing whether the real failure is local-verify or node-side.
   * Never throws: diagnostics must not perturb the real execute/broadcast path.
   */
  private async logExecutionDiagnostics(
    state: InitializedState,
    call: { programName: string; functionName: string; inputs: string[] },
    opts: { runVerifyProbe: boolean },
  ): Promise<void> {
    const { networkClient, programManager, wallet } = state;
    const { programName, functionName, inputs } = call;
    const tag = '[aleo-debug]';
    const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    const importLines = (src: string): string[] =>
      src
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('import '));
    const deploymentStatus = async (id: string): Promise<string> => {
      try {
        const src = await networkClient.getProgram(id);
        return `DEPLOYED (${src.length} chars)`;
      } catch (e) {
        return `NOT DEPLOYED / fetch failed: ${errMsg(e)}`;
      }
    };

    try {
      console.log(`\n${tag} ───────── Aleo execution diagnostics ─────────`);
      console.log(`${tag} program : ${programName}`);
      console.log(`${tag} function: ${functionName}`);
      console.log(`${tag} inputs  :`, inputs);

      // Captured for reuse by the Layer-2 verify probe (step 5).
      let rootSource: string | undefined;
      let importMap: Record<string, string> = {};

      // 1. Root program source + declared imports.
      try {
        rootSource = await networkClient.getProgram(programName);
        console.log(`${tag} root program DEPLOYED (source ${rootSource.length} chars)`);
        console.log(`${tag} root declared imports:`, importLines(rootSource));
      } catch (e) {
        console.log(`${tag} ⚠ root program fetch failed: ${errMsg(e)}`);
      }

      // 2. Direct + transitive import map, with per-program on-chain deployment status.
      try {
        const direct = await networkClient.getProgramImportNames(programName);
        console.log(`${tag} direct import names:`, direct);
      } catch (e) {
        console.log(`${tag} ⚠ getProgramImportNames failed: ${errMsg(e)}`);
      }
      try {
        importMap = (await networkClient.getProgramImports(programName)) as Record<string, string>;
        const ids = Object.keys(importMap);
        console.log(`${tag} transitive imports resolved (${ids.length}):`, ids);
        for (const id of ids) {
          const src = importMap[id] ?? '';
          console.log(`${tag}   • ${id} — supplied source ${src.length} chars — on-chain: ${await deploymentStatus(id)}`);
          const declared = importLines(src);
          if (declared.length > 0) console.log(`${tag}       declares:`, declared);
        }
        if (!ids.some((id) => id.includes('gmp_lib'))) {
          console.log(`${tag} ⚠ no gmp_lib_* program in the resolved import map — consistent with the "Missing stack" error`);
        }
      } catch (e) {
        console.log(`${tag} ⚠ getProgramImports failed: ${errMsg(e)}`);
      }

      // 3. Static call graph by declared imports (cycle-guarded).
      console.log(`${tag} static call graph (by declared imports):`);
      const visited = new Set<string>();
      const walk = async (id: string, depth: number): Promise<void> => {
        const indent = '  '.repeat(depth);
        const marker = depth === 0 ? '◆' : '└─';
        if (visited.has(id)) {
          console.log(`${tag} ${indent}${marker} ${id} (already expanded)`);
          return;
        }
        visited.add(id);
        let names: string[] = [];
        try {
          names = await networkClient.getProgramImportNames(id);
        } catch (e) {
          console.log(`${tag} ${indent}${marker} ${id} ⚠ imports unavailable: ${errMsg(e)}`);
          return;
        }
        console.log(`${tag} ${indent}${marker} ${id}${names.length === 0 ? ' (leaf)' : ''}`);
        for (const name of names) await walk(name, depth + 1);
      };
      await walk(programName, 0);

      // 4. Actual transition trace via a local authorization (PK path only — needs the signing key).
      if (isPkAleoWallet(wallet)) {
        console.log(`${tag} building local authorization to capture the actual transition trace…`);
        try {
          const authorization = await programManager.buildAuthorization({ programName, functionName, inputs });
          const transitions = (authorization.transitions() ?? []) as Array<{
            programId?: () => string;
            functionName?: () => string;
            id?: () => string;
          }>;
          console.log(`${tag} ✅ authorization built — ${transitions.length} transition(s) in call-graph order:`);
          transitions.forEach((t, i) => {
            const pid = typeof t.programId === 'function' ? t.programId() : '?';
            const fn = typeof t.functionName === 'function' ? t.functionName() : '?';
            const tid = typeof t.id === 'function' ? t.id() : '?';
            console.log(`${tag}   #${i}  ${pid} / ${fn}   (${tid})`);
          });
        } catch (e) {
          console.log(`${tag} ❌ buildAuthorization FAILED — local synthesis stopped here:`);
          console.log(`${tag}    ${errMsg(e)}`);
          console.log(
            `${tag}    → call graph could not be resolved locally; the program named above is the missing stack`,
          );
        }
      } else {
        console.log(`${tag} (browser wallet — skipping local authorization probe; no signing key in ProgramManager)`);
      }

      // 5. Layer-2 verify probe (ALEO_DEBUG_VERIFY=1, PK path only). Locally prove, then call
      // `verifyExecution` (= snarkVM `Process::verify_execution`) with and without the suspect program to
      // localize the function that emits the stack error and confirm which program is missing.
      if (opts.runVerifyProbe && isPkAleoWallet(wallet)) {
        await this.runVerifyProbe(state, { programName, functionName, inputs }, { rootSource, importMap, tag, errMsg });
      } else if (opts.runVerifyProbe) {
        console.log(`${tag} (browser wallet — skipping Layer-2 verify probe; no signing key in ProgramManager)`);
      }

      console.log(`${tag} ──────────────────────────────────────────────\n`);
    } catch (e) {
      console.log(`${tag} diagnostics aborted: ${errMsg(e)}`);
    }
  }

  /**
   * Layer-2 verify probe (see logExecutionDiagnostics step 5). Locally proves the execution, then runs
   * snarkVM's verification (`ProgramManager.verifyExecution` → `Process::verify_execution`) twice:
   *   (a) with the full import set, and
   *   (b) with every gmp_lib_* program stripped from the import set.
   * The stripped run is expected to throw the same stack error as the broadcast node — reproducing it
   * inside the verify function and naming the missing program. Comparing (a) and the real 500 reveals
   * whether the failure is local-verify (we reproduce it) or node-side (local verify passes, node still
   * fails — meaning the node's process never loaded the program, e.g. not finalized / not carried in the
   * tx). Verifying keys for the pass case are not assembled here; if (a) fails past the stack lookup with a
   * "verifying key" error, that itself confirms the stack lookup succeeded. Never throws.
   */
  private async runVerifyProbe(
    state: InitializedState,
    call: { programName: string; functionName: string; inputs: string[] },
    ctx: {
      rootSource: string | undefined;
      importMap: Record<string, string>;
      tag: string;
      errMsg: (e: unknown) => string;
    },
  ): Promise<void> {
    const { networkClient, programManager } = state;
    const { functionName, inputs } = call;
    const { rootSource, importMap, tag, errMsg } = ctx;

    console.log(`${tag} ─── Layer-2 verify probe (local prove → verifyExecution) ───`);
    if (!rootSource) {
      console.log(`${tag} ⚠ no root program source available — skipping verify probe`);
      return;
    }

    let blockHeight: number;
    try {
      blockHeight = await networkClient.getLatestHeight();
      console.log(`${tag} latest block height: ${blockHeight}`);
    } catch (e) {
      console.log(`${tag} ⚠ getLatestHeight failed (${errMsg(e)}) — skipping verify probe (height affects consensus checks)`);
      return;
    }

    // Local prove. If this throws, the error surfaces in EXECUTE/synthesis, not verification.
    let response: Awaited<ReturnType<typeof programManager.run>>;
    try {
      console.log(`${tag} proving execution locally via ProgramManager.run (this can take a while)…`);
      response = await programManager.run(rootSource, functionName, inputs, true, importMap);
      const transitions = (response.getExecution()?.transitions() ?? []) as Array<{
        programId?: () => string;
        functionName?: () => string;
      }>;
      console.log(`${tag} ✅ proved — execution has ${transitions.length} transition(s):`);
      transitions.forEach((t, i) => {
        const pid = typeof t.programId === 'function' ? t.programId() : '?';
        const fn = typeof t.functionName === 'function' ? t.functionName() : '?';
        console.log(`${tag}   #${i}  ${pid} / ${fn}`);
      });
    } catch (e) {
      console.log(`${tag} ❌ ProgramManager.run failed — the stack error surfaces in EXECUTE/synthesis (not verify):`);
      console.log(`${tag}    ${errMsg(e)}`);
      return;
    }

    // (a) Verify with the full import set.
    try {
      const ok = programManager.verifyExecution(response, blockHeight, importMap);
      console.log(`${tag} (a) verifyExecution(full imports) → ${ok}`);
      console.log(
        `${tag}     → local verify ${ok ? 'PASSES' : 'returns false'}; if the broadcast node still 500s, the missing stack is node-side (program not loaded/finalized on the node, or not carried in the tx)`,
      );
    } catch (e) {
      const msg = errMsg(e);
      console.log(`${tag} (a) verifyExecution(full imports) threw: ${msg}`);
      if (/verifying key/i.test(msg)) {
        console.log(`${tag}     → past the stack lookup (this is a verifying-key error, not a missing-stack); stack resolution succeeded`);
      }
    }

    // (b) Verify with every gmp_lib_* program stripped — reproduce the missing-stack inside verify.
    const stripped: Record<string, string> = { ...importMap };
    const removed = Object.keys(stripped).filter((k) => k.includes('gmp_lib'));
    for (const k of removed) delete stripped[k];
    const label = removed.length > 0 ? removed.join(', ') : 'gmp_lib_* (none present to strip)';
    try {
      const ok = programManager.verifyExecution(response, blockHeight, stripped);
      console.log(`${tag} (b) verifyExecution(without ${label}) → ${ok} (unexpected: no stack error raised)`);
    } catch (e) {
      console.log(`${tag} ✅ (b) reproduced in the verify path — verifyExecution(without ${label}) threw:`);
      console.log(`${tag}    ${errMsg(e)}`);
      console.log(
        `${tag}    → this is snarkVM Process::verify_execution → get_stack/get_external_stack; the named program is the missing stack`,
      );
    }
  }

  async waitForTransactionReceipt(
    transactionId: string,
    options: AleoWaitForReceiptOptions = {},
  ): Promise<AleoTransactionReceipt> {
    const { networkClient } = await this.ensureInitialized();
    const merged = this.mergePolicy('waitForReceipt', options);
    const { checkInterval = 2000, timeout = 45000 } = merged;

    try {
      const confirmedTx = await networkClient.waitForTransactionConfirmation(
        transactionId,
        checkInterval,
        timeout,
      );

      return {
        transactionId,
        status: confirmedTx.status as AleoTransactionReceipt['status'],
        type: confirmedTx.type,
        index: confirmedTx.index,
        transaction: confirmedTx.transaction as unknown,
        finalize: confirmedTx.finalize as unknown[],
        confirmedAt: new Date(),
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('timeout') || error.message.includes('did not appear')) {
          throw new Error(
            `Transaction ${transactionId} did not confirm within ${timeout}ms. The transaction may still be pending - check the transaction status manually.`,
          );
        }
        if (error.message.includes('Malformed') || error.message.includes('Invalid URL')) {
          throw new Error(
            `Invalid transaction ID format: ${transactionId}.Please verify the transaction ID is correct.`,
          );
        }
        if (error.message.includes('rejected')) {
          throw new Error(
            `Transaction ${transactionId} was rejected by the network.Check that the fee payer has sufficient credits and inputs are valid.`,
          );
        }
      }

      throw error;
    }
  }
}
