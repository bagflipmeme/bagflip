/**
 * Pure, deterministic governance decision. No I/O: the daily cycle feeds it a
 * snapshot taken at one NEAR block and persists whatever it returns.
 *
 * Rules (see README "Governance"):
 *  - Voting power = eligible token balance at the snapshot block.
 *  - Each NEAR account counts once (balances read at one block, so tokens
 *    moved between wallets can't be counted twice).
 *  - Before the first valid decision the mode is INACTIVE (no trading).
 *  - A first activation needs the initial quorum and a strict majority (>50%).
 *  - Afterwards, the mode switches only if the opposite option has >50% of
 *    valid weighted votes AND the switching quorum is met.
 *  - Exactly 50/50, zero valid votes, or missed quorum keep the previous mode.
 */

export type Choice = "DISTRIBUTE" | "AUTO_HUNT";
export type Mode = "INACTIVE" | Choice;

export interface SnapshotVote {
  accountId: string;
  choice: Choice;
  balance: bigint;
  excluded: boolean;
}

export interface DecisionInput {
  previousMode: Mode;
  votes: SnapshotVote[];
  /** Circulating supply that can vote: total supply minus excluded protocol accounts. */
  eligibleSupply: bigint;
  initialQuorumBps: number;
  switchQuorumBps: number;
  minDistinctWallets: number;
}

export interface DecisionOutput {
  effectiveMode: Mode;
  changed: boolean;
  reason: string;
  weightDistribute: bigint;
  weightHunt: bigint;
  totalWeight: bigint;
  distinctWallets: number;
  quorumRequiredBps: number;
  quorumMet: boolean;
  counted: Map<string, { counted: boolean; note?: string }>;
}

export function decide(input: DecisionInput): DecisionOutput {
  let wD = 0n;
  let wH = 0n;
  let distinct = 0;
  const counted = new Map<string, { counted: boolean; note?: string }>();
  const seen = new Set<string>();

  for (const v of input.votes) {
    if (seen.has(v.accountId)) {
      counted.set(v.accountId, { counted: false, note: "duplicate account" });
      continue;
    }
    seen.add(v.accountId);
    if (v.excluded) {
      counted.set(v.accountId, { counted: false, note: "excluded account" });
      continue;
    }
    if (v.balance <= 0n) {
      counted.set(v.accountId, { counted: false, note: "zero balance" });
      continue;
    }
    counted.set(v.accountId, { counted: true });
    distinct++;
    if (v.choice === "DISTRIBUTE") wD += v.balance;
    else wH += v.balance;
  }

  const total = wD + wH;
  const first = input.previousMode === "INACTIVE";
  const quorumRequiredBps = first ? input.initialQuorumBps : input.switchQuorumBps;
  const weightQuorumOk = input.eligibleSupply > 0n ? total * 10_000n >= input.eligibleSupply * BigInt(quorumRequiredBps) : quorumRequiredBps === 0;
  const walletsOk = distinct >= input.minDistinctWallets;
  const quorumMet = total > 0n && weightQuorumOk && walletsOk;

  const base = { weightDistribute: wD, weightHunt: wH, totalWeight: total, distinctWallets: distinct, quorumRequiredBps, quorumMet, counted };
  const keep = (reason: string): DecisionOutput => ({ ...base, effectiveMode: input.previousMode, changed: false, reason });

  if (total === 0n) return keep("no valid weighted votes; previous mode retained");
  if (!quorumMet) {
    const why = !walletsOk ? `only ${distinct} voting wallet(s), ${input.minDistinctWallets} required` : `turnout below ${(quorumRequiredBps / 100).toFixed(2)}% quorum`;
    return keep(first ? `quorum not reached (${why}); staying INACTIVE` : `quorum not reached (${why}); previous mode retained`);
  }

  // Strict majority: 2*w > total.
  const winner: Choice | null = 2n * wD > total ? "DISTRIBUTE" : 2n * wH > total ? "AUTO_HUNT" : null;
  if (!winner) return keep("exact tie; previous mode retained");
  if (winner === input.previousMode) return keep(`${winner} holds the majority; mode continues`);
  return {
    ...base,
    effectiveMode: winner,
    changed: true,
    reason: first ? `${winner} activated with a majority` : `${winner} won the majority; switching from ${input.previousMode}`,
  };
}

export function percentOf(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * 10_000n) / total) / 100;
}
