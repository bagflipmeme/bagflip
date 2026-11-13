# BAGFLIP: project overview

> **Take the reward, or flip the bag.**
> BAGFLIP is a community-controlled meme treasury that runs in Telegram. Creator tax rewards from the
> BAGFLIP token on NEAR go into a keyless vault contract. Every day, holders decide by weighted vote
> whether the money is **distributed** to them or used to **AUTO HUNT**: autonomous, extremely
> high-risk meme-token trading on Solana.

Status as of 2026-11-11:
- The code is built and tested: 77 TypeScript tests and 17 Rust contract tests.
- The integrations are verified against mainnet with read-only checks.
- The aggressive strategy has been paper-tested on live market data.
- Nothing is deployed, and no real money has moved.

---

## Contents

1. [Concept](#1-concept)
2. [The wallets](#2-the-wallets)
3. [End-to-end workflow](#3-end-to-end-workflow)
4. [Governance: continuous weighted voting](#4-governance-continuous-weighted-voting)
5. [The vault contract](#5-the-vault-contract)
6. [The Holder Council](#6-the-holder-council)
7. [Treasury accounting](#7-treasury-accounting)
8. [DISTRIBUTE mode](#8-distribute-mode)
9. [AUTO HUNT mode](#9-auto-hunt-mode)
10. [The trading strategy](#10-the-trading-strategy)
11. [Strategy comparison and the scanner funnel](#11-strategy-comparison-and-the-scanner-funnel)
12. [Cross-chain bridge (NEAR Intents 1Click)](#12-cross-chain-bridge-near-intents-1click)
13. [Telegram bot](#13-telegram-bot)
14. [Security and safety controls](#14-security-and-safety-controls)
15. [Environments](#15-environments)
16. [Architecture and code map](#16-architecture-and-code-map)
17. [Data model](#17-data-model)
18. [Testing](#18-testing)
19. [Verified facts (live checks)](#19-verified-facts-live-checks)
20. [Configuration (your values)](#20-configuration-your-values)
21. [Deployment and go-live plan](#21-deployment-and-go-live-plan)
22. [What's done vs. what's pending](#22-whats-done-vs-whats-pending)
23. [Risks, limits and legal questions](#23-risks-limits-and-legal-questions)

---

## 1. Concept

- The **BAGFLIP token** (`bagflip.v2-launchpad.justhoot.near`) trades on the justhoot launchpad. Each
  trade pays a fee, and **100% of the creator share** goes to the fee recipient, in **wNEAR**.
- Those rewards fund the **BAGFLIP vault**, a smart contract that nobody holds a key to.
- BAGFLIP holders vote in Telegram, weighted by how much BAGFLIP they hold. There are exactly two
  options:
  - **💰 DISTRIBUTE:** rewards are split pro-rata among holders, who claim them.
  - **🔥 AUTO HUNT:** an autonomous bot bridges capped amounts to Solana and trades Pump.fun meme
    tokens. It can lose everything.
- Votes are **continuous**: they persist until changed. The result is settled every day at
  **00:00 Malaysia time (MYT)**.
- Everything is **auditable**: every vote snapshot, payout list, ledger entry and transaction is
  published.

## 2. The wallets

| Account | Chain | Role | Who controls it |
|---|---|---|---|
| `bagflip.near` | NEAR | **Creator wallet.** Currently receives the launchpad rewards and holds your BAGFLIP. It can vote and hold a council seat. | You |
| `bagflip-vault.near` *(to create)* | NEAR | **The vault.** The contract that holds the community rewards. All of its keys are deleted after deployment. | **Nobody.** Only the contract's rules apply. |
| `bagflip-bot.near` *(to create)* | NEAR | **Operator.** The bot sends the vault its daily instructions with a function-call key that can only call vault methods. | The bot (limited) |
| `EwMZcvgdnZRuQxzz66bq86EYSpgLcA4ppW6eEAut8FuQ` | Solana | **Trading wallet.** Used only for AUTO HUNT trading. | The bot |

**The reward handover** (planned for deployment day):
1. `bagflip.near` calls `propose_dev_transfer` on the launchpad, naming the vault.
2. The vault accepts while it still has keys.
3. The launchpad then pays rewards **straight into the vault**.
4. The vault's keys are deleted.

If the launchpad refuses the handover, the fallback is that you forward rewards manually. Those
transfers are public and get credited as deposits.

## 3. End-to-end workflow

```
                 BAGFLIP trades (5% transfer fee, 1% pool fee)
                                   │  creator share (wNEAR)
                                   ▼
     bagflip.near ──(handover)──▶ VAULT bagflip-vault.near (no keys)
                                   │
       Telegram: holders vote continuously (weight = BAGFLIP held)
                                   │
                    00:00 MYT: snapshot at one NEAR block → decision
                         │                                │
                  DISTRIBUTE wins                   AUTO HUNT wins
                         │                                │
     bot builds pro-rata payout list          vault waits 12h (council can veto)
     → posts its Merkle root to the vault     → max 50 NEAR / 24h via NEAR Intents
     → 24h veto window (council)              → SOL arrives in the trading wallet
     → holders claim (bot relays or self)     → bot scans, scores, vets, trades
     → vault pays ONLY the listed account     → profits recycle; losses can reach 0
                                              → if DISTRIBUTE wins later: positions are
                                                unwound and SOL is bridged back
```

**The daily cycle in detail:**
1. **All day:** votes are accepted, deposits detected, the live tally and pinned Telegram message
   updated, and open positions managed.
2. **At 00:00 MYT:**
   - take the first final NEAR block at or after midnight;
   - rebuild every wallet's vote as of midnight from the append-only vote log;
   - read every voting wallet's balance at that one block;
   - decide, then record the decision and its per-wallet snapshot (immutable);
   - announce it in Telegram;
   - mirror it to the vault (`propose_mode`), with a sha256 hash of the published snapshot.
3. **After the decision:** the treasury is routed for the new mode (reserve for distribution, or fund
   trading).

## 4. Governance: continuous weighted voting

- **Wallet linking (NEP-413).**
  - `/connect` opens a Mini App where the user signs a unique challenge with their NEAR wallet
    (HOT, Meteor, Intear, MyNearWallet and others, via NEAR Connect).
  - The challenge is single-use, expires after 10 minutes and names the Telegram user.
  - The backend checks the signature **and** that the key is a **full-access key** of that account on
    chain.
  - No seed phrases or private keys, ever.
- **Voting power** = the BAGFLIP balance of each verified wallet, at **one NEAR block**. Moving tokens
  between wallets can't count them twice, and a NEAR account links to only one Telegram user.
- **Votes persist** until changed, revoked or unlinked. A vote cast after midnight counts for the next
  day.
- **Decision rules:**
  - the mode changes only if the other option has **more than 50%** of valid weighted votes;
  - an exact **50/50** tie keeps the current mode, and **zero valid votes** keeps it too;
  - the system **starts INACTIVE** (no trading);
  - a **quorum** applies: a first activation needs 5% of eligible supply plus 3 wallets, and later
    switches need 3%. Missing quorum keeps the current mode.
- **Eligible supply** = total supply minus excluded accounts: the Rhea DCL pool
  `dclv2.ref-labs.near` (about **99.86%** of BAGFLIP), the vault, and the token contract.
- **Audit:** `/public/decisions/<cycle>` returns every decision with its per-wallet snapshot and the
  exact JSON whose sha256 is recorded in the vault.

## 5. The vault contract

The contract is `contracts/vault`: Rust, near-sdk 5.30.1, a 256 KB wasm, and 17 unit tests. It's
deployed to the vault account, and then **every key is deleted**. It has **no owner, no withdraw and
no upgrade** method.

**Money can leave in only two ways:**

| Path | Rules enforced on chain |
|---|---|
| `claim` / `claim_many` (anyone can call) | Pays **only the account named in the payout list's Merkle leaf**, only after the list's **24h** veto window, at most **once** per list, and never more than the list's total. If a transfer fails, the claim reopens. |
| `fund_trading` (operator only) | Only while the mode is **AUTO_HUNT** (activated after a 12h time lock), at most **50 NEAR per rolling 24h**, and only from unreserved funds. The wrap and transfer to the NEAR Intents deposit address happen in one atomic receipt; if it fails, the cap is freed. |

**Risk asymmetry:**
- Switching to DISTRIBUTE or INACTIVE, pausing and vetoing all take effect **immediately**.
- Activating AUTO HUNT waits **12h**; new payout lists wait **24h**; admin changes wait **48h**.

**Payout list format** (identical in Rust and TypeScript, with shared test vectors):
```
leaf = sha256(0x00 ‖ epoch u64 LE ‖ amount u128 LE ‖ account_id)
node = sha256(0x01 ‖ min(a,b) ‖ max(a,b))
```

**What the contract can't verify, and how that's bounded:**
1. **The off-chain payout snapshot.** It's published, the council has 24h to check it, and a list can
   never pay more than its total.
2. **Which Solana address a NEAR Intents deposit pays out to.** The daily cap bounds it, every
   transfer is logged on chain with its quote reference, and the council can pause.
3. **The Solana trading key**, which is a hot key. The cap limits what can ever sit there; a TEE agent
   is the planned next step.

## 6. The Holder Council

- **Seats:** the **top 20 BAGFLIP holders** (your setting). Seats are decided **on chain**:
  - anyone can nominate an account with `claim_seat`;
  - the vault reads the balances itself (`ft_balance_of` on the token contract);
  - the larger **current** holder wins the seat;
  - someone who sells is displaced by anyone who now holds more.
- **Excluded from seats:** pools (`dclv2.ref-labs.near`), the vault, the token contract, the operator
  and wrap.near.
- **No buy-and-vote:** a new seat can vote only after **24h**.
- **Powers** (your settings):
  - **5 seats:** veto a pending payout list, veto a pending AUTO HUNT activation, or pause the vault.
  - **11 seats + 48h:** change the operator, the daily cap or the exclusion list, or revoke an active
    payout list.
  - **11 seats:** unpause, with no delay.
- **Safety rules:**
  - thresholds scale down if fewer seats are filled, so the vault can never deadlock;
  - only votes from current, eligible seats count.
- **Never:** withdraw funds, pay themselves, or change the code.
- **Upkeep:** the bot nominates the current top holders every 6h, and the contract re-checks every
  balance.

## 7. Treasury accounting

- **Append-only double-entry ledger** in integer units (yoctoNEAR, lamports). There's no floating
  point for money.
- **Idempotency:** every journal has an idempotency key, and debits and credits balance per asset.
- **Non-negative balances:** spendable accounts can never go below zero, enforced inside the
  database transaction.
- **NEAR side:**
  - `treasury:available` (unreserved);
  - `distribution:pool` (reserved for distribution);
  - `distribution:claimable` (owed to holders);
  - `bridge:outbound` (in transit);
  - `equity:deposits` / `equity:distributed`.
- **SOL side:**
  - `trading:available`;
  - `trading:positions` (cost basis);
  - `bridge:inbound` (in transit);
  - `pnl:realized`.
- **Both:** `expense:fees`.
- **Deposits** are credited only from the creator wallet or listed senders (for example the
  launchpad), once per on-chain receipt. Anything else is an "unattributed inflow" and is never
  traded.
- **P&L:**
  - **realized** P&L comes only from settled transactions, with fees included;
  - **unrealized** P&L uses real executable sell quotes and is always labeled as such.
- **Reconciliation** compares on-chain balances to the ledger. Any shortfall pauses trading.

## 8. DISTRIBUTE mode

1. New buys stop at once, unsent orders are cancelled, and open positions are unwound with escalating
   slippage. After 6h, anything unsellable is written off; its tokens stay recorded.
2. Idle SOL is bridged back once it's worth at least $20.
3. Available NEAR moves into the distribution pool. Below $20 it keeps accumulating.
4. **Holder discovery:** all accounts that ever touched BAGFLIP, read from chain event history
   (complete), plus the top-100 list, plus registered wallets.
5. **Snapshot** at one block; each holder gets `pool × balance / eligible supply`, rounded down. The
   rounding dust stays in the pool. Unregistered holders are included; they can connect and claim
   later.
6. The bot posts the payout list's Merkle root, total and data hash to the vault, which starts the
   **24h council veto window**.
7. Holders claim:
   - **with the bot:** `/claim` in Telegram, and the bot relays the claim;
   - **or directly:** take the proof from `/public/proofs/<account>` and call the vault yourself.

   Either way the vault pays only the listed account, and never twice.
8. **If the council vetoes a list:** its money returns to the pool and is redistributed from a fresh
   snapshot.
9. Unclaimed rewards stay reserved.

## 9. AUTO HUNT mode

1. The vault activates AUTO HUNT after the 12h time lock, unless the council vetoes it.
2. Unreserved NEAR is bridged to SOL through NEAR Intents 1Click. Each transfer must be worth at least
   $20 and fit the vault's 50 NEAR/day cap. SOL is credited only after 1Click reports success
   **and** the Solana transaction is confirmed.
3. The trading engine scans, scores, vets and trades (see §10). Profits recycle into new trades.
4. **New entries pause automatically** when:
   - the mode isn't AUTO HUNT, or the vault is paused or still time-locked;
   - the emergency pause is on;
   - reconciliation fails;
   - there are repeated RPC failures;
   - an order has been stuck for more than 10 minutes;
   - live trading isn't enabled.
5. Open positions are always still managed, whatever the pause reason.

## 10. The trading strategy

**Graduation Momentum** hunts Pump.fun tokens that have **already proven demand**, rather than
sniping brand-new launches, which bots with private infrastructure win and which mostly rug. It
targets:
- tokens **about to finish the bonding curve**;
- tokens that **just graduated** to PumpSwap;
- tokens with **accelerating volume and buy pressure**.

**Discovery** (continuous, free):
- PumpPortal WebSocket: every new token and every migration.
- GeckoTerminal: 5-minute trending pools, newest pools (PumpSwap graduates), and the busiest Pump.fun
  curve tokens.
- DexScreener: token profiles and boosts.
- **Re-checking:**
  - **fresh graduates every 10s** for their first 30 minutes;
  - **near-graduation curve tokens every 15s**;
  - new launches from 2 minutes old on a growing interval;
  - dead launches are dropped.

**Score** (0–1, explainable), with hard filters applied before scoring:

| Component | Weight |
|---|---|
| Volume acceleration (5m vs hourly pace) | 0.22 |
| Buy pressure (share of buys in 5m) | 0.18 |
| Short momentum (5m price change) | 0.15 |
| Activity (trades per hour) | 0.15 |
| Hour trend (1h price change) | 0.10 |
| Depth (liquidity or curve progress) | 0.10 |
| Lifecycle (just graduated or near graduation) | 0.10 |

**Two variants.** The engine runs **aggressive** (the default). Original stays available for comparison.

| | original | **aggressive** |
|---|---|---|
| Entry score | 0.65 | **0.52** |
| Confirmation | 2 scans, ≥20s apart | **immediate** at score ≥0.68 or for a graduate ≤20 min old; otherwise a 2nd scan ≥8s later |
| Min age | 10 min | 3 min (curve), **0 (fresh graduate)** |
| Market cap | $25k – $8M | $12k – $25M |
| Liquidity | ≥$12k | ≥$6k |
| Trades | ≥150/h, ≥15/5m | ≥60/h, ≥6/5m |
| 5m change / 1h change | > 0% / > 0% | > −3% / > −15% |
| Holder concentration | top-1 ≤12%, top-10 ≤35% | top-1 ≤20%, top-10 ≤50% |
| Round-trip cost / price impact | ≤12% / ≤4% | ≤15% / ≤6% |
| Stop loss | −30% | −35% |
| Take profit | sell 50% at +80% | sell 40% at +60% |
| Trailing stop | −25% after +40% | −22% after +30% |

**Never relaxed (both variants):**
- no mint authority, no freeze authority, no risky Token-2022 extensions;
- a **real buy-then-sell-back quote** must exist, so honeypots are skipped;
- every live transaction is simulated before it's sent;
- settlement amounts are read from the chain.

**Always-on exits:**
- a crash (≥50% drop between checks) or a liquidity collapse triggers an emergency sell;
- a momentum-fade exit;
- a **24h max hold**.

**Sizing:** up to 4 positions at a time, each up to 25% of trading capital. A trade is deferred if
it's below 0.05 SOL or if fees would be over 3% of it. **No forced trades**: if nothing qualifies,
nothing is bought.

**Execution venues:**
- **Jupiter Swap V2** (`/order` + `/execute`), which routes Pump.fun curve tokens and PumpSwap;
- **PumpPortal local transactions** as a fallback.

**Order safety:**
- every transaction is signed and its signature saved **before** sending, so a crash can never
  duplicate an order;
- a failed or expired transaction never books a trade.

## 11. Strategy comparison and the scanner funnel

- **Shadow paper books** run original and aggressive **side by side on identical live scans**, each
  with 1 virtual SOL.
  - Fills use real Jupiter quotes plus extra slippage, fees and random failures.
  - They never sign anything and never touch the ledger.
  - Commands: `/experiment` (admins), `GET /admin/experiment`, `node scripts/paper-compare.ts`.
- **The scanner funnel** records, per scan and per variant:
  - **discovered:** new tokens, by source;
  - **checked / snapshots;**
  - **filtered:** each hard-filter reason;
  - **scored → below threshold;**
  - **waiting** (with reasons) **→ confirmed;**
  - **rejected:** by safety, by quotes or by sizing;
  - **executed / failed entries.**

  See it with `/funnel`, `GET /admin/funnel`, or the `scan_funnel` table.
- **First live result** (45 minutes, 2026-11-11):

  | | original | aggressive |
  |---|---|---|
  | Trades | 0 | **2** |
  | Unrealized result | 0% | **+16.3%** (both trades still open) |
  | Execution failures | 0 | 0 |

  Aggressive was full most of the time: about 310 signals were skipped because both slots were in
  use. The sample is far too small to judge; keep paper trading for days first.
- **Bugs found by this run** (both fixed): a wrong Token-2022 program ID, and a broken GeckoTerminal
  feed.

## 12. Cross-chain bridge (NEAR Intents 1Click)

- **API:** `https://1click.chaindefuser.com` — `/v0/quote`, `/v0/status` and `/v0/deposit/submit`.
- **Routes:** wNEAR → SOL and SOL → wNEAR, both verified with dry quotes (5 NEAR → 0.2028 SOL in about
  17s).
- **State machine:** quoted → submitting → deposited → processing → success, refunded or failed.
  - The deposit transaction is persisted before it's broadcast.
  - Credit happens only after `SUCCESS` **plus** a destination-chain confirmation.
  - Refunds return the funds to available; a failure stays "in transit" until an operator resolves it.
  - Expiry is proven (the transaction provably never landed) before anything is reversed.
- **Batching:** transfers are batched to at least $20, so fees stay small.

## 13. Telegram bot

- **Everyone:** `/start` `/help` `/vote` `/status` `/treasury` `/trades` `/pnl` `/council`
  `/disclosures` `/whoami`
- **DM only:** `/connect` `/power` `/claim` `/disconnect <account>`
- **Admins** (ID `9224700927`): `/pause` `/resume` `/deposit <tx>` `/post_governance` `/admin`
  `/funnel` `/experiment`
- **The group** (`-1004404598029`):
  - one pinned governance message with **💰 DISTRIBUTE / 🔥 AUTO HUNT** buttons, updated in place;
  - announcements for deposits, decisions, mode changes, trades opened and closed, claimable rewards,
    failures and pauses.
- **The only web page** is the wallet-signing Mini App. Everything else happens in Telegram.
- **Public JSON endpoints:**
  - `/public/decisions[/:cycle]`
  - `/public/ledger`
  - `/public/distributions/:id`
  - `/public/proofs/:account`
  - `/public/vault`

## 14. Security and safety controls

- **Keys:**
  - no treasury key exists; the vault has no keys;
  - the operator key can only call vault methods;
  - keys are accepted only in live mode with explicit `LIVE_*` flags, and boot refuses unsafe
    configurations.
- **Logs:** they redact secrets.
- **Callbacks and identity:** callback data is strictly validated; the Telegram webhook needs a
  secret token; the Mini App's `initData` is HMAC-checked.
- **Admin access:** Telegram ID allow-list, with every admin action audited (append-only).
- **Rate limits:** per Telegram user and per IP.
- **Jobs:** a durable Postgres job queue with leases, retries and unique keys. A double-triggered
  midnight produces exactly one decision.
- **Restart recovery:** missed decisions are caught up, in-flight bridge transfers are resumed, and
  every submitted order is settled from the chain.
- **Repo hygiene:** `.env` is gitignored, and commits use `bagflip <bagflig.meme@gmail.com>` with
  Claude as co-author.

## 15. Environments

| | development | paper | live |
|---|---|---|---|
| NEAR | simulated | real reads | real |
| Market data | simulated | real (DexScreener, PumpPortal, GeckoTerminal) | real |
| Trading | simulated market | paper fills on real Jupiter quotes | real (needs `LIVE_TRADING_ENABLED`) |
| Vault | in-process model of the same rules | in-process model | real contract (operator calls need `LIVE_TRANSFERS_ENABLED`) |
| Money moves | never | never | yes, after explicit enablement |

## 16. Architecture and code map

Node 24 runs the TypeScript directly. The stack is PostgreSQL (or PGlite locally), grammY,
`@near-js`, `@solana/web3.js`, Docker and Railway. One process can run bot, API and worker
(`ROLE=all`). **Run exactly one worker.**

```
contracts/vault/      keyless vault (Rust), tests, shared Merkle vectors, built wasm
migrations/           001 schema · 002 vault lists/mode syncs · 003 funnel + shadow trades
src/governance/       decision engine (pure), wallets/NEP-413, daily cycle
src/treasury/         ledger, deposits, routing, prices
src/near/             RPC, NEP-413, chain (real/sim), signer, vault client (+ SimVault)
src/distribution/     holder index, pro-rata, Merkle lists, vault sync, council seat sync, claims
src/bridge/           1Click client, vault/SOL depositors, transfer state machine
src/market/           discovery (PumpPortal, GeckoTerminal, DexScreener), on-chain safety
src/strategy/         variants, scoring, confirmation, exits, replay
src/trading/          engine, evaluator + funnel, shadow books, reports, positions, risk, P&L, reconcile
src/solana/           RPC, settlement parsing, execution adapters (live/paper/simulated)
src/bot/ src/api/     Telegram bot + views, HTTP server, wallet Mini App
src/worker/           job handlers and loops
scripts/              verify-live, paper-scan, paper-compare, sync-holders, replay, vault-plan,
                      gen-merkle-vectors, dev-seed, migrate
tests/                77 tests (governance, treasury/trading, vault, aggressive, bot, security, units)
docs/                 STRATEGY, VAULT, SECURITY_AND_COMPLIANCE, this overview
```

## 17. Data model

- **Identity:** `users`, `wallets`, `auth_challenges`
- **Governance:** `votes`, `vote_events` (append-only), `governance_decisions` and
  `governance_snapshot_entries` (append-only)
- **Accounting:** `ledger_journals` and `ledger_entries` (append-only), `treasury_deposits`,
  `unattributed_inflows`
- **Bridge:** `bridge_transfers`
- **Trading:** `trading_positions`, `trading_orders`, `chain_transactions`, `market_observations`
- **Distribution:** `holder_index`, `distribution_events` and `distribution_entitlements`
  (append-only), `reward_claims`, `reward_claim_items`
- **Vault mirror:** `vault_distributions`, `vault_mode_syncs`
- **Strategy reporting:** `scan_funnel`, `shadow_trades`
- **Infrastructure:** `jobs`, `notifications` (outbox), `system_state`, `admin_audit` (append-only)

## 18. Testing

- **77 TypeScript tests** cover all 18 scenarios from the original brief:
  1. 80/20 split activates AUTO HUNT
  2. no changes the next day: AUTO HUNT stays
  3. 55% DISTRIBUTE switches the mode
  4. a 50/50 tie keeps the mode
  5. a changed vote replaces the old one
  6. selling half halves voting weight
  7. tokens reused across wallets count once
  8. rewards arriving during AUTO HUNT
  9. a total loss of trading capital
  10. new rewards after a total loss
  11. DISTRIBUTE wins with positions open
  12. too little money for fees
  13. a failed or refunded bridge transfer
  14. retrying a paid claim
  15. a worker restart mid-trade
  16. a double-triggered scheduler
  17. reserved money can't be traded
  18. failed transactions never book a trade

  They also cover:
  - vault flows: time lock, veto, cap, claim delay, self-claims, council seats;
  - NEP-413 attacks, config safety, log redaction;
  - the aggressive variant and shadow books;
  - the bot handlers.
- **17 Rust contract tests:**
  - claims and proofs;
  - council seats, ages and thresholds;
  - vetoes, the time lock and the cap;
  - pause and admin actions;
  - init validation;
  - the shared Merkle vectors.
- **Verified live:**
  - the Docker image runs on PostgreSQL 17, and a restart creates no duplicates;
  - the wallet Mini App opens the wallet selector;
  - a 45-minute paper comparison ran on live markets.

## 19. Verified facts (live checks)

- **BAGFLIP token:** `bagflip.v2-launchpad.justhoot.near`, 18 decimals, 1,000,000,000 supply.
  `dclv2.ref-labs.near` holds about 99.86%.
- **Launchpad fee state:**
  - fee recipient (`dev_id`) is `bagflip.near`;
  - creator share 100%, paid in wNEAR;
  - 5% transfer fee and 1% pool fee;
  - handover methods `propose_dev_transfer` / `accept_dev_transfer` exist.
- **NEAR Intents 1Click:** wNEAR ↔ SOL quotes work.
- **Jupiter Swap V2:** quotes Pump.fun curve tokens without an API key; the round trip measured about
  3% on one token.
- **PumpPortal:** `trade-local` returns transactions; its WebSocket sends create events with the
  creator and bonding-curve accounts.
- **GeckoTerminal:** trending, new-pools and pump-fun feeds work for free.
- **The free Solana RPC** refuses `getTokenLargestAccounts`, and **the free NEAR RPC** rate-limits
  heavy snapshots. Paid RPCs are recommended.

## 20. Configuration (your values)

| Setting | Value |
|---|---|
| Token | `bagflip.v2-launchpad.justhoot.near` (BAGFLIP, 18 decimals) |
| Creator wallet | `bagflip.near` (votes and can hold a seat) |
| Vault | `bagflip-vault.near` |
| Operator | `bagflip-bot.near` |
| Trading wallet | `EwMZcvgdnZRuQxzz66bq86EYSpgLcA4ppW6eEAut8FuQ` |
| Telegram group / admin | `-1004404598029` / `9224700927` (@bagflipmeme) |
| Excluded | `dclv2.ref-labs.near` |
| Council | top 20, veto 5, admin 11, seat age 24h, min balance 1 token |
| Daily AUTO HUNT cap | 50 NEAR |
| Delays | AUTO HUNT 12h, payouts 24h, admin 48h |
| Strategy | aggressive, with shadow comparison original vs aggressive |
| Mode now | `BAGFLIP_ENV=paper`, live flags off |

## 21. Deployment and go-live plan

1. **Create** `bagflip-bot.near` (about 3 NEAR) and `bagflip-vault.near` (about 5 NEAR).
2. **Get** a Telegram bot token from @BotFather. Recommended: paid NEAR and Solana RPCs, a Jupiter key,
   and a NEAR Intents partner key.
3. **Push** the corrected history to GitHub (`bagflipmeme/bagflip`) yourself; the sign-in window needs
   your choice of account.
4. **Rehearse on testnet:** deploy the vault, then run a payout list, a claim, a council veto and a
   pause.
5. **Host** on Railway, a VPS, or an Oracle free VM with Docker. Cloudflare Pages can't run this. Start
   in **paper** mode for a few days.
6. **Deploy the vault on mainnet** (the commands come from `scripts/vault-plan.ts`):
   1. verify the code hash;
   2. add the operator key;
   3. **hand over the reward recipient** and confirm it on the launchpad;
   4. **delete the vault's keys**;
   5. fill the council;
   6. publish the proof.
7. **Go live in three stages:**
   1. live mode with both switches off;
   2. then `LIVE_TRANSFERS_ENABLED` plus the operator key, starting with the $20 minimum;
   3. then `LIVE_TRADING_ENABLED` plus the trading key, starting small.
8. **Get a legal check** before inviting the public.

## 22. What's done vs. what's pending

**Done and tested:**
- governance, NEP-413 linking, the daily decision, quorum and the audit trail;
- the ledger, deposits, routing and reconciliation;
- the vault contract with the Holder Council, and the bot's vault integration;
- the bridge workflow, verified against the real 1Click API with dry quotes;
- the scanner, both strategy variants, the funnel and the shadow comparison;
- paper and simulated execution, positions, P&L, wind-down and restart recovery;
- distribution, claims and self-claims;
- the Telegram bot and API, Docker, and the docs.

**Built but not yet run with real money or keys:**
- live Solana execution;
- live 1Click deposits from the vault;
- the vault on testnet and mainnet;
- live claims;
- the reward handover;
- the bot in the real Telegram group;
- signing with a real wallet in the Mini App.

**Waiting on you:**
- the two NEAR accounts;
- the bot token;
- the GitHub push;
- the hosting choice;
- the go-ahead for testnet.

## 23. Risks, limits and legal questions

**Risks:**
- **Trading can lose 100%** of the trading capital: rugs, failed exits, slippage and fees. Stops are
  best effort. Paper results aren't live results.
- **The bot still computes payout lists and holds the Solana key.** This is bounded by the council
  veto, the daily cap and pause.

**Limits:**
- The engine polls every 10–30s, so it can't react inside a single block.
- Free RPCs limit holder-concentration checks and big snapshots.
- Holder discovery depends on FastNEAR's event history.

**Legal questions** (details in `docs/SECURITY_AND_COMPLIANCE.md`):
- Is this a collective investment scheme or a security?
- Do custody or money-transmission rules apply?
- How are profit-sharing payouts taxed?
- Could it count as gambling?
- AML/KYC and sanctions screening.
- Marketing claims and disclosures.
- Data protection.

Get advice **before** a public launch.
