import type { Loop, Mark } from "@/lib/history";
import { LANES, type LaneId, txUrl } from "@/lib/config";
import { seconds, wall } from "@/lib/format";
import type { Drill } from "./useDashboard";

const LANE_ORDER: LaneId[] = ["base", "lasna", "unichain"];

interface Props {
  loop: Loop;
  drill: Drill | null;
}

/**
 * Three lanes, one per chain, with a mark at the second each step landed on-chain,
 * measured from the origin swap's block timestamp.
 */
export function LatencyStrip({ loop, drill }: Props) {
  const values = loop.marks.map((m) => m.seconds);
  const min = Math.min(0, ...values);
  const max = Math.max(8, ...values.map((v) => v + 1));
  const span = max - min;
  const pos = (s: number) => `${((s - min) / span) * 100}%`;
  const ticks: number[] = [];
  for (let s = Math.ceil(min); s <= max; s += span > 16 ? 4 : 2) ticks.push(s);
  const measured = drill && drill.epoch === loop.epoch ? drill : null;

  return (
    <figure className="strip" aria-label={`Latency of depeg loop ${loop.epoch}`}>
      {LANE_ORDER.map((lane) => {
        const marks = loop.marks.filter((m) => m.lane === lane);
        return (
          <div className="strip-lane" key={lane}>
            <div className="strip-name">
              <span>{LANES[lane].label}</span>
              <span className="muted small">{LANES[lane].role}</span>
            </div>
            <ol className="strip-track">
              {marks.map((m, i) => (
                <MarkPoint key={`${m.kind}-${m.tx}`} mark={m} left={pos(m.seconds)} below={i % 2 === 1} wallMs={wallOf(measured, m)} />
              ))}
            </ol>
          </div>
        );
      })}
      <div className="strip-lane strip-axis" aria-hidden="true">
        <div className="strip-name muted small">Seconds after swap</div>
        <div className="strip-track">
          {ticks.map((t) => (
            <span key={t} className="strip-tick" style={{ left: pos(t) }}>
              {t}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="muted small strip-caption">
        <span>
          <i className="key key-origin" aria-hidden="true" />
          Swap
        </span>
        <span>
          <i className="key key-act" aria-hidden="true" />
          Sentinel, keeper and payout
        </span>
        <span>
          <i className="key key-positive" aria-hidden="true" />
          Peg restored, vault reopened
        </span>
        <span className="strip-caption-note">
          Block timestamps, 1 s resolution. Each chain keeps its own clock, so a Lasna mark can read up to about 1 s
          early against Base.{measured ? " In brackets: wall-clock seen by this browser since your drill was mined." : ""}
        </span>
      </figcaption>
    </figure>
  );
}

function wallOf(drill: Drill | null, mark: Mark): number | null {
  if (!drill) return null;
  const at = drill.seen[mark.kind];
  return at === undefined ? null : at - drill.minedAt;
}

function MarkPoint({ mark, left, below, wallMs }: { mark: Mark; left: string; below: boolean; wallMs: number | null }) {
  return (
    <li className={`strip-mark kind-${mark.kind}${below ? " below" : ""}`} style={{ left }}>
      <a href={txUrl(mark.lane, mark.tx)} target="_blank" rel="noreferrer" className="strip-link">
        <span className="strip-dot" aria-hidden="true" />
        <span className="strip-label">
          {mark.label} <span className="num">{seconds(mark.seconds)}</span>
          {wallMs !== null ? <span className="num muted"> ({wall(wallMs)})</span> : null}
        </span>
      </a>
    </li>
  );
}
