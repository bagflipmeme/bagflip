# Architecture

BAGFLIP is one Node 24 service (bot, HTTP API and worker in one process, `ROLE=all`), a PostgreSQL
database, and a Rust vault contract on NEAR. Trading runs on Solana; NEAR Intents connects the two.

## System diagram

```mermaid
flowchart TB
  subgraph Users
    TG[Telegram group + DMs]
    BR[Browser + NEAR wallet]
  end
  subgraph Service[BAGFLIP service · Node 24]
    BOT[Telegram bot · grammY]
    API[HTTP API + wallet page]
    WK[Worker · Postgres job queue]
    GOV[Governance engine]
    LED[Treasury ledger]
    DIS[Distribution + Merkle]
    VS[Vault sync]
    BRG[1Click bridge]
    HUNT[AUTO HUNT engine]
  end
  DB[(PostgreSQL)]
  subgraph NEAR[NEAR mainnet · on chain]
    TOK[BAGFLIP NEP-141 token]
    LP[justhoot launchpad]
    VAULT[bagflip-vault.near]
  end
  subgraph SOL[Solana · on chain]
    WAL[Trading wallet]
    DEX[Pump.fun / PumpSwap]
  end
  X1[NEAR Intents 1Click]
  X2[Jupiter · PumpPortal]
  X3[GeckoTerminal · DexScreener]
  TG <--> BOT
  BR <--> API
  BOT & API & WK --> GOV & LED & DIS & VS & BRG & HUNT
  GOV & LED & DIS & HUNT <--> DB
  GOV -->|ft_balance_of at a block| TOK
  LP -->|creator fee share, wNEAR| VAULT
  VS <-->|operator FC key| VAULT
  VAULT -->|claim_seat: ft_balance_of| TOK
  VAULT -->|fund_trading| X1
  BRG <--> X1
  X1 --> WAL
  HUNT <--> X2 <--> DEX
  HUNT <--> X3
  HUNT -->|signs swaps| WAL
```

## Components

| Component | Code | Responsibility |
|---|---|---|
| Configuration | `src/shared/config.ts` | Validated env; refuses unsafe live configurations at boot |
| Composition root | `src/app.ts` | Chooses simulated, paper or live adapters per `BAGFLIP_ENV` |
| Telegram bot | `src/bot/` | Commands, vote buttons, pinned governance message, outbox announcements |
| HTTP API | `src/api/server.ts` | `/connect` wallet page, `/api/challenge`, `/api/link`, `/public/*`, `/admin/*` |
| Wallet linking | `src/near/nep413.ts`, `src/governance/wallets.ts` | NEP-413 challenge, signature and full-access-key verification |
| Governance engine | `src/governance/engine.ts`, `cycle.ts` | Vote reconstruction, block snapshot, decision rules, daily cycle |
| Treasury ledger | `src/treasury/` | Double-entry journals, deposit detection, mode routing |
| Distribution | `src/distribution/` | Holder index, pro-rata entitlements, Merkle lists, claims, council seat sync |
| Vault client | `src/near/vault.ts` | `RpcVault` (live, signs with the operator key) and `SimVault` (same rules in memory) |
| Bridge | `src/bridge/` | 1Click quotes, deposits, status polling, transfer state machine |
| AUTO HUNT | `src/market/`, `src/strategy/`, `src/trading/`, `src/solana/` | Discovery, scoring, safety, execution, positions, P&L, reconciliation |
| Jobs | `src/jobs/`, `src/worker/` | Durable Postgres queue (`FOR UPDATE SKIP LOCKED`, leases, unique keys) |
| Vault contract | `contracts/vault/` | On-chain treasury rules and Holder Council |

## On-chain vs off-chain

| Concern | Where it lives | Verifiable by |
|---|---|---|
| Token balances (voting power, weights) | NEAR (BAGFLIP token) | `ft_balance_of` at the recorded block |
| Treasury funds and exit rules | NEAR (vault) | `get_status`, `get_config`, contract code hash |
| Daily mode | Decided off chain, mirrored on chain with a snapshot hash | `propose_mode` event; `/public/decisions/<cycle>` canonical JSON |
| Payout list | Computed off chain, root + total + data hash on chain | `/public/distributions/<id>`, `/public/proofs/<account>`, `claim` |
| Holder Council | NEAR (vault, balances checked by the contract) | `get_seats` |
| Bridge transfers | NEAR vault event + 1Click | `trading_fund_requested` event; 1Click `/v0/status` |
| Trades and positions | Solana transactions + off-chain ledger | Solana explorer for the trading wallet; `/public/ledger` |
| Votes and wallet links | Off chain (Postgres, append-only `vote_events`) | Decision snapshot rows |

## Custody boundaries

| Holder of funds | Controlled by | Limits |
|---|---|---|
| `bagflip-vault.near` | The contract's rules (the deployer key still exists; see [TREASURY.md](TREASURY.md)) | Claims and capped `fund_trading` only |
| `bagflip-bot.near` (operator) | The service | Function-call key: 9 vault methods, 0.25 NEAR gas allowance; holds no treasury funds |
| Solana trading wallet | The service (hot key, required to sign swaps) | Receives at most the vault's 50 NEAR / 24h cap |
| 1Click deposit address | NEAR Intents | Credited to the trading wallet only after `SUCCESS` + destination confirmation |

## Daily cycle

```mermaid
sequenceDiagram
  participant W as Worker
  participant N as NEAR RPC
  participant DB as Postgres
  participant V as Vault
  participant T as Telegram
  W->>N: first final block at/after 00:00 MYT
  W->>DB: rebuild each vote as of the boundary (vote_events)
  W->>N: ft_balance_of(voter) at that block
  W->>DB: decision + per-wallet snapshot (append-only)
  W->>V: propose_mode(cycle, mode, sha256(snapshot))
  W->>T: announce result
  Note over V: DISTRIBUTE or INACTIVE apply at once, AUTO HUNT after 12h unless vetoed
```

## Environments

| | development | paper | live |
|---|---|---|---|
| NEAR chain | simulated | real reads | real |
| Market data | simulated | real | real |
| Vault | `SimVault` | `SimVault` | contract (`LIVE_TRANSFERS_ENABLED`) |
| Trading | simulated | paper fills on real Jupiter quotes | real only with `LIVE_TRADING_ENABLED` + key |
| Database | PGlite | PGlite or Postgres | Postgres (required) |

The deployed service runs `live` with `LIVE_TRANSFERS_ENABLED=true` and `LIVE_TRADING_ENABLED=false`, so
vault operations are real and AUTO HUNT trades on paper books.

## Background jobs

| Job | Schedule |
|---|---|
| `governance.decide` / `governance.apply` | 00:00 MYT |
| `governance.tally` | every 5 min |
| `treasury.scan_deposits` | every 60 s |
| `vault.watch` (status cache, vetoes, unwrap) | every 60 s |
| `vault.sync_seats` (nominate top holders) | every 6 h |
| `vault.sync_mode`, `vault.propose_distribution`, `distribution.run`, `claim.pay` | on events |
| `bridge.fund_trading`, `bridge.poll`, `bridge.return` | on AUTO HUNT / wind-down |
| `trading.reconcile` | every 120 s |
| Hunt loop | scan every 30 s, positions every 15 s |

## Data model

| Group | Tables (* append-only) |
|---|---|
| Identity | `users`, `wallets`, `auth_challenges` |
| Governance | `votes`, `vote_events`*, `governance_decisions`*, `governance_snapshot_entries`* |
| Ledger | `ledger_journals`*, `ledger_entries`*, `treasury_deposits`, `unattributed_inflows` |
| Bridge | `bridge_transfers` |
| Trading | `trading_positions`, `trading_orders`, `chain_transactions`, `market_observations`, `scan_funnel`, `shadow_trades` |
| Distribution | `holder_index`, `distribution_events`*, `distribution_entitlements`*, `reward_claims`, `reward_claim_items`, `vault_distributions`, `vault_mode_syncs` |
| Operations | `jobs`, `notifications`, `system_state`, `admin_audit`* |

Migrations: `migrations/001_init.sql`, `002_vault.sql`, `003_funnel_shadow.sql`.
