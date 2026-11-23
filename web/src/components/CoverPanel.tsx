"use client";

import { useId, useState } from "react";
import { type Address, type Hex, maxUint256, parseUnits } from "viem";
import { mockTokenAbi } from "@/abi/MockToken";
import { policyVaultAbi } from "@/abi/PolicyVault";
import { client } from "@/lib/clients";
import { CONTRACTS, LANES, txUrl } from "@/lib/config";
import { amount, shortHash } from "@/lib/format";
import type { AccountState, LiveState } from "@/lib/live";
import { errorMessage, walletFor } from "@/lib/wallet";
import { type StepItem, type StepState, Steps } from "./Steps";

const FAUCET_AMOUNT = 10_000n * 10n ** 18n;

type Stage = "idle" | "mint" | "approve" | "buy" | "done";
const ORDER: Stage[] = ["mint", "approve", "buy", "done"];

interface Props {
  account: Address | null;
  state: AccountState | null;
  live: LiveState | null;
  onConnect: () => void;
  onDone: () => void;
}

function parseCoverage(raw: string): bigint | null {
  if (!/^\d+(\.\d{0,18})?$/.test(raw.trim())) return null;
  const v = parseUnits(raw.trim(), 18);
  return v > 0n ? v : null;
}

export function CoverPanel({ account, state, live, onConnect, onDone }: Props) {
  const inputId = useId();
  const [raw, setRaw] = useState("1000");
  const [stage, setStage] = useState<Stage>("idle");
  const [plan, setPlan] = useState<{ mint: boolean; approve: boolean } | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);

  const coverage = parseCoverage(raw);
  const premium = coverage !== null && live ? (coverage * live.premiumBps) / 10_000n : null;
  const days = live ? Number(live.term) / 86_400 : null;
  const overCapacity = coverage !== null && live !== null && coverage > live.vaultFree + (premium ?? 0n);
  const needMint = state !== null && premium !== null && state.usdBalance < premium;
  const needApprove = state !== null && premium !== null && state.allowance < premium;

  let blocked: string | null = null;
  if (coverage === null) blocked = "Enter a coverage amount in mUSD, for example 1000.";
  else if (live?.depegActive) blocked = "Cover is closed while a depeg is active. It reopens when the peg recovers.";
  else if (overCapacity && live) blocked = `The vault can cover at most ${amount(live.vaultFree)} mUSD right now.`;

  async function buy() {
    if (!account || !state || coverage === null || premium === null) return;
    setError(null);
    setTx(null);
    setPlan({ mint: state.usdBalance < premium, approve: state.allowance < premium });
    try {
      const wallet = await walletFor("unichain", account);
      const uni = client("unichain");
      const chain = LANES.unichain.chain;
      if (state.usdBalance < premium) {
        setStage("mint");
        const h = await wallet.writeContract({
          address: CONTRACTS.mockUsdUnichain,
          abi: mockTokenAbi,
          functionName: "mint",
          args: [account, FAUCET_AMOUNT],
          account,
          chain,
        });
        await uni.waitForTransactionReceipt({ hash: h });
      }
      if (state.allowance < premium) {
        setStage("approve");
        const h = await wallet.writeContract({
          address: CONTRACTS.mockUsdUnichain,
          abi: mockTokenAbi,
          functionName: "approve",
          args: [CONTRACTS.vault, maxUint256],
          account,
          chain,
        });
        await uni.waitForTransactionReceipt({ hash: h });
      }
      setStage("buy");
      const h = await wallet.writeContract({
        address: CONTRACTS.vault,
        abi: policyVaultAbi,
        functionName: "buyPolicy",
        args: [coverage],
        account,
        chain,
      });
      setTx(h);
      const receipt = await uni.waitForTransactionReceipt({ hash: h });
      if (receipt.status !== "success") throw new Error("buyPolicy reverted on Unichain Sepolia.");
      setStage("done");
      onDone();
    } catch (err) {
      setStage("idle");
      setError(errorMessage(err));
    }
  }

  const working = stage === "mint" || stage === "approve" || stage === "buy";
  const mint = plan && stage !== "idle" ? plan.mint : needMint;
  const approve = plan && stage !== "idle" ? plan.approve : needApprove;

  function stateOf(s: Stage, needed: boolean): StepState {
    if (!needed) return "skip";
    if (stage === "idle") return "todo";
    const at = ORDER.indexOf(stage);
    const me = ORDER.indexOf(s);
    return at > me ? "done" : at === me ? "current" : "todo";
  }

  const items: StepItem[] = [
    {
      label: "Mint 10,000 test mUSD",
      state: stateOf("mint", mint),
      detail: !mint ? "Not needed, you hold enough" : null,
    },
    {
      label: "Approve the vault to take the premium",
      state: stateOf("approve", approve),
      detail: !approve ? "Already approved" : null,
    },
    {
      label: "Buy the policy",
      state: stateOf("buy", true),
      detail: tx ? (
        <a className="num" href={txUrl("unichain", tx)} target="_blank" rel="noreferrer">
          {shortHash(tx)}
        </a>
      ) : null,
    },
  ];

  const label =
    stage === "mint"
      ? "Minting test mUSD…"
      : stage === "approve"
        ? "Approving the vault…"
        : stage === "buy"
          ? "Buying the policy…"
          : "Buy cover";

  return (
    <section className="card" aria-labelledby="cover-title">
      <div className="card-head">
        <h2 id="cover-title" className="card-title">
          Buy depeg cover
        </h2>
        <span className="muted small">Unichain Sepolia</span>
      </div>
      <p className="card-text">
        The full coverage is paid to you on Unichain the moment the sentinel confirms a depeg. No claim to file.
      </p>
      <div className="field">
        <label htmlFor={inputId}>Coverage, mUSD</label>
        <input
          id={inputId}
          inputMode="decimal"
          autoComplete="off"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-invalid={coverage === null}
          aria-describedby={`${inputId}-hint`}
        />
      </div>
      <dl className="facts" id={`${inputId}-hint`}>
        <div>
          <dt>Premium{live ? `, ${Number(live.premiumBps) / 100}%` : ""}</dt>
          <dd className="num">{premium === null ? "–" : `${amount(premium, 2)} mUSD`}</dd>
        </div>
        <div>
          <dt>Term</dt>
          <dd className="num">{days === null ? "–" : `${days} days`}</dd>
        </div>
        <div>
          <dt>Your mUSD on Unichain</dt>
          <dd className="num">{state ? amount(state.usdBalance, 2) : "–"}</dd>
        </div>
      </dl>
      {account !== null ? <Steps items={items} label="Cover purchase progress" /> : null}
      {account === null ? (
        <button type="button" className="btn btn-quiet" onClick={onConnect}>
          Connect wallet
        </button>
      ) : (
        <button type="button" className="btn btn-quiet" onClick={buy} disabled={blocked !== null || working || state === null}>
          {label}
        </button>
      )}
      {account !== null && blocked ? <p className="note warning">{blocked}</p> : null}
      {stage === "done" ? (
        <p className="note positive" role="status">
          Policy bought. It pays out automatically on the next depeg.
        </p>
      ) : null}
      {error ? (
        <p className="note negative" role="alert">
          {error}
        </p>
      ) : null}
      {state && state.openPolicies.length > 0 ? (
        <div className="mine">
          <h3 className="sub-title">Your open policies</h3>
          <ul className="list">
            {state.openPolicies.map((p) => (
              <li key={p.id.toString()}>
                <span>Policy {p.id.toString()}</span>
                <span className="num">{amount(p.coverage)} mUSD</span>
                <span className="muted small num">until {new Date(p.expiry * 1000).toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
