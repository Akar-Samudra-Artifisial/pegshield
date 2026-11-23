#!/usr/bin/env python3
"""Run depeg full loops on testnet and measure their latency.

Base Sepolia: dump mSTB into the pool -> Lasna sentinel confirms the depeg
-> Unichain vault pays out (DepegHandled) + Base keeper buys back (Defended)
-> the keeper's own swap restores the peg -> sentinel -> vault reopens (Recovered).

Usage:
  PRIVATE_KEY=... python3 -I scripts/depeg_demo.py                 # one loop
  PRIVATE_KEY=... python3 -I scripts/depeg_demo.py --bench 10      # 10 loops + p50/p95
  options: --amount 2000 --dumps 3 --trigger drill|swap --gap 5 --json out.json

Trigger `drill` (default when DEPEG_DRILL_BASE is deployed) does every dump in ONE Base tx,
so the origin is a single tx. `swap` sends one tx per dump; the origin is the last dump.

Reads RPCs from .env.example and addresses from deployments/testnet.env.
block Δ = destination block timestamp - origin block timestamp (1 s resolution, and each
chain's clock differs slightly, so Lasna can read ~1 s early). wall Δ = local clock from the
origin receipt to the poll that saw the log (POLL seconds of jitter, plus RPC round trips).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))  # -I drops the script dir from sys.path

from spike_latency import CAST, block_ts, load_env, rpc, topic  # noqa: E402

POLL = 0.25
TIMEOUT = 240.0
KEEPER_MIN_FUNDS = 20_000  # mUSD; one defense spends ~6-8k
KEEPER_TOP_UP = "100000ether"

STAGES = ("lasna_depegged", "base_keeper", "uni_payout", "uni_recovered")
LABELS = {
    "lasna_depegged": "Lasna: depeg confirmed",
    "base_keeper": "Base: keeper defended",
    "uni_payout": "Unichain: payout handled",
    "uni_recovered": "Unichain: vault reopened",
}


def send(rpc_url: str, key: str, to: str, sig: str, *args: str) -> dict:
    out = subprocess.run(
        [
            CAST,
            "send",
            to,
            sig,
            *args,
            "--rpc-url",
            rpc_url,
            "--private-key",
            key,
            "--json",
        ],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"{sig} failed: {out.stderr.strip()}")
    receipt = json.loads(out.stdout)
    # Never retry here: a missing status may still be a mined tx (double dump / double mint).
    if receipt.get("status") != "0x1":
        raise RuntimeError(f"{sig} reverted or no receipt: {receipt}")
    return receipt


def call_uint(rpc_url: str, to: str, sig: str, *args: str) -> int:
    out = subprocess.run(
        [CAST, "call", to, sig, *args, "--rpc-url", rpc_url],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(out.stdout.split()[0])


def logs(rpc_url: str, address: str, t0: str, t1: str, from_block: int) -> list[dict]:
    res = rpc(
        rpc_url,
        "eth_getLogs",
        [
            {
                "address": address,
                "fromBlock": hex(from_block),
                "toBlock": "latest",
                "topics": [t0, t1],
            }
        ],
    )
    assert isinstance(res, list)
    return res


class Loop:
    def __init__(self, key: str, trigger: str, amount: str, dumps: int) -> None:
        env = load_env(ROOT / ".env.example")
        self.dep = load_env(ROOT / "deployments" / "testnet.env")
        self.base = env["BASE_SEPOLIA_RPC"]
        self.uni = env["UNICHAIN_SEPOLIA_RPC"]
        self.lasna = env["LASNA_RPC"]
        self.key = key
        self.amount = amount
        self.dumps = dumps
        if trigger == "drill" and not self.dep.get("DEPEG_DRILL_BASE"):
            sys.exit(
                "DEPEG_DRILL_BASE missing in deployments/testnet.env; use --trigger swap"
            )
        self.trigger = trigger
        self.me = subprocess.run(
            [CAST, "wallet", "address", "--private-key", key],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

    # --- helpers -------------------------------------------------------------------------
    def price(self) -> float:
        return (
            call_uint(self.base, self.dep["MOCK_PAIR_BASE"], "priceE18()(uint256)")
            / 1e18
        )

    def status(self) -> int:
        return call_uint(
            self.lasna, self.dep["DEPEG_SENTINEL_LASNA"], "status()(uint8)"
        )

    def ensure_keeper_funds(self) -> None:
        bal = call_uint(
            self.base,
            self.dep["MOCK_USD_BASE"],
            "balanceOf(address)(uint256)",
            self.dep["PEG_KEEPER_BASE"],
        )
        print(f"keeper treasury {bal / 1e18:,.0f} mUSD")
        if bal / 1e18 < KEEPER_MIN_FUNDS:
            r = send(
                self.base,
                self.key,
                self.dep["MOCK_USD_BASE"],
                "mint(address,uint256)",
                self.dep["PEG_KEEPER_BASE"],
                KEEPER_TOP_UP,
            )
            print(f"  topped up keeper +100,000 mUSD (tx {r['transactionHash']})")

    def wait_normal(self, limit: float = 90.0) -> None:
        deadline = time.time() + limit
        while self.status() != 0:
            if time.time() > deadline:
                raise RuntimeError(
                    "sentinel did not return to NORMAL; not starting another loop"
                )
            time.sleep(2)

    def fire(self) -> dict:
        if self.trigger == "drill":
            r = send(
                self.base,
                self.key,
                self.dep["DEPEG_DRILL_BASE"],
                "drill(uint256,uint256)",
                f"{self.amount}ether",
                str(self.dumps),
            )
            print(
                f"  drill tx {r['transactionHash']} block {int(r['blockNumber'], 16)} price {self.price():.4f}"
            )
            return r
        r: dict = {}
        for i in range(self.dumps):
            r = send(
                self.base,
                self.key,
                self.dep["MOCK_PAIR_BASE"],
                "swap(address,uint256,uint256,address)",
                self.dep["MOCK_STABLE_BASE"],
                f"{self.amount}ether",
                "0",
                self.me,
            )
            print(
                f"  dump {i + 1}: tx {r['transactionHash']} block {int(r['blockNumber'], 16)} price {self.price():.4f}"
            )
        return r

    # --- one loop ------------------------------------------------------------------------
    def run(self) -> dict:
        epoch = (
            call_uint(self.lasna, self.dep["DEPEG_SENTINEL_LASNA"], "epoch()(uint256)")
            + 1
        )
        epoch_topic = "0x" + hex(epoch)[2:].rjust(64, "0")
        start = {
            name: int(str(rpc(u, "eth_blockNumber", [])), 16)
            for name, u in self._lanes()
        }
        print(f"\nepoch {epoch}: pool price {self.price():.4f}")

        origin = self.fire()
        w_mined = time.time()
        t0 = block_ts(self.base, origin["blockNumber"])

        targets = {
            "lasna_depegged": (
                self.lasna,
                self.dep["DEPEG_SENTINEL_LASNA"],
                topic("StatusChanged(uint256,uint8,uint8,uint256,uint256,uint256)"),
                start["lasna"],
            ),
            "base_keeper": (
                self.base,
                self.dep["PEG_KEEPER_BASE"],
                topic(
                    "Defended(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,uint256)"
                ),
                start["base"],
            ),
            "uni_payout": (
                self.uni,
                self.dep["POLICY_VAULT_UNICHAIN"],
                topic(
                    "DepegHandled(uint256,uint256,uint256,bytes32,uint256,uint256,uint256)"
                ),
                start["uni"],
            ),
            "uni_recovered": (
                self.uni,
                self.dep["POLICY_VAULT_UNICHAIN"],
                topic("Recovered(uint256,uint256,uint256,bytes32,uint256)"),
                start["uni"],
            ),
        }
        seen: dict[str, tuple[float, dict]] = {}
        deadline = time.time() + TIMEOUT
        while len(seen) < len(targets) and time.time() < deadline:
            for name, (url, addr, t, fb) in targets.items():
                if name in seen:
                    continue
                try:
                    found = logs(url, addr, t, epoch_topic, fb)
                except (
                    Exception
                ) as exc:  # transient RPC failure: keep polling, but say so
                    print(f"  rpc error on {name}: {exc}", file=sys.stderr)
                    continue
                if name == "lasna_depegged":
                    # StatusChanged fires for WATCH too; DEPEGGED is enum value 2 (`to`, 2nd data word).
                    found = [
                        lg for lg in found if int(lg["data"][2 + 64 : 2 + 128], 16) == 2
                    ]
                if found:
                    seen[name] = (time.time(), found[0])
            time.sleep(POLL)

        result: dict = {
            "epoch": epoch,
            "origin_tx": origin["transactionHash"],
            "stages": {},
        }
        for name, (url, _, _, _) in targets.items():
            if name not in seen:
                print(f"  {LABELS[name]:26s} TIMEOUT after {TIMEOUT:.0f}s")
                continue
            w, lg = seen[name]
            block_d = block_ts(url, lg["blockNumber"]) - t0
            wall_d = w - w_mined
            result["stages"][name] = {
                "tx": lg["transactionHash"],
                "block": block_d,
                "wall": round(wall_d, 3),
            }
            print(
                f"  {LABELS[name]:26s} block Δ={block_d:3d}s  wall Δ={wall_d:6.2f}s  tx {lg['transactionHash']}"
            )
        print(f"  pool price now {self.price():.4f}")
        return result

    def _lanes(self) -> tuple[tuple[str, str], ...]:
        return (("base", self.base), ("uni", self.uni), ("lasna", self.lasna))


def pct(vals: list[float], q: float) -> float:
    """Nearest-rank percentile on sorted values (n=10: p95 is the slowest run)."""
    s = sorted(vals)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def summarize(results: list[dict]) -> dict:
    out: dict = {}
    print(f"\nsummary over {len(results)} loops (seconds after the origin swap)")
    print(
        f"  {'stage':26s} {'n':>3s}  {'block p50':>9s} {'p95':>5s}  {'wall p50':>8s} {'p95':>6s} {'max':>6s}"
    )
    for name in STAGES:
        rows = [r["stages"][name] for r in results if name in r["stages"]]
        if not rows:
            print(f"  {LABELS[name]:26s}   0  (no data)")
            continue
        blocks = [float(x["block"]) for x in rows]
        walls = [x["wall"] for x in rows]
        out[name] = {
            "n": len(rows),
            "block_p50": statistics.median(blocks),
            "block_p95": pct(blocks, 0.95),
            "wall_p50": round(statistics.median(walls), 2),
            "wall_p95": round(pct(walls, 0.95), 2),
            "wall_max": round(max(walls), 2),
        }
        o = out[name]
        print(
            f"  {LABELS[name]:26s} {o['n']:3d}  {o['block_p50']:9.1f} {o['block_p95']:5.0f}  "
            f"{o['wall_p50']:8.2f} {o['wall_p95']:6.2f} {o['wall_max']:6.2f}"
        )
    failed = sum(1 for r in results if len(r["stages"]) < len(STAGES))
    print(f"  incomplete loops: {failed}/{len(results)}")
    return out


def main() -> None:
    key = os.environ.get("PRIVATE_KEY")
    if not key:
        sys.exit("export PRIVATE_KEY first")
    dep = load_env(ROOT / "deployments" / "testnet.env")
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--bench", type=int, default=1, help="number of loops (default 1)")
    ap.add_argument("--amount", default="2000", help="mSTB per dump, in ether units")
    ap.add_argument("--dumps", type=int, default=3)
    ap.add_argument(
        "--trigger",
        choices=("drill", "swap"),
        default="drill" if dep.get("DEPEG_DRILL_BASE") else "swap",
    )
    ap.add_argument(
        "--gap", type=float, default=5.0, help="seconds to wait between loops"
    )
    ap.add_argument(
        "--json", type=Path, help="write raw results + summary to this file"
    )
    args = ap.parse_args()

    loop = Loop(key, args.trigger, args.amount, args.dumps)
    print(
        f"trigger={args.trigger} amount={args.amount} dumps={args.dumps} loops={args.bench}"
    )
    results: list[dict] = []
    for i in range(args.bench):
        loop.ensure_keeper_funds()
        loop.wait_normal()
        try:
            results.append(loop.run())
        except RuntimeError as exc:
            print(f"loop {i + 1} aborted: {exc}", file=sys.stderr)
            break
        if i + 1 < args.bench:
            time.sleep(args.gap)

    summary = summarize(results) if len(results) > 1 else {}
    print(f"\nsentinel status {loop.status()} (0 NORMAL, 1 WATCH, 2 DEPEGGED)")
    if args.json:
        args.json.write_text(
            json.dumps({"results": results, "summary": summary}, indent=2) + "\n"
        )
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
