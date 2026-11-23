"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { CONTRACTS, type LaneId, addressUrl } from "@/lib/config";
import { amount, ago, price, shortHash } from "@/lib/format";
import { STATUS } from "@/lib/history";
import { type AccountState, readAccount } from "@/lib/live";
import { errorMessage, requestAccount } from "@/lib/wallet";
import { CoverPanel } from "./CoverPanel";
import { DrillPanel } from "./DrillPanel";
import { LatencyStrip } from "./LatencyStrip";
import { LoopTable } from "./LoopTable";
import { useDashboard } from "./useDashboard";

const PILL = ["positive", "warning", "negative"] as const;

const CONTRACT_ROWS: { name: string; lane: LaneId; address: Address }[] = [
  { name: "MockPair (mSTB/mUSD)", lane: "base", address: CONTRACTS.pair },
  { name: "PegKeeper", lane: "base", address: CONTRACTS.keeper },
  { name: "DepegDrill", lane: "base", address: CONTRACTS.drill },
  { name: "DepegSentinel", lane: "lasna", address: CONTRACTS.sentinel },
  { name: "PolicyVault", lane: "unichain", address: CONTRACTS.vault },
];

const LANE_SHORT: Record<LaneId, string> = { base: "Base", lasna: "Lasna", unichain: "Unichain" };

export function Dashboard() {
  const { live, liveError, loops, historyError, drill, refresh, startDrill } = useDashboard();
  const [account, setAccount] = useState<Address | null>(null);
  const [accountState, setAccountState] = useState<AccountState | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [selected, setSelected] = useState<bigint | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

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

  // Follow the newest loop unless the user picked one; a drill always jumps to its own loop.
  const shownEpoch = drill && loops?.some((l) => l.epoch === drill.epoch) ? drill.epoch : selected;
  const loop = loops?.find((l) => l.epoch === shownEpoch) ?? loops?.[0] ?? null;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span className="brand-name">PegShield</span>
          <span className="muted small scope">Testnet · Base Sepolia → Reactive Lasna → Unichain Sepolia</span>
        </div>
        {account ? (
          <span className="account num" title={account}>
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
          <h1 className="title">Peg monitor</h1>
          <p className="muted">
            One reactive contract on Lasna watches the Base pool, then pays cover on Unichain and defends the peg on
            Base.
          </p>
        </div>
        {walletError ? (
          <p className="note negative banner" role="alert">
            {walletError}
          </p>
        ) : null}

        <section className="kpis" aria-label="Live state">
          {liveError && !live ? (
            <div className="block-error" role="alert">
              <p>Could not read the contracts: {liveError}</p>
              <button type="button" className="btn btn-quiet" onClick={refresh}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <Kpi label="Pool price, mUSD per mSTB" value={live ? price(live.poolPrice) : null} />
              <div className="kpi">
                <span className="kpi-label">Sentinel</span>
                {live ? (
                  <span className="kpi-value">
                    <span className={`pill ${PILL[live.status] ?? "neutral"}`}>{STATUS[live.status] ?? "Unknown"}</span>
                    {live.status === 1 ? (
                      <span className="muted small num">
                        {" "}
                        {live.belowCount.toString()} of {live.confirmations.toString()} below {price(live.watchPrice, 2)}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="skeleton kpi-skel" />
                )}
              </div>
              <Kpi label="Depegs handled" value={live ? live.epoch.toString() : null} />
              <Kpi label="Vault free capacity, mUSD" value={live ? amount(live.vaultFree) : null} />
              <Kpi label="Keeper treasury, mUSD" value={live ? amount(live.keeperTreasury) : null} />
            </>
          )}
        </section>

        <div className="layout">
          <div className="col-main">
            <section className="card" aria-labelledby="strip-title">
              <div className="card-head">
                <h2 id="strip-title" className="card-title">
                  {loop ? `Loop of epoch ${loop.epoch}` : "Latest loop"}
                </h2>
                {live ? <span className="muted small">Read {ago(live.readAt, now)}</span> : null}
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
                <p className="empty">No depeg in the last 24 hours. Run a drill to watch the shield fire.</p>
              ) : (
                <LatencyStrip loop={loop} drill={drill} />
              )}
            </section>

            <section className="card" aria-labelledby="loops-title">
              <div className="card-head">
                <h2 id="loops-title" className="card-title">Depeg loops, last 24 hours</h2>
                {historyError && loops ? <span className="small negative">Refresh failed, retrying</span> : null}
              </div>
              {loops === null ? (
                <div className="skeleton table-skel" aria-label="Loading loops" />
              ) : loops.length === 0 ? (
                <p className="empty">Nothing yet. Each drill adds one row with its latency per chain.</p>
              ) : (
                <LoopTable loops={loops} selected={loop?.epoch ?? null} onSelect={setSelected} />
              )}
            </section>
          </div>

          <aside className="col-side" aria-label="Actions">
            <DrillPanel
              account={account}
              baseEth={accountState?.baseEth ?? null}
              live={live}
              onConnect={connect}
              onMined={startDrill}
            />
            <CoverPanel
              account={account}
              state={accountState}
              live={live}
              onConnect={connect}
              onDone={() => account && void loadAccount(account)}
            />
            <section className="card" aria-labelledby="contracts-title">
              <h2 id="contracts-title" className="card-title">Contracts</h2>
              <ul className="list">
                {CONTRACT_ROWS.map((c) => (
                  <li key={c.name}>
                    <span>{c.name}</span>
                    <span className="muted small">{LANE_SHORT[c.lane]}</span>
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

function Kpi({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      {value === null ? <span className="skeleton kpi-skel" /> : <span className="kpi-value num">{value}</span>}
    </div>
  );
}
