"use client";

import { useState } from "react";
import { type Address, type Hex, formatEther } from "viem";
import { depegDrillAbi } from "@/abi/DepegDrill";
import { client } from "@/lib/clients";
import { CONTRACTS, DRILL_AMOUNT, DRILL_DUMPS, LANES, txUrl } from "@/lib/config";
import { amount, shortHash } from "@/lib/format";
import type { Loop } from "@/lib/history";
import type { LiveState } from "@/lib/live";
import { errorMessage, walletFor } from "@/lib/wallet";
import { type StepItem, Steps } from "./Steps";

type Step = "idle" | "sign" | "mining" | "done";

interface Props {
  account: Address | null;
  baseEth: bigint | null;
  live: LiveState | null;
  loops: Loop[] | null;
  onConnect: () => void;
  onMined: (tx: Hex, epoch: bigint, minedAt: number) => void;
}

export function DrillPanel({ account, baseEth, live, loops, onConnect, onMined }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);
  const [drillEpoch, setDrillEpoch] = useState<bigint | null>(null);

  const notNormal = live !== null && live.status !== 0;
  const noGas = baseEth !== null && baseEth === 0n;
  const busy = step === "sign" || step === "mining";

  async function run() {
    if (!account || !live) return;
    setError(null);
    setTx(null);
    setDrillEpoch(null);
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
      setDrillEpoch(live.epoch + 1n);
      onMined(hash, live.epoch + 1n, Date.now());
      setStep("done");
    } catch (err) {
      setError(errorMessage(err));
      setStep("idle");
    }
  }

  const txLink = tx ? (
    <a className="num" href={txUrl("base", tx)} target="_blank" rel="noreferrer">
      {shortHash(tx)}
    </a>
  ) : null;

  // The loop is finished once the vault has reopened, or the sentinel is back to Normal for this epoch.
  const drillLoop = drillEpoch !== null ? (loops?.find((l) => l.epoch === drillEpoch) ?? null) : null;
  const loopDone =
    drillEpoch !== null &&
    ((drillLoop?.marks.some((m) => m.kind === "reopen" || m.kind === "recover") ?? false) ||
      (live !== null && live.status === 0 && live.epoch >= drillEpoch));
  const loopEnd = drillLoop ? Math.max(...drillLoop.marks.map((m) => m.seconds)) : null;

  const items: StepItem[] = [
    { label: "Connect a wallet", state: account ? "done" : "current" },
    {
      label: "Sign the drill on Base Sepolia",
      state: !account ? "todo" : step === "idle" ? "current" : step === "sign" ? "current" : "done",
      detail: step === "sign" ? "Confirm in your wallet. It switches network if needed." : null,
    },
    {
      label: "Wait for the Base block",
      state: step === "mining" ? "current" : step === "done" ? "done" : "todo",
      detail: txLink,
    },
    {
      label: "Watch the loop on three chains",
      state: step !== "done" ? "todo" : loopDone ? "done" : "current",
      detail:
        step !== "done"
          ? null
          : loopDone
            ? `Depeg ${drillEpoch} handled${loopEnd !== null ? `, whole loop done +${loopEnd} s after your swap` : ""}. The timeline shows each mark.`
            : "Marks land on the timeline within seconds.",
    },
  ];

  return (
    <section className="card" id="drill" aria-labelledby="drill-title">
      <div className="card-head">
        <h2 id="drill-title" className="card-title">
          Try it: trigger a depeg
        </h2>
        <span className="muted small">Base Sepolia</span>
      </div>
      <p className="card-text">
        One transaction sells {amount(DRILL_AMOUNT)} mSTB into the pool {DRILL_DUMPS.toString()} times, so the price
        falls under the threshold. The drill mints its own test mSTB, so you only pay testnet gas.
      </p>
      <Steps items={items} label="Drill progress" />
      <dl className="facts">
        <div>
          <dt>Your gas on Base Sepolia</dt>
          <dd className="num">{baseEth === null ? "–" : `${Number(formatEther(baseEth)).toFixed(4)} ETH`}</dd>
        </div>
      </dl>
      {account === null ? (
        <button type="button" className="btn" onClick={onConnect}>
          Connect wallet
        </button>
      ) : (
        <button type="button" className="btn" onClick={run} disabled={busy || notNormal || noGas || live === null}>
          {step === "sign" ? "Confirm in wallet…" : step === "mining" ? "Waiting for Base block…" : "Run depeg drill"}
        </button>
      )}
      {notNormal ? (
        <p className="note warning" role="status">
          The sentinel is not Normal yet. The drill unlocks when the peg has recovered.
        </p>
      ) : null}
      {noGas ? <p className="note">This wallet has no Base Sepolia ETH. Claim some from a faucet first.</p> : null}
      {error ? (
        <p className="note negative" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
