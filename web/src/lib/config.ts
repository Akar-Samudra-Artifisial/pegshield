import { type Address, type Chain, defineChain } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "Lasna REACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
  testnet: true,
});

export type LaneId = "base" | "lasna" | "unichain";

export interface Lane {
  id: LaneId;
  label: string;
  role: string;
  chain: Chain;
  /** Read RPC, first choice. Also offered to wallets when adding the chain. */
  rpc: string;
  /** Read RPCs tried in order when the first stalls (public endpoints do, for 15 s at a time). */
  fallbacks: string[];
  explorer: string;
  /** Max block span per eth_getLogs request that the RPC accepts. */
  logChunk: bigint;
}

export const LANES: Record<LaneId, Lane> = {
  base: {
    id: "base",
    label: "Base Sepolia",
    role: "Pool and peg keeper",
    chain: baseSepolia,
    rpc: "https://base-sepolia-rpc.publicnode.com",
    fallbacks: ["https://sepolia.base.org"],
    explorer: "https://sepolia.basescan.org",
    logChunk: 45_000n,
  },
  lasna: {
    id: "lasna",
    label: "Reactive Lasna",
    role: "Depeg sentinel",
    chain: lasna,
    rpc: "https://lasna-rpc.rnk.dev",
    fallbacks: [],
    explorer: "https://lasna.reactscan.net",
    logChunk: 9_000n,
  },
  unichain: {
    id: "unichain",
    label: "Unichain Sepolia",
    role: "Policy vault",
    chain: unichainSepolia,
    rpc: "https://unichain-sepolia-rpc.publicnode.com",
    // Per-epoch log windows stay under sepolia.unichain.org's ~1k-block getLogs cap.
    fallbacks: ["https://sepolia.unichain.org"],
    explorer: "https://sepolia.uniscan.xyz",
    logChunk: 45_000n,
  },
};

/** Addresses from deployments/testnet.env. */
export const CONTRACTS = {
  mockStable: "0xce47e1a57026470854347af452804f1d2bd0f0aa",
  mockUsdBase: "0x49746328fdc3787f17e9374b00ef315fb11c33f0",
  pair: "0xbbe79dc4775a7ed7031a9d47528cd1c43c35f1bd",
  keeper: "0xf7c42496d513ab05650029fa2e5da0d2a2542c2e",
  drill: "0x6d2a1f649634598044db76a4f9e1cc182ca2991e",
  sentinel: "0x729215e645fe4b9eec8a2e9d7eb40482cd276894",
  mockUsdUnichain: "0xef28b0405637d399087aca3bd0dc716374fd8edb",
  vault: "0x729215e645fe4b9eec8a2e9d7eb40482cd276894",
} as const satisfies Record<string, Address>;

/** First block with code, so history scans never start before deployment. */
export const DEPLOY_BLOCKS: Record<LaneId, bigint> = {
  base: 62_505_140n,
  lasna: 9_042_274n,
  unichain: 68_570_483n,
};

/** History window for the loop table: about the last 24 hours on each chain. */
export const HISTORY_SECONDS = 24n * 60n * 60n;

/** Drill defaults: three dumps of 2,000 mSTB move a 100k/100k pool below 0.97. */
export const DRILL_AMOUNT = 2_000n * 10n ** 18n;
export const DRILL_DUMPS = 3n;

export function txUrl(lane: LaneId, hash: string): string {
  return `${LANES[lane].explorer}/tx/${hash}`;
}

export function addressUrl(lane: LaneId, address: string): string {
  return `${LANES[lane].explorer}/address/${address}`;
}
