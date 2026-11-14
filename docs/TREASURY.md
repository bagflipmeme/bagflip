# Treasury: the BAGFLIP vault

The community treasury is a Rust smart contract ([contracts/vault](../contracts/vault/src/lib.rs),
near-sdk 5.30.1, version 1.1.0) deployed at **`bagflip-vault.near`** on NEAR mainnet. It has no owner,
no withdraw method and no upgrade method: funds leave only by the two paths below.

## Deployment record (NEAR mainnet)

| Item | Value | Check |
|---|---|---|
| Account | `bagflip-vault.near` | any explorer |
| Code hash | `5HBEhQYPoyHkaBnWXDpyRTrcUnxMiCbKmd6LfBvi48D7` | `near account view-account-summary bagflip-vault.near network-config mainnet now` |
| Token | `bagflip.v2-launchpad.justhoot.near` | `get_config` |
| Operator | `bagflip-bot.near` (function-call key: 9 vault methods, 0.25 NEAR allowance) | `get_config`, `list-keys bagflip-bot.near` |
| Trading recipient | `EwMZcvgdnZRuQxzz66bq86EYSpgLcA4ppW6eEAut8FuQ` (Solana) | `get_config` |
| Creator-fee routing | Launchpad `dev_id = bagflip-vault.near` | `get_token_fee_state` on `v2-launchpad.justhoot.near` |
| Access keys | **1 full-access key (deployer)**: retained during the hackathon for recoverability; the vault is not yet locked | `near account list-keys bagflip-vault.near network-config mainnet now` |

Deployed parameters (`get_config`): 20 council seats, veto threshold 5, admin threshold 11, minimum seat
balance 1 BAGFLIP, seat age 24 h, daily hunt cap 50 NEAR, AUTO HUNT delay 12 h, distribution delay 24 h,
admin delay 48 h, reserve 0.05 NEAR, excluded `dclv2.ref-labs.near`.

## How money can leave

| Path | Caller | Enforced by the contract |
|---|---|---|
| `claim` / `claim_many` | Anyone (the bot relays; holders can self-claim) | Pays only the account in the payout list's Merkle leaf, after the list's 24 h veto window, once per account per list, never above the list total. A failed transfer reopens the claim. |
| `fund_trading(amount, deposit_address, quote_ref)` | Operator | Only in effective AUTO_HUNT mode, from unreserved funds, ≤ 50 NEAR per rolling 24 h. Wraps NEAR and `ft_transfer`s wNEAR to the 1Click deposit address in one receipt; on failure the funds return and the cap is freed. |

## Contract methods

| Method | Who | Purpose |
|---|---|---|
| `propose_mode(cycle_id, mode, snapshot_hash)` | Operator | Mirror the daily decision; AUTO_HUNT becomes pending for 12 h |
| `apply_pending_mode()` | Anyone | Activate a matured AUTO_HUNT |
| `propose_distribution(epoch, root, total, data_hash)` | Operator | Publish a payout list; reserves `total` |
| `claim`, `claim_many` | Anyone | Pay listed accounts with Merkle proofs |
| `fund_trading` | Operator | Capped transfer to NEAR Intents |
| `unwrap(amount)` | Anyone | Convert wNEAR held by the vault to NEAR (harmless) |
| `claim_seat(candidate, replace)` | Anyone | Contest a council seat; balances read via `ft_balance_of` |
| `veto_distribution`, `veto_mode` | Council seat | Veto during the delay (5 votes) |
| `pause` | Operator (immediately) or council (5 votes) | Block claims, new payout lists and trading transfers |
| `propose_admin`, `approve_admin`, `execute_admin` | Council | Operator / cap / exclusions / revoke / unpause (11 votes, 48 h delay except unpause) |
| `get_config`, `get_status`, `get_seats`, `get_distribution`, `is_claimed`, `get_hunt_transfer`, `get_admin_proposal`, `get_votes`, `compute_leaf` | View | Inspection |

## Risk asymmetry

| Change | Effect |
|---|---|
| DISTRIBUTE or INACTIVE, pause, veto | Immediate |
| Activate AUTO_HUNT | After 12 h; 5 council seats can veto |
| New payout list | Claimable after 24 h; 5 council seats can veto |
| Operator, cap, exclusions, revoke an active list | 11 seats + 48 h |

## Treasury flow and accounting

1. **Revenue in.** The launchpad pays wNEAR to the vault; `treasury.scan_deposits` credits it once per
   receipt (`treasury:available`, `equity:deposits`).
2. **DISTRIBUTE.** The pool (≥ $20) is reserved (`distribution:pool`), entitlements are computed at one block,
   and the Merkle root goes to the vault (`propose_distribution`). After 24 h, `claim.pay` relays claims; or a
   holder claims directly.
3. **AUTO HUNT.** After the time lock, `bridge.fund_trading` requests a 1Click quote and calls
   `fund_trading` (`bridge:outbound`). SOL is credited to `trading:available` only after 1Click `SUCCESS`
   **and** the Solana transfer is confirmed.
4. **Wind-down.** When DISTRIBUTE wins, positions are sold and SOL returns to the vault through 1Click.
5. **Reconciliation.** Ledger balances are compared with on-chain balances; a shortfall pauses trading.

## Payout list format (identical in Rust and TypeScript)

```
leaf = sha256(0x00 ‖ epoch u64 LE ‖ amount u128 LE ‖ account_id utf8)
node = sha256(0x01 ‖ min(a,b) ‖ max(a,b))
```

Shared vectors: `contracts/vault/test-vectors/merkle.json` (`node scripts/gen-merkle-vectors.ts`).

## Self-claim without the bot

```bash
curl https://bagflip-production.up.railway.app/public/proofs/alice.near
```

```bash
near contract call-function as-transaction bagflip-vault.near claim json-args '{"epoch":1,"account_id":"alice.near","amount":"<amount>","proof":["<hex>"]}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <any-account> network-config mainnet sign-with-keychain send
```

The payout goes to `alice.near` regardless of who submits it; a later relay of the same claim pays nothing.

## Locking (planned)

`node --env-file=.env scripts/vault-plan.ts` prints the deploy, verify and lock commands with the expected
code hash (it executes nothing). Locking deletes the vault's last full-access key, which is irreversible.
After that, nobody can sign for the account and the deployed rules are final.
