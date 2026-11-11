/**
 * Claims: holders collect their entitlements through the vault contract's `claim_many`. The contract
 * pays only the account named in the on-chain Merkle payout list, only after the list's veto window,
 * and records every (epoch, account) it paid — so a retried or duplicated claim can never pay twice,
 * no matter what this bot does. Holders can also claim directly (near-cli) with proofs from
 * /public/proofs/<account>; such self-claims are detected and booked here.
 *
 * Bot-side safety:
 *  - each entitlement attaches to one open claim (PK on entitlement_id); one open claim per account;
 *  - the operator transaction is persisted before broadcast; retries re-send the same bytes or prove
 *    expiry before re-signing.
 */
import type { Db } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { Logger } from "../shared/log.ts";
import type { PriceOracle } from "../treasury/prices.ts";
import { A, postJournal } from "../treasury/ledger.ts";
import { enqueue, RetryLater } from "../jobs/queue.ts";
import { notify } from "../shared/outbox.ts";
import { formatAsset, toUsdMicro } from "../shared/money.ts";
import type { VaultPort, VaultTx } from "../near/vault.ts";
import { TGAS } from "../near/signer.ts";
import { payoutTree } from "./vault-sync.ts";

/** Unclaimed entitlements whose payout list was not vetoed. */
export async function claimableByAccount(db: Db, accounts: string[]): Promise<Map<string, bigint>> {
  const r = await db.query<{ account_id: string; s: string }>(
    `SELECT e.account_id, SUM(e.amount)::text AS s FROM distribution_entitlements e
      JOIN vault_distributions v ON v.event_id = e.event_id AND v.status <> 'vetoed'
      LEFT JOIN reward_claim_items i ON i.entitlement_id = e.id
     WHERE i.entitlement_id IS NULL AND e.account_id = ANY($1::text[]) GROUP BY e.account_id`,
    [accounts],
  );
  return new Map(r.rows.map((x) => [x.account_id, BigInt(x.s)]));
}

export interface ClaimDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  prices: PriceOracle;
  log: Logger;
  vault: VaultPort;
}

export type ClaimRequestResult =
  | { status: "queued"; claims: { claimId: string; accountId: string; amount: bigint; activatesAt: Date | null }[] }
  | { status: "nothing"; reason: string };

export async function requestClaim(d: ClaimDeps, userId: string): Promise<ClaimRequestResult> {
  const ws = await d.db.query<{ account_id: string }>("SELECT account_id FROM wallets WHERE user_id=$1 AND unlinked_at IS NULL", [userId]);
  if (!ws.rows.length) return { status: "nothing", reason: "Connect a NEAR wallet first with /connect." };
  const price = await d.prices.usd("NEAR");
  const minUsd = BigInt(Math.round(d.cfg.MIN_CLAIM_PAYOUT_USD * 1e6));
  const claims: { claimId: string; accountId: string; amount: bigint; activatesAt: Date | null }[] = [];
  let belowMin = false;
  for (const { account_id } of ws.rows) {
    const created = await d.db.tx(async (tx) => {
      const open = await tx.query("SELECT id FROM reward_claims WHERE account_id=$1 AND status IN ('pending','submitting')", [account_id]);
      if (open.rows.length) return null;
      // Only lists that are on chain (proposed) can be claimed; at most 20 per vault call.
      const ents = await tx.query<{ id: string; amount: string; activates_at: string | null }>(
        `SELECT e.id, e.amount, v.activates_at FROM distribution_entitlements e
           JOIN vault_distributions v ON v.event_id = e.event_id AND v.status = 'proposed'
           LEFT JOIN reward_claim_items i ON i.entitlement_id = e.id
          WHERE e.account_id=$1 AND i.entitlement_id IS NULL ORDER BY e.id LIMIT 20 FOR UPDATE OF e`,
        [account_id],
      );
      if (!ents.rows.length) return null;
      const total = ents.rows.reduce((s, e) => s + BigInt(e.amount), 0n);
      if (!price || toUsdMicro(total, "NEAR", price) < minUsd) {
        belowMin = true;
        return null;
      }
      const now = d.clock.now().toISOString();
      const prior = await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM reward_claims WHERE account_id=$1", [account_id]);
      const c = await tx.query<{ id: string }>(
        `INSERT INTO reward_claims(idempotency_key, user_id, account_id, amount, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'pending',$5,$5) RETURNING id`,
        [`claim:${account_id}:${ents.rows[0]!.id}:${ents.rows.length}:${prior.rows[0]!.n}`, userId, account_id, total.toString(), now],
      );
      const claimId = c.rows[0]!.id;
      for (const e of ents.rows) await tx.query("INSERT INTO reward_claim_items(entitlement_id, claim_id) VALUES ($1,$2)", [e.id, claimId]);
      await enqueue(tx, d.clock, { type: "claim.pay", key: `claim-pay:${claimId}`, payload: { claimId }, maxAttempts: 500 });
      const latest = ents.rows.map((e) => (e.activates_at ? new Date(e.activates_at).getTime() : 0)).reduce((a, b) => Math.max(a, b), 0);
      return { claimId, accountId: account_id, amount: total, activatesAt: latest ? new Date(latest) : null };
    });
    if (created) claims.push(created);
  }
  if (claims.length) return { status: "queued", claims };
  return {
    status: "nothing",
    reason: belowMin
      ? `Your claimable balance is below the $${d.cfg.MIN_CLAIM_PAYOUT_USD} minimum payout; it keeps accumulating.`
      : "Nothing to claim right now (a claim may already be in progress, or the payout list is not on chain yet).",
  };
}

interface ClaimRow {
  id: string;
  user_id: string;
  account_id: string;
  amount: string;
  status: string;
  tx_hash: string | null;
  signed_tx: string | null;
}

async function markPaid(d: ClaimDeps, c: ClaimRow, txHash: string, how: string) {
  const amount = BigInt(c.amount);
  await d.db.tx(async (tx) => {
    const upd = await tx.query("UPDATE reward_claims SET status='paid', tx_hash=$2, paid_at=$3, updated_at=$3, error=NULL WHERE id=$1 AND status IN ('pending','submitting') RETURNING id", [
      c.id,
      txHash,
      d.clock.now().toISOString(),
    ]);
    if (!upd.rows.length) return;
    await postJournal(tx, d.clock, {
      key: `claim-paid:${c.id}`,
      kind: "claim_payout",
      refType: "reward_claim",
      refId: c.id,
      memo: how,
      entries: [
        { account: A.claimable, asset: "NEAR", amount: -amount },
        { account: A.distributed, asset: "NEAR", amount },
      ],
    });
    await tx.query("INSERT INTO chain_transactions(chain, hash, kind, ref_type, ref_id, status, simulated, created_at) VALUES ('near',$1,'vault_claim','reward_claim',$2,'confirmed',$3,$4) ON CONFLICT DO NOTHING", [
      txHash,
      c.id,
      d.vault.simulated,
      d.clock.now().toISOString(),
    ]);
    const u = await tx.query<{ telegram_id: string }>("SELECT telegram_id FROM users WHERE id=$1", [c.user_id]);
    if (u.rows[0]) {
      await notify(tx, d.clock, `claim-paid:${c.id}`, "claimable", `✅ Claim paid by the vault: ${formatAsset(amount, "NEAR")} sent to <code>${c.account_id}</code>${d.vault.simulated ? " <i>(simulated)</i>" : ""}.`, `user:${u.rows[0].telegram_id}`);
    }
  });
}

async function releaseClaim(d: ClaimDeps, c: ClaimRow, reason: string) {
  await d.db.tx(async (tx) => {
    await tx.query("UPDATE reward_claims SET status='failed', error=$2, updated_at=$3 WHERE id=$1", [c.id, reason, d.clock.now().toISOString()]);
    await tx.query("DELETE FROM reward_claim_items WHERE claim_id=$1", [c.id]);
  });
}

/** Payout job. Idempotent: paid/cancelled/failed claims are no-ops. */
export async function payClaim(d: ClaimDeps, claimId: string): Promise<string> {
  const c = (await d.db.query<ClaimRow>("SELECT * FROM reward_claims WHERE id=$1", [claimId])).rows[0];
  if (!c) throw new Error(`claim ${claimId} not found`);
  if (!["pending", "submitting"].includes(c.status)) return c.status;
  if (d.cfg.BAGFLIP_ENV === "live" && !d.cfg.liveTransfers) throw new RetryLater("live payouts disabled (LIVE_TRANSFERS_ENABLED=false)", 15 * 60_000);

  const items = await d.db.query<{ event_id: string; amount: string; status: string; activates_at: string | null }>(
    `SELECT e.event_id, e.amount, v.status, v.activates_at FROM reward_claim_items i
       JOIN distribution_entitlements e ON e.id = i.entitlement_id JOIN vault_distributions v ON v.event_id = e.event_id
      WHERE i.claim_id=$1 ORDER BY e.event_id`,
    [claimId],
  );
  if (!items.rows.length) return c.status;
  const now = d.clock.now().getTime();
  for (const it of items.rows) {
    if (it.status !== "proposed") throw new RetryLater(`payout list #${it.event_id} is ${it.status}`, 5 * 60_000);
    const act = it.activates_at ? new Date(it.activates_at).getTime() : now;
    if (act > now) throw new RetryLater(`payout list #${it.event_id} is in its veto window`, Math.min(act - now + 5_000, 60 * 60_000));
  }

  const reset = async () => void (await d.db.query("UPDATE reward_claims SET status='pending', tx_hash=NULL, signed_tx=NULL, updated_at=$2 WHERE id=$1", [c.id, d.clock.now().toISOString()]));
  let tx: VaultTx;
  if (c.status === "submitting" && c.tx_hash && c.signed_tx) tx = { hash: c.tx_hash, signed: c.signed_tx };
  else {
    const claimItems = [];
    for (const it of items.rows) {
      const t = await payoutTree(d.db, it.event_id);
      claimItems.push({ epoch: Number(it.event_id), amount: it.amount, proof: t.proofs.get(c.account_id) ?? [] });
    }
    tx = await d.vault.prepare({ method: "claim_many", args: { account_id: c.account_id, items: claimItems }, gas: 100n * TGAS });
    await d.db.query("UPDATE reward_claims SET status='submitting', tx_hash=$2, signed_tx=$3, attempts=attempts+1, updated_at=$4 WHERE id=$1", [c.id, tx.hash, tx.signed, d.clock.now().toISOString()]);
    await d.vault.send(tx);
  }

  const o = await d.vault.outcome(tx);
  if (o.state === "expired") {
    await reset();
    throw new RetryLater("claim tx expired without landing; will re-sign", 5_000);
  }
  if (o.state === "pending" || o.state === "unknown") throw new RetryLater("claim tx pending", 10_000);
  if (o.state === "success" && o.events.some((e) => e.event === "claimed")) {
    await markPaid(d, { ...c, status: "submitting" }, tx.hash, "vault claim_many");
    return "paid";
  }
  if (o.state === "success" && o.events.some((e) => e.event === "claim_failed")) {
    await releaseClaim(d, c, "the vault could not transfer to this account (does it exist?)");
    return "failed";
  }
  // The contract rejected the call. If the holder already claimed directly, book it as paid.
  if (/already claimed/.test(o.error ?? "")) {
    let all = true;
    for (const it of items.rows) all &&= await d.vault.isClaimed(Number(it.event_id), c.account_id);
    if (all) {
      await markPaid(d, { ...c, status: "submitting" }, `self-claim:${c.account_id}:${items.rows.map((i) => i.event_id).join(",")}`, "claimed directly on the vault");
      return "paid";
    }
  }
  await reset();
  d.log.warn("vault rejected claim", { claimId, error: o.error });
  throw new RetryLater(`vault rejected claim: ${o.error}`, 15 * 60_000);
}
