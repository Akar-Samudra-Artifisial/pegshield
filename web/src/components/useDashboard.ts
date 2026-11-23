"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { type Loop, LoopScanner, buildLoops } from "@/lib/history";
import { type LiveState, readLive } from "@/lib/live";
import { errorMessage } from "@/lib/wallet";

const LIVE_MS = 4_000;
const HISTORY_MS = 10_000;
/** While a drill is in flight, poll fast so browser wall-clock marks are tight. */
const DRILL_MS = 750;
const DRILL_WATCH_MS = 90_000;

export interface Drill {
  tx: Hex;
  /** Epoch the drill is expected to open. */
  epoch: bigint;
  /** Browser wall-clock when the drill receipt arrived. */
  minedAt: number;
  /** First time this browser saw each mark kind, keyed by kind. */
  seen: Partial<Record<string, number>>;
}

export interface Dashboard {
  live: LiveState | null;
  liveError: string | null;
  loops: Loop[] | null;
  historyError: string | null;
  drill: Drill | null;
  refresh: () => void;
  startDrill: (tx: Hex, epoch: bigint, minedAt: number) => void;
}

export function useDashboard(): Dashboard {
  const [live, setLive] = useState<LiveState | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [loops, setLoops] = useState<Loop[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const scanner = useRef(new LoopScanner());
  const busy = useRef(false);
  const drillRef = useRef<Drill | null>(null);

  const pollLive = useCallback(async () => {
    try {
      setLive(await readLive());
      setLiveError(null);
    } catch (err) {
      setLiveError(errorMessage(err));
    }
  }, []);

  const pollHistory = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await scanner.current.sync();
      const next = await buildLoops(scanner.current);
      setLoops(next);
      setHistoryError(null);
      const d = drillRef.current;
      if (d) {
        const loop = next.find((l) => l.epoch === d.epoch);
        if (loop) {
          const now = Date.now();
          const seen = { ...d.seen };
          let changed = false;
          for (const m of loop.marks) {
            if (m.kind !== "origin" && seen[m.kind] === undefined) {
              seen[m.kind] = now;
              changed = true;
            }
          }
          if (changed) {
            const updated = { ...d, seen };
            drillRef.current = updated;
            setDrill(updated);
          }
        }
      }
    } catch (err) {
      setHistoryError(errorMessage(err));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void pollLive();
    void pollHistory();
    const a = setInterval(() => void pollLive(), LIVE_MS);
    const b = setInterval(() => {
      const d = drillRef.current;
      const fast = d !== null && Date.now() - d.minedAt < DRILL_WATCH_MS;
      if (!fast) void pollHistory();
    }, HISTORY_MS);
    const c = setInterval(() => {
      const d = drillRef.current;
      if (d !== null && Date.now() - d.minedAt < DRILL_WATCH_MS) {
        void pollHistory();
        void pollLive();
      }
    }, DRILL_MS);
    return () => {
      clearInterval(a);
      clearInterval(b);
      clearInterval(c);
    };
  }, [pollLive, pollHistory]);

  const startDrill = useCallback((tx: Hex, epoch: bigint, minedAt: number) => {
    const d: Drill = { tx, epoch, minedAt, seen: {} };
    drillRef.current = d;
    setDrill(d);
  }, []);

  const refresh = useCallback(() => {
    void pollLive();
    void pollHistory();
  }, [pollLive, pollHistory]);

  return { live, liveError, loops, historyError, drill, refresh, startDrill };
}
