/**
 * Real market data: DexScreener (read-only, free) for pair metrics plus
 * discovery from DexScreener token profiles/boosts and the free PumpPortal
 * WebSocket events (new tokens, bonding-curve migrations).
 *
 * Verified 2026-11-09: GET /tokens/v1/solana/{csv} returns pairs with dexId
 * "pumpfun" (bonding curve) and "pumpswap" (migrated AMM). Pump.fun curve
 * pairs carry no `liquidity` field.
 */
import WebSocket from "ws";
import type { DiscoveryEvent, MarketDataProvider, TokenMarket } from "./types.ts";
import type { Logger } from "../shared/log.ts";
import { WSOL_MINT } from "../solana/rpc.ts";

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
}

export function normalizePair(p: DsPair, now: number): TokenMarket {
  const t = (k: string) => p.txns?.[k] ?? { buys: 0, sells: 0 };
  const v = (k: string) => p.volume?.[k] ?? 0;
  const c = (k: string) => p.priceChange?.[k] ?? 0;
  return {
    mint: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    quoteMint: p.quoteToken.address,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    priceNative: p.priceNative ? Number(p.priceNative) : null,
    liquidityUsd: p.liquidity?.usd ?? null,
    marketCapUsd: p.marketCap ?? p.fdv ?? null,
    pairCreatedAt: p.pairCreatedAt ?? null,
    volume: { m5: v("m5"), h1: v("h1"), h6: v("h6"), h24: v("h24") },
    txns: { m5: t("m5"), h1: t("h1") },
    priceChange: { m5: c("m5"), h1: c("h1"), h6: c("h6"), h24: c("h24") },
    observedAt: now,
  };
}

/** Simple token bucket so we stay inside public rate limits. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private perSecond: number;
  private burst: any;
  constructor(perSecond: number, burst = Math.max(1, perSecond)) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.tokens = burst;
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.perSecond) * 1000)));
    }
  }
}

interface WatchEntry extends DiscoveryEvent {
  lastChecked: number;
}

export class DexScreenerMarket implements MarketDataProvider {
  readonly name = "dexscreener";
  private watch = new Map<string, WatchEntry>();
  private limiterPairs = new RateLimiter(4); // documented 300/min
  private limiterProfiles = new RateLimiter(0.8); // documented 60/min
  private lastProfilePoll = 0;
  private ws?: WebSocket;
  private wsStopped = false;

  private baseUrl: string;
  private log: Logger;
  private opts: { pumpPortalWs?: string; maxWatch?: number };
  constructor(baseUrl: string, log: Logger, opts: { pumpPortalWs?: string; maxWatch?: number } = {}) {
    this.baseUrl = baseUrl;
    this.log = log;
    this.opts = opts;}

  /** Start the free PumpPortal discovery stream (new tokens + migrations). */
  startDiscoveryStream() {
    if (!this.opts.pumpPortalWs || this.ws) return;
    const connect = () => {
      const ws = new WebSocket(this.opts.pumpPortalWs!);
      this.ws = ws;
      ws.on("open", () => {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        ws.send(JSON.stringify({ method: "subscribeMigration" }));
        this.log.info("pumpportal discovery stream connected");
      });
      ws.on("message", (buf) => {
        try {
          // Verified 2026-11-09: create events = {mint, txType:"create", traderPublicKey (creator), bondingCurveKey, ...}.
          const m = JSON.parse(String(buf)) as { mint?: string; txType?: string; traderPublicKey?: string; bondingCurveKey?: string };
          if (!m.mint || !m.txType) return; // subscription acks carry only {message}
          if (m.txType === "create") this.add({ mint: m.mint, source: "new_token", at: Date.now(), creator: m.traderPublicKey, bondingCurve: m.bondingCurveKey });
          else this.add({ mint: m.mint, source: "migration", at: Date.now() });
        } catch {
          /* ignore */
        }
      });
      ws.on("close", () => {
        this.ws = undefined;
        if (!this.wsStopped) setTimeout(connect, 5_000);
      });
      ws.on("error", (e) => this.log.warn("pumpportal stream error", { error: String(e) }));
    };
    connect();
  }

  stop() {
    this.wsStopped = true;
    this.ws?.close();
  }

  add(e: DiscoveryEvent) {
    const ex = this.watch.get(e.mint);
    if (ex) {
      // A migration upgrades a new-token entry.
      if (e.source === "migration" && ex.source !== "migration") Object.assign(ex, { source: "migration", at: e.at });
      if (e.creator && !ex.creator) ex.creator = e.creator;
      if (e.bondingCurve && !ex.bondingCurve) ex.bondingCurve = e.bondingCurve;
      return;
    }
    this.watch.set(e.mint, { ...e, lastChecked: 0 });
    const max = this.opts.maxWatch ?? 3000;
    if (this.watch.size > max) {
      // Evict the oldest unchecked new tokens first.
      const victims = [...this.watch.values()].sort((a, b) => (a.source === "new_token" ? 0 : 1) - (b.source === "new_token" ? 0 : 1) || a.at - b.at);
      for (const v of victims.slice(0, this.watch.size - max)) this.watch.delete(v.mint);
    }
  }

  drop(mint: string) {
    this.watch.delete(mint);
  }

  private async getJson<T>(path: string, limiter: RateLimiter): Promise<T> {
    await limiter.take();
    const res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`DexScreener ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async pollProfiles(now: number) {
    if (now - this.lastProfilePoll < 60_000) return;
    this.lastProfilePoll = now;
    for (const [path, source] of [
      ["/token-profiles/latest/v1", "profile"],
      ["/token-boosts/latest/v1", "boost"],
    ] as const) {
      try {
        const list = await this.getJson<{ chainId: string; tokenAddress: string }[]>(path, this.limiterProfiles);
        for (const t of list) if (t.chainId === "solana") this.add({ mint: t.tokenAddress, source, at: now });
      } catch (e) {
        this.log.warn("dexscreener discovery failed", { path, error: String(e) });
      }
    }
  }

  async candidates(now: number): Promise<DiscoveryEvent[]> {
    await this.pollProfiles(now);
    const out: DiscoveryEvent[] = [];
    for (const w of this.watch.values()) {
      const age = now - w.at;
      if (age > 24 * 3_600_000) {
        this.watch.delete(w.mint);
        continue;
      }
      // New launches are only worth a look after ~12 minutes (most rugs and bundles resolve by then).
      if (w.source === "new_token" && age < 12 * 60_000) continue;
      if (w.source === "new_token" && w.lastChecked > 0) continue; // one look; survivors get promoted by the scanner
      const interval = w.source === "migration" ? 30_000 : 60_000;
      if (now - w.lastChecked < interval) continue;
      w.lastChecked = now;
      out.push(w);
    }
    return out.slice(0, 120);
  }

  /** Mark a mint as "still interesting" so it keeps getting rechecked. */
  promote(mint: string) {
    const w = this.watch.get(mint);
    if (w && w.source === "new_token") w.source = "profile";
  }

  async snapshot(mints: string[]): Promise<TokenMarket[]> {
    const out: TokenMarket[] = [];
    const now = Date.now();
    for (let i = 0; i < mints.length; i += 30) {
      const batch = mints.slice(i, i + 30);
      const pairs = await this.getJson<DsPair[]>(`/tokens/v1/solana/${batch.join(",")}`, this.limiterPairs);
      // Best SOL-quoted pair per mint: prefer pump venues, then highest liquidity/volume.
      const best = new Map<string, DsPair>();
      for (const p of pairs) {
        if (p.chainId !== "solana" || p.quoteToken.address !== WSOL_MINT) continue;
        const cur = best.get(p.baseToken.address);
        const rank = (x: DsPair) => (["pumpswap", "pumpfun"].includes(x.dexId) ? 1e12 : 0) + (x.liquidity?.usd ?? 0) + (x.volume?.h1 ?? 0);
        if (!cur || rank(p) > rank(cur)) best.set(p.baseToken.address, p);
      }
      for (const p of best.values()) out.push(normalizePair(p, now));
    }
    return out;
  }
}
