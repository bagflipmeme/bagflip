//! BAGFLIP vault — the community reward treasury, deployed to the treasury account (e.g. `bagflip.near`)
//! and then LOCKED by deleting every full-access key. After that nobody — not the creator, not the
//! operator, not the guardians — can sign arbitrary transactions for this account, and the code can
//! never be replaced (there is no upgrade method).
//!
//! Funds can leave in exactly two ways:
//!  1. `claim` / `claim_many`: pays the account named in a published Merkle payout list, up to that
//!     list's total, only after the list's veto window has passed.
//!  2. `fund_trading`: wraps NEAR and sends wNEAR to a NEAR Intents 1Click deposit address, only while
//!     the mode is AUTO_HUNT, and never more than `daily_hunt_cap` per rolling 24 hours.
//!
//! Roles:
//!  - operator (the BAGFLIP bot): proposes daily modes and payout lists, requests capped trading
//!    transfers, relays claims. It cannot withdraw or redirect anything.
//!  - guardians (community members): any ONE guardian can veto a pending payout list or a pending
//!    AUTO_HUNT activation and can pause; changes to roles/caps and unpausing need `guardian_threshold`
//!    approvals plus (except unpause) the admin delay.
//!  - anyone: claims (always paid to the account in the leaf), applying a matured mode, unwrapping wNEAR.
//!
//! Risk asymmetry: changes that REDUCE risk (switching to DISTRIBUTE/INACTIVE, pausing, vetoing) take
//! effect immediately; changes that INCREASE risk (activating AUTO_HUNT, new payout lists, admin
//! changes) are time-locked so the community can inspect them first.
//!
//! What the contract cannot verify (documented, bounded): the off-chain snapshot behind a payout list
//! (guardians check the published list against `data_hash` during the veto window), and the Solana
//! recipient behind a 1Click deposit address (bounded by the daily cap; every transfer is logged with
//! its quote reference so anyone can check it on the 1Click status API).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

pub const EVENT_STANDARD: &str = "bagflip_vault";
pub const EVENT_VERSION: &str = "1.0.0";
pub const DAY_NS: u64 = 86_400 * 1_000_000_000;
/// NEP-145 registration of a fresh 1Click deposit address on wrap.near.
pub const WRAP_STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;
pub const MAX_CLAIMS_PER_CALL: usize = 20;
pub const MAX_PROOF_LEN: usize = 40;
pub const MAX_GUARDIANS: usize = 15;

const G_WRAP_CALL: Gas = Gas::from_tgas(10);
const G_FT_TRANSFER: Gas = Gas::from_tgas(15);
const G_CALLBACK: Gas = Gas::from_tgas(15);

#[ext_contract(ext_wrap)]
pub trait ExtWrap {
    fn near_withdraw(&mut self, amount: U128);
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    Inactive,
    Distribute,
    AutoHunt,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub operator: AccountId,
    pub guardians: Vec<AccountId>,
    pub guardian_threshold: u8,
    pub wrap_near: AccountId,
    /// The public Solana trading wallet (informational: the contract cannot verify 1Click recipients).
    pub trading_recipient: String,
    pub daily_hunt_cap: U128,
    pub mode_delay_ns: U64,
    pub distribution_delay_ns: U64,
    pub admin_delay_ns: U64,
    /// NEAR always kept on top of storage cost.
    pub reserve: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Distribution {
    pub epoch: u64,
    /// hex sha256 Merkle root (see `leaf_hash` / `node_hash`)
    pub root: String,
    pub total: U128,
    pub claimed: U128,
    /// hex sha256 of the published payout list, so anyone can verify it before activation.
    pub data_hash: String,
    pub proposed_ns: U64,
    pub activates_ns: U64,
    pub vetoed: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingMode {
    pub cycle_id: String,
    pub snapshot_hash: String,
    pub eta_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct HuntTransfer {
    pub id: u64,
    pub amount: U128,
    pub deposit_address: AccountId,
    pub quote_ref: String,
    pub at_ns: U64,
    /// "pending" | "sent" | "failed"
    pub status: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum AdminAction {
    SetOperator { operator: AccountId },
    SetGuardians { guardians: Vec<AccountId>, threshold: u8 },
    SetDailyHuntCap { cap: U128 },
    /// Cancel the unclaimed remainder of an already-active payout list (e.g. found to be wrong).
    RevokeDistribution { epoch: u64 },
    Unpause,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct AdminProposal {
    pub id: u64,
    pub action: AdminAction,
    pub approvals: Vec<AccountId>,
    pub created_ns: U64,
    pub eta_ns: U64,
    pub executed: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimItem {
    pub epoch: u64,
    pub amount: U128,
    pub proof: Vec<String>,
}

#[near(serializers = [json])]
pub struct Status {
    pub mode: Mode,
    pub effective_mode: Mode,
    pub mode_cycle: String,
    pub pending_mode: Option<PendingMode>,
    pub paused: bool,
    pub reserved_for_claims: U128,
    pub free_balance: U128,
    pub hunt_used_24h: U128,
    pub hunt_remaining_24h: U128,
    pub last_epoch: u64,
    pub hunt_transfers: u64,
    pub admin_proposals: u64,
    pub version: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    config: Config,
    paused: bool,
    mode: Mode,
    mode_cycle: String,
    pending_mode: Option<PendingMode>,
    distributions: LookupMap<u64, Distribution>,
    last_epoch: u64,
    claimed: LookupSet<(u64, AccountId)>,
    reserved: u128,
    hunt_window: Vec<(u64, u128)>,
    hunt_transfers: LookupMap<u64, HuntTransfer>,
    hunt_count: u64,
    admin: LookupMap<u64, AdminProposal>,
    admin_count: u64,
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": EVENT_STANDARD, "version": EVENT_VERSION, "event": event, "data": [data] })));
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn unhex32(s: &str) -> [u8; 32] {
    require!(s.len() == 64, "hash must be 64 hex chars");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("invalid hex"));
    }
    out
}

/// leaf = sha256(0x00 ‖ epoch u64 LE ‖ amount u128 LE ‖ account_id utf8)
pub fn leaf_hash(epoch: u64, account_id: &str, amount: u128) -> [u8; 32] {
    let mut buf = Vec::with_capacity(1 + 8 + 16 + account_id.len());
    buf.push(0u8);
    buf.extend_from_slice(&epoch.to_le_bytes());
    buf.extend_from_slice(&amount.to_le_bytes());
    buf.extend_from_slice(account_id.as_bytes());
    env::sha256_array(&buf)
}

/// node = sha256(0x01 ‖ min(a,b) ‖ max(a,b)) — sorted pairs, so proofs need no direction bits.
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = Vec::with_capacity(65);
    buf.push(1u8);
    buf.extend_from_slice(lo);
    buf.extend_from_slice(hi);
    env::sha256_array(&buf)
}

pub fn verify_proof(root: &[u8; 32], leaf: [u8; 32], proof: &[String]) -> bool {
    if proof.len() > MAX_PROOF_LEN {
        return false;
    }
    let mut h = leaf;
    for p in proof {
        h = node_hash(&h, &unhex32(p));
    }
    &h == root
}

fn validate_guardians(guardians: &[AccountId], threshold: u8) {
    require!(!guardians.is_empty() && guardians.len() <= MAX_GUARDIANS, "1..=15 guardians required");
    require!(threshold >= 1 && (threshold as usize) <= guardians.len(), "invalid guardian threshold");
    let mut g = guardians.to_vec();
    g.sort();
    g.dedup();
    require!(g.len() == guardians.len(), "duplicate guardian");
}

#[near]
impl Vault {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        operator: AccountId,
        guardians: Vec<AccountId>,
        guardian_threshold: u8,
        wrap_near: AccountId,
        trading_recipient: String,
        daily_hunt_cap: U128,
        mode_delay_sec: u64,
        distribution_delay_sec: u64,
        admin_delay_sec: u64,
        reserve: U128,
    ) -> Self {
        validate_guardians(&guardians, guardian_threshold);
        require!(!guardians.contains(&operator), "operator cannot be a guardian");
        require!(!trading_recipient.is_empty(), "trading recipient required");
        let s = 1_000_000_000u64;
        Self {
            config: Config {
                operator,
                guardians,
                guardian_threshold,
                wrap_near,
                trading_recipient,
                daily_hunt_cap,
                mode_delay_ns: U64(mode_delay_sec * s),
                distribution_delay_ns: U64(distribution_delay_sec * s),
                admin_delay_ns: U64(admin_delay_sec * s),
                reserve,
            },
            paused: false,
            mode: Mode::Inactive,
            mode_cycle: String::new(),
            pending_mode: None,
            distributions: LookupMap::new(b"d"),
            last_epoch: 0,
            claimed: LookupSet::new(b"c"),
            reserved: 0,
            hunt_window: Vec::new(),
            hunt_transfers: LookupMap::new(b"h"),
            hunt_count: 0,
            admin: LookupMap::new(b"a"),
            admin_count: 0,
        }
    }

    // ───────────── views ─────────────

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    pub fn get_status(&self) -> Status {
        let used = self.hunt_used(env::block_timestamp());
        Status {
            mode: self.mode.clone(),
            effective_mode: self.effective_mode(),
            mode_cycle: self.mode_cycle.clone(),
            pending_mode: self.pending_mode.clone(),
            paused: self.paused,
            reserved_for_claims: U128(self.reserved),
            free_balance: U128(self.free_balance()),
            hunt_used_24h: U128(used),
            hunt_remaining_24h: U128(self.config.daily_hunt_cap.0.saturating_sub(used)),
            last_epoch: self.last_epoch,
            hunt_transfers: self.hunt_count,
            admin_proposals: self.admin_count,
            version: EVENT_VERSION.to_string(),
        }
    }

    pub fn get_distribution(&self, epoch: u64) -> Option<Distribution> {
        self.distributions.get(&epoch).cloned()
    }

    pub fn is_claimed(&self, epoch: u64, account_id: AccountId) -> bool {
        self.claimed.contains(&(epoch, account_id))
    }

    pub fn get_hunt_transfer(&self, id: u64) -> Option<HuntTransfer> {
        self.hunt_transfers.get(&id).cloned()
    }

    pub fn get_admin_proposal(&self, id: u64) -> Option<AdminProposal> {
        self.admin.get(&id).cloned()
    }

    /// Helper so anyone can check a payout-list leaf against the on-chain hashing rules.
    pub fn compute_leaf(&self, epoch: u64, account_id: AccountId, amount: U128) -> String {
        hex(&leaf_hash(epoch, account_id.as_str(), amount.0))
    }

    // ───────────── internals ─────────────

    fn free_balance(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance().as_yoctonear().saturating_sub(storage).saturating_sub(self.config.reserve.0).saturating_sub(self.reserved)
    }

    fn effective_mode(&self) -> Mode {
        match &self.pending_mode {
            Some(p) if !self.paused && env::block_timestamp() >= p.eta_ns.0 => Mode::AutoHunt,
            _ => self.mode.clone(),
        }
    }

    fn materialize_mode(&mut self) {
        if let Some(p) = self.pending_mode.clone() {
            if !self.paused && env::block_timestamp() >= p.eta_ns.0 {
                self.mode = Mode::AutoHunt;
                self.mode_cycle = p.cycle_id.clone();
                self.pending_mode = None;
                emit("mode_applied", json!({ "mode": Mode::AutoHunt, "cycle_id": p.cycle_id, "snapshot_hash": p.snapshot_hash }));
            }
        }
    }

    fn hunt_used(&self, now: u64) -> u128 {
        self.hunt_window.iter().filter(|(t, _)| now.saturating_sub(*t) < DAY_NS).map(|(_, a)| *a).sum()
    }

    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.config.operator, "only the operator");
    }

    fn assert_guardian(&self) {
        require!(self.config.guardians.contains(&env::predecessor_account_id()), "only a guardian");
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "vault is paused");
    }

    // ───────────── operator: governance mode ─────────────

    /// Record the daily decision. DISTRIBUTE / INACTIVE take effect at once (risk-reducing);
    /// AUTO_HUNT activation waits `mode_delay` so guardians can veto it.
    pub fn propose_mode(&mut self, cycle_id: String, mode: Mode, snapshot_hash: String) {
        self.assert_operator();
        unhex32(&snapshot_hash);
        self.materialize_mode();
        match mode {
            Mode::AutoHunt => {
                if self.mode == Mode::AutoHunt {
                    self.mode_cycle = cycle_id.clone();
                    emit("mode_continued", json!({ "mode": mode, "cycle_id": cycle_id, "snapshot_hash": snapshot_hash }));
                } else if self.pending_mode.is_none() {
                    self.assert_not_paused();
                    let eta = env::block_timestamp() + self.config.mode_delay_ns.0;
                    self.pending_mode = Some(PendingMode { cycle_id: cycle_id.clone(), snapshot_hash: snapshot_hash.clone(), eta_ns: U64(eta) });
                    emit("mode_proposed", json!({ "mode": mode, "cycle_id": cycle_id, "snapshot_hash": snapshot_hash, "eta_ns": U64(eta) }));
                }
            }
            other => {
                self.pending_mode = None;
                self.mode = other.clone();
                self.mode_cycle = cycle_id.clone();
                emit("mode_applied", json!({ "mode": other, "cycle_id": cycle_id, "snapshot_hash": snapshot_hash }));
            }
        }
    }

    /// Anyone can apply a pending AUTO_HUNT whose veto window has passed.
    pub fn apply_pending_mode(&mut self) -> Mode {
        self.materialize_mode();
        self.mode.clone()
    }

    // ───────────── operator: payout lists ─────────────

    /// Reserve `total` for a payout list. Claims open after `distribution_delay`.
    pub fn propose_distribution(&mut self, epoch: u64, root: String, total: U128, data_hash: String) {
        self.assert_operator();
        self.assert_not_paused();
        require!(epoch > self.last_epoch, "epoch must increase");
        require!(total.0 > 0, "empty distribution");
        unhex32(&root);
        unhex32(&data_hash);
        require!(total.0 <= self.free_balance(), "not enough unreserved funds");
        let now = env::block_timestamp();
        let d = Distribution {
            epoch,
            root,
            total,
            claimed: U128(0),
            data_hash,
            proposed_ns: U64(now),
            activates_ns: U64(now + self.config.distribution_delay_ns.0),
            vetoed: false,
        };
        self.reserved += total.0;
        self.last_epoch = epoch;
        emit("distribution_proposed", json!(d));
        self.distributions.insert(epoch, d);
    }

    // ───────────── operator: trading allocation ─────────────

    /// Wrap `amount` NEAR and transfer it to a 1Click deposit address (one atomic receipt on wrap.near).
    pub fn fund_trading(&mut self, amount: U128, deposit_address: AccountId, quote_ref: String) -> Promise {
        self.assert_operator();
        self.assert_not_paused();
        self.materialize_mode();
        require!(self.mode == Mode::AutoHunt, "mode is not AUTO_HUNT");
        require!(amount.0 > 0, "zero amount");
        require!(quote_ref.len() <= 128, "quote_ref too long");
        let now = env::block_timestamp();
        self.hunt_window.retain(|(t, _)| now.saturating_sub(*t) < DAY_NS);
        require!(self.hunt_used(now) + amount.0 <= self.config.daily_hunt_cap.0, "daily trading cap exceeded");
        require!(amount.0 + WRAP_STORAGE_DEPOSIT + 1 <= self.free_balance(), "not enough unreserved funds");
        self.hunt_count += 1;
        let id = self.hunt_count;
        self.hunt_window.push((now, amount.0));
        let t = HuntTransfer { id, amount, deposit_address: deposit_address.clone(), quote_ref: quote_ref.clone(), at_ns: U64(now), status: "pending".into() };
        emit("trading_fund_requested", json!(t));
        self.hunt_transfers.insert(id, t);
        Promise::new(self.config.wrap_near.clone())
            .function_call(
                "storage_deposit".to_string(),
                json!({ "account_id": deposit_address, "registration_only": true }).to_string().into_bytes(),
                NearToken::from_yoctonear(WRAP_STORAGE_DEPOSIT),
                G_WRAP_CALL,
            )
            .function_call("near_deposit".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(amount.0), G_WRAP_CALL)
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": deposit_address, "amount": amount, "memo": format!("bagflip:{}", quote_ref) }).to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                G_FT_TRANSFER,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(G_CALLBACK).on_trading_funded(id))
    }

    #[private]
    pub fn on_trading_funded(&mut self, id: u64, #[callback_result] r: Result<(), PromiseError>) -> bool {
        let mut t = self.hunt_transfers.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown transfer"));
        if r.is_ok() {
            t.status = "sent".into();
            emit("trading_funded", json!(t));
            self.hunt_transfers.insert(id, t);
            true
        } else {
            // The whole wrap.near receipt reverted and its deposits came back: free the cap.
            t.status = "failed".into();
            if let Some(pos) = self.hunt_window.iter().position(|(ts, a)| *ts == t.at_ns.0 && *a == t.amount.0) {
                self.hunt_window.remove(pos);
            }
            emit("trading_fund_failed", json!(t));
            self.hunt_transfers.insert(id, t);
            false
        }
    }

    /// Convert wNEAR held by the vault (bridge returns) back to native NEAR. Harmless, so anyone may call.
    pub fn unwrap(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "zero amount");
        ext_wrap::ext(self.config.wrap_near.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(G_WRAP_CALL).near_withdraw(amount)
    }

    // ───────────── claims (anyone; always paid to the leaf's account) ─────────────

    pub fn claim(&mut self, epoch: u64, account_id: AccountId, amount: U128, proof: Vec<String>) -> Promise {
        self.claim_many(account_id, vec![ClaimItem { epoch, amount, proof }])
    }

    pub fn claim_many(&mut self, account_id: AccountId, items: Vec<ClaimItem>) -> Promise {
        self.assert_not_paused();
        require!(!items.is_empty() && items.len() <= MAX_CLAIMS_PER_CALL, "1..=20 claims per call");
        let now = env::block_timestamp();
        let mut total: u128 = 0;
        let mut epochs: Vec<(u64, U128)> = Vec::new();
        for it in items {
            let mut d = self.distributions.get(&it.epoch).cloned().unwrap_or_else(|| env::panic_str("unknown epoch"));
            require!(!d.vetoed, "distribution was vetoed");
            require!(now >= d.activates_ns.0, "distribution still in its veto window");
            require!(!self.claimed.contains(&(it.epoch, account_id.clone())), "already claimed");
            require!(verify_proof(&unhex32(&d.root), leaf_hash(it.epoch, account_id.as_str(), it.amount.0), &it.proof), "invalid proof");
            require!(d.claimed.0 + it.amount.0 <= d.total.0, "exceeds distribution total");
            d.claimed = U128(d.claimed.0 + it.amount.0);
            self.distributions.insert(it.epoch, d);
            self.claimed.insert((it.epoch, account_id.clone()));
            self.reserved -= it.amount.0;
            total += it.amount.0;
            epochs.push((it.epoch, it.amount));
        }
        emit("claim_sent", json!({ "account_id": account_id, "amount": U128(total), "epochs": epochs }));
        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(total))
            .then(Self::ext(env::current_account_id()).with_static_gas(G_CALLBACK).on_claim(account_id, epochs))
    }

    /// If the transfer failed (e.g. the account does not exist), the NEAR came back: reopen the claims.
    #[private]
    pub fn on_claim(&mut self, account_id: AccountId, epochs: Vec<(u64, U128)>, #[callback_result] r: Result<(), PromiseError>) -> bool {
        if r.is_ok() {
            emit("claimed", json!({ "account_id": account_id, "epochs": epochs }));
            return true;
        }
        for (epoch, amount) in &epochs {
            if let Some(mut d) = self.distributions.get(epoch).cloned() {
                d.claimed = U128(d.claimed.0.saturating_sub(amount.0));
                self.distributions.insert(*epoch, d);
            }
            self.claimed.remove(&(*epoch, account_id.clone()));
            self.reserved += amount.0;
        }
        emit("claim_failed", json!({ "account_id": account_id, "epochs": epochs }));
        false
    }

    // ───────────── guardians ─────────────

    /// Any single guardian can veto a payout list before it activates. Its funds become unreserved.
    pub fn veto_distribution(&mut self, epoch: u64, reason: String) {
        self.assert_guardian();
        let mut d = self.distributions.get(&epoch).cloned().unwrap_or_else(|| env::panic_str("unknown epoch"));
        require!(!d.vetoed, "already vetoed");
        require!(env::block_timestamp() < d.activates_ns.0, "veto window closed; use RevokeDistribution");
        d.vetoed = true;
        self.reserved -= d.total.0 - d.claimed.0;
        emit("distribution_vetoed", json!({ "epoch": epoch, "by": env::predecessor_account_id(), "reason": reason }));
        self.distributions.insert(epoch, d);
    }

    /// Any single guardian can veto a pending AUTO_HUNT activation.
    pub fn veto_mode(&mut self, reason: String) {
        self.assert_guardian();
        let p = self.pending_mode.clone().unwrap_or_else(|| env::panic_str("no pending mode"));
        require!(env::block_timestamp() < p.eta_ns.0, "veto window closed");
        self.pending_mode = None;
        emit("mode_vetoed", json!({ "cycle_id": p.cycle_id, "by": env::predecessor_account_id(), "reason": reason }));
    }

    /// Any guardian (or the operator) can pause: no claims, no new lists, no trading transfers.
    pub fn pause(&mut self, reason: String) {
        let p = env::predecessor_account_id();
        require!(self.config.guardians.contains(&p) || p == self.config.operator, "only a guardian or the operator");
        self.paused = true;
        emit("paused", json!({ "by": p, "reason": reason }));
    }

    pub fn propose_admin(&mut self, action: AdminAction) -> u64 {
        self.assert_guardian();
        match &action {
            AdminAction::SetGuardians { guardians, threshold } => {
                validate_guardians(guardians, *threshold);
                require!(!guardians.contains(&self.config.operator), "operator cannot be a guardian");
            }
            AdminAction::SetOperator { operator } => require!(!self.config.guardians.contains(operator), "operator cannot be a guardian"),
            AdminAction::RevokeDistribution { epoch } => require!(self.distributions.get(epoch).is_some(), "unknown epoch"),
            _ => {}
        }
        let now = env::block_timestamp();
        let eta = if action == AdminAction::Unpause { now } else { now + self.config.admin_delay_ns.0 };
        self.admin_count += 1;
        let p = AdminProposal { id: self.admin_count, action, approvals: vec![env::predecessor_account_id()], created_ns: U64(now), eta_ns: U64(eta), executed: false };
        emit("admin_proposed", json!(p));
        self.admin.insert(p.id, p.clone());
        p.id
    }

    pub fn approve_admin(&mut self, id: u64) {
        self.assert_guardian();
        let mut p = self.admin.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(!p.executed, "already executed");
        let me = env::predecessor_account_id();
        if !p.approvals.contains(&me) {
            p.approvals.push(me);
        }
        emit("admin_approved", json!({ "id": id, "approvals": p.approvals }));
        self.admin.insert(id, p);
    }

    /// Anyone can execute once enough CURRENT guardians approved and the delay passed.
    pub fn execute_admin(&mut self, id: u64) {
        let mut p = self.admin.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown proposal"));
        require!(!p.executed, "already executed");
        let valid = p.approvals.iter().filter(|a| self.config.guardians.contains(a)).count();
        require!(valid >= self.config.guardian_threshold as usize, "not enough guardian approvals");
        require!(env::block_timestamp() >= p.eta_ns.0, "admin delay not passed");
        match p.action.clone() {
            AdminAction::SetOperator { operator } => self.config.operator = operator,
            AdminAction::SetGuardians { guardians, threshold } => {
                validate_guardians(&guardians, threshold);
                self.config.guardians = guardians;
                self.config.guardian_threshold = threshold;
            }
            AdminAction::SetDailyHuntCap { cap } => self.config.daily_hunt_cap = cap,
            AdminAction::RevokeDistribution { epoch } => {
                let mut d = self.distributions.get(&epoch).cloned().unwrap_or_else(|| env::panic_str("unknown epoch"));
                if !d.vetoed {
                    d.vetoed = true;
                    self.reserved -= d.total.0 - d.claimed.0;
                    self.distributions.insert(epoch, d);
                }
            }
            AdminAction::Unpause => self.paused = false,
        }
        p.executed = true;
        emit("admin_executed", json!(p));
        self.admin.insert(id, p);
    }
}

#[cfg(test)]
mod tests;
