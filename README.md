# BAGFLIP — community-controlled meme treasury

Creator tax rewards from a NEAR meme token flow into a public BAGFLIP treasury. Token holders decide in
Telegram, continuously and weighted by holdings, between exactly two options:

* **💰 DISTRIBUTE**: rewards are split pro-rata among holders and become claimable.
* **🔥 AUTO HUNT**: an autonomous bot trades extremely high-risk Solana meme tokens (Pump.fun curve and
  PumpSwap) with the treasury. It can lose 100%.

NEAR is the token, governance and treasury chain. Solana is where trades execute. NEAR Intents 1Click
moves capital between them. Telegram is the only user interface; the single web page is a wallet-signing
Mini App.

> ⚠️ Live trading and live fund movement are **off by default**, and boot refuses unsafe configurations.
> See [docs/SECURITY_AND_COMPLIANCE.md](docs/SECURITY_AND_COMPLIANCE.md) for the legal questions that
> must be answered before a public launch.

**Trust model:** the reward treasury `bagflip.near` is a smart contract with **no keys**. See
[docs/VAULT.md](docs/VAULT.md).
* Money leaves it only as claims to the accounts in a published payout list, or as capped transfers
  to the trading route.
* AUTO HUNT activation and every payout list are time-locked, and the **Holder Council** can veto them.
  The council is the top 10 BAGFLIP holders, decided on chain by token balance.
* The bot holds only an operator key that can call those vault methods and nothing else.

## How it works

```
 Creator wallet ──(rewards)──▶ BAGFLIP VAULT contract (NEAR, no keys) ──1Click──▶ Trading wallet (Solana)
        (never signed for)              │  fund_trading: AUTO_HUNT only,  │  Jupiter V2 / PumpPortal
                                        │  time-locked, 24h cap           │
                                        │  bot ledger mirror: available / │
                                        │  distribution pool /            │  scanner → score → confirm →
                                        │  claimable / in-transit         │  safety → round-trip → trade
                                        ▼                                 ▼
             Merkle payout list (veto window) ◀──── 1Click ◀──── wind-down on DISTRIBUTE
             claim → vault pays the listed account (bot relays, or self-claim)
```

### Governance rules ([src/governance/engine.ts](src/governance/engine.ts))

* **Voting power = eligible token balance** of each verified wallet, read **at one NEAR block** at
  00:00 Asia/Kuala_Lumpur. Moving tokens between wallets can't double-count them.
* **Votes are continuous.** A vote persists across days until it is changed, revoked or the wallet is
  unlinked. Votes cast after midnight count for the next cycle: they're reconstructed "as of" the
  boundary from the append-only `vote_events` log.
* **Mode changes require a strict majority.** The mode changes only if the other option has **more than
  50%** of valid weighted votes **and** quorum is met. An exact 50/50 tie, zero valid votes or missed
  quorum all keep the previous mode.
* **Starts INACTIVE.** The system starts with no trading. The first activation needs
  `VOTING_INITIAL_QUORUM_PERCENT` of eligible supply and `VOTING_MIN_DISTINCT_WALLETS`; later switches
  need `VOTING_MIN_QUORUM_PERCENT`.
* **Eligible supply** is total supply minus excluded accounts (treasury, token contract, and
  `EXCLUDED_HOLDER_ACCOUNTS`).
  * The Rhea DCL pool `dclv2.ref-labs.near` holds most of the BAGFLIP supply; it and `intents.near` are
    excluded by default in `.env.example`.
* **Auditable.** Every decision stores block height and hash, totals, quorum, reason and config, plus one
  immutable snapshot row per wallet (`/public/decisions/<cycle>`).

### Daily cycle ([src/governance/cycle.ts](src/governance/cycle.ts))

* A durable job fires at 00:00 MYT and takes the balance snapshot.
* It records the decision, posts it, and queues the treasury operation:
  * **AUTO HUNT**: unreserved funds are bridged once they reach `MIN_CROSS_CHAIN_TRANSFER_USD`, and the
    engine may open positions.
  * **DISTRIBUTE**: new buys stop at once, unsent buy orders are cancelled, positions are unwound (with
    escalating slippage for up to `WINDDOWN_MAX_HOURS`, then written off), and idle SOL is bridged
    home. Available NEAR is reserved into the distribution pool and distributed pro-rata once it reaches
    `MIN_DISTRIBUTION_POOL_USD`.
* Double triggers are no-ops.
* After downtime, the missed boundary is caught up (using the exact boundary block when the RPC still
  has it).

### Treasury accounting ([src/treasury/ledger.ts](src/treasury/ledger.ts))

The ledger is append-only and double-entry, with bigint smallest units only (yoctoNEAR, lamports). It
distinguishes:

* **NEAR side**
  * `treasury:available` (unreserved)
  * `distribution:pool` (reserved)
  * `distribution:claimable` (owed to holders)
  * `bridge:outbound` (in transit)
  * `equity:deposits` and `equity:distributed`
* **SOL side**
  * `trading:available`
  * `trading:positions` (cost basis)
  * `bridge:inbound`
  * `pnl:realized`
* **Both:** `expense:fees`

Reporting rules:

* **Realized P&L** comes only from settled sells (actual SOL out vs. actual SOL in, fees included) and
  write-offs.
* **Unrealized P&L** uses executable sell quotes and is always labeled as such.
* **Deposits** are credited only from `CREATOR_WALLET_ADDRESS` (or `DEPOSIT_ALLOWED_SENDERS`), once per
  on-chain receipt. Everything else is recorded as an unattributed inflow.

### Strategy

The strategy is **Graduation Momentum**. It hunts Pump.fun tokens near curve completion or freshly
migrated to PumpSwap, entering when volume accelerates with buy pressure, confirmed on two scans,
safety-checked on chain, and only if a real buy-then-sell round trip is affordable. Exits are a −30%
stop, a +80% partial take-profit, a 25% trailing stop, crash/liquidity-collapse emergency exits, a
momentum-decay exit and a 24h cap. Full rationale and tradeoffs: [docs/STRATEGY.md](docs/STRATEGY.md).

## Repository layout

The suggested `apps/` + `packages/` split was flattened into one Node package. At this scale a
monorepo's build tooling buys nothing; the module boundaries are the same.

```
src/
  main.ts            entry (ROLE=all|bot|api|worker)
  app.ts             composition root: picks sim/paper/live adapters per BAGFLIP_ENV
  shared/            config (validated), fixed-point money, MYT boundary math, redacting logger, outbox
  db/                Postgres + PGlite adapter, migrations runner, advisory locks
  jobs/              durable Postgres job queue (SKIP LOCKED, leases, retries, idempotent keys)
  near/              RPC, NEP-413 verify, chain abstraction (RPC+FastNEAR | simulated), tx signer
  governance/        engine (pure), wallets+votes, daily cycle
  treasury/          ledger, deposits, routing, prices
  bridge/            1Click client, depositors (NEAR wrap+ft_transfer / SOL transfer), state machine
  market/            DexScreener + PumpPortal discovery (MarketDataProvider), on-chain SafetyChecker
  strategy/          scoring + exits (StrategyEngine, pure), historical replay
  solana/            RPC + settlement parsing; execution/ adapters: live (Jupiter V2, PumpPortal), paper, simulated
  trading/           PositionManager, RiskController, HuntEngine, PnL, reconciliation
  distribution/      holder index, pro-rata distribution, Merkle payout lists, vault sync, claims
  bot/               grammY bot, views, pinned governance message, outbox sender
  api/               HTTP server, wallet Mini App, Telegram initData validation
  worker/            job handlers + loops
contracts/vault/          the keyless treasury contract (Rust, near-sdk 5.30), its tests, Merkle vectors, built wasm
migrations/               001 full schema (append-only triggers), 002 vault payout lists + mode syncs
scripts/                  migrate, dev-seed, verify-live, paper-scan, sync-holders, replay, vault-plan, gen-merkle-vectors
tests/                    vitest suites (PGlite; no network)
```

## Running locally

Requirements: Node 24+ (it runs the TypeScript directly) and pnpm. Docker is optional.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm test
```

**Development** uses a simulated chain, market and bridge, embedded Postgres, and no network.
1. Set `BAGFLIP_ENV=development`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID` and `TELEGRAM_ADMIN_IDS` in
   `.env`.
2. Optionally seed: `node --env-file=.env scripts/dev-seed.ts` (stop the app first; PGlite is
   single-process).
3. Start the app:

```bash
node --env-file=.env src/main.ts
```

In development the admin commands `/sim_deposit 10` and `/sim_balance alice.near 5000` drive the
simulation. Three tokens labeled SIM random-walk so AUTO HUNT has something to trade.

The **wallet Mini App needs HTTPS**. For a local Telegram test, expose port 8080 with a tunnel such as
`cloudflared tunnel --url http://localhost:8080` and set `PUBLIC_URL` to the tunnel URL.

**Paper** uses real NEAR balances and deposits, real market data and real Jupiter quotes, with virtual
capital:

1. Set `BAGFLIP_ENV=paper`, `MEME_TOKEN_CONTRACT_ID=bagflip.v2-launchpad.justhoot.near`,
   `TREASURY_NEAR_ADDRESS=<bagflip treasury>` and `CREATOR_WALLET_ADDRESS=<creator>`.
2. Run `node --env-file=.env scripts/verify-live.ts` (read-only checks of every integration).
3. Run `node --env-file=.env src/main.ts`, and later `node --env-file=.env scripts/replay.ts`.

**With Postgres:**

```bash
docker compose up --build
```

## Production (Railway)

1. Create a Railway project with a **PostgreSQL** plugin. Deploy this repo; `railway.json` and the
   `Dockerfile` are picked up. Keep **1 replica**.
2. Set the variables from `.env.example`:
   * `DATABASE_URL`
   * `PUBLIC_URL` (the Railway HTTPS domain)
   * `TELEGRAM_*`, including `TELEGRAM_WEBHOOK_SECRET`
   * `ADMIN_API_TOKEN`
   * the NEAR and Solana addresses
   * `ONECLICK_API_KEY` and `JUPITER_API_KEY` (recommended)
   * a paid `SOLANA_RPC_URL` (recommended)
3. Start with `BAGFLIP_ENV=paper`. In the group, an admin runs `/post_governance` (the bot needs
   pin-message rights). Verify `/status`, `/connect`, votes and the midnight decision.
4. Go live in this order, checking `/admin/status` and the reconcile report after each step:
   1. `BAGFLIP_ENV=live` with both `LIVE_*` flags still false. Real deposits and decisions run, nothing
      moves.
   2. `LIVE_TRANSFERS_ENABLED=true` plus the **operator** key (`OPERATOR_ACCOUNT_ID`,
      `OPERATOR_PRIVATE_KEY`). The bot can now call the vault. Deploy and lock the vault first with
      [docs/VAULT.md](docs/VAULT.md); there is no treasury key at all.
   3. `LIVE_TRADING_ENABLED=true` plus `SOLANA_TRADING_PRIVATE_KEY`. Trading starts.
5. Emergency stop: `/pause` in Telegram, `POST /admin/pause {"paused":true}`, or `EMERGENCY_PAUSE=true`.

## Telegram commands

* **Everyone:** `/start` `/help` `/vote` `/status` `/treasury` `/trades` `/pnl` `/disclosures`
* **DM only:** `/connect` `/power` `/claim` `/disconnect <account>`
* **Admins:** `/pause` `/resume` `/deposit <near_tx_hash>` (credit a historical deposit after on-chain
  verification) `/post_governance` `/admin`
* **Development:** `/sim_deposit` `/sim_balance`

The group gets one pinned governance message with **💰 DISTRIBUTE / 🔥 AUTO HUNT** buttons, edited in
place (debounced, never one post per vote). Announcements go through an outbox with idempotency keys
and are rate-limited: significant deposits, daily decisions, mode changes, position opens and closes,
claimable distributions, treasury failures and pauses.

## Tests

`pnpm test` runs 70 tests against embedded Postgres, with no network. The vault contract adds 17 Rust
tests (see docs/VAULT.md). They cover every scenario in the
brief:

| # | Scenario | Test |
|---|---|---|
| 1–3 | 80/20 activates AUTO HUNT, persists, switches at 55% | governance.test.ts |
| 4 | 50/50 keeps the previous mode | governance.test.ts |
| 5 | changing a vote replaces it | governance.test.ts |
| 6 | selling half halves weight at the next snapshot | governance.test.ts |
| 7 | the same tokens across wallets count once; an account can't be linked twice | governance.test.ts |
| 8 | rewards during AUTO HUNT are bridged, credited only after settlement | treasury-trading.test.ts |
| 9–10 | total loss of trading capital; new rewards fund it again | treasury-trading.test.ts |
| 11 | DISTRIBUTE wins with open positions → unwind, return, distribute | treasury-trading.test.ts |
| 12 | too little capital for fees → no order | treasury-trading.test.ts |
| 13 | bridge refunded / failed / quote error | treasury-trading.test.ts |
| 14 | retrying a completed claim pays nothing twice | treasury-trading.test.ts |
| 15 | worker restart with an open trade, and with an order persisted mid-flight | treasury-trading.test.ts |
| 16 | scheduler triggered twice → one decision | governance.test.ts |
| 17 | reserved distribution money can't be traded | treasury-trading.test.ts |
| 18 | failed/expired submissions never book a trade | treasury-trading.test.ts |

They also cover:

* NEP-413 attacks: replay, expiry, wrong message/nonce/recipient, foreign key, Telegram mismatch, lockout
* Mini App `initData`, config safety and log redaction
* fixed-point maths and pro-rata ($100 → 10/30/60)
* strategy scoring and exits, the 1Click client, the paper fill model and replay
* the bot handlers (rendering, votes, DM-only flows, admin auth and audit)

## Status: what works, and what still needs credentials, funding or approval

**Verified working (tested locally, plus read-only checks against mainnet on 2026-11-09):**

* Wallet linking (NEP-413), continuous weighted voting, the daily MYT decision engine, quorum, the INACTIVE
  start, and audit records.
* Treasury ledger: deposits, reservations, routing by mode, reconciliation and integrity checks.
* The 1Click workflow, quotes, status handling, refund and failure paths (simulated provider). The real
  API was verified with dry quotes in both directions: 5 wNEAR → 0.2028 SOL, about 17s.
* The scanner on real DexScreener and PumpPortal data; Jupiter Swap V2 quotes on a live Pump.fun curve
  token; Solana mint-safety reads.
* Paper and simulated execution, the position lifecycle, P&L, wind-down, write-off and restart recovery.
* Pro-rata distribution and claims (payout simulated outside live), and the holder index from FastNEAR
  event history.
* Telegram bot handlers and the HTTP API. The app boots under Node 24 in development mode.
* The vault contract compiles to wasm, and its 17 unit tests pass. They cover:
  * claims only paying the listed account, once, after the veto window
  * vetoes, the time-locked AUTO HUNT and the 24h cap
  * the on-chain Holder Council (seat contests by balance, seat age, vote thresholds)
  * pause and admin thresholds
  * Merkle vectors shared with the TypeScript side

  The bot's vault flows are tested end to end against an in-process model of the same rules.
* The Docker image builds and runs against PostgreSQL 17: migrations apply, jobs run, and a restart
  doesn't duplicate decisions or jobs.
* The wallet Mini App loads its challenge and opens the NEAR Connect wallet selector (checked in a
  browser; signing needs a real wallet).
* There's no Redis: at this scale a Postgres job queue (`FOR UPDATE SKIP LOCKED`, leases, unique keys)
  gives the same durability with one fewer service to run and pay for.

**Built but not yet exercised with real funds or credentials** (this needs your approval and setup):

* **Live Solana execution** (`src/solana/execution/live.ts`). Jupiter `/order` + `/execute` and the
  PumpPortal `trade-local` fallback, with simulation before send and token-account close. Not yet run with
  a signing key; it needs a funded `TRADING_WALLET_ADDRESS` key and `LIVE_TRADING_ENABLED=true`. Do a
  first live run with a tiny balance.
* **The vault contract on mainnet.** It builds (256 KB wasm) and passes 17 unit tests, plus the bot's
  integration tests against an identical in-process model. It is **not deployed** and has not been run
  in the NEAR sandbox or on testnet.
  * Rehearse on testnet (a tiny payout list, a claim, a veto) before deploying to `bagflip.near`.
  * Use a reproducible build so others can verify the code hash.
  * Only then delete the keys; locking is irreversible.
* **Live 1Click deposits.** The vault's `fund_trading` wraps and `ft_transfer`s to the deposit address
  (with `storage_deposit`) in one receipt; the SOL side does a native transfer. Not yet done for real.
  1Click's docs do not explicitly state the NEAR deposit mechanics, so do the first transfer at the $20
  minimum and watch `/admin/status`.
* **Live claim payouts** through the vault's `claim_many`. Not yet done for real.
* **Telegram in a real group.** Needs a bot token, a group with pin rights, and an HTTPS `PUBLIC_URL` for
  the Mini App. The NEAR Connect wallet flow (`@hot-labs/near-connect` via esm.sh) has not been clicked
  through with a real wallet. Backend verification is fully tested, and a manual-paste fallback exists.
* **Deposit auto-detection** depends on the FastNEAR transaction API. If it lags, admins can credit by
  hash with `/deposit`.
* **A full distribution snapshot on real data.** The holder index was built from real chain history
  (a test token with 4,275 transactions → 501 holder accounts, marked complete), and sampled balance reads
  pinned to one block succeeded. Reading all 501 balances in one pass was throttled (HTTP 429) by the
  **free** FastNEAR RPC from this machine after several full scans in one day. **Use a keyed
  `NEAR_RPC_URL` in production.** The client paces about 15 req/s and backs off, and the distribution
  job retries, but a free endpoint can still stall it. The daily governance snapshot only reads voting
  wallets, so it's much lighter.

**Decisions only you can make before going live:**

* the BAGFLIP treasury account and the trading wallet (to be created and published)
* the exact `EXCLUDED_HOLDER_ACCOUNTS` (verify pool, bridge and launchpad accounts)
* quorum values
* whether the creator's own BAGFLIP should vote (add it to the exclusions if not)
* legal review (see the compliance doc)

**Known limitations:**

* Holder discovery = FastNEAR event history ∪ top-100 ∪ registered wallets. Treat it as complete only
  when `holder_source` says `complete`.
* Unclaimed rewards stay reserved indefinitely (there's no expiry policy yet).
* The trading loop polls every 15–30s, so it can't react inside a single block.
