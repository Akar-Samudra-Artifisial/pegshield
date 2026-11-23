# PegShield: DoraHacks "Submit Build" text (paste-ready)

Everything here is paste-ready. It is copied from `README.md`,
`deployments/testnet.env`, `docs/depeg-bench-2026-11-23.txt` and `docs/depeg-loop-2026-11-23-run1.txt`.

## Project name

PegShield

## Tagline (≤100 chars)

One Reactive contract defends a stablecoin peg and pays depeg insurance across 3 chains in seconds.

## Short description (≤300 chars)

PegShield watches a stablecoin pool on Base Sepolia from Reactive Lasna. On a confirmed depeg, one react() fires two callbacks: a PegKeeper buys back the stable on Base, and a PolicyVault pays insurance on Unichain Sepolia. 10/10 full loops, payout p50 2.83 s, p95 4.74 s.

## Track

Every Second Counts

## Full description (markdown)

### Problem

Stablecoin depegs unfold in seconds. Off-chain bots and manual insurance claims are too slow, and a
cross-chain response normally needs one bot per chain.

### How it works

1. A large swap in the stablecoin pool (MockPair, Base Sepolia) emits a `Sync` event.
2. `DepegSentinel` on Reactive Lasna reads every `Sync`. State machine: NORMAL, WATCH (price < 0.97),
   DEPEGGED (3 consecutive confirmations).
3. On confirmation one `react()` emits two callbacks:
   - **PegKeeper** (Base Sepolia) buys the stablecoin back with capped treasury buys.
   - **PolicyVault** (Unichain Sepolia) pays every open parametric depeg policy in full, with no claim form.
4. The buy-back emits a new `Sync`. Price back at 0.99 or higher returns the sentinel to NORMAL and the vault reopens.

`DepegDrill` is a testnet helper: three large dumps in one transaction (pool 1.00 to about 0.89) for a one-click demo.
The dashboard has a peg gauge, a loop flow with p50/p95, a three-lane latency strip, a loop table, a "Trigger a test depeg" panel and a "Buy cover" panel.

### Why Reactive

The whole defense is one reactive contract on Lasna. No bots, no relayers, no per-chain keepers.
It subscribes to a Base event and drives callbacks on two other chains, which is the cross-chain,
event-driven work Reactive Network is built for.

### Latency results

10 full loops (`python3 -I scripts/depeg_demo.py --bench 10`), 10/10 completed, 2026-11-23.
Seconds after the origin drill tx on Base Sepolia.

| Stage | block delta p50 | block delta p95 | wall p50 (s) | wall p95 (s) |
|---|---|---|---|---|
| Lasna: sentinel confirms DEPEGGED | -1 | 0 | 1.65 | 1.78 |
| Base: PegKeeper `Defended` (buy-back) | 1 | 2 | 1.99 | 2.10 |
| Unichain: PolicyVault `DepegHandled` (payout) | 2 | 3 | 2.83 | 4.74 |
| Unichain: PolicyVault `Recovered` (vault reopens) | 3 | 4 | 3.74 | 5.55 |

Method and caveats: block delta is destination block timestamp minus origin block timestamp (1 s resolution,
Lasna's clock reads about 1 s behind Base, hence -1). Wall time is the local clock from the origin receipt to
the 0.25 s poll that saw the log, so it includes polling and public-RPC round trips. p95 is nearest-rank
(n=10, the slowest run). Logs: `docs/depeg-bench-2026-11-23.txt`, `docs/depeg-bench-2026-11-23.json`.

### How to try

- Live dashboard (testnet, read-only without a wallet): https://pegshield-one.vercel.app
- Connect a wallet with Base Sepolia and Unichain Sepolia ETH. "Buy cover" mints test mUSD, approves and buys a policy (2% premium, 7-day term).
- Click "Trigger a test depeg" and watch the timeline and payout appear.
- Reproduce locally: `cd contracts && forge test`, then `python3 -I scripts/depeg_demo.py --bench 10`.

### Tech stack

Solidity 0.8.29 (Foundry, `evm_version = paris` for Lasna), `reactive-lib-omni`, 41 contract tests,
Next.js dashboard (`web/`, viem) on Vercel, Python scripts for deploy and latency measurement.

### What's next

- **Real Uniswap v4 pools**: watch live stablecoin pools on Base and Unichain instead of the MockPair.
- **Pro-rata payouts**: when open cover exceeds vault capital, pay every policy its share in one callback instead of a full payout queue.
- **Multi-stablecoin**: one sentinel tracking several stablecoins, each with its own thresholds, keeper and policy book.

## Links

- Repository: https://github.com/Akar-Samudra-Artifisial/pegshield
- Live demo: https://pegshield-one.vercel.app
- Video (<3 min): https://youtu.be/IXj_Qs9nCVo
- Hackathon: https://dorahacks.io/hackathon/reactive-omni-buildathon/detail

## Contract addresses

Base Sepolia (84532), explorer https://sepolia.basescan.org

| Contract | Address |
|---|---|
| MockStable (mSTB) | [0xce47e1a57026470854347af452804f1d2bd0f0aa](https://sepolia.basescan.org/address/0xce47e1a57026470854347af452804f1d2bd0f0aa) |
| MockUSD (mUSD) | [0x49746328fdc3787f17e9374b00ef315fb11c33f0](https://sepolia.basescan.org/address/0x49746328fdc3787f17e9374b00ef315fb11c33f0) |
| MockPair | [0xbbe79dc4775a7ed7031a9d47528cd1c43c35f1bd](https://sepolia.basescan.org/address/0xbbe79dc4775a7ed7031a9d47528cd1c43c35f1bd) |
| PegKeeper | [0xf7c42496d513ab05650029fa2e5da0d2a2542c2e](https://sepolia.basescan.org/address/0xf7c42496d513ab05650029fa2e5da0d2a2542c2e) |
| DepegDrill (testnet trigger) | [0x6d2a1f649634598044db76a4f9e1cc182ca2991e](https://sepolia.basescan.org/address/0x6d2a1f649634598044db76a4f9e1cc182ca2991e) |

Reactive Lasna (5318007), explorer https://lasna.reactscan.net

| Contract | Address |
|---|---|
| DepegSentinel | [0x729215e645fe4b9eec8a2e9d7eb40482cd276894](https://lasna.reactscan.net/address/0x729215e645fe4b9eec8a2e9d7eb40482cd276894) |

Unichain Sepolia (1301), explorer https://sepolia.uniscan.xyz

| Contract | Address |
|---|---|
| MockUSD (mUSD) | [0xef28b0405637d399087aca3bd0dc716374fd8edb](https://sepolia.uniscan.xyz/address/0xef28b0405637d399087aca3bd0dc716374fd8edb) |
| PolicyVault | [0x729215e645fe4b9eec8a2e9d7eb40482cd276894](https://sepolia.uniscan.xyz/address/0x729215e645fe4b9eec8a2e9d7eb40482cd276894) |

## Transactions: full loops

### Run 1 (policy paid out in full, 10,000 mUSD)

| Step | Chain | Tx hash |
|---|---|---|
| Origin swap (confirming dump) | Base Sepolia | [0x6f60ab74256f42a7a8e9012d07c769d86f88ddc542a0d805b3a5e6fe1085047f](https://sepolia.basescan.org/tx/0x6f60ab74256f42a7a8e9012d07c769d86f88ddc542a0d805b3a5e6fe1085047f) |
| Lasna react (sentinel DEPEGGED) | Lasna | [0x162b43c36237a60db693f83ea05e34cd0142e6d82e435a6567b851dc03977356](https://lasna.reactscan.net/tx/0x162b43c36237a60db693f83ea05e34cd0142e6d82e435a6567b851dc03977356) |
| Keeper callback (buy-back) | Base Sepolia | [0xd9a057b1973b5217f07045dacd05fcf0e3275da0a63e31f12aa630ee9bf05b50](https://sepolia.basescan.org/tx/0xd9a057b1973b5217f07045dacd05fcf0e3275da0a63e31f12aa630ee9bf05b50) |
| Vault payout | Unichain Sepolia | [0x2c6b89d48388ab7b936182e4b5cca5a2a6c29ceb541ca8c87f8a3755f0d5686c](https://sepolia.uniscan.xyz/tx/0x2c6b89d48388ab7b936182e4b5cca5a2a6c29ceb541ca8c87f8a3755f0d5686c) |
| Recovered (peg restored, vault reopens) | Unichain Sepolia | [0x2ede435233840afcfad43e8ca9014a6ca42492c399bc56618db822dcd94dfc62](https://sepolia.uniscan.xyz/tx/0x2ede435233840afcfad43e8ca9014a6ca42492c399bc56618db822dcd94dfc62) |

### Bench loop, epoch 13 (last of 10, latency only)

| Step | Chain | Tx hash |
|---|---|---|
| Origin drill | Base Sepolia | [0x725fcc0a8c4b35c09af5bc6705f47b4559722029b27ee03f81f63e0d9d3c4f9e](https://sepolia.basescan.org/tx/0x725fcc0a8c4b35c09af5bc6705f47b4559722029b27ee03f81f63e0d9d3c4f9e) |
| Lasna react | Lasna | [0xf41b11755a9d5fc36e3c64c7fe3b3e76aa41496df098287f819b08393435c7a7](https://lasna.reactscan.net/tx/0xf41b11755a9d5fc36e3c64c7fe3b3e76aa41496df098287f819b08393435c7a7) |
| Keeper callback | Base Sepolia | [0x9219aac2f2d81d197b2e3dd86d7a69a9a315d705164aa846d5106de8ee6856da](https://sepolia.basescan.org/tx/0x9219aac2f2d81d197b2e3dd86d7a69a9a315d705164aa846d5106de8ee6856da) |
| Vault payout handled | Unichain Sepolia | [0x60ab31a05399e38e20754f5db8b8669522b4e616047a4bd46ade1e071a66a51e](https://sepolia.uniscan.xyz/tx/0x60ab31a05399e38e20754f5db8b8669522b4e616047a4bd46ade1e071a66a51e) |
| Recovered | Unichain Sepolia | [0xe4f9765f94a2f513fc5a37550fa1ba17a313e6a8bd657a3fe3adb11291a24256](https://sepolia.uniscan.xyz/tx/0xe4f9765f94a2f513fc5a37550fa1ba17a313e6a8bd657a3fe3adb11291a24256) |

All bench tx hashes (epochs 4 to 13): `docs/depeg-bench-2026-11-23.txt`.

### Browser-wallet loop, epoch 14 (dashboard "Buy cover" + "Trigger a test depeg", 1,000 mUSD policy paid)

| Step | Chain | Tx hash |
|---|---|---|
| Buy policy #2 (1,000 mUSD cover) | Unichain Sepolia | [0xd401c1bd7ae82fd6cfc1fe03cbacc9012e5c7e19121e79230045364d8a765ded](https://sepolia.uniscan.xyz/tx/0xd401c1bd7ae82fd6cfc1fe03cbacc9012e5c7e19121e79230045364d8a765ded) |
| Origin drill | Base Sepolia | [0x8d6105090331dcef785676511e1d4bdd515a3c05090688c30d3a655411a247f9](https://sepolia.basescan.org/tx/0x8d6105090331dcef785676511e1d4bdd515a3c05090688c30d3a655411a247f9) |
| Lasna react (sentinel DEPEGGED) | Lasna | [0xe04cd96751b94b29699a3fea56468357252d73677ade73438cf69bc86172a55c](https://lasna.reactscan.net/tx/0xe04cd96751b94b29699a3fea56468357252d73677ade73438cf69bc86172a55c) |
| Keeper callback (buy-back) | Base Sepolia | [0x75d7c5acbd31edc1a84c694691c5f322f7231f58585e30706049c5d0a773f200](https://sepolia.basescan.org/tx/0x75d7c5acbd31edc1a84c694691c5f322f7231f58585e30706049c5d0a773f200) |
| Vault payout | Unichain Sepolia | [0x491aefb24130bae0b1c95b9c742a99e4b7f6b6c06163cff9e152f2fad92bdb2b](https://sepolia.uniscan.xyz/tx/0x491aefb24130bae0b1c95b9c742a99e4b7f6b6c06163cff9e152f2fad92bdb2b) |
| Lasna react (sentinel back to NORMAL) | Lasna | [0x7877b46634da12f853285efea5b7c9d012380af3aade48ea55cf7a0dc915d291](https://lasna.reactscan.net/tx/0x7877b46634da12f853285efea5b7c9d012380af3aade48ea55cf7a0dc915d291) |
| Recovered (vault reopens) | Unichain Sepolia | [0x5604def2907cb3d7e5abc41526e4a73977e4998e0e9b248e8bb95db5b56cea5b](https://sepolia.uniscan.xyz/tx/0x5604def2907cb3d7e5abc41526e4a73977e4998e0e9b248e8bb95db5b56cea5b) |

## Honest notes

Block timestamps have 1 s resolution and the chains' clocks differ, so Lasna can read about 1 s early (block delta -1).
Wall times include polling and public-RPC round trips. Run 1's wall clock started about 0.3 s late; its block deltas are unaffected.
Contracts are testnet mocks and are not audited.

## Team

Solo build by Bayu Trisnapati (Akar Samudra Artifisial). Contact via DoraHacks or the GitHub organization
https://github.com/Akar-Samudra-Artifisial.
