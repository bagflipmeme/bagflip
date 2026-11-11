/**
 * Append-only double-entry ledger. Every movement of BAGFLIP capital is one
 * journal with an idempotency key; entries in a journal sum to zero per asset.
 * Posting the same key twice is a no-op, which is what makes retries safe.
 *
 * Sign convention: asset accounts are positive when BAGFLIP holds value there.
 * "equity:deposits" goes negative as deposits arrive (source of funds);
 * "pnl:realized" goes negative on profit, positive on loss.
 */
import type { Tx } from "../db/index.ts";
import { advisoryXactLock } from "../db/index.ts";
import type { Asset } from "../shared/money.ts";
import type { Clock } from "../shared/time.ts";

export const A = {
  // NEAR side
  deposits: "equity:deposits",
  available: "treasury:available",
  distPool: "distribution:pool",
  claimable: "distribution:claimable",
  distributed: "equity:distributed",
  bridgeOut: "bridge:outbound",
  // SOL side
  tradingAvailable: "trading:available",
  positions: "trading:positions",
  bridgeIn: "bridge:inbound",
  pnl: "pnl:realized",
  // both
  fx: "fx:conversion",
  fees: "expense:fees",
  adjustments: "equity:adjustments",
} as const;

/** Accounts that must never go negative: spending beyond them is impossible by construction. */
const NON_NEGATIVE = new Set<string>([A.available, A.distPool, A.claimable, A.bridgeOut, A.tradingAvailable, A.positions, A.bridgeIn]);

export interface Entry {
  account: string;
  asset: Asset;
  amount: bigint;
}

export interface JournalInput {
  key: string;
  kind: string;
  refType?: string;
  refId?: string | number;
  memo?: string;
  entries: Entry[];
}

export class LedgerError extends Error {}

export async function postJournal(tx: Tx, clock: Clock, j: JournalInput): Promise<{ journalId: string; created: boolean }> {
  const entries = j.entries.filter((e) => e.amount !== 0n);
  const sums = new Map<Asset, bigint>();
  for (const e of entries) sums.set(e.asset, (sums.get(e.asset) ?? 0n) + e.amount);
  for (const [asset, s] of sums) if (s !== 0n) throw new LedgerError(`Unbalanced journal ${j.key}: ${asset} sums to ${s}`);
  if (!entries.length) throw new LedgerError(`Empty journal ${j.key}`);

  await advisoryXactLock(tx, "ledger");
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO ledger_journals(idempotency_key, kind, ref_type, ref_id, memo, created_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [j.key, j.kind, j.refType ?? null, j.refId !== undefined ? String(j.refId) : null, j.memo ?? null, clock.now().toISOString()],
  );
  if (!ins.rows[0]) {
    const ex = await tx.query<{ id: string }>("SELECT id FROM ledger_journals WHERE idempotency_key=$1", [j.key]);
    return { journalId: ex.rows[0]!.id, created: false };
  }
  const id = ins.rows[0].id;
  for (const e of entries) {
    await tx.query("INSERT INTO ledger_entries(journal_id, account, asset, amount) VALUES ($1,$2,$3,$4)", [id, e.account, e.asset, e.amount.toString()]);
  }
  for (const e of entries) {
    if (!NON_NEGATIVE.has(e.account) || e.amount > 0n) continue;
    const bal = await balance(tx, e.account, e.asset);
    if (bal < 0n) throw new LedgerError(`Journal ${j.key} would overdraw ${e.account} (${e.asset}) to ${bal}`);
  }
  return { journalId: id, created: true };
}

export async function balance(tx: Tx, account: string, asset: Asset): Promise<bigint> {
  const r = await tx.query<{ s: string }>("SELECT COALESCE(SUM(amount),0)::text AS s FROM ledger_entries WHERE account=$1 AND asset=$2", [account, asset]);
  return BigInt(r.rows[0]!.s);
}

export async function allBalances(tx: Tx): Promise<Map<string, bigint>> {
  const r = await tx.query<{ account: string; asset: string; s: string }>(
    "SELECT account, asset, SUM(amount)::text AS s FROM ledger_entries GROUP BY account, asset",
  );
  const m = new Map<string, bigint>();
  for (const row of r.rows) m.set(`${row.account}|${row.asset}`, BigInt(row.s));
  return m;
}

export const bal = (m: Map<string, bigint>, account: string, asset: Asset) => m.get(`${account}|${asset}`) ?? 0n;

/** Sum of each asset across all accounts must be zero — a full-ledger integrity check. */
export async function verifyLedgerIntegrity(tx: Tx): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const r = await tx.query<{ asset: string; s: string }>("SELECT asset, SUM(amount)::text AS s FROM ledger_entries GROUP BY asset");
  for (const row of r.rows) if (BigInt(row.s) !== 0n) problems.push(`${row.asset} ledger sums to ${row.s}`);
  const j = await tx.query<{ journal_id: string; asset: string; s: string }>(
    "SELECT journal_id, asset, SUM(amount)::text AS s FROM ledger_entries GROUP BY journal_id, asset HAVING SUM(amount) <> 0 LIMIT 5",
  );
  for (const row of j.rows) problems.push(`journal ${row.journal_id} unbalanced in ${row.asset}`);
  const m = await allBalances(tx);
  for (const [k, v] of m) {
    const [acct] = k.split("|");
    if (NON_NEGATIVE.has(acct!) && v < 0n) problems.push(`${k} is negative (${v})`);
  }
  return { ok: problems.length === 0, problems };
}
