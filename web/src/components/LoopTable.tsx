import { type Loop, type MarkKind, markOf } from "@/lib/history";
import { txUrl } from "@/lib/config";
import { price, seconds, shortHash } from "@/lib/format";

interface Props {
  loops: Loop[];
  selected: bigint | null;
  onSelect: (epoch: bigint) => void;
}

function cell(loop: Loop, kind: MarkKind) {
  const m = markOf(loop, kind);
  return m ? <span className="num">{seconds(m.seconds)}</span> : <span className="muted">Waiting</span>;
}

export function LoopTable({ loops, selected, onSelect }: Props) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Depeg loops in the last 24 hours, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Depeg</th>
            <th scope="col" className="r col-opt">Low price</th>
            <th scope="col" className="r">
              Confirmed <span className="th-chain">Lasna</span>
            </th>
            <th scope="col" className="r">
              Keeper <span className="th-chain">Base</span>
            </th>
            <th scope="col" className="r">
              Payout <span className="th-chain">Unichain</span>
            </th>
            <th scope="col" className="r">
              Peg restored <span className="th-chain">Lasna</span>
            </th>
            <th scope="col" className="r col-opt">Policies paid</th>
            <th scope="col" className="col-opt">Swap tx</th>
          </tr>
        </thead>
        <tbody>
          {loops.map((loop) => {
            const active = loop.epoch === selected;
            return (
              <tr key={loop.epoch.toString()} className={active ? "active" : undefined}>
                <th scope="row">
                  <button
                    type="button"
                    className="row-select"
                    aria-pressed={active}
                    onClick={() => onSelect(loop.epoch)}
                  >
                    Epoch {loop.epoch.toString()}
                  </button>
                </th>
                <td className="r num col-opt">{price(loop.depegPrice)}</td>
                <td className="r">{cell(loop, "detect")}</td>
                <td className="r">{cell(loop, "defend")}</td>
                <td className="r">{cell(loop, "payout")}</td>
                <td className="r">{cell(loop, "recover")}</td>
                <td className="r num col-opt">{loop.paidCount === null ? "–" : loop.paidCount.toString()}</td>
                <td className="col-opt">
                  <a className="num" href={txUrl("base", loop.marks[0].tx)} target="_blank" rel="noreferrer">
                    {shortHash(loop.marks[0].tx)}
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
