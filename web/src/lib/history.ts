import { type Hex, getAbiItem, numberToHex } from "viem";
import { depegSentinelAbi } from "@/abi/DepegSentinel";
import { pegKeeperAbi } from "@/abi/PegKeeper";
import { policyVaultAbi } from "@/abi/PolicyVault";
import { blockTimestamp, client } from "./clients";
import { CONTRACTS, DEPLOY_BLOCKS, HISTORY_SECONDS, LANES, type LaneId } from "./config";

export const STATUS = ["Normal", "Watch", "Depegged"] as const;
export type StatusName = (typeof STATUS)[number];

interface Located {
  block: bigint;
  tx: Hex;
}

export interface StatusEvt extends Located {
  epoch: bigint;
  from: number;
  to: number;
  price: bigint;
  originBlock: bigint;
  originTx: Hex;
}

export interface DefendedEvt extends Located {
  epoch: bigint;
  round: bigint;
  quoteIn: bigint;
  stableOut: bigint;
  priceBefore: bigint;
  priceAfter: bigint;
}

export interface HandledEvt extends Located {
  epoch: bigint;
  paidCount: bigint;
  openRemaining: bigint;
}

export interface RecoveredEvt extends Located {
  epoch: bigint;
}

/** Blocks per second (measured: Base Sepolia 200 ms blocks, Lasna and Unichain ~1 s). Sizes the history window. */
const BLOCKS_PER_SECOND: Record<LaneId, bigint> = { base: 5n, lasna: 1n, unichain: 1n };

const SCAN_CONCURRENCY = 4;

function located(log: { blockNumber: bigint | null; transactionHash: Hex | null }): Located {
  if (log.blockNumber === null || log.transactionHash === null) {
    throw new Error("Pending log returned by RPC");
  }
  return { block: log.blockNumber, tx: log.transactionHash };
}

/** Sentinel stores the origin tx hash as uint256. */
function hashFromUint(value: bigint): Hex {
  return numberToHex(value, { size: 32 });
}

async function chunked<T>(
  lane: LaneId,
  from: bigint,
  to: bigint,
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
): Promise<T[]> {
  const step = LANES[lane].logChunk;
  const ranges: [bigint, bigint][] = [];
  for (let start = from; start <= to; start += step) {
    ranges.push([start, start + step - 1n < to ? start + step - 1n : to]);
  }
  // A few requests in flight at once: public RPCs throttle bursts, but serial scans are slow.
  const results: T[][] = new Array(ranges.length);
  let next = 0;
  async function worker() {
    while (next < ranges.length) {
      const i = next++;
      results[i] = await fetch(ranges[i][0], ranges[i][1]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, ranges.length) }, worker));
  return results.flat();
}

const statusChangedEvent = getAbiItem({ abi: depegSentinelAbi, name: "StatusChanged" });
const defendedEvent = getAbiItem({ abi: pegKeeperAbi, name: "Defended" });
const depegHandledEvent = getAbiItem({ abi: policyVaultAbi, name: "DepegHandled" });
const recoveredEvent = getAbiItem({ abi: policyVaultAbi, name: "Recovered" });

/** After this long, an epoch's destination events are final; stop re-querying them. */
const SETTLE_SECONDS = 180;
/** Destination search window around the origin block: generous enough for slow relays. */
const BASE_AFTER_BLOCKS = 900n; // 3 min of 200 ms blocks
const UNI_BEFORE_BLOCKS = 30n;
const UNI_AFTER_BLOCKS = 180n;

interface EpochEvents {
  defended: DefendedEvt[];
  handled: HandledEvt | null;
  recovered: RecoveredEvt | null;
  settled: boolean;
}

/**
 * The Lasna sentinel is the index: its StatusChanged log names each depeg epoch and the Base
 * origin block. Destination events are then fetched per epoch from a small block window, so a
 * refresh costs a handful of RPC calls instead of scanning a day of 200 ms Base blocks.
 */
export class LoopScanner {
  status: StatusEvt[] = [];
  private epochs = new Map<bigint, EpochEvents>();
  private nextLasna: bigint | undefined;

  get defended(): DefendedEvt[] {
    return [...this.epochs.values()].flatMap((e) => e.defended);
  }

  get handled(): HandledEvt[] {
    return [...this.epochs.values()].flatMap((e) => (e.handled ? [e.handled] : []));
  }

  get recovered(): RecoveredEvt[] {
    return [...this.epochs.values()].flatMap((e) => (e.recovered ? [e.recovered] : []));
  }

  async sync(): Promise<void> {
    await this.syncLasna();
    const open = this.status.filter((d) => d.to === 2 && !this.epochs.get(d.epoch)?.settled);
    await Promise.all(open.map((d) => this.syncEpoch(d)));
  }

  private async syncLasna(): Promise<void> {
    const head = await client("lasna").getBlockNumber();
    let from = this.nextLasna;
    if (from === undefined) {
      const windowStart = head - HISTORY_SECONDS * BLOCKS_PER_SECOND.lasna;
      from = windowStart > DEPLOY_BLOCKS.lasna ? windowStart : DEPLOY_BLOCKS.lasna;
    }
    if (from > head) return;
    const logs = await chunked("lasna", from, head, (fromBlock, toBlock) =>
      client("lasna").getLogs({ address: CONTRACTS.sentinel, event: statusChangedEvent, fromBlock, toBlock }),
    );
    for (const l of logs) {
      this.status.push({
        ...located(l),
        epoch: l.args.epoch ?? 0n,
        from: l.args.from ?? 0,
        to: l.args.to ?? 0,
        price: l.args.priceE18 ?? 0n,
        originBlock: l.args.originBlock ?? 0n,
        originTx: hashFromUint(l.args.originTxHash ?? 0n),
      });
    }
    this.nextLasna = head + 1n;
  }

  private async syncEpoch(d: StatusEvt): Promise<void> {
    const base = client("base");
    const uni = client("unichain");
    const [t0, baseHead, uniHeadBlock] = await Promise.all([
      blockTimestamp("base", d.originBlock),
      base.getBlockNumber(),
      uni.getBlock({ blockTag: "latest" }),
    ]);
    // Unichain makes one block per second, so the origin time maps to a block by offset from head.
    const uniHead = uniHeadBlock.number;
    const lagSeconds = BigInt(Math.max(0, Number(uniHeadBlock.timestamp) - t0));
    const uniOrigin = uniHead - lagSeconds;
    const uniFrom = uniOrigin - UNI_BEFORE_BLOCKS;
    const uniTo = uniOrigin + UNI_AFTER_BLOCKS < uniHead ? uniOrigin + UNI_AFTER_BLOCKS : uniHead;
    const baseTo = d.originBlock + BASE_AFTER_BLOCKS < baseHead ? d.originBlock + BASE_AFTER_BLOCKS : baseHead;
    const args = { epoch: d.epoch };
    const vault = CONTRACTS.vault;

    const [defended, handled, recovered] = await Promise.all([
      base.getLogs({ address: CONTRACTS.keeper, event: defendedEvent, args, fromBlock: d.originBlock, toBlock: baseTo }),
      uni.getLogs({ address: vault, event: depegHandledEvent, args, fromBlock: uniFrom, toBlock: uniTo }),
      uni.getLogs({ address: vault, event: recoveredEvent, args, fromBlock: uniFrom, toBlock: uniTo }),
    ]);
    const h = handled[0];
    const r = recovered[0];
    this.epochs.set(d.epoch, {
      defended: defended.map((l) => ({
        ...located(l),
        epoch: l.args.epoch ?? 0n,
        round: l.args.round ?? 0n,
        quoteIn: l.args.quoteIn ?? 0n,
        stableOut: l.args.stableOut ?? 0n,
        priceBefore: l.args.priceBeforeE18 ?? 0n,
        priceAfter: l.args.priceAfterE18 ?? 0n,
      })),
      handled: h
        ? { ...located(h), epoch: h.args.epoch ?? 0n, paidCount: h.args.paidCount ?? 0n, openRemaining: h.args.openRemaining ?? 0n }
        : null,
      recovered: r ? { ...located(r), epoch: r.args.epoch ?? 0n } : null,
      settled: Number(uniHeadBlock.timestamp) - t0 > SETTLE_SECONDS,
    });
  }
}

export type MarkKind = "origin" | "detect" | "defend" | "payout" | "recover" | "reopen";

export interface Mark {
  kind: MarkKind;
  lane: LaneId;
  label: string;
  tx: Hex;
  block: bigint;
  /** Seconds after the origin block, from block timestamps (1 s resolution). */
  seconds: number;
}

export interface Loop {
  epoch: bigint;
  depegPrice: bigint;
  originBlock: bigint;
  marks: Mark[];
  paidCount: bigint | null;
  restoredPrice: bigint | null;
}

/** Joins the three chains' events into one record per depeg epoch, newest first. */
export async function buildLoops(s: LoopScanner): Promise<Loop[]> {
  const depegs = s.status.filter((e) => e.to === 2);
  const loops = await Promise.all(
    depegs.map(async (d): Promise<Loop> => {
      const t0 = await blockTimestamp("base", d.originBlock);
      const at = async (lane: LaneId, block: bigint) => (await blockTimestamp(lane, block)) - t0;
      const marks: Mark[] = [
        { kind: "origin", lane: "base", label: "Dump swap", tx: d.originTx, block: d.originBlock, seconds: 0 },
        { kind: "detect", lane: "lasna", label: "Depeg confirmed", tx: d.tx, block: d.block, seconds: await at("lasna", d.block) },
      ];
      const defenses = s.defended.filter((e) => e.epoch === d.epoch).sort((a, b) => Number(a.round - b.round));
      for (const e of defenses) {
        marks.push({ kind: "defend", lane: "base", label: `Keeper round ${e.round}`, tx: e.tx, block: e.block, seconds: await at("base", e.block) });
      }
      const handled = s.handled.find((e) => e.epoch === d.epoch);
      if (handled) {
        marks.push({ kind: "payout", lane: "unichain", label: "Payout", tx: handled.tx, block: handled.block, seconds: await at("unichain", handled.block) });
      }
      const back = s.status.find((e) => e.epoch === d.epoch && e.to === 0);
      if (back) {
        marks.push({ kind: "recover", lane: "lasna", label: "Peg restored", tx: back.tx, block: back.block, seconds: await at("lasna", back.block) });
      }
      const reopened = s.recovered.find((e) => e.epoch === d.epoch);
      if (reopened) {
        marks.push({ kind: "reopen", lane: "unichain", label: "Vault reopened", tx: reopened.tx, block: reopened.block, seconds: await at("unichain", reopened.block) });
      }
      const last = defenses.at(-1);
      return {
        epoch: d.epoch,
        depegPrice: d.price,
        originBlock: d.originBlock,
        marks,
        paidCount: handled ? handled.paidCount : null,
        restoredPrice: back ? back.price : last ? last.priceAfter : null,
      };
    }),
  );
  return loops.sort((a, b) => Number(b.epoch - a.epoch));
}

export function markOf(loop: Loop, kind: MarkKind): Mark | undefined {
  return loop.marks.find((m) => m.kind === kind);
}
