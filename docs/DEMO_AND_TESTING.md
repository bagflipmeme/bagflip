# Demo and testing

Each step lists **Action → Expected result → Verification**. Sections 1–5 run locally with no keys, no
funds and no Telegram account. Section 6 reads the live mainnet deployment. Section 7 needs Telegram and
a NEAR wallet. The outputs quoted below were observed on 2026-11-14.

Requirements: Node ≥ 24, pnpm 10, Docker (for the contract tests). Commands assume a POSIX shell from the
repository root.

## 1. Install and run the service tests

```bash
pnpm install
pnpm test
```

* **Expected:** `Tests  77 passed (77)` in about 20 s (embedded Postgres, no network).
* **Verification:** suites in `tests/`: governance (scenarios 1–7, 16), treasury + AUTO HUNT (8–15, 17, 18),
  vault flows, Holder Council, NEP-413 attacks, config safety, bot handlers.

Selected tests that cover the treasury rules:

| Test | Shows |
|---|---|
| `vault.test.ts` › AUTO HUNT is time-locked in the vault | No funding or entries until the 12 h delay passes |
| `vault.test.ts` › the vault's rolling 24h cap bounds how much can reach the trading wallet | Cap enforcement |
| `vault.test.ts` › claims wait for the payout list's veto window, then the vault pays the listed account | Claim restrictions |
| `vault.test.ts` › anyone can verify and self-claim with published proofs | Self-claim without paying twice |
| `vault.test.ts` › a council veto returns the list's money to the pool | Veto path |
| `treasury-trading.test.ts` › scenario 17: money reserved for distribution can never be traded | Reserved funds |
| `treasury-trading.test.ts` › scenario 13: refunded or failed cross-chain transfers never credit Solana | Bridge safety |
| `treasury-trading.test.ts` › scenario 14: retrying a completed claim pays nothing twice | Idempotent claims |

## 2. Vault contract tests

```bash
docker build -t bagflip-build -f contracts/vault/Dockerfile.build contracts/vault
docker run --rm -v "$PWD/contracts/vault:/work" -w /work bagflip-build cargo test
```

* **Expected:** `test result: ok. 17 passed; 0 failed`.
* **Verification:** test names include `claims_pay_only_the_listed_account_after_the_veto_window`,
  `trading_transfers_are_operator_only_and_capped_per_24h`,
  `risk_reducing_modes_are_instant_auto_hunt_is_time_locked_and_vetoable`,
  `seats_are_won_by_on_chain_balance_and_exclude_protocol_accounts`, `merkle_vectors_match_typescript`.
* Build the wasm: `docker run --rm -v "$PWD/contracts/vault:/work" -w /work bagflip-build cargo near build non-reproducible-wasm --no-abi`
  (output `contracts/vault/res/bagflip_vault.wasm`).

## 3. Governance and treasury in development mode (simulated chain)

```bash
export BAGFLIP_ENV=development PGLITE_DATA_DIR=./data/demo
node scripts/dev-seed.ts
```

* **Expected:**
  ```
  seeded sim-whale.near (1000000 BAGFLIP) → AUTO_HUNT
  seeded sim-bagflip.near (50000 BAGFLIP) → AUTO_HUNT
  seeded sim-saver.near (400000 BAGFLIP) → DISTRIBUTE
  seeded sim-holder.near (1000 BAGFLIP) → no vote
  seeded a simulated 12 NEAR reward deposit
  ```
* **Verification:** each wallet is linked through the real NEP-413 verification path (`verifyAndLink`).

```bash
node src/main.ts        # keep running; API on http://localhost:8080
```

| Action | Expected result |
|---|---|
| `curl localhost:8080/health` | `{"ok":true,"env":"development","mode":"INACTIVE"}` |
| `curl localhost:8080/public/decisions` | Today's decision with `block_height`, `block_hash`, weights, `eligible_supply`, `quorum_met` and `reason`. Votes cast after the boundary count for the next cycle, so the first decision reads `"no valid weighted votes; previous mode retained"`. |
| `curl localhost:8080/public/ledger` | A balanced `deposit` journal: `treasury:available NEAR +12…` and `equity:deposits NEAR −12…` |
| `curl localhost:8080/public/vault` | Simulated vault status and a Holder Council seated by balance (`sim-whale.near`, `sim-saver.near`, …) |

PGlite is single-process: stop the app before running another script against the same data directory.

## 4. AUTO HUNT on live market data (paper)

```bash
node scripts/paper-scan.ts --minutes 3
node scripts/paper-compare.ts --minutes 10
```

* **Expected:** `paper-scan` prints candidates, scores and filter reasons. `paper-compare` prints per-variant
  entries, P&L and a scanner funnel, and writes `data/paper-compare-<timestamp>.json`.
* **Observed (10 min run):** aggressive: 134 scored → 46 confirmed → 4 entries, −19.9% of 1 virtual SOL (1
  closed, 3 open); original: 38 scored → 1 confirmed → 0 entries.
* **Verification:** no keys are loaded; fills use real Jupiter quotes plus 1.5% slippage and 5% random
  failures. Free public RPCs may rate-limit (HTTP 429 lines); the scan retries.

## 5. Inspect trading decisions and replay

* `node scripts/replay.ts --since <YYYY-MM-DD>`: replays recorded `market_observations` through the same
  entry and exit rules (an upper bound: it cannot model failed exits).
* The `scan_funnel`, `shadow_trades` and `market_observations` tables hold every decision and its reason.

## 6. Live deployment (read-only)

| Action | Expected result |
|---|---|
| `curl https://bagflip-production.up.railway.app/health` | `{"ok":true,"env":"live",...}` |
| `curl https://bagflip-production.up.railway.app/public/vault` | Mainnet vault status, council seats, distributions, mode syncs |
| `near contract call-function as-read-only bagflip-vault.near get_config json-args {} network-config mainnet now` | 20 seats, veto 5, admin 11, cap 50 NEAR, delays 12 h / 24 h / 48 h |
| `near account view-account-summary bagflip-vault.near network-config mainnet now` | Code hash `5HBEhQYPoyHkaBnWXDpyRTrcUnxMiCbKmd6LfBvi48D7` |
| `near contract call-function as-read-only v2-launchpad.justhoot.near get_token_fee_state json-args '{"token_id":"bagflip.v2-launchpad.justhoot.near"}' network-config mainnet now` | `dev_id: "bagflip-vault.near"`, `transfer_fee_pips: 50000`, `shares.token_owner_bps: 10000` |
| `node --env-file=.env scripts/verify-live.ts` | Read-only checks of NEAR RPC, token metadata, 1Click dry quotes, Jupiter, PumpPortal |

## 7. End-to-end in Telegram (needs a NEAR wallet holding BAGFLIP)

| Action | Expected result | Verification |
|---|---|---|
| DM [@bagflip_bot](https://t.me/bagflip_bot): `/connect` | A single-use "Verify NEAR wallet" link | Link expires in 10 min |
| Open it in a browser, sign with Meteor (or HOT / Intear) | "✅ `<account>` verified" | Bot confirms in DM; no transaction is sent |
| In [the group](https://t.me/bagfliptrade), tap 🔥 AUTO HUNT or 💰 DISTRIBUTE | "Vote recorded…"; the pinned tally updates | `/status` shows the live tally |
| Wait for 00:00 MYT | Decision posted in the group | `/public/decisions/<cycle>` shows the snapshot row for your wallet |
| `/power`, `/council`, `/treasury` | Your weight, council seats, vault balances | Matches `get_seats` / `get_status` |

## 8. Operations that need funds or keys

| Operation | Requires |
|---|---|
| Live AUTO HUNT trades | An AUTO HUNT decision + 12 h time lock, vault balance ≥ $20, `LIVE_TRADING_ENABLED=true`, `SOLANA_TRADING_PRIVATE_KEY`, SOL for fees |
| Live distribution and claims | A creator-fee payout in the vault, a DISTRIBUTE decision, the 24 h veto window |
| Vault calls from the service | `LIVE_TRANSFERS_ENABLED=true` and the operator function-call key (configured in production) |
