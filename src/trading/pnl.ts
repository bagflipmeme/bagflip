/**
 * PnLCalculator. Realized P&L comes only from settled sells (actual SOL in vs
 * actual SOL out, fees included) and write-offs. Unrealized P&L is the last
 * executable sell quote minus remaining cost, and is always labeled as such.
 */
import type { Tx } from "../db/index.ts";

export interface PnlStats {
  closed: number;
  wins: number;
  losses: number;
  writtenOff: number;
  winRatePct: number;
  realizedLamports: bigint;
  feesLamports: bigint;
  costLamports: bigint;
  bestLamports: bigint;
  worstLamports: bigint;
  avgHoldMinutes: number;
  open: number;
  unrealizedLamports: bigint;
  failedEntries: number;
}

export async function pnlStats(db: Tx, since?: Date): Promise<PnlStats> {
  const params = since ? [since.toISOString()] : [];
  const cond = since ? "AND closed_at >= $1" : "";
  const r = await db.query<{ n: string; wins: string; losses: string; wo: string; realized: string; fees: string; cost: string; best: string | null; worst: string | null; hold: string | null }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE realized_pnl_lamports > 0)::text AS wins,
            count(*) FILTER (WHERE realized_pnl_lamports <= 0)::text AS losses,
            count(*) FILTER (WHERE status = 'written_off')::text AS wo,
            COALESCE(SUM(realized_pnl_lamports),0)::text AS realized,
            COALESCE(SUM(fees_lamports),0)::text AS fees,
            COALESCE(SUM(cost_lamports),0)::text AS cost,
            MAX(realized_pnl_lamports)::text AS best,
            MIN(realized_pnl_lamports)::text AS worst,
            AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 60)::text AS hold
       FROM trading_positions WHERE status IN ('closed','written_off') ${cond}`,
    params,
  );
  const row = r.rows[0]!;
  const o = await db.query<{ n: string; u: string }>(
    `SELECT count(*)::text AS n, COALESCE(SUM(COALESCE(last_value_lamports, remaining_cost_lamports) - remaining_cost_lamports),0)::text AS u
       FROM trading_positions WHERE status IN ('open','closing')`,
  );
  const f = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM trading_positions WHERE status='failed' ${since ? "AND opened_at >= $1" : ""}`, params);
  const closed = Number(row.n);
  return {
    closed,
    wins: Number(row.wins),
    losses: Number(row.losses),
    writtenOff: Number(row.wo),
    winRatePct: closed ? (Number(row.wins) / closed) * 100 : 0,
    realizedLamports: BigInt(row.realized),
    feesLamports: BigInt(row.fees),
    costLamports: BigInt(row.cost),
    bestLamports: BigInt(row.best ?? "0"),
    worstLamports: BigInt(row.worst ?? "0"),
    avgHoldMinutes: Number(row.hold ?? 0),
    open: Number(o.rows[0]!.n),
    unrealizedLamports: BigInt(o.rows[0]!.u),
    failedEntries: Number(f.rows[0]!.n),
  };
}
