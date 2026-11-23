import type { LaneId } from "./config";
import type { MarkKind } from "./history";

/**
 * Wall-clock latency of the full loop, seconds after the origin swap was mined.
 * Copied from docs/depeg-bench-2026-11-23.txt (summary over 10 loops, 0 incomplete).
 */
export const BENCH = {
  date: "2026-11-23",
  runs: 10,
  source: "https://github.com/Akar-Samudra-Artifisial/pegshield/blob/main/docs/depeg-bench-2026-11-23.txt",
  stages: [
    { kind: "detect", lane: "lasna", label: "Depeg confirmed", p50: 1.65, p95: 1.78 },
    { kind: "defend", lane: "base", label: "Keeper buys back", p50: 1.99, p95: 2.1 },
    { kind: "payout", lane: "unichain", label: "Policies paid", p50: 2.83, p95: 4.74 },
    { kind: "reopen", lane: "unichain", label: "Vault reopened", p50: 3.74, p95: 5.55 },
  ],
} as const satisfies {
  date: string;
  runs: number;
  source: string;
  stages: readonly { kind: MarkKind; lane: LaneId; label: string; p50: number; p95: number }[];
};

export type BenchStage = (typeof BENCH.stages)[number];
