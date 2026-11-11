# AUTO HUNT strategy: "Graduation Momentum"

Code: [src/strategy/strategy.ts](../src/strategy/strategy.ts) (pure, unit-tested), orchestration in
[src/trading/hunt.ts](../src/trading/hunt.ts). Every threshold is an env var (see `.env.example`).

## Why this strategy (and not sniping)

The capital is tiny: roughly $5–$10 a day, batched into $20+ bridge transfers, so positions are about
0.05–0.5 SOL. That rules several approaches out:

| Approach | Why it's a poor fit for BAGFLIP |
|---|---|
| First-block sniping of new Pump.fun launches | Won by co-located bots with private relays and bundles. Most launches are dumped or rugged within minutes. We'd consistently buy the top of someone else's bundle. |
| Market making / arbitrage | Needs inventory, low latency and size. Fees eat a small book. |
| Long-horizon "gems" | Needs judgment we can't automate, and capital sits idle. |
| **Momentum continuation on tokens that already proved demand** | Works at any size. The signal is visible in public data. Liquidity exists for exits. Fits a 15s–30s polling loop. |

So BAGFLIP hunts tokens that have **survived the launch phase and are igniting**:

* tokens close to **completing the Pump.fun bonding curve** (≈$45k+ market cap on the curve), and
* **fresh Pump.fun graduates** on PumpSwap (migrated within the last ~6 hours),

when volume is **accelerating**, **buyers outnumber sellers**, and the move is **not yet vertical**.

## Discovery

* PumpPortal free WebSocket: `subscribeNewToken` (each launch gets one look after ~12 minutes) and
  `subscribeMigration` (re-checked every 30s for 24h). Verified 2026-11-09: create events carry `mint`,
  the creator (`traderPublicKey`) and `bondingCurveKey`.
* DexScreener `/token-profiles/latest/v1` and `/token-boosts/latest/v1` (Solana only).
* Metrics come from DexScreener `/tokens/v1/solana/{≤30 mints}`, verified to label curve pairs `pumpfun`
  and migrated pairs `pumpswap`.

## Entry

1. **Hard filters** (any one rejects; the reasons are logged in `market_observations`):
   * venue is `pumpfun`, `pumpswap`, `raydium` or `meteora`, quoted in SOL
   * pair age between 10 minutes and 72 hours
   * market cap between $25k and $8M
   * liquidity of at least $12k (except on the curve, where DexScreener reports none)
   * at least 150 trades in the last hour and 15 in the last 5 minutes
   * 5-minute sells are no more than 1.25× buys
   * 5-minute and 1-hour price change both positive
   * 5-minute change at most +60% and 1-hour change at most +500% (don't chase verticals)
2. **Explainable score**, 0–1, with weights:

   | Component | Weight | 1.0 when |
   |---|---|---|
   | Volume acceleration | 0.22 | 5m volume ≥ 4× the hour's average 5m pace |
   | Buy pressure | 0.18 | ≥ 75% of 5m trades are buys |
   | Short momentum | 0.15 | +15% in 5m (halved above +40%) |
   | Hour trend | 0.10 | +100% in 1h |
   | Activity | 0.15 | ~2,000 trades in 1h (log scale) |
   | Depth | 0.10 | curve: market-cap progress to completion; AMM: liquidity ≥ 15% of market cap |
   | Lifecycle | 0.10 | fresh graduate = 1, near curve completion = 0.8, else 0.3 |

   An entry needs a score of at least `ENTRY_SCORE_THRESHOLD` (0.65).
3. **Confirmation**: the token must pass on **two consecutive scans** at least 20s apart, and the price
   must not drop more than 2% between them. A one-candle spike doesn't count.
4. **On-chain safety** ([src/market/safety.ts](../src/market/safety.ts)). Reject if:
   * the mint or freeze authority is still set
   * the token uses a risky Token-2022 extension (transfer fee, permanent delegate, transfer hook,
     non-transferable, default account state, pausable)
   * the largest non-pool holder has over 12%, or the top-10 non-pool holders have over 35%
   * the known creator still holds over 8%
5. **Executable round trip.** Get a real buy quote for the position size, then a real sell quote for the
   tokens that buy would return. Reject if price impact is over 4% or the round trip loses over 12%.
   This catches honeypots (no sell route), thin pools and fee-heavy routes **before** money moves.
6. **Sizing** ([src/trading/risk.ts](../src/trading/risk.ts)):
   * size = `POSITION_SIZE_PERCENT` (50%) of BAGFLIP trading capital, at most 2 concurrent positions,
     capped by the free balance after the SOL fee reserve, network fees and token-account rent
   * if the position would be under `MIN_POSITION_SOL`, or fixed fees would be over 3% of it, the
     trade is **deferred** until more capital accumulates
   * the bot never trades just because money is available

## Exit

All exit checks use the **executable sell quote** for the tokens actually held (net of venue fees),
not a mid price. That makes price impact and liquidity collapse part of the mark. Every exit is a
best-effort trigger: it starts a sell, and the realized price is whatever the chain gives.

| Rule | Trigger | Action |
|---|---|---|
| Crash / rug | value falls ≥50% between two checks (15s) | sell all, 50% slippage |
| Liquidity collapse | pool liquidity < 40% of entry liquidity | sell all, 50% slippage |
| Stop loss | −30% | sell all |
| Take profit | +80% | sell 50% (once) |
| Trailing stop | after peak ≥ +40%, value −25% from peak | sell the rest |
| Momentum faded | after 3h, P&L < +10% and 5m volume < 30% of entry | sell all |
| Max hold | 24h | sell all |
| Wind-down | mode ≠ AUTO HUNT | sell all; after 2 failed attempts slippage escalates to 50% |

After a full exit the token is on a 6h re-entry cooldown. A failed or reverted entry puts it on a 1h
cooldown so fees aren't burned retrying it. After the wind-down window (`WINDDOWN_MAX_HOURS`), a position
that still can't be sold is **written off**: its cost becomes a realized loss and the tokens stay
recorded in the wallet.

## Costs this strategy must overcome (measured, not assumed)

* Jupiter Swap V2 round trip on a live Pump.fun curve token, 0.05 SOL: **2.97%** (verified 2026-11-09).
  Jupiter charges 10 bps on most pairs and 50 bps on tokens under 24h old. PumpPortal Local API charges
  0.5% per trade.
* Network: 5,000 lamports base plus the priority fee (`PRIORITY_FEE_LAMPORTS`, default 0.0001 SOL) per
  transaction.
* Token-account rent of 0.00204 SOL per new token, recovered when the account is closed after a full exit.
* 1Click bridge: about 0.5% (5 NEAR → 0.2028 SOL quoted at $17.55 → $17.47). Batched by
  `MIN_CROSS_CHAIN_TRANSFER_USD`.

A position therefore needs roughly a +4–6% move just to break even. The exit ladder is shaped for
asymmetric outcomes (cut at −30%, let winners run past +80%), not for a high win rate.

## Known risks the strategy can't remove

* **Rugs between checks.** A 15s polling loop can't beat a dev dump in one block. The crash rule sells
  the remains.
* **Failed exits.** Congestion, expired blockhashes and slippage can fail a sell. The engine retries
  with escalating slippage and never assumes the exit happened.
* **No route.** If no venue quotes a sell, the position can't be priced or sold. It's held, retried, and
  eventually written off.
* **Data lag.** DexScreener aggregates lag the chain by seconds to a minute.
* **Fees vs. size.** Small positions pay proportionally more in fees, so trades are deferred until the
  economics work.

## Evaluating before going live

1. `node scripts/paper-scan.ts --minutes 30` shows what the live scanner sees (no DB, no orders).
2. Run `BAGFLIP_ENV=paper` for days. Every signal and every held-position mark is recorded in
   `market_observations`, paper fills use real Jupiter quotes with extra adverse slippage, and 5% of
   transactions fail at random.
3. `node scripts/replay.ts --since 2026-11-10` replays the recorded data through the same entry and exit
   functions. Treat the result as an **upper bound**: replay can't model failed exits or rugs between
   observations.
4. Only then set `BAGFLIP_ENV=live` plus `LIVE_TRADING_ENABLED=true`, with a small funded trading wallet.
