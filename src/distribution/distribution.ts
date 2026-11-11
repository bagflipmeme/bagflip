/**
 * DISTRIBUTE: turn the reserved distribution pool into immutable, claimable
 * entitlements proportional to holdings at one snapshot block.
 *
 *   entitlement_i = floor(pool * balance_i / eligibleSupply)
 *
 * Integer arithmetic only; the rounding dust stays in the pool for the next
 * distribution. The pool → claimable journal and the entitlement rows are
 * written in one transaction keyed by the snapshot block, so a retried job can
 * never allocate the same capital twice.
 */
import type { Db } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { NearChain } from "../near/chain.ts";
import type { PriceOracle } from "../treasury/prices.ts";
import { A, balance, postJournal } from "../treasury/ledger.ts";
import { excludedAccounts } from "../governance/cycle.ts";
import type { HolderSource } from "./holders.ts";
import { notify } from "../shared/outbox.ts";
import { formatAsset, formatUsd, toUsdMicro } from "../shared/money.ts";
import { advisoryXactLock } from "../db/index.ts";
import { enqueue } from "../jobs/queue.ts";

export interface Allocation {
  accountId: string;
  balance: bigint;
  amount: bigint;
}

/** Pure pro-rata allocation. */
export function allocate(pool: bigint, holdings: { accountId: string; balance: bigint }[]): { allocations: Allocation[]; allocated: bigint; dust: bigint; supply: bigint } {
  const supply = holdings.reduce((s, h) => s + h.balance, 0n);
  if (supply === 0n || pool <= 0n) return { allocations: [], allocated: 0n, dust: pool, supply };
  const allocations: Allocation[] = [];
  let allocated = 0n;
  for (const h of [...holdings].sort((a, b) => (a.accountId < b.accountId ? -1 : 1))) {
    const amount = (pool * h.balance) / supply;
    if (amount > 0n) {
      allocations.push({ accountId: h.accountId, balance: h.balance, amount });
      allocated += amount;
    }
  }
  return { allocations, allocated, dust: pool - allocated, supply };
}

export interface DistDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  chain: NearChain;
  prices: PriceOracle;
  holders: HolderSource;
}

export type DistResult = { created: true; eventId: string; allocated: bigint; holders: number } | { created: false; reason: string };

export async function runDistribution(d: DistDeps): Promise<DistResult> {
  const pool = await balance(d.db, A.distPool, "NEAR");
  if (pool <= 0n) return { created: false, reason: "empty pool" };
  const price = await d.prices.usd("NEAR");
  if (!price) return { created: false, reason: "no NEAR price" };
  if (toUsdMicro(pool, "NEAR", price) < BigInt(Math.round(d.cfg.MIN_DISTRIBUTION_POOL_USD * 1e6))) {
    return { created: false, reason: `pool below $${d.cfg.MIN_DISTRIBUTION_POOL_USD}; accumulating` };
  }

  const block = await d.chain.finalBlock();
  const disc = await d.holders.discover();
  const registered = await d.db.query<{ account_id: string }>("SELECT DISTINCT account_id FROM wallets WHERE unlinked_at IS NULL");
  const excluded = excludedAccounts(d.cfg);
  const candidates = [...new Set([...disc.accounts, ...registered.rows.map((r) => r.account_id)].map((a) => a.toLowerCase()))].filter((a) => !excluded.has(a));
  const balances = await d.chain.ftBalances(d.cfg.MEME_TOKEN_CONTRACT_ID, candidates, block);
  const holdings = [...balances.entries()].filter(([, b]) => b >= d.cfg.minEligibleTokenBalance && b > 0n).map(([accountId, b]) => ({ accountId, balance: b }));
  const a = allocate(pool, holdings);
  if (!a.allocations.length) return { created: false, reason: "no eligible holders" };

  const r = await d.db.tx(async (tx) => {
    await advisoryXactLock(tx, "distribution");
    // Re-read the pool under the lock: allocate only what is still there.
    const poolNow = await balance(tx, A.distPool, "NEAR");
    if (poolNow !== pool) return null;
    const key = `dist:${block.height}:${pool}`;
    const ex = await tx.query("SELECT id FROM distribution_events WHERE idempotency_key=$1", [key]);
    if (ex.rows.length) return null;
    const j = await postJournal(tx, d.clock, {
      key,
      kind: "distribution",
      refType: "distribution_event",
      memo: `pro-rata distribution to ${a.allocations.length} holders at block ${block.height}`,
      entries: [
        { account: A.distPool, asset: "NEAR", amount: -a.allocated },
        { account: A.claimable, asset: "NEAR", amount: a.allocated },
      ],
    });
    const ev = await tx.query<{ id: string }>(
      `INSERT INTO distribution_events(idempotency_key, pool_amount, allocated_amount, dust_amount, holder_count, eligible_supply,
         snapshot_block_height, snapshot_block_hash, holder_source, journal_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [key, pool.toString(), a.allocated.toString(), a.dust.toString(), a.allocations.length, a.supply.toString(), block.height.toString(), block.hash, disc.source, j.journalId, d.clock.now().toISOString()],
    );
    const eventId = ev.rows[0]!.id;
    for (const al of a.allocations) {
      await tx.query("INSERT INTO distribution_entitlements(event_id, account_id, balance, amount) VALUES ($1,$2,$3,$4)", [eventId, al.accountId, al.balance.toString(), al.amount.toString()]);
    }
    await notify(
      tx,
      d.clock,
      `claimable:${eventId}`,
      "claimable",
      `💰 <b>Rewards are claimable</b>\n${formatAsset(a.allocated, "NEAR")} (${formatUsd(toUsdMicro(a.allocated, "NEAR", price))}) split pro-rata across ${a.allocations.length} holders (snapshot block ${block.height}).\nClaims open on the vault after the guardian veto window. DM the bot /claim to queue yours.`,
    );
    // Publish it as an on-chain Merkle payout list (time-locked, guardian-vetoable).
    await enqueue(tx, d.clock, { type: "vault.propose_distribution", key: `vault-dist:${eventId}`, payload: { eventId }, maxAttempts: 500 });
    return eventId;
  });
  if (!r) return { created: false, reason: "pool changed or already distributed; will retry" };
  return { created: true, eventId: r, allocated: a.allocated, holders: a.allocations.length };
}
