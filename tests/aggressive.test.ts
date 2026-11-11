import { afterEach, describe, expect, it } from "vitest";
import { scoreToken, confirmEntry, ORIGINAL_PARAMS, AGGRESSIVE_PARAMS } from "../src/strategy/strategy.ts";
import { reasonKey, mergeFunnels, newFunnel, vetEntry, variantConfig } from "../src/trading/evaluate.ts";
import { testConfig } from "../src/shared/config.ts";
import type { TokenMarket } from "../src/market/types.ts";
import { makeHarness, pump, setMode, deposit, balances, hotToken, type Harness } from "./harness.ts";

const now = Date.UTC(2026, 10, 11, 12);
const mk = (o: Partial<TokenMarket> = {}): TokenMarket => ({
  mint: "M",
  symbol: "M",
  name: "M",
  pairAddress: "P",
  dexId: "pumpswap",
  quoteMint: "So11111111111111111111111111111111111111112",
  priceUsd: 0.001,
  priceNative: 0.00001,
  liquidityUsd: 45_000,
  marketCapUsd: 250_000,
  pairCreatedAt: now - 2 * 3_600_000,
  volume: { m5: 10_000, h1: 30_000, h6: 80_000, h24: 120_000 },
  txns: { m5: { buys: 80, sells: 20 }, h1: { buys: 700, sells: 300 } },
  priceChange: { m5: 9, h1: 55, h6: 90, h24: 140 },
  observedAt: now,
  ...o,
});

describe("aggressive vs original variant", () => {
  it("aggressive accepts thinner, choppier momentum that original rejects", () => {
    const thin = mk({
      marketCapUsd: 16_000,
      liquidityUsd: 8_000,
      volume: { m5: 2_500, h1: 6_000, h6: 9_000, h24: 9_000 },
      txns: { m5: { buys: 12, sells: 6 }, h1: { buys: 70, sells: 30 } },
      priceChange: { m5: 4, h1: 18, h6: 20, h24: 20 },
    });
    const o = scoreToken(thin, now, ORIGINAL_PARAMS);
    const a = scoreToken(thin, now, AGGRESSIVE_PARAMS);
    expect(o.rejects.length).toBeGreaterThan(0);
    expect(a.rejects).toEqual([]);
    expect(AGGRESSIVE_PARAMS.entryScore).toBeGreaterThanOrEqual(0.5);
    expect(AGGRESSIVE_PARAMS.entryScore).toBeLessThanOrEqual(0.55);
    // a small 5m dip with strong buying is tolerated by aggressive only
    const dip = mk({ priceChange: { m5: -1.5, h1: 40, h6: 0, h24: 0 } });
    expect(scoreToken(dip, now, ORIGINAL_PARAMS).rejects).toContain("no 5m momentum");
    expect(scoreToken(dip, now, AGGRESSIVE_PARAMS).rejects).not.toContain("no 5m momentum");
  });

  it("captures a fresh graduation immediately; original waits for two scans and 10 minutes", () => {
    const grad = mk({
      pairCreatedAt: now - 2 * 60_000,
      liquidityUsd: 20_000,
      marketCapUsd: 70_000,
      volume: { m5: 9_000, h1: 9_000, h6: 9_000, h24: 9_000 },
      txns: { m5: { buys: 60, sells: 25 }, h1: { buys: 60, sells: 25 } },
      priceChange: { m5: 12, h1: 12, h6: 12, h24: 12 },
    });
    const a = scoreToken(grad, now, AGGRESSIVE_PARAMS, { migratedAt: now - 2 * 60_000 });
    expect(a.pass).toBe(true);
    expect(a.notes.join()).toMatch(/just graduated/);
    expect(confirmEntry(undefined, { score: a.score, priceNative: 1, at: now }, AGGRESSIVE_PARAMS, a.graduateAgeMin).confirmed).toBe(true);
    const o = scoreToken(grad, now, ORIGINAL_PARAMS);
    expect(o.rejects.join()).toMatch(/too new/);
  });

  it("aggressive confirmation: strong signals enter at once, weaker ones need a quick second scan", () => {
    expect(confirmEntry(undefined, { score: 0.7, priceNative: 1, at: now }, AGGRESSIVE_PARAMS).confirmed).toBe(true);
    expect(confirmEntry(undefined, { score: 0.7, priceNative: 1, at: now }, ORIGINAL_PARAMS).confirmed).toBe(false);
    const prev = { score: 0.55, priceNative: 1, at: now };
    expect(confirmEntry(prev, { score: 0.56, priceNative: 0.96, at: now + 10_000 }, AGGRESSIVE_PARAMS).confirmed).toBe(true);
    expect(confirmEntry(prev, { score: 0.56, priceNative: 0.9, at: now + 10_000 }, AGGRESSIVE_PARAMS).confirmed).toBe(false);
  });

  it("essential execution safety is identical for every variant", async () => {
    const cfg = testConfig();
    const f = newFunnel("aggressive", new Date(now));
    const base = { quoteBuy: async () => ({ side: "buy" as const, mint: "M", inAmount: 1n, outAmount: 1000n, priceImpactPct: 1, feeBps: 10, venue: "t" }) };
    // unsafe mint (authority still active) → rejected even for aggressive
    const unsafe = await vetEntry(mk(), 1_000_000n, variantConfig(cfg, "aggressive"), { ...base, safety: { check: async () => ({ ok: false, reasons: ["mint authority still active (supply can be inflated)"], facts: {} }) }, quoteSell: async () => null }, undefined, f);
    expect(unsafe).toMatchObject({ ok: false, stage: "safety" });
    // no sell route → possible honeypot → rejected
    const honeypot = await vetEntry(mk(), 1_000_000n, variantConfig(cfg, "aggressive"), { ...base, safety: { check: async () => ({ ok: true, reasons: [], facts: {} }) }, quoteSell: async () => null }, undefined, f);
    expect(honeypot).toMatchObject({ ok: false, stage: "quote" });
    expect(f.safetyRejected).toEqual({ "mint authority still active": 1 });
    expect(f.quoteRejected).toEqual({ "no sell route (possible honeypot)": 1 });
  });

  it("normalizes rejection reasons and merges funnels", () => {
    expect(reasonKey("only 42 trades in 1h")).toBe("only N trades in 1h");
    expect(reasonKey("too new (3m)")).toBe("too new");
    expect(reasonKey("market cap below $25000")).toBe("market cap below N");
    const a = newFunnel("x", new Date(now));
    a.scored = 2;
    a.filtered = { "too new": 3 };
    a.discovery = { watchlist: 10, newSinceLast: { migration: 2 }, hotCurve: 1, freshGraduates: 1 };
    const b = newFunnel("x", new Date(now + 1000));
    b.scored = 1;
    b.executed = 1;
    b.filtered = { "too new": 1, "no 5m momentum": 2 };
    const m = mergeFunnels([a, b]);
    expect(m).toMatchObject({ scans: 2, scored: 3, executed: 1, filtered: { "too new": 4, "no 5m momentum": 2 }, discoveredNew: { migration: 2 } });
  });
});

let h: Harness;
afterEach(async () => {
  await h?.db.close();
  h = undefined as never;
});

describe("engine + shadow books", () => {
  it("the aggressive engine enters a strong signal on the first scan and records the funnel", async () => {
    h = await makeHarness({ STRATEGY_VARIANT: "aggressive" });
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    hotToken(h, "AGGtoken111");
    const r = await h.app.hunt.tick({ force: true });
    expect(r.entries).toBe(1);
    const f = await h.db.query<{ data: { executed: number; confirmed: number; variant: string } }>("SELECT data FROM scan_funnel WHERE variant='aggressive' ORDER BY id DESC LIMIT 1");
    expect(f.rows[0]!.data).toMatchObject({ variant: "aggressive", confirmed: 1, executed: 1 });
  });

  it("shadow books compare variants on the same scans without touching the treasury ledger", async () => {
    h = await makeHarness({ SHADOW_VARIANTS: "original,aggressive", SHADOW_START_SOL: "1" });
    // A moderate signal: passes aggressive (0.52) but not original (0.65).
    hotToken(h, "MIDtoken111", {
      marketCapUsd: 20_000,
      liquidityUsd: 9_000,
      volume: { m5: 3_000, h1: 9_000, h6: 9_000, h24: 9_000 },
      txns: { m5: { buys: 14, sells: 6 }, h1: { buys: 80, sells: 40 } },
      priceChange: { m5: 5, h1: 20, h6: 20, h24: 20 },
    });
    // Governance is INACTIVE: the real engine is paused, the shadows still evaluate.
    const before = await balances(h);
    await h.app.hunt.tick({ force: true });
    h.clock.advance(30_000);
    await h.app.hunt.tick({ force: true });
    const [orig, aggr] = h.app.hunt.shadows.map((s) => s.summary());
    expect(orig!.variant).toBe("original");
    expect(orig!.entries).toBe(0);
    expect(aggr!.entries).toBe(1);
    expect(BigInt(aggr!.cashLamports) < 1_000_000_000n).toBe(true);
    expect(await balances(h)).toEqual(before); // ledger untouched
    expect((await h.db.query("SELECT 1 FROM trading_positions")).rows).toHaveLength(0);
    const fun = await h.db.query<{ variant: string }>("SELECT DISTINCT variant FROM scan_funnel ORDER BY variant");
    expect(fun.rows.map((r) => r.variant)).toEqual(["shadow:aggressive", "shadow:original"]);

    // Price doubles → aggressive takes profit; the closed trade is persisted.
    h.market.movePrice("MIDtoken111", 2.5);
    h.clock.advance(20_000);
    await h.app.hunt.tick({ force: true });
    h.market.movePrice("MIDtoken111", 0.5);
    h.clock.advance(20_000);
    await h.app.hunt.tick({ force: true });
    const s = h.app.hunt.shadows[1]!.summary();
    expect(s.closed + s.open.length).toBeGreaterThanOrEqual(1);
    expect(BigInt(s.netPnlLamports) > 0n).toBe(true);
  });
});
