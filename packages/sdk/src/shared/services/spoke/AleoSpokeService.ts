import { keccak256, toHex, type Address, type Hex } from 'viem';
import {
  type AleoChainKey,
  type AleoExecuteOptions,
  type AleoNetworkEnv,
  type AleoProgramId,
  type AleoRawTransaction,
  type AleoSpokeChainConfig,
  type AleoTransactionReceipt,
  ChainKeys,
  getIntentRelayChainId,
  type IAleoWalletProvider,
  type Result,
  type TxReturnType,
} from '@sodax/types';
import type {
  DepositParams,
  EstimateGasParams,
  GetDepositParams,
  SendMessageParams,
  WaitForTxReceiptParams,
  WaitForTxReceiptReturnType,
} from '../../types/spoke-types.js';
import type { ConfigService } from '../../config/ConfigService.js';
import { decodeBech32m } from '../../utils/bech32m.js';
import type { EvmHubProvider } from '../../entities/EvmHubProvider.js';

const U64_MAX = BigInt('18446744073709551615');
const ALEO_DEFAULT_TIMEOUT_MS = 45_000;
const ALEO_DEFAULT_CHECK_INTERVAL_MS = 2_000;
const ALEO_ADDRESS_PREFIX = 'aleo1';
const ALEO_ADDRESS_LENGTH = 63;
const ALEO_TX_PREFIX = 'at1';
const ALEO_TX_LENGTH = 61;
const ALEO_CONNSN_GENERATION_RETRIES = 3;

// Lazy-load @provablehq/sdk to avoid triggering WASM initialization at import time.
type AleoSDK = typeof import('@provablehq/sdk');

function loadAleoSDK(network: AleoNetworkEnv): Promise<AleoSDK> {
  if (network === 'testnet') return import('@provablehq/sdk/testnet.js') as unknown as Promise<AleoSDK>;
  return import('@provablehq/sdk/mainnet.js') as unknown as Promise<AleoSDK>;
}

function isValidAleoAddress(address: string): boolean {
  return typeof address === 'string' && address.startsWith(ALEO_ADDRESS_PREFIX) && address.length === ALEO_ADDRESS_LENGTH;
}

function isValidAleoTransactionId(txId: string): boolean {
  return typeof txId === 'string' && txId.startsWith(ALEO_TX_PREFIX) && txId.length === ALEO_TX_LENGTH;
}

function formatAleoInput(value: bigint, type: 'u64' | 'u128' | 'field' = 'u128'): string {
  return `${value}${type}`;
}

/** Convert hex string to Leo `[u8; 32]` array literal, left-padded to 32 bytes. */
function hexToAleoU8Array(hex: string): string {
  let normalized = hex.trim().toLowerCase();
  if (normalized.startsWith('0x')) normalized = normalized.slice(2);
  if (normalized.length % 2 === 1) normalized = `0${normalized}`;

  const bytes = new Uint8Array(normalized.match(/.{1,2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? []);
  if (bytes.length > 32) throw new Error(`Hex input exceeds 32 bytes: ${bytes.length}`);

  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return `[${Array.from(padded)
    .map(b => `${b}u8`)
    .join(', ')}]`;
}

function aleoAddressToHex(address: string): Hex {
  if (!isValidAleoAddress(address)) {
    throw new Error(`Invalid Aleo address: ${address}`);
  }
  const { data } = decodeBech32m(address);
  return toHex(new Uint8Array([...data].reverse()));
}

export class AleoSpokeService {
  private readonly chainConfig: AleoSpokeChainConfig;
  private readonly network: AleoNetworkEnv;
  private readonly pollingIntervalMs: number;
  private readonly maxTimeoutMs: number;

  private _networkClient: Awaited<AleoSDK>['AleoNetworkClient']['prototype'] | null = null;
  private _programManager: Awaited<AleoSDK>['ProgramManager']['prototype'] | null = null;

  public constructor(config: ConfigService, network: AleoNetworkEnv = 'mainnet') {
    this.chainConfig = config.getChainConfig(ChainKeys.ALEO_MAINNET) as AleoSpokeChainConfig;
    this.network = network;
    this.pollingIntervalMs = this.chainConfig.pollingConfig.pollingIntervalMs;
    this.maxTimeoutMs = this.chainConfig.pollingConfig.maxTimeoutMs;
  }

  private async ensureClients(): Promise<void> {
    if (!this._networkClient) {
      const { AleoNetworkClient, ProgramManager } = await loadAleoSDK(this.network);
      this._networkClient = new AleoNetworkClient(this.chainConfig.rpcUrl);
      this._programManager = new ProgramManager(this.chainConfig.rpcUrl);
    }
  }

  public async estimateGas(_: EstimateGasParams<AleoChainKey>): Promise<bigint | number> {
    await this.ensureClients();
    if (!this._programManager) throw new Error('Aleo SDK not initialized');
    // Without a concrete tx context we approximate at zero gas — Aleo fees are computed
    // by the program manager from execute params at submit time.
    return 0n;
  }

  /**
   * Deposit tokens from Aleo to the hub via asset_manager.aleo.
   * Aleo transitions cannot read on-chain mappings, so conn_sn, fee, hub_chain_id, and
   * hub_address must all be passed as inputs.
   */
  public async deposit<R extends boolean>(
    params: DepositParams<AleoChainKey, R>,
    hubProvider: EvmHubProvider,
  ): Promise<TxReturnType<AleoChainKey, R>> {
    if (params.amount > U64_MAX) {
      throw new Error(`Amount ${params.amount} exceeds u64 maximum of ${U64_MAX}`);
    }

    const tokenField = BigInt(params.token);
    const isNative = tokenField === BigInt(this.chainConfig.nativeToken);
    const recipient: Address =
      params.to ?? (await hubProvider.getUserHubWalletAddress(params.srcAddress, ChainKeys.ALEO_MAINNET));
    const dataHash = keccak256(params.data);
    const connSn = await this.generateUniqueConnSn();
    const feeAmount = params.feeAmount ?? 0n;

    const hubChainId = BigInt(getIntentRelayChainId(ChainKeys.SONIC_MAINNET));
    const hubAddress = hubProvider.chainConfig.addresses.assetManager;

    const commonInputs: string[] = [
      hexToAleoU8Array(recipient),
      formatAleoInput(params.amount, 'u64'),
      formatAleoInput(connSn, 'u128'),
      hexToAleoU8Array(dataHash),
      formatAleoInput(feeAmount, 'u64'),
      formatAleoInput(hubChainId, 'u128'),
      hexToAleoU8Array(hubAddress),
    ];

    // Default: public transfer. Private flow runs only when aleoMode === 'private'.
    let functionName: string;
    let inputs: string[];
    if (params.aleoMode === 'private') {
      const { aleoRecord, aleoFallbackRecipient } = params;
      if (!aleoRecord) {
        throw new Error('aleoRecord is required when aleoMode is "private"');
      }
      if (!aleoFallbackRecipient || !isValidAleoAddress(aleoFallbackRecipient)) {
        throw new Error(`Invalid aleoFallbackRecipient for private transfer: ${aleoFallbackRecipient}`);
      }
      // Private transitions consume a record (credits.aleo::credits or token_registry.aleo::Token)
      // as the first input and append a fallback recipient address at the end.
      functionName = isNative ? 'transfer_native_private' : 'transfer_token_private';
      inputs = [aleoRecord, ...commonInputs, aleoFallbackRecipient];
    } else {
      functionName = isNative ? 'transfer_native_public' : 'transfer_token_public';
      inputs = [formatAleoInput(tokenField, 'field'), ...commonInputs];
    }
   
    const executeParams: AleoExecuteOptions = {
      programName: this.chainConfig.addresses.assetManager,
      functionName,
      inputs,
    };

    if (params.raw === true) {
      const tx: AleoRawTransaction = {
        from: params.srcAddress,
        to: this.chainConfig.addresses.assetManager as AleoProgramId,
        value: BigInt(params.amount),
        data: executeParams,
      };
      return tx as TxReturnType<AleoChainKey, true> as TxReturnType<AleoChainKey, R>;
    }

    const wallet = params.walletProvider as IAleoWalletProvider;
    const result = await wallet.execute(executeParams);
    return result.transactionId as TxReturnType<AleoChainKey, false> as TxReturnType<AleoChainKey, R>;
  }

  public async sendMessage<R extends boolean>(
    params: SendMessageParams<AleoChainKey, R>,
  ): Promise<TxReturnType<AleoChainKey, R>> {
    const dstChainId = BigInt(getIntentRelayChainId(params.dstChainKey));
    const connSn = await this.generateUniqueConnSn();

    const executeParams: AleoExecuteOptions = {
      programName: this.chainConfig.addresses.connection,
      functionName: 'send_message',
      inputs: [
        formatAleoInput(dstChainId, 'u128'),
        hexToAleoU8Array(params.dstAddress),
        formatAleoInput(connSn, 'u128'),
        hexToAleoU8Array(keccak256(params.payload)),
      ],
    };

    if (params.raw === true) {
      const tx: AleoRawTransaction = {
        from: params.srcAddress,
        to: this.chainConfig.addresses.connection as AleoProgramId,
        value: 0n,
        data: executeParams,
      };
      return tx as TxReturnType<AleoChainKey, true> as TxReturnType<AleoChainKey, R>;
    }

    const wallet = params.walletProvider as IAleoWalletProvider;
    const result = await wallet.execute(executeParams);
    return result.transactionId as TxReturnType<AleoChainKey, false> as TxReturnType<AleoChainKey, R>;
  }

  public async getDeposit(params: GetDepositParams<AleoChainKey>): Promise<bigint> {
    await this.ensureClients();
    if (!this._networkClient) throw new Error('Aleo SDK not initialized');

    const walletAddress = params.srcAddress;
    if (!isValidAleoAddress(walletAddress)) {
      throw new Error(`Invalid Aleo address: ${walletAddress}`);
    }

    if (params.token === this.chainConfig.nativeToken) {
      const balanceStr = await this._networkClient.getProgramMappingValue(
        this.chainConfig.addresses.creditsProgram,
        this.chainConfig.mappings.account,
        walletAddress,
      );
      return balanceStr ? BigInt(balanceStr.replace(/[^\d]/g, '')) : 0n;
    }

    const { BHP256, Plaintext } = await loadAleoSDK(this.network);
    const bhp = new BHP256();
    const structLiteral = `{ account: ${walletAddress}, token_id: ${params.token}field }`;
    const plaintext = Plaintext.fromString(structLiteral);
    const key = bhp.hash(plaintext.toBitsLe()).toString();
    const result = await this._networkClient.getProgramMappingValue(
      this.chainConfig.addresses.tokenRegistry,
      this.chainConfig.mappings.authorizedBalances,
      key,
    );
    if (result == null) return 0n;
    const match = result.match(/balance:\s*(\d+)u128/);
    return match?.[1] != null ? BigInt(match[1]) : 0n;
  }

  public async waitForTransactionReceipt(
    params: WaitForTxReceiptParams<AleoChainKey>,
  ): Promise<Result<WaitForTxReceiptReturnType<AleoChainKey>>> {
    const { txHash, pollingIntervalMs = this.pollingIntervalMs, maxTimeoutMs = this.maxTimeoutMs } = params;

    if (!isValidAleoTransactionId(txHash)) {
      return { ok: false, error: new Error(`Invalid Aleo transaction ID: ${txHash}`) };
    }

    void pollingIntervalMs;
    void maxTimeoutMs;
    void ALEO_DEFAULT_TIMEOUT_MS;
    void ALEO_DEFAULT_CHECK_INTERVAL_MS;

    return {
      ok: false,
      error: new Error('waitForTransactionReceipt for Aleo requires a connected IAleoWalletProvider'),
    };
  }

  /**
   * Wait for an Aleo transaction using the wallet provider's receipt API.
   * Aleo network does not expose a standalone tx-status RPC, so this requires
   * a connected wallet provider to query.
   */
  public async waitForReceiptViaWallet(
    txHash: string,
    walletProvider: IAleoWalletProvider,
    timeout = ALEO_DEFAULT_TIMEOUT_MS,
  ): Promise<Result<AleoTransactionReceipt>> {
    if (!isValidAleoTransactionId(txHash)) {
      return { ok: false, error: new Error(`Invalid Aleo transaction ID: ${txHash}`) };
    }
    try {
      const receipt = await walletProvider.waitForTransactionReceipt(txHash, {
        timeout,
        checkInterval: ALEO_DEFAULT_CHECK_INTERVAL_MS,
      });
      return { ok: true, value: receipt };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Generate a unique conn_sn (u64) by reading the messages mapping on connection.aleo.
   * Aleo transitions can't read mappings, so the value is generated client-side.
   */
  private async generateUniqueConnSn(inputConnSn?: bigint): Promise<bigint> {
    await this.ensureClients();
    if (!this._networkClient) throw new Error('Aleo SDK not initialized');

    const isUsed = async (connSn: bigint): Promise<boolean> => {
      try {
        const value = await this._networkClient?.getProgramMappingValue(
          this.chainConfig.addresses.connection,
          this.chainConfig.mappings.messages,
          `${connSn}u128`,
        );
        return value != null;
      } catch {
        return false;
      }
    };

    if (inputConnSn != null && !(await isUsed(inputConnSn))) {
      return inputConnSn;
    }

    for (let i = 0; i < ALEO_CONNSN_GENERATION_RETRIES; i++) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      const connSn = Array.from(bytes).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
      if (!(await isUsed(connSn))) return connSn;
    }
    throw new Error('Failed to generate unique connSn after maximum retries');
  }

  /** Static helper for callers that need to encode an Aleo address as hub-style hex. */
  public static encodeAleoAddress(address: string): Hex {
    return aleoAddressToHex(address);
  }
}
