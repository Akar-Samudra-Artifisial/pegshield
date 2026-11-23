#!/usr/bin/env python3
"""Run one depeg full loop on testnet and measure its latency.

Base Sepolia: dump mSTB into the pool `DUMPS` times -> Lasna sentinel confirms the depeg
-> Unichain vault pays out (DepegHandled) + Base keeper buys back (Defended)
-> the keeper's own swap restores the peg -> sentinel -> vault reopens (Recovered).

Usage: PRIVATE_KEY=... python3 -I scripts/depeg_demo.py [dump_amount_ether] [dumps]
Reads RPCs from .env.example and addresses from deployments/testnet.env.
Wall-clock times come from polling (POLL seconds of jitter); block deltas use block timestamps.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))  # -I drops the script dir from sys.path

from spike_latency import CAST, block_ts, load_env, rpc, topic  # noqa: E402

POLL = 0.25
TIMEOUT = 240.0


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
    if receipt.get("status") != "0x1":
        raise RuntimeError(f"{sig} reverted or no receipt: {receipt}")
    return receipt


def call_uint(rpc_url: str, to: str, sig: str) -> int:
    out = subprocess.run(
        [CAST, "call", to, sig, "--rpc-url", rpc_url],
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


def main() -> None:
    key = os.environ.get("PRIVATE_KEY")
    if not key:
        sys.exit("export PRIVATE_KEY first")
    amount = sys.argv[1] if len(sys.argv) > 1 else "2000"
    dumps = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    env = load_env(ROOT / ".env.example")
    dep = load_env(ROOT / "deployments" / "testnet.env")
    base, uni, lasna = (
        env["BASE_SEPOLIA_RPC"],
        env["UNICHAIN_SEPOLIA_RPC"],
        env["LASNA_RPC"],
    )
    me = subprocess.run(
        [CAST, "wallet", "address", "--private-key", key],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    epoch = call_uint(lasna, dep["DEPEG_SENTINEL_LASNA"], "epoch()(uint256)") + 1
    epoch_topic = "0x" + hex(epoch)[2:].rjust(64, "0")
    start = {
        name: int(str(rpc(u, "eth_blockNumber", [])), 16)
        for name, u in (("base", base), ("uni", uni), ("lasna", lasna))
    }
    print(
        f"expecting epoch {epoch}; pool price {call_uint(base, dep['MOCK_PAIR_BASE'], 'priceE18()(uint256)') / 1e18:.4f}"
    )

    last: dict = {}
    w_mined = 0.0
    for i in range(dumps):
        last = send(
            base,
            key,
            dep["MOCK_PAIR_BASE"],
            "swap(address,uint256,uint256,address)",
            dep["MOCK_STABLE_BASE"],
            f"{amount}ether",
            "0",
            me,
        )
        w_mined = time.time()
        price = call_uint(base, dep["MOCK_PAIR_BASE"], "priceE18()(uint256)") / 1e18
        print(
            f"dump {i + 1}: tx {last['transactionHash']} block {int(last['blockNumber'], 16)} price {price:.4f}"
        )
    t0 = block_ts(base, last["blockNumber"])

    # name -> (rpc, address, event topic0, from block)
    targets = {
        "lasna_depegged": (
            lasna,
            dep["DEPEG_SENTINEL_LASNA"],
            topic("StatusChanged(uint256,uint8,uint8,uint256,uint256,uint256)"),
            start["lasna"],
        ),
        "uni_payout": (
            uni,
            dep["POLICY_VAULT_UNICHAIN"],
            topic(
                "DepegHandled(uint256,uint256,uint256,bytes32,uint256,uint256,uint256)"
            ),
            start["uni"],
        ),
        "base_keeper": (
            base,
            dep["PEG_KEEPER_BASE"],
            topic(
                "Defended(uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,uint256)"
            ),
            start["base"],
        ),
        "uni_recovered": (
            uni,
            dep["POLICY_VAULT_UNICHAIN"],
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
            except Exception as exc:  # transient RPC failure: keep polling, but say so
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

    print(
        f"\nconfirming origin tx {last['transactionHash']} (Base block {int(last['blockNumber'], 16)})"
    )
    for name, (url, _, _, _) in targets.items():
        if name not in seen:
            print(f"  {name:15s} TIMEOUT after {TIMEOUT:.0f}s")
            continue
        w, lg = seen[name]
        ts = block_ts(url, lg["blockNumber"])
        print(
            f"  {name:15s} tx {lg['transactionHash']}  block Δ={ts - t0:3d}s  wall Δ={w - w_mined:6.2f}s"
        )

    print(
        f"\npool price now {call_uint(base, dep['MOCK_PAIR_BASE'], 'priceE18()(uint256)') / 1e18:.4f}"
    )
    print(
        f"sentinel status {call_uint(lasna, dep['DEPEG_SENTINEL_LASNA'], 'status()(uint8)')} (0 NORMAL, 1 WATCH, 2 DEPEGGED)"
    )


if __name__ == "__main__":
    main()
