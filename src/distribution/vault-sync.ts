/**
 * Mirrors BAGFLIP's off-chain decisions into the vault contract, where they are time-locked and
 * guardian-vetoable:
 *  - every distribution event → propose_distribution(epoch, merkle root, total, data hash)
 *  - every daily decision     → propose_mode(cycle, mode, snapshot hash)
 * and watches the vault for guardian vetoes (a vetoed list's money returns to the distribution pool
 * and is re-distributed from a fresh snapshot).
 *
 * Every operator transaction is signed and persisted before broadcast; retries re-send the same bytes
 * or prove expiry before re-signing.
 */
import type { Db } from "../db/index.ts";
import { setState } from "../db/index.ts";
import type { Clock } from "../shared/time.ts";
import type { Config } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import type { NearChain } from "../near/chain.ts";
import type { VaultOutcome, VaultPort, VaultTx, VaultMode } from "../near/vault.ts";
import { buildPayoutTree, sha256Hex, type PayoutTree } from "./merkle.ts";
import { A, postJournal } from "../treasury/ledger.ts";
import { RetryLater } from "../jobs/queue.ts";
import { notify } from "../shared/outbox.ts";
import { formatAsset } from "../shared/money.ts";
import { TGAS } from "../near/signer.ts";
import type { Mode } from "../governance/engine.ts";

export interface VaultDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  log: Logger;
  vault: VaultPort;
  chain: NearChain;
}

const MODE_MAP: Record<Mode, VaultMode> = { INACTIVE: "Inactive", DISTRIBUTE: "Distribute", AUTO_HUNT: "AutoHunt" };

// Per-database cache (entitlements are append-only, so a tree never changes once built).
const treeCache = new WeakMap<Db, Map<string, PayoutTree>>();

/** Deterministic payout tree for a distribution event (epoch = event id). */
export async function payoutTree(db: Db, eventId: string): Promise<PayoutTree> {
  let cache = treeCache.get(db);
  if (!cache) treeCache.set(db, (cache = new Map()));
  const c = cache.get(eventId);
  if (c) return c;
  const r = await db.query<{ account_id: string; amount: string }>("SELECT account_id, amount FROM distribution_entitlements WHERE event_id=$1", [eventId]);
  const t = buildPayoutTree(BigInt(eventId), r.rows.map((x) => ({ accountId: x.account_id, amount: BigInt(x.amount) })));
  cache.set(eventId, t);
  return t;
}

/** sha256 of the canonical per-wallet snapshot behind a daily decision (published at /public/decisions/<cycle>). */
export async function snapshotHash(db: Db, cycleId: string): Promise<string> {
  const d = await db.query<{ id: string; block_height: string; block_hash: string; effective_mode: string }>("SELECT id, block_height, block_hash, effective_mode FROM governance_decisions WHERE cycle_id=$1", [cycleId]);
  if (!d.rows[0]) throw new Error(`no decision for ${cycleId}`);
  const e = await db.query<{ account_id: string; choice: string; balance: string; counted: boolean }>(
    "SELECT account_id, choice, balance, counted FROM governance_snapshot_entries WHERE decision_id=$1 ORDER BY account_id",
    [d.rows[0].id],
  );
  return sha256Hex(canonicalSnapshot(cycleId, d.rows[0], e.rows));
}

export function canonicalSnapshot(cycleId: string, d: { block_height: string; block_hash: string; effective_mode: string }, entries: { account_id: string; choice: string; balance: string; counted: boolean }[]) {
  return JSON.stringify({ cycle: cycleId, block: d.block_height, block_hash: d.block_hash, mode: d.effective_mode, votes: entries.map((x) => [x.account_id, x.choice, x.balance, x.counted]) });
}

/** Handle the outcome of a persisted operator tx. Returns true when the call succeeded. */
async function settleOp(d: VaultDeps, tx: VaultTx, onReset: () => Promise<void>): Promise<VaultOutcome> {
  const o = await d.vault.outcome(tx);
  if (o.state === "expired") {
    await onReset();
    throw new RetryLater("vault tx expired without landing; will re-sign", 5_000);
  }
  if (o.state === "pending" || o.state === "unknown") throw new RetryLater("vault tx pending", 10_000);
  return o;
}

// ───────────── payout lists ─────────────

export async function proposeDistribution(d: VaultDeps, eventId: string): Promise<string> {
  const t = await payoutTree(d.db, eventId);
  const now = d.clock.now().toISOString();
  await d.db.query(
    `INSERT INTO vault_distributions(event_id, epoch, root, data_hash, total, status, created_at, updated_at) VALUES ($1,$1,$2,$3,$4,'prepared',$5,$5) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, t.root, t.dataHash, t.total.toString(), now],
  );
  const row = (await d.db.query<{ status: string; tx_hash: string | null; signed_tx: string | null }>("SELECT status, tx_hash, signed_tx FROM vault_distributions WHERE event_id=$1", [eventId])).rows[0]!;
  if (row.status === "proposed" || row.status === "vetoed") return row.status;
  if (!d.vault.canSign) throw new RetryLater("vault operator key not configured", 15 * 60_000);

  let tx: VaultTx;
  if (row.status === "submitting" && row.tx_hash && row.signed_tx) tx = { hash: row.tx_hash, signed: row.signed_tx };
  else {
    tx = await d.vault.prepare({ method: "propose_distribution", args: { epoch: Number(eventId), root: t.root, total: t.total.toString(), data_hash: t.dataHash }, gas: 50n * TGAS });
    await d.db.query("UPDATE vault_distributions SET status='submitting', tx_hash=$2, signed_tx=$3, updated_at=$4 WHERE event_id=$1", [eventId, tx.hash, tx.signed, d.clock.now().toISOString()]);
    await d.vault.send(tx);
  }
  const reset = async () => void (await d.db.query("UPDATE vault_distributions SET status='prepared', tx_hash=NULL, signed_tx=NULL, updated_at=$2 WHERE event_id=$1", [eventId, d.clock.now().toISOString()]));
  const o = await settleOp(d, tx, reset);
  const ev = o.events.find((e) => e.event === "distribution_proposed");
  if (o.state === "success" && ev) {
    const activates = new Date(Number(BigInt(String(ev.data.activates_ns)) / 1_000_000n));
    await d.db.tx(async (q) => {
      await q.query("UPDATE vault_distributions SET status='proposed', activates_at=$2, error=NULL, updated_at=$3 WHERE event_id=$1", [eventId, activates.toISOString(), d.clock.now().toISOString()]);
      await q.query(
        "INSERT INTO chain_transactions(chain, hash, kind, ref_type, ref_id, status, simulated, created_at) VALUES ('near',$1,'vault_propose_distribution','distribution_event',$2,'confirmed',$3,$4) ON CONFLICT DO NOTHING",
        [tx.hash, eventId, d.vault.simulated, d.clock.now().toISOString()],
      );
    });
    return "proposed";
  }
  await reset();
  await d.db.query("UPDATE vault_distributions SET error=$2 WHERE event_id=$1", [eventId, o.error ?? "no distribution_proposed event"]);
  await notify(d.db, d.clock, `vault-dist-fail:${eventId}:${d.clock.now().toISOString().slice(0, 13)}`, "failure", `⚠️ Vault rejected payout list #${eventId}: ${o.error ?? "unknown"}`, "admins");
  throw new RetryLater(`vault rejected payout list: ${o.error}`, 15 * 60_000);
}

// ───────────── daily mode ─────────────

export async function syncMode(d: VaultDeps, cycleId: string): Promise<string> {
  const dec = await d.db.query<{ effective_mode: Mode }>("SELECT effective_mode FROM governance_decisions WHERE cycle_id=$1", [cycleId]);
  if (!dec.rows[0]) throw new Error(`no decision for ${cycleId}`);
  const mode = MODE_MAP[dec.rows[0].effective_mode];
  const hash = await snapshotHash(d.db, cycleId);
  const now = d.clock.now().toISOString();
  const ex = (await d.db.query<{ status: string; tx_hash: string | null; signed_tx: string | null }>("SELECT status, tx_hash, signed_tx FROM vault_mode_syncs WHERE cycle_id=$1", [cycleId])).rows[0];
  if (ex?.status === "done") return "done";
  if (!d.vault.canSign) throw new RetryLater("vault operator key not configured", 15 * 60_000);
  let tx: VaultTx;
  if (ex?.status === "submitting" && ex.tx_hash && ex.signed_tx) tx = { hash: ex.tx_hash, signed: ex.signed_tx };
  else {
    tx = await d.vault.prepare({ method: "propose_mode", args: { cycle_id: cycleId, mode, snapshot_hash: hash }, gas: 30n * TGAS });
    await d.db.query(
      `INSERT INTO vault_mode_syncs(cycle_id, mode, snapshot_hash, status, tx_hash, signed_tx, created_at, updated_at) VALUES ($1,$2,$3,'submitting',$4,$5,$6,$6)
       ON CONFLICT (cycle_id) DO UPDATE SET status='submitting', tx_hash=EXCLUDED.tx_hash, signed_tx=EXCLUDED.signed_tx, updated_at=EXCLUDED.updated_at`,
      [cycleId, mode, hash, tx.hash, tx.signed, now],
    );
    await d.vault.send(tx);
  }
  const reset = async () => void (await d.db.query("UPDATE vault_mode_syncs SET status='failed', updated_at=$2 WHERE cycle_id=$1", [cycleId, d.clock.now().toISOString()]));
  const o = await settleOp(d, tx, reset);
  if (o.state === "success") {
    await d.db.query("UPDATE vault_mode_syncs SET status='done', error=NULL, updated_at=$2 WHERE cycle_id=$1", [cycleId, d.clock.now().toISOString()]);
    const proposed = o.events.find((e) => e.event === "mode_proposed");
    if (proposed) {
      const eta = new Date(Number(BigInt(String(proposed.data.eta_ns)) / 1_000_000n));
      await notify(d.db, d.clock, `vault-mode-eta:${cycleId}`, "mode_change", `⏳ AUTO HUNT is time-locked in the vault until ${eta.toISOString().slice(0, 16).replace("T", " ")} UTC. Guardians can veto until then.`);
    }
    return "done";
  }
  await reset();
  await d.db.query("UPDATE vault_mode_syncs SET error=$2 WHERE cycle_id=$1", [cycleId, o.error ?? "failed"]);
  throw new RetryLater(`vault rejected mode: ${o.error}`, 5 * 60_000);
}

// ───────────── watcher ─────────────

/** Cache vault status, detect guardian vetoes, unwrap returned wNEAR (live). */
export async function watchVault(d: VaultDeps): Promise<{ vetoed: number }> {
  const st = await d.vault.status();
  await setState(d.db, "vault_status", { ...st, at: d.clock.now().toISOString() });
  let vetoed = 0;
  const open = await d.db.query<{ event_id: string }>("SELECT event_id FROM vault_distributions WHERE status='proposed'");
  for (const r of open.rows) {
    const vd = await d.vault.distribution(Number(r.event_id));
    if (vd?.vetoed) {
      await handleVeto(d, r.event_id);
      vetoed++;
    }
  }
  if (!d.vault.simulated && d.vault.canSign) {
    const h = await d.chain.nearHoldings(d.vault.accountId);
    if (h.wrapped > 10_000_000_000_000_000_000_000n) {
      const tx = await d.vault.prepare({ method: "unwrap", args: { amount: h.wrapped.toString() }, gas: 30n * TGAS });
      await d.vault.send(tx);
    }
  }
  return { vetoed };
}

/** A guardian vetoed a payout list: return its money to the pool and cancel claims against it. */
export async function handleVeto(d: VaultDeps, eventId: string) {
  await d.db.tx(async (tx) => {
    const upd = await tx.query("UPDATE vault_distributions SET status='vetoed', updated_at=$2 WHERE event_id=$1 AND status <> 'vetoed' RETURNING total", [eventId, d.clock.now().toISOString()]);
    if (!upd.rows.length) return;
    const claims = await tx.query<{ claim_id: string }>(
      `SELECT DISTINCT i.claim_id FROM reward_claim_items i JOIN distribution_entitlements e ON e.id=i.entitlement_id
        JOIN reward_claims c ON c.id=i.claim_id WHERE e.event_id=$1 AND c.status IN ('pending','submitting')`,
      [eventId],
    );
    for (const c of claims.rows) {
      await tx.query("UPDATE reward_claims SET status='cancelled', error='payout list vetoed by a guardian', updated_at=$2 WHERE id=$1", [c.claim_id, d.clock.now().toISOString()]);
      await tx.query("DELETE FROM reward_claim_items WHERE claim_id=$1", [c.claim_id]);
    }
    const unpaid = await tx.query<{ s: string }>(
      `SELECT COALESCE(SUM(e.amount),0)::text AS s FROM distribution_entitlements e
        LEFT JOIN reward_claim_items i ON i.entitlement_id=e.id LEFT JOIN reward_claims c ON c.id=i.claim_id AND c.status='paid'
       WHERE e.event_id=$1 AND c.id IS NULL`,
      [eventId],
    );
    const amount = BigInt(unpaid.rows[0]!.s);
    if (amount > 0n) {
      await postJournal(tx, d.clock, {
        key: `dist-veto:${eventId}`,
        kind: "distribution_vetoed",
        refType: "distribution_event",
        refId: eventId,
        entries: [
          { account: A.claimable, asset: "NEAR", amount: -amount },
          { account: A.distPool, asset: "NEAR", amount },
        ],
      });
    }
    await notify(tx, d.clock, `dist-veto:${eventId}`, "failure", `🛑 A guardian vetoed payout list #${eventId}. ${formatAsset(amount, "NEAR")} returns to the distribution pool and will be re-distributed from a fresh snapshot.`);
  });
}

/** Payout lists a holder can claim, with Merkle proofs (also used for self-claims via near-cli). */
export async function proofsFor(db: Db, accountId: string) {
  const r = await db.query<{ event_id: string; amount: string; activates_at: string | null; status: string; root: string }>(
    `SELECT e.event_id, e.amount, v.activates_at, v.status, v.root FROM distribution_entitlements e JOIN vault_distributions v ON v.event_id=e.event_id
      WHERE e.account_id=$1 AND v.status IN ('proposed','submitting','prepared') ORDER BY e.event_id`,
    [accountId],
  );
  const out = [];
  for (const row of r.rows) {
    const t = await payoutTree(db, row.event_id);
    out.push({ epoch: Number(row.event_id), amount: row.amount, proof: t.proofs.get(accountId) ?? [], root: row.root, status: row.status, activates_at: row.activates_at });
  }
  return out;
}
