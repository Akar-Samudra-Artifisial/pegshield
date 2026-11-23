import type { Address } from "viem";
import { depegSentinelAbi } from "@/abi/DepegSentinel";
import { mockPairAbi } from "@/abi/MockPair";
import { mockTokenAbi } from "@/abi/MockToken";
import { policyVaultAbi } from "@/abi/PolicyVault";
import { client } from "./clients";
import { CONTRACTS } from "./config";

export interface LiveState {
  poolPrice: bigint;
  reserveStable: bigint;
  reserveQuote: bigint;
  status: number;
  epoch: bigint;
  belowCount: bigint;
  confirmations: bigint;
  watchPrice: bigint;
  recoverPrice: bigint;
  keeperTreasury: bigint;
  vaultAssets: bigint;
  vaultFree: bigint;
  vaultLocked: bigint;
  depegActive: boolean;
  premiumBps: bigint;
  term: bigint;
  readAt: number;
}

export async function readLive(): Promise<LiveState> {
  const base = client("base");
  const lasna = client("lasna");
  const uni = client("unichain");
  const sentinel = { address: CONTRACTS.sentinel, abi: depegSentinelAbi } as const;
  const vault = { address: CONTRACTS.vault, abi: policyVaultAbi } as const;

  const [
    poolPrice,
    reserves,
    keeperTreasury,
    status,
    epoch,
    belowCount,
    confirmations,
    watchPrice,
    recoverPrice,
    vaultAssets,
    vaultFree,
    vaultLocked,
    depegActive,
    premiumBps,
    term,
  ] = await Promise.all([
    base.readContract({ address: CONTRACTS.pair, abi: mockPairAbi, functionName: "priceE18" }),
    base.readContract({ address: CONTRACTS.pair, abi: mockPairAbi, functionName: "getReserves" }),
    base.readContract({
      address: CONTRACTS.mockUsdBase,
      abi: mockTokenAbi,
      functionName: "balanceOf",
      args: [CONTRACTS.keeper],
    }),
    lasna.readContract({ ...sentinel, functionName: "status" }),
    lasna.readContract({ ...sentinel, functionName: "epoch" }),
    lasna.readContract({ ...sentinel, functionName: "belowCount" }),
    lasna.readContract({ ...sentinel, functionName: "confirmations" }),
    lasna.readContract({ ...sentinel, functionName: "watchPriceE18" }),
    lasna.readContract({ ...sentinel, functionName: "recoverPriceE18" }),
    uni.readContract({ ...vault, functionName: "totalAssets" }),
    uni.readContract({ ...vault, functionName: "freeAssets" }),
    uni.readContract({ ...vault, functionName: "lockedCoverage" }),
    uni.readContract({ ...vault, functionName: "depegActive" }),
    uni.readContract({ ...vault, functionName: "premiumBps" }),
    uni.readContract({ ...vault, functionName: "term" }),
  ]);

  return {
    poolPrice,
    reserveStable: BigInt(reserves[0]),
    reserveQuote: BigInt(reserves[1]),
    status: Number(status),
    epoch,
    belowCount,
    confirmations,
    watchPrice,
    recoverPrice,
    keeperTreasury,
    vaultAssets,
    vaultFree,
    vaultLocked,
    depegActive,
    premiumBps,
    term,
    readAt: Date.now(),
  };
}

export interface Holding {
  id: bigint;
  coverage: bigint;
  expiry: number;
}

export interface AccountState {
  usdBalance: bigint;
  allowance: bigint;
  openPolicies: Holding[];
  baseEth: bigint;
  unichainEth: bigint;
}

export async function readAccount(account: Address): Promise<AccountState> {
  const uni = client("unichain");
  const vault = { address: CONTRACTS.vault, abi: policyVaultAbi } as const;
  const token = { address: CONTRACTS.mockUsdUnichain, abi: mockTokenAbi } as const;
  const [usdBalance, allowance, ids, baseEth, unichainEth] = await Promise.all([
    uni.readContract({ ...token, functionName: "balanceOf", args: [account] }),
    uni.readContract({ ...token, functionName: "allowance", args: [account, CONTRACTS.vault] }),
    uni.readContract({ ...vault, functionName: "openPolicyIds" }),
    client("base").getBalance({ address: account }),
    uni.getBalance({ address: account }),
  ]);
  const policies = await Promise.all(
    ids.map(async (id) => {
      const [holder, , expiry, settled, coverage] = await uni.readContract({
        ...vault,
        functionName: "policies",
        args: [id],
      });
      return { id, holder, expiry: Number(expiry), settled, coverage };
    }),
  );
  const mine = policies.filter((p) => !p.settled && p.holder.toLowerCase() === account.toLowerCase());
  return {
    usdBalance,
    allowance,
    openPolicies: mine.map(({ id, coverage, expiry }) => ({ id, coverage, expiry })),
    baseEth,
    unichainEth,
  };
}
