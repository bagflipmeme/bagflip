# Security, operations and compliance

## Wallet roles and boundaries

| Role | Chain | What BAGFLIP may do with it |
|---|---|---|
| **Creator wallet** (`CREATOR_WALLET_ADDRESS`) | NEAR | Nothing. No key is configured. It is only the default *allowed deposit sender*; transfers from it into the treasury are credited. It is never read for funds, swept or signed for. |
| **BAGFLIP vault** (`TREASURY_NEAR_ADDRESS`, e.g. `bagflip.near`) | NEAR | A smart contract with **all keys deleted** ([docs/VAULT.md](VAULT.md)). Nobody can sign for it. Funds leave only as claims to accounts in a time-locked Merkle payout list the Holder Council (top 10 holders) can veto, or as `fund_trading` transfers (AUTO_HUNT only, time-locked, rolling 24h cap). |
| **Operator** (`OPERATOR_ACCOUNT_ID`) | NEAR | The bot's account. Its function-call key can only call vault operator methods; it can't withdraw or redirect funds. The Holder Council can rotate it (6 of 10 seats plus a 48h delay). |
| **Trading wallet** (`TRADING_WALLET_ADDRESS`) | Solana | Dedicated hot wallet. It holds only SOL bridged in from the treasury. It signs swaps, token-account closes and SOL deposits back to 1Click. |

The boundary is enforced in the ledger, not just by convention:

* **Ledger, not wallet balance.** The trading engine sizes positions from the ledger account
  `trading:available`, which only grows through settled 1Click transfers and sell proceeds. SOL sent to
  the trading wallet from anywhere else appears as an "unattributed surplus" and is never traded.
* **No overdrafts.** Accounts that must stay non-negative are checked inside the posting transaction.
  Overdrawing `treasury:available`, `distribution:pool` or `trading:available` raises `LedgerError` and
  rolls back.
* **Reserved funds stay reserved.** Distribution pool and claimable funds live in separate ledger
  accounts. `tradableNear()` only ever sees `treasury:available` minus the fee reserve.
* **No top-ups.** Nothing ever draws from the creator wallet to cover losses. There is no code path that
  could.

## Secrets

* Keys are only accepted when `BAGFLIP_ENV=live`, and only when the matching `LIVE_*` flag is on. Boot fails
  otherwise.
* Store keys in Railway variables or another secret manager, never in the repo. `.env` is gitignored.
* The logger redacts any key named like `token`, `secret`, `private`, `password`, `seed`, `api_key` or
  `authorization`, and any registered secret value that appears inside a message or stack trace (tested).
* Users are never asked for seed phrases, private keys or passwords. The bot and the Mini App say so
  explicitly.

## Authentication

* **Wallet linking: NEP-413.** The backend issues a challenge with a random 32-byte nonce. It names the
  Telegram user id, expires after 10 minutes and is single-use (an atomic `used_at` flip). The signature
  is checked against `sha256(borsh(2^31+413) ‖ borsh(payload))` with recipient `NEP413_RECIPIENT`, so it
  only works for BAGFLIP. The key must be a **full-access key of that account on chain**. Five bad attempts
  lock a challenge, and challenge creation is rate-limited. Tests cover replay, expiry, wrong message,
  wrong nonce, wrong recipient, foreign key, someone else's account and Telegram mismatch.
* **One account, one owner.** A NEAR account links to at most one Telegram user (partial unique index).
  When another user proves ownership, the account moves to them and the old link's vote is revoked.
* **Mini App.** When the page runs inside Telegram, its `initData` HMAC is validated, and the Telegram
  user must match the challenge.
* **Webhook.** Telegram updates must carry `X-Telegram-Bot-Api-Secret-Token`. Without
  `TELEGRAM_WEBHOOK_SECRET`, the bot uses long polling instead.
* **Callbacks.** Inline callback data is matched against fixed patterns (`v:D`, `v:H`, `claim:go`).
  Anything else is ignored.
* **Admins.** Admin commands only answer the Telegram ids in `TELEGRAM_ADMIN_IDS`, and every admin action
  is written to the append-only `admin_audit` table. HTTP admin endpoints need a constant-time-compared
  Bearer token.
* **Rate limits.** Per Telegram user (burst 6, 20/min) and per IP on `/api/*`.

## Idempotency and recovery

| Operation | Protection |
|---|---|
| Daily decision | `cycle_id` is unique; the decision is written under an advisory lock; job key `decide:<cycle>` |
| Ledger posting | `idempotency_key` is unique; append-only triggers on entries and journals |
| Deposits | `receipt_id` is unique (one credit per on-chain receipt) |
| Bridge transfer | At most one in flight per direction. The signed deposit is persisted **before** broadcast. Recovery re-broadcasts the same bytes or proves expiry. Credit happens only after 1Click `SUCCESS` **and** a destination-chain confirmation. |
| Orders | `client_order_id` is unique; one active position per mint. The signature is persisted before broadcast. Settlement is read from the confirmed transaction's balance changes. An unknown signature past its blockhash's validity is `expired`. |
| Distribution | Key = snapshot block + pool; the pool is re-read under lock; entitlements are append-only |
| Claims | Each entitlement attaches to exactly one claim, and an account can have only one open claim. The payout tx is persisted before broadcast. A retry re-broadcasts or proves failure/expiry before re-signing. |
| Jobs | Postgres queue with `FOR UPDATE SKIP LOCKED`, leases, exponential backoff and dead-letter alerts. Unique job keys make double triggers no-ops. |
| Trading loop | DB lease, so one engine acts at a time |

On restart the worker re-arms the governance schedule (and catches up a missed midnight), re-queues every
in-flight bridge transfer, and the hunt engine settles every `submitting` order before doing anything else.

## Automatic trading pauses

New entries stop, while open positions keep being managed, when any of these is true:

* the mode is not AUTO HUNT (DISTRIBUTE triggers a full wind-down)
* the emergency pause is on (`/pause`, `POST /admin/pause`, or `EMERGENCY_PAUSE=true`)
* live mode is on but `LIVE_TRADING_ENABLED` is false
* there have been 5 or more consecutive RPC/API failures (`RPC_FAILURE_PAUSE_THRESHOLD`)
* (live) the latest reconciliation failed or is stale: the wallet holds less SOL or fewer tokens than
  the ledger says, or the ledger fails its integrity check
* an order has been unresolved for over 10 minutes
* there are too few funds for an economically viable trade (that trade is deferred)

A pause posts to the group once.

## Monitoring

* `GET /health` for liveness.
* `GET /admin/status` (Bearer token) shows mode, treasury categories, trading state, reconciliation,
  job queue, recent bridge transfers and unattributed inflows.
* JSON logs on stdout, with the env, module and job key on every line.
* Public audit endpoints:
  * `/public/decisions` and `/public/decisions/<cycle>`: every daily decision and the per-wallet balance
    snapshot behind it
  * `/public/ledger`: the latest journals and every chain transaction
  * `/public/distributions/<id>`: every entitlement

## Legal and compliance questions (not answered by this prototype)

BAGFLIP is a prototype. Nothing in this repository makes it legally approved anywhere. Before inviting the
public, get advice on at least these questions:

1. **Collective investment / securities.** Holders vote on whether pooled funds are traded for profit,
   and profits are distributed pro-rata to token holders. Regulators (for example the Securities
   Commission Malaysia, the US SEC under Howey, or MiCA in the EU) may treat this as a collective
   investment scheme, or may treat the meme token as a security or investment contract.
2. **Custody and money transmission.** The reward treasury is a keyless contract, but the operator still
   proposes payout lists and holds the Solana trading key. Holding
   and moving funds for others may need a licence (for example digital asset custodian or money
   services rules).
3. **Profit-sharing distributions.** Pro-rata payouts tied to token holdings can look like dividends.
   Tax treatment applies both to the operator and to recipients.
4. **Gambling characterisation.** An extremely high-risk "hunt" with community-directed outcomes may
   fall under gaming rules in some jurisdictions.
5. **AML/KYC and sanctions.** Payouts go to self-custodied wallets without KYC, and trading touches
   anonymous tokens. Consider sanctions screening of claimants, geofencing, and a policy for tainted
   tokens.
6. **Marketing and disclosures.** Make no profit promises. Keep risk disclosures prominent (the bot's
   `/disclosures`). Watch consumer-protection rules on "earn" language.
7. **Creator tax revenue.** Check the token's launchpad terms on redirecting creator rewards, and whether
   the creator still controls an instrument others hold.
8. **Market conduct.** The strategy never trades to create volume or move prices, but automated meme
   trading can still raise market-abuse questions. Keep the audit trail.
9. **Data protection.** Telegram ids are linked to wallet addresses and stored. Publish a privacy notice
   and set retention rules.

## Disclosures shown to users

These are in `/disclosures` and summarised in `/start` and `/help`:

* Voting is weighted by holdings.
* The treasury is a keyless vault contract, with time locks and vetoes by the top-10-holder council.
* The operator still computes payout lists and holds the Solana trading key.
* Trading capital can be lost entirely.
* Stops are best-effort.
* Distributions come only from reconciled funds.
* None of this is financial advice.
