/**
 * The daily governance cycle (00:00 Asia/Kuala_Lumpur by default).
 *
 * 1. Resolve the snapshot block: the first final NEAR block at/after the boundary.
 * 2. Reconstruct each wallet's vote *as of the boundary* from the immutable
 *    vote_events log (votes cast after midnight count toward the next cycle).
 * 3. Read every voting wallet's token balance at that single block.
 * 4. decide() → persist decision + per-wallet snapshot rows (append-only).
 * 5. Queue the treasury operation for the new mode and the announcement.
 *
 * Idempotent: cycle_id is unique and the whole insert runs under an advisory
 * lock, so double-triggered schedulers or restarted workers cannot create a
 * second decision for the same day.
 */
import type { Db } from "../db/index.ts";
import { advisoryXactLock, getState, setState } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import { cycleIdFor, nextBoundary, previousBoundary } from "../shared/time.ts";
import type { NearChain } from "../near/chain.ts";
import type { BlockRef } from "../near/rpc.ts";
import { enqueue, RetryLater } from "../jobs/queue.ts";
import { decide, type Choice, type DecisionOutput, type Mode, percentOf } from "./engine.ts";
import { activeVotes } from "./wallets.ts";

export interface GovDeps {
  db: Db;
  chain: NearChain;
  clock: Clock;
  cfg: Config;
}

export function excludedAccounts(cfg: Config): Set<string> {
  return new Set([...cfg.EXCLUDED_HOLDER_ACCOUNTS, cfg.TREASURY_NEAR_ADDRESS, cfg.MEME_TOKEN_CONTRACT_ID].filter(Boolean).map((a) => a.toLowerCase()));
}

export async function currentDecision(db: Db) {
  const r = await db.query<{
    cycle_id: string;
    effective_mode: Mode;
    previous_mode: Mode;
    changed: boolean;
    reason: string;
    weight_distribute: string;
    weight_hunt: string;
    eligible_supply: string;
    distinct_wallets: number;
    quorum_met: boolean;
    block_height: string;
    executed_at: string;
  }>("SELECT * FROM governance_decisions ORDER BY boundary_at DESC, id DESC LIMIT 1");
  return r.rows[0] ?? null;
}

export async function currentMode(db: Db): Promise<Mode> {
  return (await currentDecision(db))?.effective_mode ?? "INACTIVE";
}

/** Votes in force at `at`, reconstructed from the append-only event log. */
export async function votesAsOf(db: Db, at: Date) {
  const r = await db.query<{ wallet_id: string; user_id: string; account_id: string; choice: Choice | null; action: string }>(
    `SELECT DISTINCT ON (e.wallet_id) e.wallet_id, e.user_id, w.account_id, e.choice, e.action
       FROM vote_events e
       JOIN wallets w ON w.id = e.wallet_id
       JOIN users u ON u.id = w.user_id
      WHERE e.created_at <= $1 AND w.verified_at <= $1 AND (w.unlinked_at IS NULL OR w.unlinked_at > $1) AND NOT u.is_banned
      ORDER BY e.wallet_id, e.created_at DESC, e.id DESC`,
    [at.toISOString()],
  );
  return r.rows.filter((x) => x.action === "vote" && x.choice).map((x) => ({ ...x, choice: x.choice as Choice }));
}

async function resolveSnapshotBlock(d: GovDeps, boundary: Date): Promise<{ block: BlockRef; late: boolean }> {
  const head = await d.chain.finalBlock();
  if (head.timestamp < boundary) throw new RetryLater("final NEAR block has not reached the boundary yet", 5_000);
  const lagMs = head.timestamp.getTime() - boundary.getTime();
  if (lagMs <= 120_000) return { block: head, late: false };
  const exact = await d.chain.blockAtOrAfter(boundary);
  if (exact) return { block: exact, late: false };
  return { block: head, late: true };
}

export interface CycleResult {
  cycleId: string;
  created: boolean;
  decision: DecisionOutput | null;
  mode: Mode;
}

export async function runDailyDecision(d: GovDeps, boundary: Date): Promise<CycleResult> {
  const { db, cfg, clock } = d;
  const cycleId = cycleIdFor(cfg.boundary, boundary);
  const exists = await db.query<{ effective_mode: Mode }>("SELECT effective_mode FROM governance_decisions WHERE cycle_id=$1", [cycleId]);
  if (exists.rows[0]) return { cycleId, created: false, decision: null, mode: exists.rows[0].effective_mode };

  const { block, late } = await resolveSnapshotBlock(d, boundary);
  const excluded = excludedAccounts(cfg);
  const votes = await votesAsOf(db, boundary);
  const token = cfg.MEME_TOKEN_CONTRACT_ID;
  const balances = await d.chain.ftBalances(token, [...new Set([...votes.map((v) => v.account_id), ...excluded])], block);
  const totalSupply = await d.chain.ftTotalSupply(token, block);
  let excludedBal = 0n;
  for (const a of excluded) excludedBal += balances.get(a) ?? 0n;
  const eligibleSupply = totalSupply > excludedBal ? totalSupply - excludedBal : 0n;

  const prev = await db.query<{ effective_mode: Mode }>(
    "SELECT effective_mode FROM governance_decisions WHERE boundary_at < $1 ORDER BY boundary_at DESC LIMIT 1",
    [boundary.toISOString()],
  );
  const previousMode: Mode = prev.rows[0]?.effective_mode ?? "INACTIVE";

  const decision = decide({
    previousMode,
    votes: votes.map((v) => {
      const bal = balances.get(v.account_id) ?? 0n;
      // Dust below the eligibility minimum does not vote.
      return { accountId: v.account_id, choice: v.choice, balance: bal >= cfg.minEligibleTokenBalance ? bal : 0n, excluded: excluded.has(v.account_id) };
    }),
    eligibleSupply,
    initialQuorumBps: Math.round(cfg.VOTING_INITIAL_QUORUM_PERCENT * 100),
    switchQuorumBps: Math.round(cfg.VOTING_MIN_QUORUM_PERCENT * 100),
    minDistinctWallets: cfg.VOTING_MIN_DISTINCT_WALLETS,
  });

  const created = await db.tx(async (tx) => {
    await advisoryXactLock(tx, "governance-cycle");
    const again = await tx.query("SELECT 1 FROM governance_decisions WHERE cycle_id=$1", [cycleId]);
    if (again.rows.length) return false;
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO governance_decisions(cycle_id, boundary_at, executed_at, block_height, block_hash, block_timestamp, late_snapshot,
         previous_mode, effective_mode, changed, reason, weight_distribute, weight_hunt, eligible_supply, distinct_wallets,
         quorum_required_bps, quorum_met, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb) RETURNING id`,
      [
        cycleId,
        boundary.toISOString(),
        clock.now().toISOString(),
        block.height.toString(),
        block.hash,
        block.timestamp.toISOString(),
        late,
        previousMode,
        decision.effectiveMode,
        decision.changed,
        decision.reason,
        decision.weightDistribute.toString(),
        decision.weightHunt.toString(),
        eligibleSupply.toString(),
        decision.distinctWallets,
        decision.quorumRequiredBps,
        decision.quorumMet,
        JSON.stringify({
          token,
          totalSupply: totalSupply.toString(),
          excluded: [...excluded],
          initialQuorumPercent: cfg.VOTING_INITIAL_QUORUM_PERCENT,
          switchQuorumPercent: cfg.VOTING_MIN_QUORUM_PERCENT,
          minDistinctWallets: cfg.VOTING_MIN_DISTINCT_WALLETS,
          minEligibleTokenBalance: cfg.minEligibleTokenBalance.toString(),
        }),
      ],
    );
    const decisionId = ins.rows[0]!.id;
    for (const v of votes) {
      const c = decision.counted.get(v.account_id);
      await tx.query(
        `INSERT INTO governance_snapshot_entries(decision_id, account_id, wallet_id, user_id, choice, balance, counted, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [decisionId, v.account_id, v.wallet_id, v.user_id, v.choice, (balances.get(v.account_id) ?? 0n).toString(), c?.counted ?? false, c?.note ?? null],
      );
    }
    await enqueue(tx, clock, { type: "governance.apply", key: `apply:${cycleId}`, payload: { cycleId, mode: decision.effectiveMode, previousMode, changed: decision.changed } });
    await enqueue(tx, clock, {
      type: "notify.decision",
      key: `notify-decision:${cycleId}`,
      payload: { cycleId },
    });
    return true;
  });
  return { cycleId, created, decision, mode: created ? decision.effectiveMode : await currentMode(db) };
}

/** Ensure the next boundary's decision job exists, and catch up a missed one. */
export async function scheduleDecisions(d: GovDeps) {
  const now = d.clock.now();
  const next = nextBoundary(d.cfg.boundary, now);
  await enqueue(d.db, d.clock, {
    type: "governance.decide",
    key: `decide:${cycleIdFor(d.cfg.boundary, next)}`,
    payload: { boundary: next.toISOString() },
    runAt: next,
    maxAttempts: 50,
  });
  // Recovery: if the most recent boundary has no decision (server was down), run it now.
  const prev = previousBoundary(d.cfg.boundary, now);
  await enqueue(d.db, d.clock, {
    type: "governance.decide",
    key: `decide:${cycleIdFor(d.cfg.boundary, prev)}`,
    payload: { boundary: prev.toISOString() },
    runAt: now,
    maxAttempts: 50,
  });
}

export interface LiveTally {
  at: string;
  blockHeight: string;
  distribute: string;
  hunt: string;
  wallets: number;
  distributePct: number;
  huntPct: number;
}

/** Current (non-binding) weighted tally for the Telegram UI, cached in system_state. */
export async function computeLiveTally(d: GovDeps): Promise<LiveTally> {
  const votes = await activeVotes(d.db);
  const excluded = excludedAccounts(d.cfg);
  const block = await d.chain.finalBlock();
  const balances = await d.chain.ftBalances(d.cfg.MEME_TOKEN_CONTRACT_ID, votes.map((v) => v.account_id), block);
  let D = 0n;
  let H = 0n;
  let wallets = 0;
  for (const v of votes) {
    if (excluded.has(v.account_id)) continue;
    const b = balances.get(v.account_id) ?? 0n;
    if (b < d.cfg.minEligibleTokenBalance || b <= 0n) continue;
    wallets++;
    if (v.choice === "DISTRIBUTE") D += b;
    else H += b;
  }
  const t: LiveTally = {
    at: d.clock.now().toISOString(),
    blockHeight: block.height.toString(),
    distribute: D.toString(),
    hunt: H.toString(),
    wallets,
    distributePct: percentOf(D, D + H),
    huntPct: percentOf(H, D + H),
  };
  await setState(d.db, "live_tally", t);
  return t;
}

export async function getLiveTally(db: Db): Promise<LiveTally | undefined> {
  return getState<LiveTally>(db, "live_tally");
}
