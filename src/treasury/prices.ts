/**
 * USD prices for display and economic thresholds only (never for accounting).
 * Source: NEAR Intents 1Click /v0/tokens (wNEAR and SOL). Last good price is
 * cached; if no price has ever been fetched the caller must treat USD-based
 * thresholds as "not met" rather than guess.
 */
import type { Asset } from "../shared/money.ts";

export interface PriceOracle {
  usd(asset: Asset): Promise<number | null>;
}

export class FixedPrices implements PriceOracle {
  private p: Record<Asset, number>;
  constructor(p: Record<Asset, number>) {
    this.p = p;}
  async usd(a: Asset) {
    return this.p[a];
  }
  set(a: Asset, v: number) {
    this.p[a] = v;
  }
}

const ASSET_IDS: Record<Asset, string> = { NEAR: "nep141:wrap.near", SOL: "nep141:sol.omft.near" };

export class OneClickPrices implements PriceOracle {
  private cache = new Map<Asset, { at: number; price: number }>();
  private baseUrl: string;
  private ttlMs: number;
  constructor(baseUrl: string, ttlMs = 5 * 60_000) {
    this.baseUrl = baseUrl;
    this.ttlMs = ttlMs;}

  async usd(a: Asset): Promise<number | null> {
    const c = this.cache.get(a);
    if (c && Date.now() - c.at < this.ttlMs) return c.price;
    try {
      const res = await fetch(`${this.baseUrl}/v0/tokens`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as { assetId: string; price: number }[];
      for (const [asset, id] of Object.entries(ASSET_IDS) as [Asset, string][]) {
        const t = list.find((x) => x.assetId === id);
        if (t && t.price > 0) this.cache.set(asset, { at: Date.now(), price: t.price });
      }
    } catch {
      /* fall through to stale cache */
    }
    return this.cache.get(a)?.price ?? null;
  }
}
