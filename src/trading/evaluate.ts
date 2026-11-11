/**
 * Shared scan evaluation used by the real HuntEngine and by the shadow comparison books, so every
 * variant is judged by identical code on identical market data. Every candidate's fate is counted in
 * a Funnel: discovered → snapshot → filtered (hard rejects) → scored → confirmed → vetted (safety,
 * executable quotes, sizing) → executed, with normalized reasons at every stage.
 */
import type { Config } from "../shared/config.ts";
import type { TokenMarket, SafetyChecker, DiscoveryEvent } from "../market/types.ts";
import type { SwapQuote } from "../solana/execution/types.ts";
import { DEFAULT_LIMITS, AGGRESSIVE_LIMITS, type SafetyLimits } from "../market/safety.ts";
import { scoreToken, confirmEntry, VARIANTS, variantExits, type ExitParams, type ScoreResult, type SignalPoint, type StrategyParams } from "../strategy/strategy.ts";

export interface VariantConfig {
  name: string;
  params: StrategyParams;
  exits: ExitParams;
  safety: SafetyLimits;
  maxRoundTripPct: number;
  maxImpactPct: number;
}

export function baseExitParams(cfg: Config): ExitParams {
  return {
    stopLossPct: cfg.STOP_LOSS_PERCENT,
    takeProfitPct: cfg.TAKE_PROFIT_PERCENT,
    takeProfitSellPct: cfg.TAKE_PROFIT_SELL_PERCENT,
    trailingActivatePct: cfg.TRAILING_ACTIVATE_PERCENT,
    trailingStopPct: cfg.TRAILING_STOP_PERCENT,
    maxHoldHours: cfg.MAX_POSITION_HOLD_HOURS,
    staleHours: cfg.STALE_EXIT_HOURS,
    exitSlippageBps: cfg.EXIT_SLIPPAGE_BPS,
    emergencySlippageBps: cfg.EMERGENCY_EXIT_SLIPPAGE_BPS,
  };
}

export function variantConfig(cfg: Config, name: string): VariantConfig {
  const base = VARIANTS[name];
  if (!base) throw new Error(`unknown strategy variant "${name}" (use original or aggressive)`);
  const aggressive = name === "aggressive";
  // ENTRY_SCORE_THRESHOLD, when set, overrides the configured main variant only.
  const params = name === cfg.STRATEGY_VARIANT && cfg.ENTRY_SCORE_THRESHOLD ? { ...base, entryScore: Number(cfg.ENTRY_SCORE_THRESHOLD) } : base;
  return {
    name,
    params,
    exits: variantExits(baseExitParams(cfg), name),
    safety: aggressive ? AGGRESSIVE_LIMITS : DEFAULT_LIMITS,
    maxRoundTripPct: aggressive ? Math.max(cfg.MAX_ROUNDTRIP_COST_PERCENT, 15) : cfg.MAX_ROUNDTRIP_COST_PERCENT,
    maxImpactPct: aggressive ? Math.max(cfg.MAX_PRICE_IMPACT_PERCENT, 6) : cfg.MAX_PRICE_IMPACT_PERCENT,
  };
}

// ───────────── funnel ─────────────

export interface FunnelSample {
  mint: string;
  symbol: string;
  stage: string;
  reason: string;
  score?: number;
}

export interface Funnel {
  variant: string;
  at: string;
  discovery: { watchlist: number; newSinceLast: Record<string, number>; hotCurve: number; freshGraduates: number } | null;
  candidates: number;
  snapshots: number;
  noPair: number;
  filtered: Record<string, number>;
  scored: number;
  belowThreshold: number;
  awaitingConfirmation: Record<string, number>;
  confirmed: number;
  safetyRejected: Record<string, number>;
  quoteRejected: Record<string, number>;
  sizingSkipped: Record<string, number>;
  executed: number;
  entryFailed: Record<string, number>;
  samples: FunnelSample[];
}

export function newFunnel(variant: string, at: Date): Funnel {
  return {
    variant,
    at: at.toISOString(),
    discovery: null,
    candidates: 0,
    snapshots: 0,
    noPair: 0,
    filtered: {},
    scored: 0,
    belowThreshold: 0,
    awaitingConfirmation: {},
    confirmed: 0,
    safetyRejected: {},
    quoteRejected: {},
    sizingSkipped: {},
    executed: 0,
    entryFailed: {},
    samples: [],
  };
}

/** "only 42 trades in 1h" → "only N trades in 1h"; "too new (3m)" → "too new". */
export function reasonKey(r: string): string {
  return r
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\$?\b\d[\d,.]*%?(?![hm]\b)/g, "N") // keep time windows like 1h / 5m
    .replace(/:.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function bump(rec: Record<string, number>, key: string, n = 1) {
  rec[key] = (rec[key] ?? 0) + n;
}

function sample(f: Funnel, s: FunnelSample) {
  if (f.samples.length < 25) f.samples.push(s);
}

/** Merge many funnels (e.g. a day of scans) into one report. */
export function mergeFunnels(list: Funnel[]): Omit<Funnel, "at" | "discovery" | "samples"> & { scans: number; from: string | null; to: string | null; discoveredNew: Record<string, number> } {
  const out = { ...newFunnel(list[0]?.variant ?? "?", new Date(0)), scans: list.length, from: list[0]?.at ?? null, to: list.at(-1)?.at ?? null, discoveredNew: {} as Record<string, number> };
  for (const f of list) {
    for (const k of ["candidates", "snapshots", "noPair", "scored", "belowThreshold", "confirmed", "executed"] as const) out[k] += f[k];
    for (const k of ["filtered", "awaitingConfirmation", "safetyRejected", "quoteRejected", "sizingSkipped", "entryFailed"] as const) {
      for (const [r, n] of Object.entries(f[k])) bump(out[k], r, n);
    }
    for (const [s, n] of Object.entries(f.discovery?.newSinceLast ?? {})) bump(out.discoveredNew, s, n);
  }
  const { at: _a, discovery: _d, samples: _s, ...rest } = out;
  return rest;
}

// ───────────── evaluation ─────────────

export class SignalTracker {
  signals = new Map<string, SignalPoint>();
  cooldown = new Map<string, number>();
}

export interface Ranked {
  m: TokenMarket;
  s: ScoreResult;
  why: string;
}

/** Score + confirm every snapshot for one variant. Updates the tracker and the funnel. */
export function evaluateMarkets(
  markets: TokenMarket[],
  now: number,
  vc: VariantConfig,
  tracker: SignalTracker,
  held: Set<string>,
  migratedAt: (mint: string) => number | undefined,
  f: Funnel,
): { ranked: Ranked[]; scoresByMint: Map<string, ScoreResult> } {
  const ranked: Ranked[] = [];
  const scoresByMint = new Map<string, ScoreResult>();
  for (const m of markets) {
    const s = scoreToken(m, now, vc.params, { migratedAt: migratedAt(m.mint) });
    scoresByMint.set(m.mint, s);
    if (s.rejects.length) {
      for (const r of s.rejects) bump(f.filtered, reasonKey(r));
      tracker.signals.delete(m.mint);
      continue;
    }
    f.scored++;
    if (!s.pass) {
      f.belowThreshold++;
      sample(f, { mint: m.mint, symbol: m.symbol, stage: "below_threshold", reason: `score ${s.score} < ${vc.params.entryScore}`, score: s.score });
      tracker.signals.delete(m.mint);
      continue;
    }
    const cur = { score: s.score, priceNative: m.priceNative ?? 0, at: now };
    const conf = confirmEntry(tracker.signals.get(m.mint), cur, vc.params, s.graduateAgeMin);
    tracker.signals.set(m.mint, cur);
    if (!conf.confirmed) {
      bump(f.awaitingConfirmation, conf.why);
      continue;
    }
    if (held.has(m.mint)) {
      bump(f.awaitingConfirmation, "already holding");
      continue;
    }
    if ((tracker.cooldown.get(m.mint) ?? 0) > now) {
      bump(f.awaitingConfirmation, "re-entry cooldown");
      continue;
    }
    f.confirmed++;
    ranked.push({ m, s, why: conf.why });
  }
  ranked.sort((a, b) => b.s.score - a.s.score);
  return { ranked, scoresByMint };
}

export interface VetDeps {
  safety: SafetyChecker;
  quoteBuy(mint: string, lamports: bigint): Promise<SwapQuote | null>;
  quoteSell(mint: string, tokens: bigint): Promise<SwapQuote | null>;
}

export type VetResult =
  | { ok: true; buyQ: SwapQuote; sellQ: SwapQuote; roundTripLossPct: number; safety: Record<string, unknown> }
  | { ok: false; stage: "safety" | "quote"; reason: string; cooldownMs: number };

/**
 * Essential execution security, applied to every variant: on-chain token safety and a real
 * buy-then-sell-back quote (no route = possible honeypot), within the variant's impact/cost limits.
 */
export async function vetEntry(m: TokenMarket, size: bigint, vc: VariantConfig, deps: VetDeps, disc: DiscoveryEvent | undefined, f: Funnel): Promise<VetResult> {
  const safety = await deps.safety.check(m, disc?.creator, disc?.bondingCurve, vc.safety);
  if (!safety.ok) {
    for (const r of safety.reasons) bump(f.safetyRejected, reasonKey(r));
    sample(f, { mint: m.mint, symbol: m.symbol, stage: "safety", reason: safety.reasons.join("; ") });
    return { ok: false, stage: "safety", reason: safety.reasons[0] ?? "unsafe", cooldownMs: 3_600_000 };
  }
  const buyQ = await deps.quoteBuy(m.mint, size);
  if (!buyQ) {
    bump(f.quoteRejected, "no buy route");
    return { ok: false, stage: "quote", reason: "no buy route", cooldownMs: 10 * 60_000 };
  }
  if (buyQ.priceImpactPct > vc.maxImpactPct) {
    bump(f.quoteRejected, "price impact too high");
    sample(f, { mint: m.mint, symbol: m.symbol, stage: "quote", reason: `impact ${buyQ.priceImpactPct.toFixed(1)}%` });
    return { ok: false, stage: "quote", reason: "price impact too high", cooldownMs: 5 * 60_000 };
  }
  const sellQ = await deps.quoteSell(m.mint, buyQ.outAmount);
  if (!sellQ) {
    bump(f.quoteRejected, "no sell route (possible honeypot)");
    sample(f, { mint: m.mint, symbol: m.symbol, stage: "quote", reason: "no sell route" });
    return { ok: false, stage: "quote", reason: "no sell route", cooldownMs: 6 * 3_600_000 };
  }
  const roundTripLossPct = (1 - Number(sellQ.outAmount) / Number(size)) * 100;
  if (roundTripLossPct > vc.maxRoundTripPct) {
    bump(f.quoteRejected, "round-trip cost too high");
    sample(f, { mint: m.mint, symbol: m.symbol, stage: "quote", reason: `round trip ${roundTripLossPct.toFixed(1)}%` });
    return { ok: false, stage: "quote", reason: "round-trip cost too high", cooldownMs: 10 * 60_000 };
  }
  return { ok: true, buyQ, sellQ, roundTripLossPct, safety: safety.facts };
}
