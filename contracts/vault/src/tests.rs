//! Unit tests for every rule that protects vault funds, including the on-chain Holder Council.
#![allow(unused_must_use)]

use super::*;
use near_sdk::serde_json;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const ME: &str = "bagflip.near";
const OPERATOR: &str = "bagflip-bot.near";
const TOKEN: &str = "bagflip.launchpad.justhoot.near";
const POOL: &str = "dclv2.ref-labs.near";
const MALLORY: &str = "mallory.near";
const WRAP: &str = "wrap.near";
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const TOK: u128 = 1_000_000_000_000_000_000; // 1 token, 18 decimals
const SEC: u64 = 1_000_000_000;
const HOUR: u64 = 3600 * SEC;
const HASH: &str = "aa11bb22cc33dd44ee55ff6600778899aa11bb22cc33dd44ee55ff6600778899";
const T0: u64 = 1_000_000 * SEC;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn env_at(pred: &str, now: u64, balance: u128, results: Vec<PromiseResult>) {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(acc(ME))
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(now)
        .account_balance(NearToken::from_yoctonear(balance));
    testing_env!(ctx.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), results);
}

fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

fn new_vault() -> Vault {
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    Vault::new(
        acc(OPERATOR),
        acc(TOKEN),
        vec![acc(POOL), acc("intents.near")],
        10,
        U128(1_000 * TOK),
        24 * 3600,
        3,
        6,
        acc(WRAP),
        "TradingWa11et1111111111111111111111111111111".into(),
        U128(20 * NEAR),
        12 * 3600,
        24 * 3600,
        48 * 3600,
        U128(NEAR),
    )
}

fn holder(i: usize) -> String {
    format!("holder{}.near", i)
}

/// Seat an account through the real nominate → balance-callback path.
fn seat(v: &mut Vault, who: &str, bal: u128, now: u64) -> bool {
    env_at(MALLORY, now, 100 * NEAR, vec![]);
    v.claim_seat(acc(who), None);
    env_at(ME, now, 100 * NEAR, vec![]);
    v.on_seat_add(acc(who), Ok(U128(bal)))
}

/// Fill `n` seats at T0 (eligible to vote from T0 + 24h). holder0 is the largest.
fn council(v: &mut Vault, n: usize) {
    for i in 0..n {
        assert!(seat(v, &holder(i), (100_000 - i as u128 * 1_000) * TOK, T0));
    }
}

fn contest(v: &mut Vault, cand: &str, target: &str, cand_bal: u128, target_bal: u128, now: u64) -> bool {
    env_at(MALLORY, now, 100 * NEAR, vec![]);
    v.claim_seat(acc(cand), Some(acc(target)));
    env_at(ME, now, 100 * NEAR, vec![]);
    v.on_seat_replace(acc(cand), acc(target), Ok(U128(cand_bal)), Ok(U128(target_bal)))
}

#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VLeaf {
    account_id: String,
    amount: String,
    leaf: String,
    proof: Vec<String>,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VCase {
    epoch: u64,
    root: String,
    total: String,
    leaves: Vec<VLeaf>,
}

fn vectors() -> Vec<VCase> {
    serde_json::from_str(include_str!("../test-vectors/merkle.json")).unwrap()
}

/// Case 7: alice 6 / bob 3 / carol 1 NEAR.
fn case7() -> VCase {
    vectors().into_iter().find(|c| c.epoch == 7).unwrap()
}

fn propose7(v: &mut Vault, now: u64) -> VCase {
    let c = case7();
    env_at(OPERATOR, now, 100 * NEAR, vec![]);
    v.propose_distribution(7, c.root.clone(), U128(c.total.parse().unwrap()), HASH.into());
    c
}

fn leaf<'a>(c: &'a VCase, who: &str) -> &'a VLeaf {
    c.leaves.iter().find(|l| l.account_id == who).unwrap()
}

fn amt(l: &VLeaf) -> U128 {
    U128(l.amount.parse().unwrap())
}

#[test]
fn merkle_vectors_match_typescript() {
    env_at(OPERATOR, T0, 0, vec![]);
    for c in vectors() {
        let root = unhex32(&c.root);
        for l in &c.leaves {
            let h = leaf_hash(c.epoch, &l.account_id, l.amount.parse().unwrap());
            assert_eq!(hex(&h), l.leaf, "leaf mismatch for {}", l.account_id);
            assert!(verify_proof(&root, h, &l.proof), "proof failed for {} in epoch {}", l.account_id, c.epoch);
            assert!(!verify_proof(&root, leaf_hash(c.epoch, &l.account_id, l.amount.parse::<u128>().unwrap() + 1), &l.proof));
            assert!(!verify_proof(&root, leaf_hash(c.epoch + 1, &l.account_id, l.amount.parse().unwrap()), &l.proof));
        }
        assert!(!c.total.is_empty());
    }
}

// ───────────── claims ─────────────

#[test]
fn claims_pay_only_the_listed_account_after_the_veto_window() {
    let mut v = new_vault();
    let c = propose7(&mut v, T0);
    assert_eq!(v.get_status().reserved_for_claims.0, 10 * NEAR);
    let a = leaf(&c, "alice.near");

    env_at(MALLORY, T0 + HOUR, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), amt(a), a.proof.clone());
    }), "claim inside veto window must fail");

    let later = T0 + 25 * HOUR;
    env_at(MALLORY, later, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc(MALLORY), amt(a), a.proof.clone());
    }));
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), U128(amt(a).0 * 2), a.proof.clone());
    }));
    v.claim(7, acc("alice.near"), amt(a), a.proof.clone());
    assert!(v.is_claimed(7, acc("alice.near")));
    assert_eq!(v.get_status().reserved_for_claims.0, 4 * NEAR);
    assert!(get_logs().iter().any(|l| l.contains("claim_sent") && l.contains("alice.near")));
    env_at(OPERATOR, later, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), amt(a), a.proof.clone());
    }));
}

#[test]
fn failed_claim_transfer_reopens_the_claim() {
    let mut v = new_vault();
    let c = propose7(&mut v, T0);
    let b = leaf(&c, "bob.near");
    let later = T0 + 25 * HOUR;
    env_at(OPERATOR, later, 100 * NEAR, vec![]);
    v.claim(7, acc("bob.near"), amt(b), b.proof.clone());
    env_at(ME, later, 100 * NEAR, vec![PromiseResult::Failed]);
    assert!(!v.on_claim(acc("bob.near"), vec![(7, amt(b))], Err(PromiseError::Failed)));
    assert!(!v.is_claimed(7, acc("bob.near")));
    assert_eq!(v.get_status().reserved_for_claims.0, 10 * NEAR);
    assert_eq!(v.get_distribution(7).unwrap().claimed.0, 0);
}

#[test]
fn claim_many_rejects_duplicate_epochs() {
    let mut v = new_vault();
    let c = propose7(&mut v, T0);
    let a = leaf(&c, "alice.near");
    env_at(OPERATOR, T0 + 25 * HOUR, 100 * NEAR, vec![]);
    let item = ClaimItem { epoch: 7, amount: amt(a), proof: a.proof.clone() };
    assert!(panics(|| {
        v.claim_many(acc("alice.near"), vec![item.clone(), item.clone()]);
    }));
}

#[test]
fn reserved_claims_and_reserve_cannot_be_overcommitted() {
    let mut v = new_vault();
    env_at(OPERATOR, T0, 12 * NEAR, vec![]);
    let free = v.get_status().free_balance.0;
    assert!(free < 11 * NEAR);
    assert!(panics(|| v.propose_distribution(1, HASH.into(), U128(free + 1), HASH.into())));
    v.propose_distribution(1, HASH.into(), U128(free - NEAR), HASH.into());
    assert_eq!(v.get_status().free_balance.0, NEAR);
    env_at(OPERATOR, T0, 12 * NEAR, vec![]);
    v.propose_mode("2026-11-10".into(), Mode::AutoHunt, HASH.into());
    env_at(OPERATOR, T0 + 13 * HOUR, 12 * NEAR, vec![]);
    assert!(panics(|| {
        v.fund_trading(U128(2 * NEAR), acc("deposit.near"), "q1".into());
    }));
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    assert!(panics(|| v.propose_distribution(1, HASH.into(), U128(NEAR), HASH.into())));
}

// ───────────── Holder Council seats ─────────────

#[test]
fn seats_are_won_by_on_chain_balance_and_exclude_protocol_accounts() {
    let mut v = new_vault();
    env_at(MALLORY, T0, 100 * NEAR, vec![]);
    for bad in [POOL, "intents.near", OPERATOR, TOKEN, ME, WRAP] {
        assert!(panics(|| {
            v.claim_seat(acc(bad), None);
        }), "{} must be excluded", bad);
    }
    assert!(!seat(&mut v, "tiny.near", 999 * TOK, T0), "below the minimum balance");
    env_at(ME, T0, 100 * NEAR, vec![]);
    assert!(!v.on_seat_add(acc("x.near"), Err(PromiseError::Failed)), "failed balance read changes nothing");
    council(&mut v, 10);
    assert_eq!(v.get_seats().len(), 10);
    env_at(MALLORY, T0, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim_seat(acc("whale.near"), None);
    }), "full council: must contest a seat");
    assert!(panics(|| {
        v.claim_seat(acc(&holder(0)), Some(acc(&holder(9))));
    }), "already seated");
    assert!(!contest(&mut v, "small.near", &holder(9), 50_000 * TOK, 91_000 * TOK, T0), "smaller holder cannot displace");
    assert!(contest(&mut v, "whale.near", &holder(9), 500_000 * TOK, 91_000 * TOK, T0));
    assert!(v.get_seats().iter().any(|s| s.account_id == acc("whale.near")));
    assert!(!v.get_seats().iter().any(|s| s.account_id == acc(&holder(9))));
}

#[test]
fn a_seat_holder_who_sold_is_displaced_by_anyone_holding_more_now() {
    let mut v = new_vault();
    council(&mut v, 10);
    // holder0 won with 100k but sold down to 10 tokens; CURRENT balances decide
    assert!(contest(&mut v, "newcomer.near", &holder(0), 5_000 * TOK, 10 * TOK, T0 + HOUR));
}

#[test]
fn new_seats_cannot_vote_until_they_have_aged() {
    let mut v = new_vault();
    council(&mut v, 10);
    propose7(&mut v, T0 + HOUR);
    env_at(&holder(0), T0 + 2 * HOUR, 100 * NEAR, vec![]);
    assert_eq!(v.get_status().eligible_seats, 0);
    assert!(panics(|| {
        v.veto_distribution(7, "x".into());
    }), "seat younger than 24h");
}

// ───────────── council votes ─────────────

#[test]
fn payout_list_veto_needs_three_council_votes() {
    let mut v = new_vault();
    council(&mut v, 10);
    let t = T0 + 25 * HOUR;
    propose7(&mut v, t);
    assert_eq!(v.get_status().veto_votes_required, 3);
    env_at(MALLORY, t + 1, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.veto_distribution(7, "x".into());
    }), "non-seat cannot vote");
    for (i, expect) in [(0, false), (1, false), (1, false), (2, true)] {
        env_at(&holder(i), t + 10, 100 * NEAR, vec![]);
        assert_eq!(v.veto_distribution(7, "list does not match snapshot".into()), expect);
    }
    assert!(v.get_distribution(7).unwrap().vetoed);
    assert_eq!(v.get_status().reserved_for_claims.0, 0);
    let c = case7();
    let a = leaf(&c, "alice.near");
    env_at(OPERATOR, t + 25 * HOUR, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), amt(a), a.proof.clone());
    }));
}

#[test]
fn votes_of_a_replaced_seat_stop_counting() {
    let mut v = new_vault();
    council(&mut v, 10);
    let t = T0 + 25 * HOUR;
    propose7(&mut v, t);
    env_at(&holder(0), t + 1, 100 * NEAR, vec![]);
    v.veto_distribution(7, "x".into());
    env_at(&holder(1), t + 2, 100 * NEAR, vec![]);
    v.veto_distribution(7, "x".into());
    assert!(contest(&mut v, "bigger.near", &holder(0), 900_000 * TOK, 100 * TOK, t + 3));
    env_at(&holder(2), t + 4, 100 * NEAR, vec![]);
    assert!(!v.veto_distribution(7, "x".into()), "only 2 current eligible votes");
    env_at(&holder(3), t + 5, 100 * NEAR, vec![]);
    assert!(v.veto_distribution(7, "x".into()));
}

#[test]
fn thresholds_scale_down_with_few_eligible_seats_so_nothing_deadlocks() {
    let mut v = new_vault();
    council(&mut v, 2);
    env_at(OPERATOR, T0 + 25 * HOUR, 100 * NEAR, vec![]);
    let st = v.get_status();
    assert_eq!((st.eligible_seats, st.veto_votes_required, st.admin_votes_required), (2, 2, 2));
    assert!(v.pause("operator pause".into()), "operator pauses immediately");
    env_at(&holder(0), T0 + 25 * HOUR, 100 * NEAR, vec![]);
    let id = v.propose_admin(AdminAction::Unpause);
    assert!(panics(|| v.execute_admin(id)));
    env_at(&holder(1), T0 + 25 * HOUR, 100 * NEAR, vec![]);
    v.approve_admin(id);
    v.execute_admin(id);
    assert!(!v.get_status().paused);
}

#[test]
fn risk_reducing_modes_are_instant_auto_hunt_is_time_locked_and_vetoable() {
    let mut v = new_vault();
    council(&mut v, 10);
    let t = T0 + 25 * HOUR;
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    v.propose_mode("c1".into(), Mode::AutoHunt, HASH.into());
    assert_eq!(v.get_status().mode, Mode::Inactive);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }), "cannot trade before the mode delay");
    for (i, expect) in [(0, false), (1, false), (2, true)] {
        env_at(&holder(i), t + HOUR, 100 * NEAR, vec![]);
        assert_eq!(v.veto_mode("suspicious snapshot".into()), expect);
    }
    env_at(OPERATOR, t + 13 * HOUR, 100 * NEAR, vec![]);
    assert_eq!(v.get_status().effective_mode, Mode::Inactive);

    v.propose_mode("c2".into(), Mode::AutoHunt, HASH.into());
    env_at(OPERATOR, t + 26 * HOUR, 100 * NEAR, vec![]);
    assert_eq!(v.apply_pending_mode(), Mode::AutoHunt);
    v.propose_mode("c3".into(), Mode::Distribute, HASH.into());
    assert_eq!(v.get_status().mode, Mode::Distribute);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }));
    env_at(MALLORY, t + 27 * HOUR, 100 * NEAR, vec![]);
    assert!(panics(|| v.propose_mode("x".into(), Mode::Inactive, HASH.into())));
}

fn hunting_vault() -> (Vault, u64) {
    let mut v = new_vault();
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    v.propose_mode("c1".into(), Mode::AutoHunt, HASH.into());
    (v, T0 + 13 * HOUR)
}

#[test]
fn trading_transfers_are_operator_only_and_capped_per_24h() {
    let (mut v, t) = hunting_vault();
    env_at(MALLORY, t, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }));
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    v.fund_trading(U128(15 * NEAR), acc("deposit1.near"), "quote-1".into());
    assert_eq!(v.get_status().hunt_used_24h.0, 15 * NEAR);
    assert!(panics(|| {
        v.fund_trading(U128(6 * NEAR), acc("deposit2.near"), "quote-2".into());
    }), "cap is 20 NEAR per rolling day");
    env_at(ME, t, 100 * NEAR, vec![PromiseResult::Failed]);
    assert!(!v.on_trading_funded(1, Err(PromiseError::Failed)));
    assert_eq!(v.get_hunt_transfer(1).unwrap().status, "failed");
    assert_eq!(v.get_status().hunt_used_24h.0, 0);
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    v.fund_trading(U128(20 * NEAR), acc("deposit3.near"), "quote-3".into());
    env_at(OPERATOR, t + DAY_NS + 1, 100 * NEAR, vec![]);
    assert_eq!(v.get_status().hunt_used_24h.0, 0);
    v.fund_trading(U128(NEAR), acc("deposit4.near"), "quote-4".into());
    env_at(ME, t + DAY_NS + 1, 100 * NEAR, vec![PromiseResult::Successful(vec![])]);
    assert!(v.on_trading_funded(3, Ok(())));
    assert_eq!(v.get_hunt_transfer(3).unwrap().status, "sent");
}

#[test]
fn council_pause_needs_three_votes_and_unpause_needs_six() {
    let mut v = new_vault();
    council(&mut v, 10);
    let t = T0 + 25 * HOUR;
    let c = propose7(&mut v, T0);
    for (i, expect) in [(0, false), (1, false), (2, true)] {
        env_at(&holder(i), t, 100 * NEAR, vec![]);
        assert_eq!(v.pause("incident".into()), expect);
    }
    assert!(v.get_status().paused);
    let a = leaf(&c, "alice.near");
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), amt(a), a.proof.clone());
    }));
    assert!(panics(|| v.propose_distribution(8, HASH.into(), U128(NEAR), HASH.into())));
    v.propose_mode("c9".into(), Mode::Distribute, HASH.into()); // risk-reducing still works
    env_at(&holder(0), t, 100 * NEAR, vec![]);
    let id = v.propose_admin(AdminAction::Unpause);
    for i in 1..5 {
        env_at(&holder(i), t, 100 * NEAR, vec![]);
        v.approve_admin(id);
    }
    assert!(panics(|| v.execute_admin(id)), "5 of 6");
    env_at(&holder(5), t, 100 * NEAR, vec![]);
    v.approve_admin(id);
    env_at(MALLORY, t, 100 * NEAR, vec![]);
    v.execute_admin(id);
    assert!(!v.get_status().paused);
    env_at(&holder(0), t + 1, 100 * NEAR, vec![]);
    assert!(!v.pause("again".into()), "a new pause round needs fresh votes");
}

#[test]
fn admin_changes_need_six_seats_and_the_delay() {
    let mut v = new_vault();
    council(&mut v, 10);
    let t = T0 + 25 * HOUR;
    env_at(&holder(0), t, 100 * NEAR, vec![]);
    let id = v.propose_admin(AdminAction::SetOperator { operator: acc("new-bot.near") });
    for i in 1..6 {
        env_at(&holder(i), t, 100 * NEAR, vec![]);
        v.approve_admin(id);
    }
    assert!(panics(|| v.execute_admin(id)), "admin delay not passed");
    env_at(MALLORY, t + 48 * HOUR, 100 * NEAR, vec![]);
    v.execute_admin(id);
    assert_eq!(v.get_config().operator, acc("new-bot.near"));
    env_at(&holder(0), t + 49 * HOUR, 100 * NEAR, vec![]);
    let id = v.propose_admin(AdminAction::SetExcluded { accounts: vec![acc(POOL), acc(&holder(9))] });
    for i in 1..6 {
        env_at(&holder(i), t + 49 * HOUR, 100 * NEAR, vec![]);
        v.approve_admin(id);
    }
    env_at(MALLORY, t + 98 * HOUR, 100 * NEAR, vec![]);
    v.execute_admin(id);
    assert_eq!(v.get_seats().len(), 9, "excluding an account removes its seat");
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.propose_admin(AdminAction::SetDailyHuntCap { cap: U128(1000 * NEAR) });
    }), "non-seats cannot propose");
}

#[test]
fn active_lists_can_only_be_revoked_by_the_council_with_delay() {
    let mut v = new_vault();
    council(&mut v, 10);
    propose7(&mut v, T0);
    let t = T0 + 25 * HOUR;
    env_at(&holder(0), t, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.veto_distribution(7, "late".into());
    }));
    let id = v.propose_admin(AdminAction::RevokeDistribution { epoch: 7 });
    for i in 1..6 {
        env_at(&holder(i), t, 100 * NEAR, vec![]);
        v.approve_admin(id);
    }
    env_at(MALLORY, t + 48 * HOUR, 100 * NEAR, vec![]);
    v.execute_admin(id);
    assert!(v.get_distribution(7).unwrap().vetoed);
    assert_eq!(v.get_status().reserved_for_claims.0, 0);
}

#[test]
fn init_validates_council_parameters() {
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    let mk = |seats: u8, veto: u8, admin: u8, min: u128| {
        Vault::new(acc(OPERATOR), acc(TOKEN), vec![], seats, U128(min), 1, veto, admin, acc(WRAP), "x".into(), U128(1), 1, 1, 1, U128(0));
    };
    assert!(panics(|| {
        mk(0, 1, 1, 1);
    }));
    assert!(panics(|| {
        mk(10, 11, 6, 1);
    }));
    assert!(panics(|| {
        mk(10, 3, 11, 1);
    }));
    assert!(panics(|| {
        mk(10, 3, 6, 0);
    }));
    mk(10, 3, 6, 1);
}
