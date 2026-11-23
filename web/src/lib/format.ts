import { formatUnits } from "viem";

/** 1e18-scaled price as "0.9712". */
export function price(value: bigint, digits = 4): string {
  return Number(formatUnits(value, 18)).toFixed(digits);
}

/** 18-decimal token amount with thousands separators. */
export function amount(value: bigint, digits = 0): string {
  return Number(formatUnits(value, 18)).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Signed seconds, e.g. "+2 s" / "−1 s". */
export function seconds(value: number): string {
  if (value === 0) return "0 s";
  return `${value > 0 ? "+" : "−"}${Math.abs(value)} s`;
}

export function wall(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
