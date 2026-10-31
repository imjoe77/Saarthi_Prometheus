import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseAbiItem,
  stringToHex,
  type Account,
  type Chain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

export const EMBER_UNIT_WEI = 10n ** 18n;

const EMBER_TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function treasury() view returns (address)',
  'function balanceOf(address account) view returns (uint256)',
  'function mint(address to, uint256 amount)',
  'function burnTreasury(uint256 amount)',
]);

const MINTED_EVENT = parseAbiItem(
  'event TokensMinted(address indexed to, uint256 amount, uint256 newTotalSupply)',
);
const BURNED_EVENT = parseAbiItem(
  'event TokensBurned(address indexed from, uint256 amount, uint256 newTotalSupply)',
);

export interface ChainDeployment {
  network: string;
  chainId: number;
  rpcUrl: string;
  tokenAddress: string;
  treasuryAddress: string;
  maxSupplyWhole: string | null;
  deploymentBlock: number;
  confirmations: number;
}

export type SignerResolution =
  | { kind: 'keyFile'; path: string }
  | { kind: 'provided'; account: Account }
  | null;

export interface GatewayDependencies {
  deployment: ChainDeployment;
  minter: SignerResolution;
  treasuryBurner: SignerResolution;
}

export interface SubmittedTransaction {
  txHash: `0x${string}`;
}

export interface ContractReceipt {
  status: 'success' | 'reverted';
  blockNumber: string;
}

export interface ContractEventOccurrence {
  eventName: 'TokensMinted' | 'TokensBurned';
  network: string;
  chainId: number;
  txHash: string;
  blockNumber: string;
  logIndex: number;
  account: string;
  amount: string;
  newTotalSupply: string;
}

export interface ContractSnapshot {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  maxSupply: string;
  treasuryBalance: string;
  treasuryAddress: string;
  tokenAddress: string;
}

export interface EmberChainGateway {
  chainId(): Promise<number>;
  snapshot(): Promise<ContractSnapshot>;
  submitMint(amount: string): Promise<SubmittedTransaction>;
  submitBurn(amount: string): Promise<SubmittedTransaction>;
  waitForReceipt(txHash: `0x${string}`, timeoutMs: number): Promise<ContractReceipt>;
  historyEvents(fromBlock: number, toBlock?: 'latest'): Promise<ContractEventOccurrence[]>;
  receiptEvents(txHash: `0x${string}`): Promise<ContractEventOccurrence[]>;
}

export class BlockchainDisabledError extends Error {
  constructor() {
    super('The blockchain layer is disabled. Deploy the contracts from blockchain/ and set BLOCKCHAIN_ENABLED=true.');
    this.name = 'BlockchainDisabledError';
  }
}

export class MissingSignerError extends Error {
  constructor(readonly role: string) {
    super(`No ${role} signer is configured. Provide the ${role} server-side key file to submit ${role === 'minter' ? 'mint' : 'burn'} transactions.`);
    this.name = 'MissingSignerError';
  }
}

export function emberAmountToWei(emberAmount: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(emberAmount)) {
    throw new Error(`Invalid EMBER amount '${emberAmount}'.`);
  }
  const [wholeRaw, fractionRaw = ''] = emberAmount.split('.');
  const whole = wholeRaw ?? '0';
  const padded = (fractionRaw + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * EMBER_UNIT_WEI + BigInt(padded);
}

export function weiToEmberAmount(wei: bigint): string {
  const whole = wei / EMBER_UNIT_WEI;
  const fraction = (wei % EMBER_UNIT_WEI).toString().padStart(18, '0');
  return `${whole}.${fraction}`;
}

export function createEmberChain(chainId: number, networkName: string, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: networkName,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    testnet: true,
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

type ViemPublicClient = ReturnType<typeof createPublicClient>;
type ViemTransport = ReturnType<typeof http>;

export function createViemGateway(
  dependencies: GatewayDependencies & { runtimeChain?: Chain; publicClient?: ViemPublicClient },
): EmberChainGateway {
  const chain =
    dependencies.runtimeChain ??
    createEmberChain(dependencies.deployment.chainId, dependencies.deployment.network, dependencies.deployment.rpcUrl);
  const transport = http(dependencies.deployment.rpcUrl, { timeout: 10_000, retryCount: 2 });
  const publicClient =
    dependencies.publicClient ?? createPublicClient({ chain, transport: transport as never });

  return new ViemEmberGateway(publicClient, chain, transport, {
    deployment: dependencies.deployment,
    minter: dependencies.minter,
    treasuryBurner: dependencies.treasuryBurner,
  });
}

type RawLog = {
  address: string;
  blockNumber: bigint;
  transactionHash: `0x${string}` | null;
  logIndex: number;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
};

class ViemEmberGateway implements EmberChainGateway {
  constructor(
    private readonly publicClient: ViemPublicClient,
    private readonly chain: Chain,
    private readonly transport: ViemTransport,
    private readonly deps: GatewayDependencies,
  ) {}

  private account(role: 'minter' | 'treasuryBurner'): Account {
    const resolution = role === 'minter' ? this.deps.minter : this.deps.treasuryBurner;
    if (!resolution) throw new MissingSignerError(role === 'minter' ? 'minter' : 'treasury');
    if (resolution.kind === 'provided') return resolution.account;
    const raw = readFileSync(resolution.path, 'utf8').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        `The key file '${resolution.path}' must contain a single hex private key (0x followed by 64 hex characters).`,
      );
    }
    return privateKeyToAccount(raw as `0x${string}`);
  }

  private walletClient(role: 'minter' | 'treasuryBurner') {
    return createWalletClient({
      account: this.account(role),
      chain: this.chain,
      transport: this.transport,
    });
  }

  async chainId(): Promise<number> {
    const id = await this.publicClient.getChainId();
    return Number(id);
  }

  async snapshot(): Promise<ContractSnapshot> {
    const address = this.deps.deployment.tokenAddress as `0x${string}`;
    const results = await Promise.all([
      this.publicClient.readContract({ address, abi: EMBER_TOKEN_ABI, functionName: 'name' }),
      this.publicClient.readContract({ address, abi: EMBER_TOKEN_ABI, functionName: 'symbol' }),
      this.publicClient.readContract({ address, abi: EMBER_TOKEN_ABI, functionName: 'decimals' }),
      this.publicClient.readContract({ address, abi: EMBER_TOKEN_ABI, functionName: 'totalSupply' }),
      this.publicClient.readContract({ address, abi: EMBER_TOKEN_ABI, functionName: 'maxSupply' }),
      this.publicClient.readContract({ address, abi: EMBER_TOKEN_ABI, functionName: 'treasury' }),
      this.publicClient.readContract({
        address,
        abi: EMBER_TOKEN_ABI,
        functionName: 'balanceOf',
        args: [this.deps.deployment.treasuryAddress as `0x${string}`],
      }),
    ]);
    const [name, symbol, decimals, totalSupply, maxSupply, treasuryOnChain, treasuryBalance] = results as [
      string,
      string,
      number,
      bigint,
      bigint,
      string,
      bigint,
    ];
    return {
      name,
      symbol,
      decimals: Number(decimals),
      totalSupply: weiToEmberAmount(totalSupply),
      maxSupply: weiToEmberAmount(maxSupply),
      treasuryBalance: weiToEmberAmount(treasuryBalance),
      treasuryAddress: treasuryOnChain,
      tokenAddress: address,
    };
  }

  private async write(
    role: 'minter' | 'treasuryBurner',
    functionName: 'mint' | 'burnTreasury',
    args: readonly unknown[],
  ): Promise<SubmittedTransaction> {
    const wallet = this.walletClient(role);
    const txHash = await wallet.writeContract({
      address: this.deps.deployment.tokenAddress as `0x${string}`,
      abi: EMBER_TOKEN_ABI,
      functionName,
      args: args as never,
    });
    return { txHash };
  }

  async submitMint(amount: string): Promise<SubmittedTransaction> {
    const wei = emberAmountToWei(amount);
    return this.write('minter', 'mint', [this.deps.deployment.treasuryAddress as `0x${string}`, wei]);
  }

  async submitBurn(amount: string): Promise<SubmittedTransaction> {
    const wei = emberAmountToWei(amount);
    return this.write('treasuryBurner', 'burnTreasury', [wei]);
  }

  async waitForReceipt(txHash: `0x${string}`, timeoutMs: number): Promise<ContractReceipt> {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: timeoutMs,
      confirmations: Math.max(1, this.deps.deployment.confirmations),
    });
    return {
      status: receipt.status === 'reverted' ? 'reverted' : 'success',
      blockNumber: String(receipt.blockNumber),
    };
  }

  async historyEvents(fromBlock: number, toBlock: 'latest' = 'latest'): Promise<ContractEventOccurrence[]> {
    const logs = await this.publicClient.getLogs({
      address: this.deps.deployment.tokenAddress as `0x${string}`,
      events: [MINTED_EVENT, BURNED_EVENT],
      fromBlock: BigInt(fromBlock),
      toBlock,
    });
    return logs
      .map((log) => this.decode(log as RawLog))
      .filter((entry): entry is ContractEventOccurrence => entry !== null);
  }

  async receiptEvents(txHash: `0x${string}`): Promise<ContractEventOccurrence[]> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    return receipt.logs
      .map((log) => this.decode(log as unknown as RawLog))
      .filter((entry): entry is ContractEventOccurrence => entry !== null);
  }

  private decode(log: RawLog): ContractEventOccurrence | null {
    const topic0 = log.topics[0];
    if (!topic0 || !log.transactionHash) return null;
    let eventName: 'TokensMinted' | 'TokensBurned' | null = null;
    if (topic0 === eventTopic('TokensMinted(address,uint256,uint256)')) eventName = 'TokensMinted';
    if (topic0 === eventTopic('TokensBurned(address,uint256,uint256)')) eventName = 'TokensBurned';
    if (!eventName) return null;

    const data = log.data.slice(2);
    if (data.length < 128) return null;
    const amount = BigInt(`0x${data.slice(0, 64)}`);
    const newTotalSupply = BigInt(`0x${data.slice(64, 128)}`);
    const accountTopic = log.topics[1] ?? '0x0';
    const hexAccount = accountTopic.slice(2).slice(24);
    return {
      eventName,
      network: this.deps.deployment.network,
      chainId: this.deps.deployment.chainId,
      txHash: log.transactionHash,
      blockNumber: String(log.blockNumber),
      logIndex: log.logIndex,
      account: `0x${hexAccount}`,
      amount: weiToEmberAmount(amount),
      newTotalSupply: weiToEmberAmount(newTotalSupply),
    };
  }
}

const EVENT_TOPIC_CACHE = new Map<string, `0x${string}`>();

function eventTopic(signature: string): `0x${string}` {
  const cached = EVENT_TOPIC_CACHE.get(signature);
  if (cached) return cached;
  const topic = keccak256(stringToHex(signature));
  EVENT_TOPIC_CACHE.set(signature, topic);
  return topic;
}
