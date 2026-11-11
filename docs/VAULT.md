# The BAGFLIP vault

The reward treasury is a smart contract ([contracts/vault](../contracts/vault/src/lib.rs)) deployed to
`bagflip.near` and then **locked**: every access key of that account is deleted. After that:

* **Nobody can sign for the account:** not the creator, not the bot operator, not the Holder Council.
* **The code can never change.** The contract has no upgrade or withdraw method.
* **Anyone can check this** on any NEAR explorer: the account shows 0 access keys and the published
  code hash.

## How money can leave (the only two ways)

| Path | Who calls it | What the contract enforces |
|---|---|---|
| `claim` / `claim_many` | anyone (the bot relays them, holders can call directly) | Pays **only the account named in the payout list's Merkle leaf**, only after that list's veto window, at most once per account per list, and never more than the list's total. If the transfer fails, the claim reopens. |
| `fund_trading` | operator only | Only while the mode is AUTO_HUNT (activated through a time lock). At most `daily_hunt_cap` per rolling 24h, only from unreserved funds. The wrap → `ft_transfer` to the 1Click deposit address happens in one atomic receipt; if it fails the funds come back and the cap is freed. |

Funds reserved for proposed payout lists can't be used for trading. The contract keeps
`reserved_for_claims` and refuses any `fund_trading` or new list beyond the unreserved balance.

## Roles

* **Operator** (the BAGFLIP bot, e.g. `bagflip-bot.near`).
  * Proposes each daily mode and each payout list, requests capped trading transfers, and relays
    claims.
  * Use a **function-call key** restricted to the vault's operator methods. A leaked operator key can
    then only do what the contract allows the operator to do.
* **Holder Council: the top 10 BAGFLIP holders.** Membership is decided **on chain**, not by the bot
  or the creator.
  * Anyone can nominate an account with `claim_seat`. The vault reads the BAGFLIP balances itself
    (`ft_balance_of` on the token contract).
  * While seats are free, any holder with at least `min_seat_balance` joins.
  * When the council is full, the nominee must name a seat to contest. The nominee takes it only if
    their **current** balance is larger than that seat holder's **current** balance. So a holder who
    sells is displaced by anyone who now holds more.
  * Pools, bridges, the vault, the token contract and the operator can never sit
    (`excluded`).
  * **No buy-and-vote:** a new seat can vote only after `seat_min_age` (default 24h).
  * **3 seats** can veto a pending payout list or a pending AUTO_HUNT activation, or pause the vault.
  * **6 seats**, plus the admin delay (default 48h), can change the operator, the daily cap or the
    excluded list, or revoke an already-active payout list. Unpausing needs 6 seats with no delay.
  * Only votes from **current, eligible** seats count; a seat that is lost takes its votes with it.
  * If fewer seats are filled, both thresholds scale down to the number of eligible seats (minimum 1),
    so the vault can never deadlock.
  * Council members can never withdraw funds, send money to themselves or change the code. The
    contract has no function for that.
* **The bot** nominates the current top holders every 6 hours. It can't seat anyone the balances
  don't support, because the contract re-checks them.
* **Anyone** can contest seats, execute an approved admin action, apply a matured mode, unwrap
  returned wNEAR, and relay claims.

## Risk asymmetry

| Change | Effect |
|---|---|
| Switch to DISTRIBUTE or INACTIVE | **immediate** (reduces risk) |
| Pause, veto | **immediate** |
| Activate AUTO_HUNT | after `mode_delay` (default 12h); 3 council seats can veto |
| New payout list | claims open after `distribution_delay` (default 24h); 3 council seats can veto |
| Operator / cap / exclusions / revoke an active list | 6 council seats + `admin_delay` (default 48h) |

So when holders vote AUTO HUNT at 00:00 MYT, new trading allocations can start at 12:00 MYT at the
earliest. A vote to DISTRIBUTE stops new allocations at once.

## What the contract cannot verify (and how that's bounded)

1. **The snapshot behind a payout list.** A NEAR contract can't read historical token balances, so
   the bot computes the list off chain. Every list is public:
   * `/public/distributions/<id>` returns the exact canonical JSON whose sha256 is the on-chain
     `data_hash`.
   * `/public/decisions/<cycle>` returns the per-wallet vote snapshot whose sha256 the vault records
     with `propose_mode`.

   The council and any holder can recompute both from chain data during the veto window. A list can never
   pay more than its stated total.
2. **The Solana recipient behind a 1Click deposit address.** 1Click decides the recipient off chain.
   This is bounded in three ways:
   * the daily cap limits the worst case;
   * every transfer is logged on chain (`trading_fund_requested`, with the deposit address as
     `quote_ref`), so anyone can check `GET https://1click.chaindefuser.com/v0/status?depositAddress=…`
     shows the published trading wallet as recipient;
   * the council (3 seats) or the bot can pause.
3. **The Solana trading wallet itself** is a hot key the bot needs to trade. The vault cap limits how
   much can ever sit there. Moving the bot into a TEE (for example NEAR Shade Agents) is the planned
   next step.

## Payout list format (identical in Rust and TypeScript)

```
leaf = sha256(0x00 ‖ epoch u64 LE ‖ amount u128 LE ‖ account_id utf8)
node = sha256(0x01 ‖ min(a,b) ‖ max(a,b))        # sorted pairs: proofs need no direction bits
```

* Leaves are ordered by account id, and an odd node at the end of a level is promoted.
* Shared test vectors live in `contracts/vault/test-vectors/merkle.json`. Regenerate them with
  `node scripts/gen-merkle-vectors.ts`. Both the Rust and TS suites check them.

## Self-claim, without the bot

```bash
curl https://<PUBLIC_URL>/public/proofs/alice.near
```

```bash
near contract call-function as-transaction bagflip.near claim json-args '{"epoch":1,"account_id":"alice.near","amount":"6000000000000000000000000","proof":["…"]}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as <any-account> network-config mainnet sign-with-keychain send
```

The payout goes to `alice.near` whoever submits the call. If the bot later relays the same claim, it
sees `already claimed` and books it, without paying twice.

## Deploy and lock runbook

`node --env-file=.env scripts/vault-plan.ts` prints these commands with your values filled in, plus
the expected code hash. It executes nothing.

0. **Build and test.**
   * `docker run --rm -v "$PWD/contracts/vault:/work" -w /work wtn-build cargo test` (17 tests).
   * Build with `cargo near build non-reproducible-wasm --no-abi`.
   * For public verification, prefer `cargo near build reproducible-wasm` from a clean git checkout,
     so anyone can rebuild the exact code hash.
1. **Create the accounts.** Create `bagflip.near` (the vault) and a separate operator account (e.g.
   `bagflip-bot.near`). Deploy **after** the BAGFLIP token launches: council seats read its balances.
2. **Deploy and initialize** with `near contract deploy … with-init-call new …`.
3. **Verify.** Check `get_config` and the code hash against the plan output.
4. **Add the operator key.** Add a function-call key on the operator account, limited to the vault's
   operator methods. Put it in `OPERATOR_PRIVATE_KEY`.
5. **Route rewards.** Point creator rewards at the vault; if the launchpad doesn't allow that, forward
   them manually.
6. **Test before locking.** Run a small rehearsal first (or on testnet): a tiny payout list, a claim,
   and a veto.
7. **Lock.** Delete every key of `bagflip.near`. **This can't be undone.** If the contract had a bug,
   funds already in it can only leave by its rules.
8. **Fill the council.** Seat the top holders (the bot does this automatically; `/council` in Telegram
   shows the seats).
9. **Publish.** Post the account, the code hash, the 0 access keys and the council in the
   Telegram group.

## Testing

* **Contract:** 17 Rust unit tests cover:
  * claims only paying the listed account, after the window, once, within the total
  * failed transfers reopening claims
  * Holder Council seats: on-chain balance contests, exclusions, minimum balance, seat age, a seller
    being displaced, vote thresholds, votes of replaced seats no longer counting, threshold scaling
  * council vetoes, before and after activation
  * time-locked AUTO_HUNT versus instant DISTRIBUTE
  * the rolling cap and freeing it on failure
  * pause and unpause thresholds
  * operator rotation
  * init validation
  * the shared Merkle vectors
* **Backend:** `tests/vault.test.ts` runs the full bot flows against `SimVault`, an in-process model
  of the same rules: time-lock, veto, cap, claim delay, self-claims, snapshot hashes and pause.
