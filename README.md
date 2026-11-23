# PegShield

Depeg defense on Reactive Network: one reactive contract on Lasna watches a stablecoin pool on
Base Sepolia and, within seconds of a depeg, fires two callbacks:

- **PolicyVault** (Unichain Sepolia) pays out parametric depeg insurance automatically.
- **PegKeeper** (Base Sepolia) defends the peg with capped treasury buys.

Built for the [Reactive Omni Buildathon](https://dorahacks.io/hackathon/reactive-omni-buildathon/detail)
(track: Every Second Counts). Work in progress.

**Live dashboard:** https://pegshield-one.vercel.app (testnet; read-only without a wallet; auto-deployed from `main`, app root `web/`)

## Status

| Milestone | State |
|---|---|
| Latency spike: Base → Lasna → Base + Unichain | Done (2026-11-23) |
| DepegSentinel state machine, PolicyVault, PegKeeper (41 tests) | Done (2026-11-23) |
| Testnet deploy + depeg full loop | Done (2026-11-23) |
| Dashboard (policies, trigger depeg, latency timeline) | Done (2026-11-23) |
| Latency bench, 10 full loops | Done (2026-11-23) |

## Latency bench: 10 depeg full loops (2026-11-23)

`python3 -I scripts/depeg_demo.py --bench 10`: each loop is one `DepegDrill.drill(2000e18, 3)` tx on
Base Sepolia (three dumps → three `Sync` logs, pool 1.00 → 0.89). 10/10 loops completed; log in
[`docs/depeg-bench-2026-11-23.txt`](docs/depeg-bench-2026-11-23.txt), raw tx hashes per stage in
[`docs/depeg-bench-2026-11-23.json`](docs/depeg-bench-2026-11-23.json).

| Stage (seconds after the origin drill tx) | block Δ p50 | block Δ p95 | wall p50 | wall p95 |
|---|---|---|---|---|
| Lasna: sentinel confirms DEPEGGED | −1 | 0 | 1.65 | 1.78 |
| Base: PegKeeper `Defended` (buy-back) | 1 | 2 | 1.99 | 2.10 |
| Unichain: PolicyVault `DepegHandled` (payout) | 2 | 3 | 2.83 | 4.74 |
| Unichain: PolicyVault `Recovered` (peg restored, vault reopens) | 3 | 4 | 3.74 | 5.55 |

block Δ = destination block timestamp − origin block timestamp (1 s resolution; Lasna's clock reads
~1 s behind Base, hence −1). wall = local clock from the origin receipt to the 0.25 s poll that saw
the log, so it includes polling and public-RPC round trips. p95 is nearest-rank (n=10 → slowest run).

## Depeg full loop on testnet (2026-11-23)

Three 2,000 mSTB dumps push the Base Sepolia pool from 1.00 to 0.89. On the third `Sync` the
sentinel confirms the depeg (watch 0.97, 3 confirmations) and fires two callbacks. The keeper's
buy-back emits a new `Sync`, the sentinel sees price ≥ 0.99 and tells the vault to reopen.
Script: `scripts/depeg_demo.py`; logs in [`docs/`](docs/).

| Step (after confirming origin tx mined) | Run 1 block Δ / wall | Run 2 block Δ / wall |
|---|---|---|
| Lasna: status → DEPEGGED | −1 s / 1.69 s* | 0 s / 2.66 s |
| Base: PegKeeper `Defended` (buy-back) | 1 s / 2.94 s* | 2 s / 3.80 s |
| Unichain: PolicyVault `DepegHandled` (payout) | 2 s / 4.85 s* | 3 s / 5.81 s |
| Unichain: PolicyVault `Recovered` (after peg restored) | 4 s / 5.78 s* | 4 s / 6.62 s |

\* Run 1 started the wall clock ~0.3 s late (after a price read); block Δ is unaffected. Run 1
Lasna block Δ was −1 s (second-resolution timestamps). Run 1 paid the 10,000 mUSD policy in full;
run 2 had no open policy, so it shows latency only.

Run 1 transactions:

- Confirming dump, Base Sepolia: `0x6f60ab74256f42a7a8e9012d07c769d86f88ddc542a0d805b3a5e6fe1085047f`
- Sentinel DEPEGGED, Lasna: `0x162b43c36237a60db693f83ea05e34cd0142e6d82e435a6567b851dc03977356`
- Keeper buy-back, Base Sepolia: `0xd9a057b1973b5217f07045dacd05fcf0e3275da0a63e31f12aa630ee9bf05b50`
- Payout, Unichain Sepolia: `0x2c6b89d48388ab7b936182e4b5cca5a2a6c29ceb541ca8c87f8a3755f0d5686c`
- Recovered, Unichain Sepolia: `0x2ede435233840afcfad43e8ca9014a6ca42492c399bc56618db822dcd94dfc62`

| Contract | Chain | Address |
|---|---|---|
| MockStable (mSTB) | Base Sepolia (84532) | `0xce47e1a57026470854347af452804f1d2bd0f0aa` |
| MockUSD (mUSD) | Base Sepolia (84532) | `0x49746328fdc3787f17e9374b00ef315fb11c33f0` |
| MockPair | Base Sepolia (84532) | `0xbbe79dc4775a7ed7031a9d47528cd1c43c35f1bd` |
| PegKeeper | Base Sepolia (84532) | `0xf7c42496d513ab05650029fa2e5da0d2a2542c2e` |
| DepegDrill (testnet trigger) | Base Sepolia (84532) | `0x6d2a1f649634598044db76a4f9e1cc182ca2991e` |
| DepegSentinel | Lasna (5318007) | `0x729215e645fe4b9eec8a2e9d7eb40482cd276894` |
| MockUSD (mUSD) | Unichain Sepolia (1301) | `0xef28b0405637d399087aca3bd0dc716374fd8edb` |
| PolicyVault | Unichain Sepolia (1301) | `0x729215e645fe4b9eec8a2e9d7eb40482cd276894` |

## Latency spike (2026-11-23)

`Pinger.ping()` on Base Sepolia → `SpikeReactive.react()` on Lasna → `SpikeCallback.onPing()` on
Base Sepolia and Unichain Sepolia. 10 runs, `scripts/spike_latency.py`, full log in
[`docs/spike-latency-2026-11-23.txt`](docs/spike-latency-2026-11-23.txt).

| Leg (seconds after origin tx mined, wall clock) | p50 | p95 |
|---|---|---|
| Lasna reactive tx visible | 1.55 | 1.66 |
| Base Sepolia callback visible | 1.88 | 2.00 |
| Unichain Sepolia callback visible | 3.84 | 4.90 |

Block-timestamp deltas (origin → destination): Base 2 s p50, Unichain 2 s p50 / 3 s p95.
Wall-clock times are measured by polling public RPCs every 0.25 s, so they include polling jitter.

| Contract | Chain | Address |
|---|---|---|
| Pinger | Base Sepolia (84532) | `0xa53e584a87db8be5e5a2896a9a9530a8eb791568` |
| SpikeReactive | Lasna (5318007) | `0xa53e584a87db8be5e5a2896a9a9530a8eb791568` |
| SpikeCallback | Base Sepolia (84532) | `0xef28b0405637d399087aca3bd0dc716374fd8edb` |
| SpikeCallback | Unichain Sepolia (1301) | `0xa53e584a87db8be5e5a2896a9a9530a8eb791568` |

Example full loop (run id=2):

- Origin: Base Sepolia `0x9b80b6c2b300c40929a33847421761ff384b8862decbb29ecba1275cff144b8e`
- Reactive: Lasna `0x7734ef3843ece284782559f894a57771ace9c72ee11e4d4b3c501a733602aa31`
- Callback: Base Sepolia `0x3313ac5cd5dbf49ccc3e0590a7840160cc8f3829a11aac2896aafa0fd296b60a`
- Callback: Unichain Sepolia `0x508f4ed78ebb654cc6c596198c1e61ab35a187e5a578a146e10dfa557914b8c9`

## Development

```bash
git clone --recurse-submodules <repo>
cd contracts && forge test
export PRIVATE_KEY=...            # testnet deployer, never commit
bash scripts/spike-deploy.sh      # writes deployments/spike.env
python3 -I scripts/spike_latency.py 10
bash scripts/deploy.sh            # PegShield, writes deployments/testnet.env
python3 -I scripts/depeg_demo.py  # one depeg full loop + latency
python3 -I scripts/depeg_demo.py --bench 10 --json docs/bench.json  # p50/p95
cd web && pnpm install && pnpm build && pnpm start -p 3311  # dashboard
PRIVATE_KEY=... node web/scripts/dev-wallet.mjs  # optional test wallet, see file header
```

Stack: Foundry, Solidity 0.8.29 (`evm_version = paris` for Lasna), `reactive-lib-omni`.
