# Security and trust model

## Accounts, keys and custody

| Account | Chain | Key held by | What it can do |
|---|---|---|---|
| `bagflip-vault.near` (treasury) | NEAR | Deployer full-access key (retained until locking) | Contract rules: claims and capped `fund_trading` only. Locking removes the key ([TREASURY.md](TREASURY.md#locking-planned)). |
| `bagflip-bot.near` (operator) | NEAR | The service (`OPERATOR_PRIVATE_KEY`) | Function-call key limited to 9 vault methods with a 0.25 NEAR gas allowance. Cannot withdraw or redirect funds. Replaceable by the council (11 seats + 48 h). |
| `bagflip.near` (creator) | NEAR | The creator | Not used by the service; it is an allowed deposit sender and a token holder. |
| `EwMZcvgd…8FuQ` (trading wallet) | Solana | The service (`SOLANA_TRADING_PRIVATE_KEY`, live trading only) | Hot wallet that signs swaps. Receives at most the vault's 50 NEAR / 24 h cap. |

**Custody boundary.** Funds in the vault are governed by contract code. Funds bridged to Solana for AUTO HUNT
are in a wallet the service controls. That is the trust assumption of AUTO HUNT, bounded by the daily cap,
the time lock and the council's veto and pause. A TEE-attested trading agent is the planned next step.

## Configuration safety

* Three environments: `development` (simulated), `paper` (real data, virtual capital), `live`.
* Keys are accepted only in `live`, and only with the matching flag: `LIVE_TRANSFERS_ENABLED` for the operator
  key, `LIVE_TRADING_ENABLED` for the Solana key. Boot fails on any unsafe combination, and the operator
  account may not be the treasury or creator account.
* Secrets live in environment variables (Railway), never in the repository; `.env` is gitignored.
* The logger redacts secret-named fields and registered secret values (tested).

## Authentication

* **NEP-413 wallet linking.** Single-use challenge with a random 32-byte nonce, the Telegram user id and a
  10-minute expiry. The signature is verified for recipient `NEP413_RECIPIENT`, the key must be a
  full-access key of the account on chain, and 5 bad attempts lock the challenge. Tested against replay,
  expiry, wrong message, nonce or recipient, foreign keys and Telegram mismatch.
* **Telegram.** Webhook updates require `X-Telegram-Bot-Api-Secret-Token`. Callback data must match fixed
  patterns. Admin commands answer only `TELEGRAM_ADMIN_IDS` and are written to the append-only `admin_audit`.
* **HTTP admin.** Bearer token, constant-time comparison. Rate limits per Telegram user and per IP.
* Users are never asked for seed phrases or private keys.

## Integrity and recovery

| Operation | Protection |
|---|---|
| Daily decision | Unique `cycle_id`, advisory lock, unique job key |
| Ledger | Unique idempotency keys; append-only triggers; non-negative balances checked in-transaction |
| Deposits | One credit per on-chain receipt; unknown senders recorded as unattributed |
| Bridge | One transfer in flight per direction; signed deposit persisted before broadcast; credit only after 1Click `SUCCESS` + destination confirmation; refunds return funds |
| Orders | Signature persisted before broadcast; settlement read from the chain; expired or failed transactions never book a trade |
| Claims | Each entitlement attaches to one claim; payout persisted before broadcast; the vault rejects double claims |
| Jobs | Postgres queue with leases, retries and dead-letter alerts |

On restart the worker catches up a missed decision, resumes in-flight bridge transfers and settles every
submitted order before trading.

## Automatic trading pauses

New entries stop, while open positions keep being managed, when: the mode is not AUTO HUNT or the vault is
paused or time-locked; the emergency pause is on; live trading is not enabled; there are 5 consecutive
RPC/API failures; reconciliation fails or is stale; or an order is unresolved for over 10 minutes.

## Monitoring and audit

* `GET /health`; `GET /admin/status` (token) for mode, treasury, trading, reconciliation and jobs.
* Public: `/public/vault`, `/public/decisions[/<cycle>]`, `/public/ledger`, `/public/distributions/<id>`,
  `/public/proofs/<account>`.

## Disclosures

* The vault contract is tested (17 Rust tests, plus service-level tests against an identical in-process
  model) but has not been independently audited.
* AUTO HUNT trades high-volatility assets. Losses can include the full allocated amount, and exits are
  best-effort.
* Payout lists and daily decisions are computed off chain and verified through published data and council
  vetoes.
* Telegram ids are linked to wallet addresses in the service database.
* Users see these points in the bot's `/disclosures`. Regulatory treatment of community treasuries and
  automated trading varies by jurisdiction.
