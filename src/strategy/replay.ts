/**
 * Historical replay: run the exact entry/exit logic over recorded market
 * observations (market_observations, written by every paper/live scan and
 * every position check) and report what the strategy would have done.
 *
 * Fill model (deliberately pessimistic): each side pays venue fee + extra
 * slippage + network fees; price impact uses a constant-product estimate from
 * the observed liquidity. Replay cannot reproduce failed exits or rugs
 * between observations perfectly — treat results as an upper bound.
 */
import type { TokenMarket } from "../market/types.ts";
import { scoreToken, confirmEntry, decideExit, type StrategyParams, type ExitParams } from "./strategy.ts";

export interface ReplayParams {
  strategy: StrategyParams;
  exits: ExitParams;
  startLamports: bigint;
  positionPct: number;
  maxConcurrent: number;
  feeBps: number;
  extraSlippageBps: number;
  networkFeeLamports: bigint;
  solUsd: number;
}

export interface ReplayTrade {
  mint: string;
  symbol: string;
  openedAt: number;
  closedAt: number | null;
  cost: bigint;
  proceeds: bigint;
  pnl: bigint;
  reason: string;
}

function impactFactor(m: TokenMarket, sizeLamports: bigint, solUsd: number): number {
  const liqSol = (m.liquidityUsd ?? (m.marketCapUsd ?? 0) * 0.1) / solUsd / 2; // SOL side of pool
  const size = Number(sizeLamports) / 1e9;
  return liqSol > 0 ? liqSol / (liqSol + size) : 0;
}

export function replay(observations: TokenMarket[], p: ReplayParams) {
  const obs = [...observations].sort((a, b) => a.observedAt - b.observedAt);
  let cash = p.startLamports;
  const open = new Map<string, { tokens: number; cost: bigint; remaining: bigint; peak: bigint; last: bigint | null; tp: boolean; openedAt: number; volM5: number; liq: number | null; symbol: string; proceeds: bigint }>();
  const trades: ReplayTrade[] = [];
  const signals = new Map<string, { score: number; priceNative: number; at: number }>();
  const keep = (bps: number) => (10_000 - bps) / 10_000;

  for (const m of obs) {
    const now = m.observedAt;
    const pos = open.get(m.mint);
    if (pos && m.priceNative) {
      const gross = pos.tokens * m.priceNative * 1e9 * impactFactor(m, BigInt(Math.round(pos.tokens * m.priceNative * 1e9)), p.solUsd) * keep(p.feeBps);
      const value = BigInt(Math.max(0, Math.floor(gross)));
      const d = decideExit(
        { remainingCost: pos.remaining, peakValue: pos.peak, lastValue: pos.last, takeProfitDone: pos.tp, openedAt: pos.openedAt, exitAttempts: 0, entryVolumeM5: pos.volM5, entryLiquidityUsd: pos.liq },
        value,
        m,
        now,
        true,
        p.exits,
      );
      pos.last = value;
      if (value > pos.peak) pos.peak = value;
      if (d.action === "sell") {
        const frac = d.fractionBps / 10_000;
        const out = BigInt(Math.floor(Number(value) * frac * keep(p.extraSlippageBps))) - p.networkFeeLamports;
        const costPortion = frac >= 1 ? pos.remaining : BigInt(Math.floor(Number(pos.remaining) * frac));
        cash += out;
        pos.proceeds += out;
        pos.remaining -= costPortion;
        pos.tokens *= 1 - frac;
        pos.peak = BigInt(Math.floor(Number(pos.peak) * (1 - frac)));
        if (d.reason === "take_profit") pos.tp = true;
        if (frac >= 1) {
          trades.push({ mint: m.mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: now, cost: pos.cost, proceeds: pos.proceeds, pnl: pos.proceeds - pos.cost, reason: d.reason });
          open.delete(m.mint);
        }
      }
      continue;
    }
    const s = scoreToken(m, now, p.strategy);
    const cur = { score: s.score, priceNative: m.priceNative ?? 0, at: now };
    if (!s.pass) {
      signals.delete(m.mint);
      continue;
    }
    const conf = confirmEntry(signals.get(m.mint), cur, p.strategy.entryScore);
    signals.set(m.mint, cur);
    if (!conf.confirmed || open.size >= p.maxConcurrent || !m.priceNative) continue;
    const size = (cash * BigInt(Math.round(p.positionPct * 100))) / 10_000n;
    if (size <= p.networkFeeLamports * 4n) continue;
    const tokens = ((Number(size) / 1e9) * impactFactor(m, size, p.solUsd) * keep(p.feeBps) * keep(p.extraSlippageBps)) / m.priceNative;
    const cost = size + p.networkFeeLamports;
    cash -= cost;
    open.set(m.mint, { tokens, cost, remaining: cost, peak: cost, last: cost, tp: false, openedAt: now, volM5: m.volume.m5, liq: m.liquidityUsd, symbol: m.symbol, proceeds: 0n });
  }
  // Mark anything still open at its last value (unrealized).
  let unrealized = 0n;
  for (const [mint, pos] of open) {
    unrealized += pos.last ?? 0n;
    trades.push({ mint, symbol: pos.symbol, openedAt: pos.openedAt, closedAt: null, cost: pos.cost, proceeds: pos.proceeds, pnl: (pos.last ?? 0n) + pos.proceeds - pos.cost, reason: "still_open" });
  }
  const closed = trades.filter((t) => t.closedAt !== null);
  return {
    trades,
    endCash: cash,
    unrealized,
    endEquity: cash + unrealized,
    returnPct: (Number(cash + unrealized) / Number(p.startLamports) - 1) * 100,
    wins: closed.filter((t) => t.pnl > 0n).length,
    losses: closed.filter((t) => t.pnl <= 0n).length,
  };
}
