import { formatUnits } from "viem";
import { amount, price } from "@/lib/format";
import { STATUS } from "@/lib/history";
import type { LiveState } from "@/lib/live";
import { Ago } from "./Ago";

const TONE = ["positive", "warning", "negative"] as const;

interface Props {
  live: LiveState | null;
  error: string | null;
  onRetry: () => void;
}

function toNumber(v: bigint): number {
  return Number(formatUnits(v, 18));
}

function explain(live: LiveState, watch: string, recover: string): string {
  if (live.status === 2) {
    return `Depeg confirmed. The keeper is buying back and cover is closed until the price is ${recover} or above.`;
  }
  if (live.status === 1) {
    return `${live.confirmations} pool Syncs in a row below ${watch} confirm a depeg. ${live.belowCount} of ${live.confirmations} so far.`;
  }
  return `Price is above ${watch}. Cover is on sale and the sentinel is watching every swap.`;
}

/** Live pool price on a scale with the sentinel's two thresholds drawn in. */
export function PegStatus({ live, error, onRetry }: Props) {
  return (
    <section className="card peg-card" aria-labelledby="peg-title">
      <div className="card-head">
        <h2 id="peg-title" className="card-title">
          Peg status, mSTB in mUSD
        </h2>
        {live ? <Ago ts={live.readAt} prefix="Read " className="muted small" /> : null}
      </div>
      {error && !live ? (
        <div className="block-error" role="alert">
          <p>Could not read the contracts: {error}</p>
          <button type="button" className="btn btn-quiet" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : live === null ? (
        <div className="peg-skel" aria-label="Loading pool price">
          <span className="skeleton skel-price" />
          <span className="skeleton skel-line" />
          <span className="skeleton skel-block" />
        </div>
      ) : (
        <PegBody live={live} />
      )}
    </section>
  );
}

function PegBody({ live }: { live: LiveState }) {
  const p = toNumber(live.poolPrice);
  const watch = toNumber(live.watchPrice);
  const recover = toNumber(live.recoverPrice);
  const lo = Math.min(0.88, Math.floor((p - 0.01) * 100) / 100);
  const hi = Math.max(1.02, Math.ceil((p + 0.01) * 100) / 100);
  const pos = (v: number) => `${((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100}%`;
  const watchLabel = price(live.watchPrice, 2);
  const recoverLabel = price(live.recoverPrice, 2);
  const tone = TONE[live.status] ?? "neutral";

  return (
    <>
      <div className="peg-head">
        <span className="peg-price num">{price(live.poolPrice)}</span>
        <span className={`pill ${tone}`} aria-live="polite">
          {STATUS[live.status] ?? "Unknown"}
        </span>
      </div>
      <p className="peg-explain" aria-live="polite">
        {explain(live, watchLabel, recoverLabel)}
      </p>

      <figure
        className="gauge"
        aria-label={`Pool price ${price(live.poolPrice)}. Depeg below ${watchLabel}, recovered at ${recoverLabel}.`}
      >
        <div className="gauge-track">
          <span className="gauge-zone zone-negative" style={{ left: 0, width: pos(watch) }} />
          <span
            className="gauge-zone zone-warning"
            style={{ left: pos(watch), width: `calc(${pos(recover)} - ${pos(watch)})` }}
          />
          <span className="gauge-zone zone-positive" style={{ left: pos(recover), right: 0 }} />
          <span className="gauge-threshold" style={{ left: pos(watch) }} />
          <span className="gauge-threshold" style={{ left: pos(recover) }} />
          <span className={`gauge-needle ${tone}`} style={{ left: pos(p) }} />
        </div>
        <div className="gauge-axis" aria-hidden="true">
          <span className="num" style={{ left: 0 }}>
            {lo.toFixed(2)}
          </span>
          <span className="num" style={{ left: pos(watch) }}>
            {watchLabel}
          </span>
          <span className="num" style={{ left: pos(recover) }}>
            {recoverLabel}
          </span>
          <span className="num" style={{ left: "100%" }}>
            {hi.toFixed(2)}
          </span>
        </div>
        <figcaption className="gauge-legend small">
          <span>
            <i className="key key-negative" aria-hidden="true" />
            Depeg under {watchLabel} for {live.confirmations.toString()} Syncs
          </span>
          <span>
            <i className="key key-positive" aria-hidden="true" />
            Recovered at {recoverLabel}
          </span>
        </figcaption>
      </figure>

      <dl className="facts facts-grid">
        <div>
          <dt>Depegs handled</dt>
          <dd className="num">{live.epoch.toString()}</dd>
        </div>
        <div>
          <dt>Cover</dt>
          <dd className={live.depegActive ? "negative" : "positive"}>{live.depegActive ? "Closed" : "On sale"}</dd>
        </div>
        <div>
          <dt>Vault free, mUSD</dt>
          <dd className="num">{amount(live.vaultFree)}</dd>
        </div>
        <div>
          <dt>Keeper treasury, mUSD</dt>
          <dd className="num">{amount(live.keeperTreasury)}</dd>
        </div>
      </dl>
    </>
  );
}
