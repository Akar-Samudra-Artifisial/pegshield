#!/usr/bin/env python3
"""Measure full-loop latency of the spike: Base ping -> Lasna react -> Base/Unichain callbacks.

Usage: PRIVATE_KEY=... python3 -I scripts/spike_latency.py [runs]
Reads RPCs from .env.example and addresses from deployments/spike.env.
Wall-clock times are measured by polling, so they include up to POLL seconds of jitter.
"""

from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POLL = 0.25
TIMEOUT = 180.0
CAST = os.path.expanduser("~/.foundry/bin/cast")


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
    return env


def rpc(url: str, method: str, params: list, attempts: int = 4) -> object:
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    # curl instead of urllib: Python's resolver here stalls on TLS handshakes (likely IPv6),
    # while curl's happy-eyeballs connects reliably.
    cmd = [
        "curl",
        "-sS",
        "-m",
        "15",
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "--data-binary",
        "@-",
        url,
    ]
    for i in range(attempts):
        out = subprocess.run(cmd, input=body, capture_output=True)
        if out.returncode == 0:
            res = json.loads(out.stdout)
            break
        if i == attempts - 1:
            raise RuntimeError(f"{method} on {url}: {out.stderr.decode().strip()}")
        print(
            f"  retry {method} on {url}: {out.stderr.decode().strip()}", file=sys.stderr
        )
        time.sleep(1)
    if "error" in res:
        raise RuntimeError(f"{method}: {res['error']}")
    return res["result"]


def topic(sig: str) -> str:
    out = subprocess.run(
        [CAST, "keccak", sig], capture_output=True, text=True, check=True
    )
    return out.stdout.strip()


def find_log(
    url: str, address: str, t0: str, id_topic: str, from_block: int
) -> dict | None:
    logs = rpc(
        url,
        "eth_getLogs",
        [
            {
                "address": address,
                "fromBlock": hex(from_block),
                "toBlock": "latest",
                "topics": [t0, id_topic],
            }
        ],
    )
    assert isinstance(logs, list)
    return logs[0] if logs else None


def block_ts(url: str, number_hex: str) -> int:
    b = rpc(url, "eth_getBlockByNumber", [number_hex, False])
    assert isinstance(b, dict)
    return int(b["timestamp"], 16)


def run_once(
    env: dict[str, str], dep: dict[str, str], key: str, topics: dict[str, str]
) -> dict[str, float]:
    base, uni, lasna = (
        env["BASE_SEPOLIA_RPC"],
        env["UNICHAIN_SEPOLIA_RPC"],
        env["LASNA_RPC"],
    )
    start = {
        name: int(str(rpc(u, "eth_blockNumber", [])), 16)
        for name, u in (("base", base), ("uni", uni), ("lasna", lasna))
    }

    w_send = time.time()
    out = subprocess.run(
        [
            CAST,
            "send",
            dep["PINGER"],
            "ping()",
            "--rpc-url",
            base,
            "--private-key",
            key,
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    receipt = json.loads(out.stdout)
    w_mined = time.time()
    origin_block = receipt["blockNumber"]
    ping_log = next(lg for lg in receipt["logs"] if lg["topics"][0] == topics["ping"])
    id_topic = ping_log["topics"][1]
    t0 = block_ts(base, origin_block)

    targets = {
        "lasna": (lasna, dep["SPIKE_REACTIVE"], topics["relayed"], start["lasna"]),
        "base_cb": (base, dep["SPIKE_CB_BASE"], topics["handled"], start["base"]),
        "uni_cb": (uni, dep["SPIKE_CB_UNICHAIN"], topics["handled"], start["uni"]),
    }
    seen: dict[str, tuple[float, dict]] = {}
    deadline = time.time() + TIMEOUT
    while len(seen) < len(targets) and time.time() < deadline:
        for name, (url, addr, t, fb) in targets.items():
            if name in seen:
                continue
            try:
                lg = find_log(url, addr, t, id_topic, fb)
            except Exception as exc:  # transient RPC failures: keep polling, but say so
                print(f"  rpc error on {name}: {exc}", file=sys.stderr)
                continue
            if lg:
                seen[name] = (time.time(), lg)
        time.sleep(POLL)

    result: dict[str, float] = {
        "id": int(id_topic, 16),
        "wall_send_to_mined": w_mined - w_send,
    }
    print(f"run id={result['id']} origin tx {receipt['transactionHash']}")
    for name, (url, _, _, _) in targets.items():
        if name not in seen:
            print(f"  {name}: TIMEOUT after {TIMEOUT:.0f}s")
            continue
        w, lg = seen[name]
        ts = block_ts(url, lg["blockNumber"])
        result[f"{name}_wall_from_mined"] = w - w_mined
        result[f"{name}_block_delta"] = ts - t0
        print(
            f"  {name}: tx {lg['transactionHash']}  block Δ={ts - t0}s  wall Δ(from origin mined)={w - w_mined:.2f}s"
        )
    return result


def main() -> None:
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    key = os.environ.get("PRIVATE_KEY")
    if not key:
        sys.exit("export PRIVATE_KEY first")
    env = load_env(ROOT / ".env.example")
    dep = load_env(ROOT / "deployments" / "spike.env")
    topics = {
        "ping": topic("Ping(uint256,address)"),
        "relayed": topic("Relayed(uint256,uint256,uint256)"),
        "handled": topic("Handled(uint256,uint256,uint256,bytes32,uint256)"),
    }
    results = [run_once(env, dep, key, topics) for _ in range(runs)]

    if runs > 1:
        print("\nsummary (seconds)")
        keys = sorted({k for r in results for k in r if k != "id"})
        for k in keys:
            vals = sorted(r[k] for r in results if k in r)
            if not vals:
                continue
            p95 = vals[min(len(vals) - 1, int(round(0.95 * (len(vals) - 1))))]
            print(
                f"  {k:32s} n={len(vals):2d} p50={statistics.median(vals):6.2f} p95={p95:6.2f}"
            )


if __name__ == "__main__":
    main()
