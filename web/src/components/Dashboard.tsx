"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { CONTRACTS, LANES, type LaneId, addressUrl } from "@/lib/config";
import { seconds, shortHash } from "@/lib/format";
import { type AccountState, readAccount } from "@/lib/live";
import { errorMessage, requestAccount } from "@/lib/wallet";
import { CoverPanel } from "./CoverPanel";
import { DrillPanel } from "./DrillPanel";
import { LatencyStrip } from "./LatencyStrip";
import { LoopFlow } from "./LoopFlow";
import { LoopTable } from "./LoopTable";
import { PegStatus } from "./PegStatus";
import { useDashboard } from "./useDashboard";

const CONTRACT_ROWS: { name: string; job: string; lane: LaneId; address: Address }[] = [
  { name: "MockPair", job: "mSTB/mUSD pool", lane: "base", address: CONTRACTS.pair },
  { name: "PegKeeper", job: "Buys back on depeg", lane: "base", address: CONTRACTS.keeper },
  { name: "DepegDrill", job: "Test trigger", lane: "base", address: CONTRACTS.drill },
  { name: "DepegSentinel", job: "Reactive contract", lane: "lasna", address: CONTRACTS.sentinel },
  { name: "PolicyVault", job: "Sells and pays cover", lane: "unichain", address: CONTRACTS.vault },
];

export function Dashboard() {
  const { live, liveError, loops, historyError, drill, refresh, startDrill } = useDashboard();
  const [account, setAccount] = useState<Address | null>(null);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [selected, setSelected] = useState<bigint | null>(null);

  const loadAccount = useCallback(async (a: Address) => {
    try {
      setAccountState(await readAccount(a));
    } catch (err) {
      setWalletError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    if (!account) return;
    void loadAccount(account);
    const t = setInterval(() => void loadAccount(account), 8_000);
    return () => clearInterval(t);
  }, [account, loadAccount]);

  async function connect() {
    setWalletError(null);
    try {
      setAccount(await requestAccount());
    } catch (err) {
      setWalletError(errorMessage(err));
    }
  }

  // A drill pins its own epoch once mined; a row click or "Show latest" replaces the pick.
  const onMined = useCallback(
    (tx: Hex, epoch: bigint, minedAt: number) => {
      startDrill(tx, epoch, minedAt);
      setSelected(epoch);
    },
    [startDrill],
  );

  // Follow the newest loop unless one is picked (until a picked loop is indexed, show the newest).
  const loop = loops?.find((l) => l.epoch === selected) ?? loops?.[0] ?? null;
  const latest = loops?.[0] ?? null;
  const lastMark = loop?.marks.reduce((a, b) => (b.seconds > a.seconds ? b : a), loop.marks[0]) ?? null;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 1.5 17 4v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V4l7-2.5Z" />
            <path className="mark-line" d="M5.5 10.5h3l1.5-3 1.5 5 1.5-2h1.5" />
          </svg>
          <span className="brand-name">PegShield</span>
          <span className="muted small scope">Testnet · {LANES.base.label} · {LANES.lasna.label} · {LANES.unichain.label}</span>
        </div>
        {account ? (
          <span className="account num" title={account}>
            <span className="account-dot" aria-hidden="true" />
            {shortHash(account)}
          </span>
        ) : (
          <button type="button" className="btn btn-quiet" onClick={connect}>
            Connect wallet
          </button>
        )}
      </header>

      <main className="page">
        <div className="page-head">
          <div className="page-intro">
            <h1 className="title">Stablecoin depeg cover that pays out in seconds</h1>
            <p className="lede">
              One Reactive contract on Lasna watches a stablecoin pool on Base. When the price breaks, it defends the
              peg on Base and pays every insurance policy on Unichain, with no bot and no claim form.
            </p>
          </div>
          <a className="btn btn-link" href="#drill">
            Trigger a test depeg
          </a>
        </div>
        {walletError ? (
          <p className="note negative banner" role="alert">
            {walletError}
          </p>
        ) : null}

        <div className="overview">
          <PegStatus live={live} error={liveError} onRetry={refresh} />
          <LoopFlow live={live} loop={loop} isLatest={loop !== null && loop.epoch === latest?.epoch} />
        </div>

        <div className="layout">
          <div className="col-main">
            <section className="card" aria-labelledby="strip-title">
              <div className="card-head">
                <div>
                  <h2 id="strip-title" className="card-title">
                    {loop ? `Timeline of depeg ${loop.epoch}` : "Timeline of the latest depeg"}
                  </h2>
                  {loop && lastMark ? (
                    <p className="card-sub">
                      Whole loop done {seconds(lastMark.seconds)} after the swap, across three chains. Each mark links to
                      its transaction.
                    </p>
                  ) : null}
                </div>
                {loop && loop.epoch !== latest?.epoch ? (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setSelected(null)}>
                    Show latest
                  </button>
                ) : null}
              </div>
              {historyError && !loops ? (
                <div className="block-error" role="alert">
                  <p>Could not scan chain history: {historyError}</p>
                  <button type="button" className="btn btn-quiet" onClick={refresh}>
                    Retry
                  </button>
                </div>
              ) : loops === null ? (
                <div className="skeleton strip-skel" aria-label="Loading loop history" />
              ) : loop === null ? (
                <p className="empty">No depeg in the last 24 hours. Trigger a test depeg to watch the shield fire.</p>
              ) : (
                <LatencyStrip loop={loop} drill={drill} />
              )}
            </section>

            <section className="card" aria-labelledby="loops-title">
              <div className="card-head">
                <div>
                  <h2 id="loops-title" className="card-title">
                    Every depeg in the last 24 hours
                  </h2>
                  <p className="card-sub">Seconds after the swap, block time. Select a row to draw its timeline above.</p>
                </div>
                {historyError && loops ? <span className="small negative">Refresh failed, retrying</span> : null}
              </div>
              {loops === null ? (
                <div className="skeleton table-skel" aria-label="Loading loops" />
              ) : loops.length === 0 ? (
                <p className="empty">Nothing yet. Each test depeg adds one row with its latency per chain.</p>
              ) : (
                <LoopTable loops={loops} selected={loop?.epoch ?? null} onSelect={setSelected} />
              )}
            </section>
          </div>

          <aside className="col-side" aria-label="Try it">
            <DrillPanel
              account={account}
              baseEth={accountState?.baseEth ?? null}
              live={live}
              loops={loops}
              onConnect={connect}
              onMined={onMined}
            />
            <CoverPanel
              account={account}
              state={accountState}
              live={live}
              onConnect={connect}
              onDone={() => account && void loadAccount(account)}
            />
            <section className="card" aria-labelledby="contracts-title">
              <h2 id="contracts-title" className="card-title">
                Contracts on testnet
              </h2>
              <ul className="list contracts">
                {CONTRACT_ROWS.map((c) => (
                  <li key={c.name}>
                    <span className="contract-name">
                      {c.name}
                      <span className="muted small">{c.job}</span>
                    </span>
                    <span className={`chain chain-${c.lane}`}>{LANES[c.lane].label.split(" ")[0]}</span>
                    <a className="num" href={addressUrl(c.lane, c.address)} target="_blank" rel="noreferrer">
                      {shortHash(c.address)}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}
