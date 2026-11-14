/**
 * "Graduation Momentum" — BAGFLIP's initial AUTO HUNT strategy.
 *
 * Thesis (see docs/AUTO_HUNT.md): with $5–$10/day of capital and no co-located
 * infrastructure we cannot win the first-block sniping race on brand-new
 * Pump.fun launches, and most of those launches rug within minutes. The
 * practical edge for small capital is *momentum continuation on tokens that
 * have already shown real demand*: tokens close to completing the bonding
 * curve, or freshly migrated to PumpSwap, where volume is accelerating, buyers
 * outnumber sellers, and the move is not yet vertical. We enter on a
 * confirmed (two-scan) ignition, size positions so fixed fees stay small, and
 * exit fast with a hard stop, a partial take-profit, a trailing stop, a
 * momentum-decay exit and a 24h cap. Every number below is configurable.
 *
 * All functions here are pure: they take observations and return decisions
 * with human-readable reasons. That is what makes the strategy explainable,
 * replayable on recorded data, and unit-testable.
 */
import type { TokenMarket } from "../market/types.ts";

export interface StrategyParams {
  name: string;
  /** Minimum pair age for bonding-curve / other pairs, and for a PumpSwap graduate. */
  minAgeMin: number;
  minGraduateAgeMin: number;
  maxAgeHours: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  minLiquidityUsd: number;
  minTxnsH1: number;
  minTxnsM5: number;
  /** Reject when 5m sells > buys × this. */
  sellerDominance: number;
  /** 5m price change must be above this (%). */
  minM5ChangePct: number;
  /** 1h price change must be above this (%). Not applied to pairs younger than 60 minutes. */
  minH1ChangePct: number;
  maxM5ChangePct: number;
  maxH1ChangePct: number;
  entryScore: number;
  /** Score that enters on the first sighting (no second scan needed). */
  immediateEntryScore: number;
  /** A graduate this fresh (minutes since migration) enters on first sighting at entryScore. */
  freshGraduateMinutes: number;
  /** Two-scan confirmation: minimum gap, and how far price may slip between scans. */
  confirmMinGapMs: number;
  confirmMaxDropPct: number;
  allowedDexes: string[];
}

/** The original, selective variant (unchanged behaviour). */
export const ORIGINAL_PARAMS: StrategyParams = {
  name: "original",
  minAgeMin: 10,
  minGraduateAgeMin: 10,
  maxAgeHours: 72,
  minMcapUsd: 25_000,
  maxMcapUsd: 8_000_000,
  minLiquidityUsd: 12_000,
  minTxnsH1: 150,
  minTxnsM5: 15,
  sellerDominance: 1.25,
  minM5ChangePct: 0,
  minH1ChangePct: 0,
  maxM5ChangePct: 60,
  maxH1ChangePct: 500,
  entryScore: 0.65,
  immediateEntryScore: 2, // never: always two scans
  freshGraduateMinutes: 0,
  confirmMinGapMs: 20_000,
  confirmMaxDropPct: 2,
  allowedDexes: ["pumpfun", "pumpswap", "raydium", "meteora"],
};

/**
 * Aggressive momentum hunter: trades far more often. Looser activity/momentum filters, a 0.52 entry
 * score, single-scan entries on strong signals and on fresh graduates, and wider tolerance for
 * volatile candles. The essential execution-safety checks (mint/freeze authority, risky token
 * extensions, an executable sell-back quote) are NOT relaxed.
 */
export const AGGRESSIVE_PARAMS: StrategyParams = {
  name: "aggressive",
  minAgeMin: 3,
  minGraduateAgeMin: 0,
  maxAgeHours: 96,
  minMcapUsd: 12_000,
  maxMcapUsd: 25_000_000,
  minLiquidityUsd: 6_000,
  minTxnsH1: 60,
  minTxnsM5: 6,
  sellerDominance: 1.6,
  minM5ChangePct: -3,
  minH1ChangePct: -15,
  maxM5ChangePct: 150,
  maxH1ChangePct: 2_000,
  entryScore: 0.52,
  immediateEntryScore: 0.68,
  freshGraduateMinutes: 20,
  confirmMinGapMs: 8_000,
  confirmMaxDropPct: 6,
  allowedDexes: ["pumpfun", "pumpswap", "raydium", "meteora", "meteoradbc", "raydium-launchlab"],
};

export const DEFAULT_PARAMS = ORIGINAL_PARAMS;
export const VARIANTS: Record<string, StrategyParams> = { original: ORIGINAL_PARAMS, aggressive: AGGRESSIVE_PARAMS };

export interface ScoreContext {
  /** When the discovery feed saw this token migrate off the bonding curve. */
  migratedAt?: number;
}

export interface ScoreResult {
  pass: boolean;
  score: number;
  components: Record<string, number>;
  rejects: string[];
  notes: string[];
  /** Minutes since graduation, when it is a PumpSwap graduate. */
  graduateAgeMin: number | null;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export const WEIGHTS = {
  volumeAcceleration: 0.22,
  buyPressure: 0.18,
  shortMomentum: 0.15,
  hourTrend: 0.1,
  activity: 0.15,
  depth: 0.1,
  lifecycle: 0.1,
} as const;

/** Hard filters + weighted score for one market observation. */
export function scoreToken(m: TokenMarket, now: number, p: StrategyParams = DEFAULT_PARAMS, ctx: ScoreContext = {}): ScoreResult {
  const rejects: string[] = [];
  const notes: string[] = [];
  const ageMin = m.pairCreatedAt ? (now - m.pairCreatedAt) / 60_000 : null;
  const txM5 = m.txns.m5.buys + m.txns.m5.sells;
  const txH1 = m.txns.h1.buys + m.txns.h1.sells;
  const isCurve = m.dexId === "pumpfun";
  const isGraduate = m.dexId === "pumpswap";
  const gradRef = ctx.migratedAt ?? (isGraduate ? m.pairCreatedAt : null);
  const graduateAgeMin = isGraduate && gradRef ? Math.max(0, (now - gradRef) / 60_000) : null;
  const minAge = isGraduate ? p.minGraduateAgeMin : p.minAgeMin;
  // A graduate in its first minutes has little 1h history: judge it on 5m activity.
  const freshGrad = graduateAgeMin !== null && graduateAgeMin < Math.max(p.freshGraduateMinutes, 1);

  if (!p.allowedDexes.includes(m.dexId)) rejects.push(`venue ${m.dexId} not supported`);
  if (m.priceNative === null || m.priceNative <= 0) rejects.push("no SOL price");
  if (ageMin === null) rejects.push("unknown pair age");
  else if (ageMin < minAge) rejects.push(`too new (${ageMin.toFixed(0)}m)`);
  else if (ageMin > p.maxAgeHours * 60) rejects.push(`too old (${(ageMin / 60).toFixed(0)}h)`);
  if (m.marketCapUsd === null || m.marketCapUsd < p.minMcapUsd) rejects.push(`market cap below $${p.minMcapUsd}`);
  if (m.marketCapUsd !== null && m.marketCapUsd > p.maxMcapUsd) rejects.push("market cap too large for a momentum hunt");
  if (!isCurve && (m.liquidityUsd ?? 0) < p.minLiquidityUsd) rejects.push(`liquidity below $${p.minLiquidityUsd}`);
  if (!freshGrad && txH1 < p.minTxnsH1) rejects.push(`only ${txH1} trades in 1h`);
  if (txM5 < p.minTxnsM5) rejects.push(`only ${txM5} trades in 5m`);
  if (m.txns.m5.sells > m.txns.m5.buys * p.sellerDominance) rejects.push("sellers dominate the last 5m");
  if (!(m.priceChange.m5 > p.minM5ChangePct)) rejects.push("no 5m momentum");
  const hourOld = ageMin === null || ageMin >= 60 || p.name === "original";
  if (hourOld && !(m.priceChange.h1 > p.minH1ChangePct)) rejects.push("1h trend not positive");
  if (m.priceChange.m5 > p.maxM5ChangePct) rejects.push(`vertical 5m candle (+${m.priceChange.m5}%), chase risk`);
  if (m.priceChange.h1 > p.maxH1ChangePct) rejects.push(`overextended 1h (+${m.priceChange.h1}%)`);

  const avg5mOfHour = m.volume.h1 / 12;
  const accel = avg5mOfHour > 0 ? m.volume.m5 / avg5mOfHour : 0;
  const buyShare = txM5 > 0 ? m.txns.m5.buys / txM5 : 0;
  const depth = isCurve
    ? clamp01(((m.marketCapUsd ?? 0) - 25_000) / 45_000) // progress toward curve completion
    : clamp01((m.liquidityUsd ?? 0) / Math.max(1, (m.marketCapUsd ?? 1) * 0.15));
  let lifecycle = 0.3;
  if (isGraduate && ageMin !== null && ageMin < 6 * 60) {
    lifecycle = 1;
    notes.push(graduateAgeMin !== null && graduateAgeMin < 30 ? `just graduated (${graduateAgeMin.toFixed(0)}m ago)` : "fresh Pump.fun graduate");
  } else if (isCurve && (m.marketCapUsd ?? 0) > 45_000) {
    lifecycle = 0.8;
    notes.push("near bonding-curve completion");
  }

  const components = {
    // A brand-new graduate has no hourly baseline, so measure its burst by 5m trade count instead.
    volumeAcceleration: freshGrad && p.freshGraduateMinutes > 0 ? clamp01(txM5 / 60) : clamp01((accel - 1) / 3),
    buyPressure: clamp01((buyShare - 0.5) / 0.25),
    shortMomentum: clamp01(m.priceChange.m5 / 15) * (m.priceChange.m5 > 40 ? 0.5 : 1),
    hourTrend: clamp01(m.priceChange.h1 / 100),
    activity: clamp01(Math.log10(Math.max(1, freshGrad && p.freshGraduateMinutes > 0 ? txM5 * 12 : txH1) / 100) / 1.3),
    depth,
    lifecycle,
  };
  let score = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) score += w * components[k as keyof typeof components];
  notes.push(`5m volume ${accel.toFixed(1)}x hourly pace`, `${(buyShare * 100).toFixed(0)}% buys in 5m`);
  const pass = rejects.length === 0 && score >= p.entryScore;
  return { pass, score: Math.round(score * 1000) / 1000, components, rejects, notes, graduateAgeMin };
}

export interface SignalPoint {
  score: number;
  priceNative: number;
  at: number;
}

/**
 * Entry confirmation. Original: two consecutive passing scans ≥20s apart, price not down >2%.
 * Aggressive: enters on the first sighting when the score is very strong or the token is a fresh
 * graduate; otherwise a second scan ≥8s later with price not down >6%.
 */
export function confirmEntry(prev: SignalPoint | undefined, cur: SignalPoint, p: StrategyParams | number, graduateAgeMin: number | null = null): { confirmed: boolean; why: string } {
  const params: StrategyParams = typeof p === "number" ? { ...ORIGINAL_PARAMS, entryScore: p } : p;
  if (cur.score >= params.immediateEntryScore) return { confirmed: true, why: "strong signal: immediate entry" };
  if (graduateAgeMin !== null && graduateAgeMin <= params.freshGraduateMinutes && cur.score >= params.entryScore) {
    return { confirmed: true, why: "fresh graduation momentum: immediate entry" };
  }
  if (!prev) return { confirmed: false, why: "first sighting; waiting for confirmation" };
  if (cur.at - prev.at < params.confirmMinGapMs) return { confirmed: false, why: "confirmation too soon" };
  if (cur.at - prev.at > 5 * 60_000) return { confirmed: false, why: "previous signal stale" };
  if (prev.score < params.entryScore) return { confirmed: false, why: "previous scan below threshold" };
  if (cur.priceNative < prev.priceNative * (1 - params.confirmMaxDropPct / 100)) return { confirmed: false, why: "price fell between scans" };
  return { confirmed: true, why: "momentum confirmed on consecutive scans" };
}

/** Exit parameters per variant: aggressive takes profits sooner and trails tighter. */
export function variantExits(base: ExitParams, variant: string): ExitParams {
  if (variant !== "aggressive") return base;
  return { ...base, stopLossPct: 35, takeProfitPct: 60, takeProfitSellPct: 40, trailingActivatePct: 30, trailingStopPct: 22, staleHours: 2 };
}

// ───────────────────────────── exits ─────────────────────────────

export interface ExitParams {
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitSellPct: number;
  trailingActivatePct: number;
  trailingStopPct: number;
  maxHoldHours: number;
  staleHours: number;
  exitSlippageBps: number;
  emergencySlippageBps: number;
}

export interface PositionView {
  remainingCost: bigint;
  peakValue: bigint;
  lastValue: bigint | null;
  takeProfitDone: boolean;
  openedAt: number;
  exitAttempts: number;
  entryVolumeM5: number | null;
  entryLiquidityUsd: number | null;
}

export type ExitDecision =
  | { action: "hold"; why: string }
  | { action: "sell"; fractionBps: number; reason: string; slippageBps: number };

/**
 * `value` is the EXECUTABLE value of the remaining tokens (a real sell quote, net of
 * venue fees) — not a mid price. Stops and targets are best-effort: they trigger a
 * sell attempt, and the realized price is whatever the chain gives us.
 */
export function decideExit(
  pos: PositionView,
  value: bigint | null,
  m: TokenMarket | null,
  now: number,
  modeIsHunt: boolean,
  p: ExitParams,
): ExitDecision {
  const slip = (base: number) => (pos.exitAttempts >= 2 ? p.emergencySlippageBps : base);
  if (!modeIsHunt) return { action: "sell", fractionBps: 10_000, reason: "wind_down", slippageBps: slip(p.exitSlippageBps) };
  const ageH = (now - pos.openedAt) / 3_600_000;
  if (value === null) {
    if (ageH >= p.maxHoldHours) return { action: "sell", fractionBps: 10_000, reason: "max_hold_no_quote", slippageBps: p.emergencySlippageBps };
    return { action: "hold", why: "no executable quote (route missing) — cannot price exit" };
  }
  if (pos.remainingCost <= 0n) return { action: "sell", fractionBps: 10_000, reason: "cleanup", slippageBps: p.exitSlippageBps };
  const pnlPct = (Number(value) / Number(pos.remainingCost) - 1) * 100;
  const peak = pos.peakValue > value ? pos.peakValue : value;
  const peakPct = (Number(peak) / Number(pos.remainingCost) - 1) * 100;

  if (pos.lastValue && pos.lastValue > 0n && Number(value) < Number(pos.lastValue) * 0.5) {
    return { action: "sell", fractionBps: 10_000, reason: "crash", slippageBps: p.emergencySlippageBps };
  }
  if (m && pos.entryLiquidityUsd && m.liquidityUsd !== null && m.liquidityUsd < pos.entryLiquidityUsd * 0.4) {
    return { action: "sell", fractionBps: 10_000, reason: "liquidity_collapse", slippageBps: p.emergencySlippageBps };
  }
  if (pnlPct <= -p.stopLossPct) return { action: "sell", fractionBps: 10_000, reason: "stop_loss", slippageBps: slip(p.exitSlippageBps) };
  if (!pos.takeProfitDone && pnlPct >= p.takeProfitPct) {
    return { action: "sell", fractionBps: Math.round(p.takeProfitSellPct * 100), reason: "take_profit", slippageBps: slip(p.exitSlippageBps) };
  }
  if (peakPct >= p.trailingActivatePct && Number(value) <= Number(peak) * (1 - p.trailingStopPct / 100)) {
    return { action: "sell", fractionBps: 10_000, reason: "trailing_stop", slippageBps: slip(p.exitSlippageBps) };
  }
  if (ageH >= p.maxHoldHours) return { action: "sell", fractionBps: 10_000, reason: "max_hold", slippageBps: slip(p.exitSlippageBps) };
  if (ageH >= p.staleHours && pnlPct < 10 && m && pos.entryVolumeM5 && m.volume.m5 < pos.entryVolumeM5 * 0.3) {
    return { action: "sell", fractionBps: 10_000, reason: "momentum_faded", slippageBps: slip(p.exitSlippageBps) };
  }
  return { action: "hold", why: `pnl ${pnlPct.toFixed(1)}%, peak ${peakPct.toFixed(1)}%` };
}
