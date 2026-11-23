# PegShield: demo video script (target 2:40, hard limit 2:50)

Language: English. Pace ~140 words/min. All numbers come from `docs/depeg-bench-2026-11-23.txt`
and `docs/depeg-loop-2026-11-23-run1.txt`. Do not speed up or edit any on-screen latency number.

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:15 | Title card "PegShield", then https://pegshield-one.vercel.app at the top, peg gauge showing ~1.00 and status Normal. | When a stablecoin loses its peg, you have seconds, not minutes. Bots are late, and insurance claims take days. PegShield reacts on-chain, across three chains, with no keeper and no claim form. |
| 0:15–0:40 | Scroll to the LoopFlow card (5-step flow with p50/p95 bars). Point at each step with the cursor: Base swap, Lasna sentinel, Base keeper, Unichain payout, vault reopened. | A big swap on Base Sepolia emits a Sync event. One Reactive contract on Lasna, the DepegSentinel, watches it. Price under 0.97 is Watch. Three confirmations in a row is Depegged. Then a single react call fires two callbacks: the PegKeeper on Base buys stablecoin back, and the PolicyVault on Unichain pays every open policy. |
| 0:40–1:00 | Scroll to the "Buy depeg cover" panel (Unichain Sepolia). Wallet already connected. Enter coverage `10000`, click **Buy cover**, confirm in wallet. Wait for the green "done" step and the tx link. | First, I buy cover. Ten thousand test dollars of coverage for a two percent premium, on Unichain. The policy is now open. |
| 1:00–1:15 | Scroll up to the "Trigger a test depeg" button (`#drill`). Say what it does, then click it and confirm in wallet. Keep the PegStatus gauge and LatencyStrip in frame. | Now the drill. This button sends three large dumps into the Base pool in one transaction. Price falls from 1.00 to about 0.89. Watch the gauge. |
| 1:15–1:40 | Gauge drops into red, status goes Depegged; the new loop appears in "Timeline of depeg N" with marks on three lanes; the loops table gets a new row; then gauge returns to ~1.00 and status Normal. Pause on the finished strip. | Depegged on Lasna. Keeper buy on Base. Payout on Unichain. Peg restored, vault reopened. The whole loop finishes in about six seconds, and each mark on the strip links to its transaction. |
| 1:40–2:05 | Click the strip marks one by one, each opens in a new tab prepared in advance: Lasna tx on https://lasna.reactscan.net, Base keeper tx on https://sepolia.basescan.org, Unichain payout tx on https://sepolia.uniscan.xyz. Show the event (Defended / DepegHandled) briefly on each. | Every step is a real transaction. Here is the reactive transaction on Lasna. Here is the keeper's callback on Base, with the Defended event. And here is the payout on Unichain: the policy holder was paid in full, with no claim. |
| 2:05–2:30 | Back to the dashboard LoopFlow p50/p95 bars. Then terminal: show `python3 -I scripts/depeg_demo.py --bench 10` (pre-recorded output of `docs/depeg-bench-2026-11-23.txt`, summary table in frame). | We measured ten full loops. Median wall time after the swap: Lasna confirms in 1.65 seconds, the keeper on Base in 1.99, the payout on Unichain in 2.83, and the vault reopens in 3.74. The slowest run, p95, paid out in 4.74 seconds. Ten out of ten completed. Anyone can reproduce it with this one command. |
| 2:30–2:40 | Terminal or browser at https://github.com/Akar-Samudra-Artifisial/pegshield, README visible; end card with repo URL and dashboard URL. | Block timestamps have one-second resolution and chains keep different clocks, so we report wall time and say so. Why Reactive? Without it, this needs an off-chain bot per chain. With it, one contract does the work. Code and docs: github.com/Akar-Samudra-Artifisial/pegshield. Thank you. |

## Word count and timing

Narration is 306 words (counted with awk over the Narration column). At 140 wpm that is about
2:11 of speech. The remaining ~30 s of the 2:40 target is on-screen waiting (two wallet
confirmations, the ~6 s loop, opening explorer tabs). If the take runs over 2:50, shorten
the explorer segment first.

## Pre-recording checklist

- [ ] Wallet has Base Sepolia ETH (drill tx, 3 dumps) and Unichain Sepolia ETH (mint, approve, buyPolicy).
- [ ] Wallet is connected on https://pegshield-one.vercel.app and on the right chain per action.
- [ ] Sentinel status is Normal and pool price ~1.00 (check PegStatus; read `status` on Lasna, `0 NORMAL`).
- [ ] Keeper treasury is not empty (bench ended at 32,043 mUSD after 10 loops, about 5,662 mUSD per loop; top up if low).
- [ ] No previous loop still in progress (wait for vault reopened before starting).
- [ ] Explorer tabs open and logged in nothing: Lasna Reactscan, Basescan Sepolia, Uniscan Sepolia (links in `docs/submission.md`).
- [ ] Bench terminal output ready (run `python3 -I scripts/depeg_demo.py --bench 10` earlier or show `docs/depeg-bench-2026-11-23.txt`).
- [ ] Browser zoom 110%, notifications off, one clean take of the drill (about 15 s), record screen at 1080p.
- [ ] Upload (YouTube/Loom) and replace `<VIDEO_URL>` in `docs/submission.md`.

## Risk notes

- Public RPC slow or the wallet prompt hangs: cut the wait in the edit. Never speed up the video
  during the loop or alter the latency numbers; the dashboard timeline must stay at real speed.
- If the drill does not fire (a previous loop not finished, vault still closed), wait for Normal and retry.
- If the indexer is slow to show the new loop, say so and open the explorer txs first, then return.
- Show the bench numbers as measured (wall p50/p95) and keep the one-second-resolution caveat in the narration.
