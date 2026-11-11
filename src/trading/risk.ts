/**
 * RiskController: decides whether NEW positions may open, and how big.
 *
 * It protects the treasury from *unintended* losses (wrong mode, missing
 * funds, unreconciled state, broken RPC, unauthorized live trading). It does
 * not impose conservative investment caps: up to 100% of dedicated,
 * unreserved BAGFLIP capital may be at risk, as configured.
 */
import type { Db } from "../db/index.ts";
import { getState } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import { A, balance } from "../treasury/ledger.ts";
import { currentMode } from "../governance/cycle.ts";
import { ATA_RENT_LAMPORTS, BASE_FEE_LAMPORTS, type ExecMode } from "../solana/execution/types.ts";

export interface RiskVerdict {
  ok: boolean;
  reasons: string[];
}

export interface HealthState {
  rpcFailures: number;
  reconcile?: { ok: boolean; at: string; problems: string[] };
}

export async function getHealth(db: Db): Promise<HealthState> {
  return (await getState<HealthState>(db, "trading_health")) ?? { rpcFailures: 0 };
}

export async function canOpenPositions(db: Db, cfg: Config, clock: Clock, mode: ExecMode, vault: { mode: string; paused: boolean } | null = null): Promise<RiskVerdict> {
  const reasons: string[] = [];
  const gov = await currentMode(db);
  if (gov !== "AUTO_HUNT") reasons.push("governance mode is not AUTO HUNT");
  else if (vault && vault.mode !== "AutoHunt") reasons.push("vault has not activated AUTO HUNT yet (time-lock or council veto)");
  if (vault?.paused) reasons.push("vault is paused");
  if (cfg.EMERGENCY_PAUSE || (await getState<boolean>(db, "emergency_pause")) === true) reasons.push("emergency pause is active");
  if (mode === "live" && !cfg.liveTrading) reasons.push("live trading is not enabled");
  const h = await getHealth(db);
  if (h.rpcFailures >= cfg.RPC_FAILURE_PAUSE_THRESHOLD) reasons.push(`critical RPC/API failures (${h.rpcFailures} consecutive)`);
  if (mode === "live") {
    const fresh = h.reconcile && clock.now().getTime() - new Date(h.reconcile.at).getTime() < cfg.RECONCILE_INTERVAL_SECONDS * 3000;
    if (!h.reconcile || !fresh) reasons.push("wallet state not reconciled recently");
    else if (!h.reconcile.ok) reasons.push(`position/wallet state cannot be reconciled: ${h.reconcile.problems.join("; ")}`);
  }
  const stuck = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM trading_orders WHERE status IN ('planned','submitting') AND created_at < $1",
    [new Date(clock.now().getTime() - 10 * 60_000).toISOString()],
  );
  if (Number(stuck.rows[0]!.n) > 0) reasons.push("an order has been unresolved for over 10 minutes");
  return { ok: reasons.length === 0, reasons };
}

export function fixedCostLamports(cfg: Config): bigint {
  return 2n * (BASE_FEE_LAMPORTS + BigInt(cfg.PRIORITY_FEE_LAMPORTS));
}

/**
 * Position size from BAGFLIP trading capital only (ledger trading:available),
 * never from anything else in the wallet. Returns 0 when a trade would not be
 * economically viable.
 */
export async function positionSize(db: Db, cfg: Config, openCount: number, pendingBuys: bigint): Promise<{ size: bigint; why: string }> {
  if (openCount >= cfg.MAX_CONCURRENT_POSITIONS) return { size: 0n, why: "max concurrent positions reached" };
  const available = await balance(db, A.tradingAvailable, "SOL");
  const inPositions = await balance(db, A.positions, "SOL");
  const fixed = fixedCostLamports(cfg);
  const free = available - pendingBuys - cfg.solFeeReserve - fixed - ATA_RENT_LAMPORTS;
  if (free <= 0n) return { size: 0n, why: "insufficient trading capital for fees" };
  const capital = available + inPositions;
  let size = (capital * BigInt(Math.round(cfg.POSITION_SIZE_PERCENT * 100))) / 10_000n;
  if (size > free) size = free;
  if (cfg.maxPositionLamports > 0n && size > cfg.maxPositionLamports) size = cfg.maxPositionLamports;
  if (size < cfg.minPositionLamports) return { size: 0n, why: `position would be below minimum ${cfg.MIN_POSITION_SOL} SOL` };
  if (Number(fixed) / Number(size) > cfg.MAX_FIXED_COST_PERCENT / 100) return { size: 0n, why: "fixed fees too large relative to position" };
  return { size, why: "ok" };
}
