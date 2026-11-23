"use client";

import { useState } from "react";
import { type Address, type Hex, formatEther } from "viem";
import { depegDrillAbi } from "@/abi/DepegDrill";
import { client } from "@/lib/clients";
import { CONTRACTS, DRILL_AMOUNT, DRILL_DUMPS, LANES, txUrl } from "@/lib/config";
import { amount, shortHash } from "@/lib/format";
import type { LiveState } from "@/lib/live";
import { errorMessage, walletFor } from "@/lib/wallet";

type Step = "idle" | "sign" | "mining" | "done";

interface Props {
  account: Address | null;
  baseEth: bigint | null;
  live: LiveState | null;
  onConnect: () => void;
  onMined: (tx: Hex, epoch: bigint, minedAt: number) => void;
}

export function DrillPanel({ account, baseEth, live, onConnect, onMined }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);

  const notNormal = live !== null && live.status !== 0;
  const noGas = baseEth !== null && baseEth === 0n;
  const busy = step === "sign" || step === "mining";

  async function run() {
    if (!account || !live) return;
    setError(null);
    setTx(null);
    try {
      setStep("sign");
      const wallet = await walletFor("base", account);
      const hash = await wallet.writeContract({
        address: CONTRACTS.drill,
        abi: depegDrillAbi,
        functionName: "drill",
        args: [DRILL_AMOUNT, DRILL_DUMPS],
        account,
        chain: LANES.base.chain,
      });
      setTx(hash);
      setStep("mining");
      const receipt = await client("base").waitForTransactionReceipt({ hash, pollingInterval: 250 });
      if (receipt.status !== "success") throw new Error("The drill transaction reverted on Base Sepolia.");
      onMined(hash, live.epoch + 1n, Date.now());
      setStep("done");
    } catch (err) {
      setError(errorMessage(err));
      setStep("idle");
    }
  }

  return (
    <section className="card" aria-labelledby="drill-title">
      <h2 id="drill-title" className="card-title">Run a depeg drill</h2>
      <p className="card-text">
        Sells {amount(DRILL_AMOUNT)} mSTB into the Base pool {DRILL_DUMPS.toString()} times in one transaction. The
        sentinel should confirm the depeg, pay open policies on Unichain and send the keeper to buy back.
      </p>
      <dl className="facts">
        <div>
          <dt>Gas on Base Sepolia</dt>
          <dd className="num">{baseEth === null ? "–" : `${Number(formatEther(baseEth)).toFixed(4)} ETH`}</dd>
        </div>
      </dl>
      {account === null ? (
        <button type="button" className="btn" onClick={onConnect}>
          Connect wallet to drill
        </button>
      ) : (
        <button type="button" className="btn" onClick={run} disabled={busy || notNormal || noGas || live === null}>
          {step === "sign" ? "Confirm in wallet…" : step === "mining" ? "Waiting for Base block…" : "Run depeg drill"}
        </button>
      )}
      {notNormal ? <p className="note">The sentinel is not Normal yet. Wait for the peg to recover, then drill again.</p> : null}
      {noGas ? <p className="note">This wallet has no Base Sepolia ETH. Bridge or claim some from a faucet first.</p> : null}
      {error ? (
        <p className="note negative" role="alert">
          {error}
        </p>
      ) : null}
      {tx ? (
        <p className="note" role="status">
          {step === "done" ? "Mined. Watching all three chains: " : "Sent: "}
          <a className="num" href={txUrl("base", tx)} target="_blank" rel="noreferrer">
            {shortHash(tx)}
          </a>
        </p>
      ) : null}
    </section>
  );
}
