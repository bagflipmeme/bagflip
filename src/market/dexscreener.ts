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
  checks: number;
  lastMcap: number | null;
  lastDex: string | null;
  /** When graduation was observed (PumpPortal migration event, or the pair flipping pumpfun → pumpswap). */
  migratedAt?: number;
  sources: Set<string>;
}

export interface DiscoveryStats {
  watchlist: number;
  bySource: Record<string, number>;
  /** New mints added since the previous stats() call, by source. */
  newSinceLast: Record<string, number>;
  hotCurve: number;
  freshGraduates: number;
}

const GECKO = "https://api.geckoterminal.com/api/v2";

export class DexScreenerMarket implements MarketDataProvider {
  readonly name = "dexscreener";
  private watch = new Map<string, WatchEntry>();
  private limiterPairs = new RateLimiter(4); // documented 300/min
  private limiterProfiles = new RateLimiter(0.8); // documented 60/min
  private limiterGecko = new RateLimiter(0.4, 2); // GeckoTerminal free tier ~30/min
  private lastProfilePoll = 0;
  private lastGeckoPoll = 0;
  private newCounts: Record<string, number> = {};
  private ws?: WebSocket;
  private wsStopped = false;

  private baseUrl: string;
  private log: Logger;
  private opts: { pumpPortalWs?: string; maxWatch?: number; gecko?: boolean };
  constructor(baseUrl: string, log: Logger, opts: { pumpPortalWs?: string; maxWatch?: number; gecko?: boolean } = {}) {
    this.baseUrl = baseUrl;
    this.log = log;
    this.opts = opts;
  }

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
      ex.sources.add(e.source);
      if (e.source === "migration") {
        // Graduation: switch to the fast lane immediately.
        if (!ex.migratedAt) ex.migratedAt = e.at;
        ex.source = "migration";
        ex.lastChecked = 0;
      }
      if (e.creator && !ex.creator) ex.creator = e.creator;
      if (e.bondingCurve && !ex.bondingCurve) ex.bondingCurve = e.bondingCurve;
      return;
    }
    this.newCounts[e.source] = (this.newCounts[e.source] ?? 0) + 1;
    this.watch.set(e.mint, { ...e, lastChecked: 0, checks: 0, lastMcap: null, lastDex: null, migratedAt: e.source === "migration" ? e.at : undefined, sources: new Set([e.source]) });
    const max = this.opts.maxWatch ?? 5000;
    if (this.watch.size > max) {
      // Evict quiet new launches first, then the oldest entries.
      const quiet = (w: WatchEntry) => (w.source === "new_token" && (w.lastMcap ?? 0) < 15_000 ? 0 : 1);
      const victims = [...this.watch.values()].sort((a, b) => quiet(a) - quiet(b) || a.at - b.at);
      for (const v of victims.slice(0, this.watch.size - max)) this.watch.delete(v.mint);
    }
  }

  drop(mint: string) {
    this.watch.delete(mint);
  }

  /** Feed back what a snapshot showed, so hot tokens get rechecked faster. */
  observe(m: TokenMarket) {
    const w = this.watch.get(m.mint);
    if (!w) return;
    if (w.lastDex === "pumpfun" && m.dexId === "pumpswap" && !w.migratedAt) w.migratedAt = m.observedAt; // graduation seen in data
    w.lastMcap = m.marketCapUsd;
    w.lastDex = m.dexId;
  }

  migratedAt(mint: string): number | undefined {
    return this.watch.get(mint)?.migratedAt;
  }

  stats(now = Date.now()): DiscoveryStats {
    const bySource: Record<string, number> = {};
    let hotCurve = 0;
    let freshGraduates = 0;
    for (const w of this.watch.values()) {
      bySource[w.source] = (bySource[w.source] ?? 0) + 1;
      if (w.lastDex === "pumpfun" && (w.lastMcap ?? 0) >= 30_000) hotCurve++;
      if (w.migratedAt && now - w.migratedAt < 30 * 60_000) freshGraduates++;
    }
    const newSinceLast = this.newCounts;
    this.newCounts = {};
    return { watchlist: this.watch.size, bySource, newSinceLast, hotCurve, freshGraduates };
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

  /**
   * GeckoTerminal (free, verified 2026-11-11): 5-minute trending pools (mostly PumpSwap), the newest
   * PumpSwap pools (fresh graduates) and the busiest Pump.fun curve pools (tokens nearing graduation).
   */
  private async pollGecko(now: number) {
    if (this.opts.gecko === false || now - this.lastGeckoPoll < 60_000) return;
    this.lastGeckoPoll = now;
    const feeds: [string, DiscoveryEvent["source"]][] = [
      ["/networks/solana/trending_pools?page=1&duration=5m", "trending"],
      ["/networks/solana/dexes/pumpswap/pools?page=1&sort=pool_created_at_desc", "new_pool"],
      ["/networks/solana/dexes/pump-fun/pools?page=1&sort=h24_tx_count_desc", "curve_active"],
    ];
    for (const [path, source] of feeds) {
      try {
        await this.limiterGecko.take();
        const res = await fetch(`${GECKO}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { data?: { attributes?: { pool_created_at?: string }; relationships?: { base_token?: { data?: { id?: string } } } }[] };
        for (const p of j.data ?? []) {
          const id = p.relationships?.base_token?.data?.id ?? "";
          if (!id.startsWith("solana_")) continue;
          const mint = id.slice(7);
          if (mint === WSOL_MINT) continue;
          const created = p.attributes?.pool_created_at ? Date.parse(p.attributes.pool_created_at) : now;
          // A brand-new PumpSwap pool is a graduation.
          if (source === "new_pool" && now - created < 2 * 3_600_000) this.add({ mint, source: "migration", at: created });
          else this.add({ mint, source, at: now });
        }
      } catch (e) {
        this.log.warn("geckoterminal discovery failed", { path, error: String(e) });
      }
    }
  }

  /** How often a watched token is re-checked (0 = drop it). */
  private interval(w: WatchEntry, now: number): number {
    const age = now - w.at;
    if (w.migratedAt) {
      const since = now - w.migratedAt;
      if (since < 30 * 60_000) return 10_000; // fresh graduate: fast lane
      if (since < 3 * 3_600_000) return 20_000;
      return 45_000;
    }
    if (w.lastDex === "pumpfun" && (w.lastMcap ?? 0) >= 30_000) return 15_000; // nearing graduation
    if (w.source === "trending") return 30_000;
    if (w.source === "new_token") {
      if (age < 2 * 60_000) return -1; // not yet
      if (w.checks > 0 && age > 30 * 60_000 && (w.lastMcap ?? 0) < 6_000) return 0; // dead launch
      if (age > 2 * 3_600_000 && (w.lastMcap ?? 0) < 15_000) return 0;
      return age < 20 * 60_000 ? 60_000 : 120_000;
    }
    return 60_000;
  }

  private priority(w: WatchEntry, now: number): number {
    if (w.migratedAt && now - w.migratedAt < 30 * 60_000) return 0;
    if (w.lastDex === "pumpfun" && (w.lastMcap ?? 0) >= 30_000) return 1;
    if (w.source === "trending" || w.source === "migration") return 2;
    if (w.source === "new_token") return 4;
    return 3;
  }

  async candidates(now: number): Promise<DiscoveryEvent[]> {
    await this.pollProfiles(now);
    await this.pollGecko(now);
    const due: WatchEntry[] = [];
    for (const w of this.watch.values()) {
      if (now - w.at > 24 * 3_600_000 && !(w.migratedAt && now - w.migratedAt < 24 * 3_600_000)) {
        this.watch.delete(w.mint);
        continue;
      }
      const iv = this.interval(w, now);
      if (iv === 0) {
        this.watch.delete(w.mint);
        continue;
      }
      if (iv < 0 || now - w.lastChecked < iv) continue;
      due.push(w);
    }
    due.sort((a, b) => this.priority(a, now) - this.priority(b, now) || a.lastChecked - b.lastChecked);
    const picked = due.slice(0, 150);
    for (const w of picked) {
      w.lastChecked = now;
      w.checks++;
    }
    return picked.map((w) => ({ mint: w.mint, source: w.source, at: w.at, creator: w.creator, bondingCurve: w.bondingCurve }));
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
