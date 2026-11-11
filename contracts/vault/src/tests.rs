//! Unit tests for every rule that protects vault funds.
#![allow(unused_must_use)]

use super::*;
use near_sdk::serde_json;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const ME: &str = "bagflip.near";
const OPERATOR: &str = "bagflip-bot.near";
const G1: &str = "guardian1.near";
const G2: &str = "guardian2.near";
const G3: &str = "guardian3.near";
const MALLORY: &str = "mallory.near";
const WRAP: &str = "wrap.near";
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const SEC: u64 = 1_000_000_000;
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
    Vault::new(acc(OPERATOR), vec![acc(G1), acc(G2), acc(G3)], 2, acc(WRAP), "TradingWa11et1111111111111111111111111111111".into(), U128(20 * NEAR), 12 * 3600, 24 * 3600, 48 * 3600, U128(NEAR))
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

#[test]
fn merkle_vectors_match_typescript() {
    env_at(OPERATOR, T0, 0, vec![]);
    for c in vectors() {
        let root = unhex32(&c.root);
        for l in &c.leaves {
            let h = leaf_hash(c.epoch, &l.account_id, l.amount.parse().unwrap());
            assert_eq!(hex(&h), l.leaf, "leaf mismatch for {}", l.account_id);
            assert!(verify_proof(&root, h, &l.proof), "proof failed for {} in epoch {}", l.account_id, c.epoch);
            // a different amount or epoch never verifies
            assert!(!verify_proof(&root, leaf_hash(c.epoch, &l.account_id, l.amount.parse::<u128>().unwrap() + 1), &l.proof));
            assert!(!verify_proof(&root, leaf_hash(c.epoch + 1, &l.account_id, l.amount.parse().unwrap()), &l.proof));
        }
    }
}

#[test]
fn claims_pay_only_the_listed_account_after_the_veto_window() {
    let mut v = new_vault();
    let c = propose7(&mut v, T0);
    assert_eq!(v.get_status().reserved_for_claims.0, 10 * NEAR);
    let a = leaf(&c, "alice.near");

    env_at(MALLORY, T0 + 3600 * SEC, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), U128(a.amount.parse().unwrap()), a.proof.clone());
    }), "claim inside veto window must fail");

    let later = T0 + 25 * 3600 * SEC;
    env_at(MALLORY, later, 100 * NEAR, vec![]);
    // Mallory cannot use Alice's proof for herself, nor inflate the amount.
    assert!(panics(|| {
        v.claim(7, acc(MALLORY), U128(a.amount.parse().unwrap()), a.proof.clone());
    }));
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), U128(a.amount.parse::<u128>().unwrap() * 2), a.proof.clone());
    }));
    // Anyone may relay the claim, but it always pays alice.near.
    let _ = v.claim(7, acc("alice.near"), U128(a.amount.parse().unwrap()), a.proof.clone());
    assert!(v.is_claimed(7, acc("alice.near")));
    assert_eq!(v.get_status().reserved_for_claims.0, 4 * NEAR);
    assert!(get_logs().iter().any(|l| l.contains("claim_sent") && l.contains("alice.near")));
    // No double claim.
    env_at(OPERATOR, later, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), U128(a.amount.parse().unwrap()), a.proof.clone());
    }));
}

#[test]
fn failed_claim_transfer_reopens_the_claim() {
    let mut v = new_vault();
    let c = propose7(&mut v, T0);
    let b = leaf(&c, "bob.near");
    let later = T0 + 25 * 3600 * SEC;
    env_at(OPERATOR, later, 100 * NEAR, vec![]);
    let _ = v.claim(7, acc("bob.near"), U128(b.amount.parse().unwrap()), b.proof.clone());
    env_at(ME, later, 100 * NEAR, vec![PromiseResult::Failed]);
    assert!(!v.on_claim(acc("bob.near"), vec![(7, U128(b.amount.parse().unwrap()))], Err(PromiseError::Failed)));
    assert!(!v.is_claimed(7, acc("bob.near")));
    assert_eq!(v.get_status().reserved_for_claims.0, 10 * NEAR);
    assert_eq!(v.get_distribution(7).unwrap().claimed.0, 0);
}

#[test]
fn claim_many_batches_epochs_and_respects_totals() {
    let mut v = new_vault();
    let c = propose7(&mut v, T0);
    let a = leaf(&c, "alice.near");
    env_at(OPERATOR, T0 + 25 * 3600 * SEC, 100 * NEAR, vec![]);
    let item = ClaimItem { epoch: 7, amount: U128(a.amount.parse().unwrap()), proof: a.proof.clone() };
    // same epoch twice in one call → second fails as already claimed
    assert!(panics(|| {
        v.claim_many(acc("alice.near"), vec![item.clone(), item.clone()]);
    }));
}

#[test]
fn reserved_claims_and_reserve_cannot_be_overcommitted() {
    let mut v = new_vault();
    env_at(OPERATOR, T0, 12 * NEAR, vec![]);
    // free = balance − storage cost − reserve; one yocto more than that is refused
    let free = v.get_status().free_balance.0;
    assert!(free < 11 * NEAR);
    assert!(panics(|| v.propose_distribution(1, HASH.into(), U128(free + 1), HASH.into())));
    v.propose_distribution(1, HASH.into(), U128(free - NEAR), HASH.into());
    assert_eq!(v.get_status().free_balance.0, NEAR);
    // trading cannot touch the reserved 10 NEAR
    env_at(OPERATOR, T0, 12 * NEAR, vec![]);
    v.propose_mode("2026-11-10".into(), Mode::AutoHunt, HASH.into());
    env_at(OPERATOR, T0 + 13 * 3600 * SEC, 12 * NEAR, vec![]);
    assert!(panics(|| {
        v.fund_trading(U128(2 * NEAR), acc("deposit.near"), "q1".into());
    }));
    // epochs must increase
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    assert!(panics(|| v.propose_distribution(1, HASH.into(), U128(NEAR), HASH.into())));
}

#[test]
fn guardian_veto_frees_a_pending_list_but_not_an_active_one() {
    let mut v = new_vault();
    propose7(&mut v, T0);
    env_at(MALLORY, T0 + 100, 100 * NEAR, vec![]);
    assert!(panics(|| v.veto_distribution(7, "x".into())));
    env_at(G2, T0 + 100, 100 * NEAR, vec![]);
    v.veto_distribution(7, "list does not match snapshot".into());
    assert_eq!(v.get_status().reserved_for_claims.0, 0);
    let c = case7();
    let a = leaf(&c, "alice.near");
    env_at(OPERATOR, T0 + 25 * 3600 * SEC, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), U128(a.amount.parse().unwrap()), a.proof.clone());
    }));

    // an active list can only be revoked by threshold + delay
    let mut v = new_vault();
    propose7(&mut v, T0);
    let t = T0 + 25 * 3600 * SEC;
    env_at(G1, t, 100 * NEAR, vec![]);
    assert!(panics(|| v.veto_distribution(7, "late".into())));
    let id = v.propose_admin(AdminAction::RevokeDistribution { epoch: 7 });
    assert!(panics(|| v.execute_admin(id)), "one approval is below threshold");
    env_at(G3, t, 100 * NEAR, vec![]);
    v.approve_admin(id);
    assert!(panics(|| v.execute_admin(id)), "admin delay not passed");
    env_at(MALLORY, t + 49 * 3600 * SEC, 100 * NEAR, vec![]);
    v.execute_admin(id);
    assert!(v.get_distribution(7).unwrap().vetoed);
    assert_eq!(v.get_status().reserved_for_claims.0, 0);
}

#[test]
fn risk_reducing_modes_are_instant_auto_hunt_is_time_locked() {
    let mut v = new_vault();
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    v.propose_mode("c1".into(), Mode::AutoHunt, HASH.into());
    assert_eq!(v.get_status().mode, Mode::Inactive);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }), "cannot trade before the mode delay");
    // a guardian can veto the pending activation
    env_at(G1, T0 + 3600 * SEC, 100 * NEAR, vec![]);
    v.veto_mode("suspicious snapshot".into());
    env_at(OPERATOR, T0 + 13 * 3600 * SEC, 100 * NEAR, vec![]);
    assert_eq!(v.get_status().effective_mode, Mode::Inactive);

    v.propose_mode("c2".into(), Mode::AutoHunt, HASH.into());
    env_at(OPERATOR, T0 + 26 * 3600 * SEC, 100 * NEAR, vec![]);
    assert_eq!(v.apply_pending_mode(), Mode::AutoHunt);
    // switching to DISTRIBUTE is immediate
    v.propose_mode("c3".into(), Mode::Distribute, HASH.into());
    assert_eq!(v.get_status().mode, Mode::Distribute);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }));
    // only the operator proposes modes
    env_at(MALLORY, T0 + 27 * 3600 * SEC, 100 * NEAR, vec![]);
    assert!(panics(|| v.propose_mode("x".into(), Mode::Inactive, HASH.into())));
}

fn hunting_vault() -> (Vault, u64) {
    let mut v = new_vault();
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    v.propose_mode("c1".into(), Mode::AutoHunt, HASH.into());
    (v, T0 + 13 * 3600 * SEC)
}

#[test]
fn trading_transfers_are_operator_only_and_capped_per_24h() {
    let (mut v, t) = hunting_vault();
    env_at(MALLORY, t, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }));
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    let _ = v.fund_trading(U128(15 * NEAR), acc("deposit1.near"), "quote-1".into());
    assert_eq!(v.get_status().hunt_used_24h.0, 15 * NEAR);
    assert!(panics(|| {
        v.fund_trading(U128(6 * NEAR), acc("deposit2.near"), "quote-2".into());
    }), "cap is 20 NEAR per rolling day");
    // a failed wrap.near receipt frees the cap
    env_at(ME, t, 100 * NEAR, vec![PromiseResult::Failed]);
    assert!(!v.on_trading_funded(1, Err(PromiseError::Failed)));
    assert_eq!(v.get_hunt_transfer(1).unwrap().status, "failed");
    assert_eq!(v.get_status().hunt_used_24h.0, 0);
    // window rolls after 24h
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    let _ = v.fund_trading(U128(20 * NEAR), acc("deposit3.near"), "quote-3".into());
    env_at(OPERATOR, t + DAY_NS + 1, 100 * NEAR, vec![]);
    assert_eq!(v.get_status().hunt_used_24h.0, 0);
    let _ = v.fund_trading(U128(NEAR), acc("deposit4.near"), "quote-4".into());
    env_at(ME, t + DAY_NS + 1, 100 * NEAR, vec![PromiseResult::Successful(vec![])]);
    assert!(v.on_trading_funded(3, Ok(())));
    assert_eq!(v.get_hunt_transfer(3).unwrap().status, "sent");
}

#[test]
fn pause_blocks_money_movement_and_unpause_needs_threshold() {
    let (mut v, t) = hunting_vault();
    let c = propose7(&mut v, T0);
    env_at(G3, t, 100 * NEAR, vec![]);
    v.pause("incident".into());
    env_at(OPERATOR, t, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.fund_trading(U128(NEAR), acc("deposit.near"), "q".into());
    }));
    assert!(panics(|| v.propose_distribution(8, HASH.into(), U128(NEAR), HASH.into())));
    let a = leaf(&c, "alice.near");
    env_at(OPERATOR, T0 + 25 * 3600 * SEC, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.claim(7, acc("alice.near"), U128(a.amount.parse().unwrap()), a.proof.clone());
    }));
    // risk-reducing mode change still works while paused
    v.propose_mode("c9".into(), Mode::Distribute, HASH.into());
    // unpause: 2 of 3 guardians, no delay
    env_at(G1, T0 + 25 * 3600 * SEC, 100 * NEAR, vec![]);
    let id = v.propose_admin(AdminAction::Unpause);
    assert!(panics(|| v.execute_admin(id)));
    env_at(G2, T0 + 25 * 3600 * SEC, 100 * NEAR, vec![]);
    v.approve_admin(id);
    v.execute_admin(id);
    assert!(!v.get_status().paused);
}

#[test]
fn operator_rotation_and_guardian_changes_are_threshold_and_delay_gated() {
    let mut v = new_vault();
    env_at(G1, T0, 100 * NEAR, vec![]);
    let id = v.propose_admin(AdminAction::SetOperator { operator: acc("new-bot.near") });
    env_at(G2, T0, 100 * NEAR, vec![]);
    v.approve_admin(id);
    assert!(panics(|| v.execute_admin(id)));
    env_at(MALLORY, T0 + 48 * 3600 * SEC, 100 * NEAR, vec![]);
    v.execute_admin(id);
    assert_eq!(v.get_config().operator, acc("new-bot.near"));
    // invalid guardian sets are rejected at proposal time
    env_at(G1, T0, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.propose_admin(AdminAction::SetGuardians { guardians: vec![acc(G1)], threshold: 2 });
    }));
    assert!(panics(|| {
        v.propose_admin(AdminAction::SetGuardians { guardians: vec![acc(G1), acc("new-bot.near")], threshold: 1 });
    }));
    // non-guardians cannot propose
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    assert!(panics(|| {
        v.propose_admin(AdminAction::SetDailyHuntCap { cap: U128(1000 * NEAR) });
    }));
}

#[test]
fn init_validates_roles() {
    env_at(OPERATOR, T0, 100 * NEAR, vec![]);
    assert!(panics(|| {
        Vault::new(acc(OPERATOR), vec![acc(G1)], 2, acc(WRAP), "x".into(), U128(1), 1, 1, 1, U128(0));
    }));
    assert!(panics(|| {
        Vault::new(acc(OPERATOR), vec![acc(OPERATOR)], 1, acc(WRAP), "x".into(), U128(1), 1, 1, 1, U128(0));
    }));
}
