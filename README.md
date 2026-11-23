# PegShield

Depeg defense on Reactive Network: one reactive contract on Lasna watches a stablecoin pool on
Base Sepolia and, within seconds of a depeg, fires two callbacks:

- **PolicyVault** (Unichain Sepolia) pays out parametric depeg insurance automatically.
- **PegKeeper** (Base Sepolia) defends the peg with capped treasury buys.

Built for the [Reactive Omni Buildathon](https://dorahacks.io/hackathon/reactive-omni-buildathon/detail)
(track: Every Second Counts). Work in progress.

## Status

| Milestone | State |
|---|---|
| Latency spike: Base → Lasna → Base + Unichain | Done (2026-11-23) |
| DepegSentinel state machine, PolicyVault, PegKeeper | Next |
| Dashboard (policies, trigger depeg, latency timeline) | Planned |

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
```

Stack: Foundry, Solidity 0.8.29 (`evm_version = paris` for Lasna), `reactive-lib-omni`.
