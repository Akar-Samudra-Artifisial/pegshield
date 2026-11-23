"use client";

import { useId, useState } from "react";
import { type Address, maxUint256, parseUnits } from "viem";
import { mockTokenAbi } from "@/abi/MockToken";
import { policyVaultAbi } from "@/abi/PolicyVault";
import { client } from "@/lib/clients";
import { CONTRACTS, LANES } from "@/lib/config";
import { amount } from "@/lib/format";
import type { AccountState, LiveState } from "@/lib/live";
import { errorMessage, walletFor } from "@/lib/wallet";

const FAUCET_AMOUNT = 10_000n * 10n ** 18n;

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
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const coverage = parseCoverage(raw);
  const premium = coverage !== null && live ? (coverage * live.premiumBps) / 10_000n : null;
  const days = live ? Number(live.term) / 86_400 : null;
  const overCapacity = coverage !== null && live !== null && coverage > live.vaultFree + (premium ?? 0n);

  let blocked: string | null = null;
  if (coverage === null) blocked = "Enter a coverage amount in mUSD.";
  else if (live?.depegActive) blocked = "Cover is closed while a depeg is active. It reopens when the peg recovers.";
  else if (overCapacity && live) blocked = `The vault can cover at most ${amount(live.vaultFree)} mUSD right now.`;

  async function buy() {
    if (!account || !state || coverage === null || premium === null) return;
    setError(null);
    try {
      const wallet = await walletFor("unichain", account);
      const uni = client("unichain");
      const chain = LANES.unichain.chain;
      if (state.usdBalance < premium) {
        setProgress("Minting test mUSD…");
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
        setProgress("Approving the vault…");
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
      setProgress("Buying the policy…");
      const h = await wallet.writeContract({
        address: CONTRACTS.vault,
        abi: policyVaultAbi,
        functionName: "buyPolicy",
        args: [coverage],
        account,
        chain,
      });
      const receipt = await uni.waitForTransactionReceipt({ hash: h });
      if (receipt.status !== "success") throw new Error("buyPolicy reverted on Unichain Sepolia.");
      setProgress("Policy bought. It pays out automatically on the next depeg.");
      onDone();
    } catch (err) {
      setProgress(null);
      setError(errorMessage(err));
    }
  }

  const working = progress !== null && progress.endsWith("…");

  return (
    <section className="card" aria-labelledby="cover-title">
      <h2 id="cover-title" className="card-title">Buy depeg cover</h2>
      <p className="card-text">
        Pays the full coverage in mUSD on Unichain the moment the sentinel confirms a depeg. No claim to file.
      </p>
      <div className="field">
        <label htmlFor={inputId}>Coverage (mUSD)</label>
        <input
          id={inputId}
          inputMode="decimal"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          aria-invalid={coverage === null}
          aria-describedby={`${inputId}-hint`}
        />
      </div>
      <dl className="facts" id={`${inputId}-hint`}>
        <div>
          <dt>Premium {live ? `(${Number(live.premiumBps) / 100}%)` : ""}</dt>
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
      {account === null ? (
        <button type="button" className="btn" onClick={onConnect}>
          Connect wallet to buy cover
        </button>
      ) : (
        <button type="button" className="btn" onClick={buy} disabled={blocked !== null || working || state === null}>
          {working ? progress : "Buy cover"}
        </button>
      )}
      {account !== null && blocked ? <p className="note">{blocked}</p> : null}
      {account !== null && state && premium !== null && state.usdBalance < premium ? (
        <p className="note">You hold too little test mUSD, so the first step mints 10,000 from the public faucet.</p>
      ) : null}
      {progress && !working ? (
        <p className="note positive" role="status">
          {progress}
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
                <span className="muted small">until {new Date(p.expiry * 1000).toLocaleDateString("en-GB")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
