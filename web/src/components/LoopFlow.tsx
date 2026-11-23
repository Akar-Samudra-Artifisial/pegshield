import { BENCH } from "@/lib/bench";
import { LANES, type LaneId } from "@/lib/config";
import { price, seconds } from "@/lib/format";
import { type Loop, type MarkKind, markOf } from "@/lib/history";
import type { LiveState } from "@/lib/live";

interface Props {
  live: LiveState | null;
  /** The loop picked in the table (the newest by default). */
  loop: Loop | null;
  isLatest: boolean;
}

interface Step {
  kind: MarkKind;
  lane: LaneId;
  title: string;
  text: string;
}

/** Bars share one scale so the steps read as one timeline. */
const SCALE_S = 6;

/**
 * The loop as five steps across three chains, each with its measured latency:
 * bench p50 and p95 (wall clock), plus the newest on-chain loop (block time).
 */
export function LoopFlow({ live, loop, isLatest }: Props) {
  const loopLabel = loop ? `${isLatest ? "Latest, epoch" : "Epoch"} ${loop.epoch.toString()}` : null;
  const watch = live ? price(live.watchPrice, 2) : "0.97";
  const recover = live ? price(live.recoverPrice, 2) : "0.99";
  const confirmations = live ? live.confirmations.toString() : "3";

  const steps: Step[] = [
    {
      kind: "origin",
      lane: "base",
      title: "Swap breaks the peg",
      text: `A large sell pushes the mSTB pool price under ${watch}.`,
    },
    {
      kind: "detect",
      lane: "lasna",
      title: "Sentinel confirms",
      text: `DepegSentinel reads every pool Sync. ${confirmations} in a row under ${watch} confirm a depeg and fire two callbacks.`,
    },
    {
      kind: "defend",
      lane: "base",
      title: "Keeper buys back",
      text: "PegKeeper spends its treasury to buy mSTB and pull the price back up.",
    },
    {
      kind: "payout",
      lane: "unichain",
      title: "Policies paid",
      text: "PolicyVault pays every open policy in full. Nobody files a claim.",
    },
    {
      kind: "reopen",
      lane: "unichain",
      title: "Cover reopens",
      text: `Once the price is back at ${recover} or above, the sentinel returns to Normal and the vault sells cover again.`,
    },
  ];

  return (
    <section className="card flow-card" aria-labelledby="flow-title">
      <div className="card-head">
        <h2 id="flow-title" className="card-title">
          How a depeg is handled, and how fast
        </h2>
        <a className="small" href={BENCH.source} target="_blank" rel="noreferrer">
          Bench log, {BENCH.runs} runs
        </a>
      </div>
      <ol className="flow">
        {steps.map((step) => {
          const bench = BENCH.stages.find((s) => s.kind === step.kind);
          const mark = loop ? markOf(loop, step.kind) : undefined;
          return (
            <li key={step.kind} className="flow-step">
              <span className={`chain chain-${step.lane}`}>{LANES[step.lane].label}</span>
              <h3 className="flow-title">{step.title}</h3>
              <p className="flow-text">{step.text}</p>
              <div className="flow-figure">
                {bench ? (
                  <>
                    <span className="flow-value num">{bench.p50.toFixed(2)} s</span>
                    <span className="muted small num">p95 {bench.p95.toFixed(2)} s</span>
                  </>
                ) : (
                  <>
                    <span className="flow-value num">0 s</span>
                    <span className="muted small">Clock starts</span>
                  </>
                )}
              </div>
              <div
                className="flow-bar"
                aria-hidden="true"
                style={
                  {
                    "--p50": `${((bench?.p50 ?? 0) / SCALE_S) * 100}%`,
                    "--p95": `${((bench?.p95 ?? 0) / SCALE_S) * 100}%`,
                  } as React.CSSProperties
                }
              >
                <span className="flow-bar-p95" />
                <span className="flow-bar-p50" />
              </div>
              <p className="flow-latest small">
                {loopLabel === null ? (
                  <span className="muted">Latest loop: –</span>
                ) : mark ? (
                  <>
                    <span className="muted">{loopLabel}: </span>
                    <span className="num">{seconds(mark.seconds)}</span>
                  </>
                ) : (
                  <span className="muted">{loopLabel}: waiting</span>
                )}
              </p>
            </li>
          );
        })}
      </ol>
      <p className="muted small flow-note">
        Big figure: median wall-clock seconds after the swap was mined, over {BENCH.runs} drills on {BENCH.date}.
        Bars run 0 to {SCALE_S} s; the pale extension reaches p95. The line under each bar is the loop selected in the table (the latest by default), in block timestamps
        (1 s resolution).
      </p>
    </section>
  );
}
