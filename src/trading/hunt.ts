/**
 * HuntEngine: the autonomous AUTO HUNT loop. One tick:
 *   1. settle in-flight orders (always, any mode)
 *   2. mark + manage open positions with executable sell quotes (always) —
 *      in any mode other than AUTO HUNT this is the wind-down
 *   3. scan: discovery → snapshot → score → confirm → safety → size → round-trip quote → open,
 *      with every candidate's fate recorded in a scanner funnel. Shadow comparison books (paper only)
 *      evaluate the same snapshots with their own variant.
 * Only one engine instance acts at a time (DB lease), and every real effect goes
 * through PositionManager's idempotent order flow.
 */
import type { Db } from "../db/index.ts";
import { getState, setState } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { Logger } from "../shared/log.ts";
import { currentDecision, currentMode } from "../governance/cycle.ts";
import type { MarketDataProvider, SafetyChecker, TokenMarket, DiscoveryEvent } from "../market/types.ts";
import type { ExecutionAdapter } from "../solana/execution/types.ts";
import { PositionManager, type PositionRow } from "./positions.ts";
import { canOpenPositions, getHealth, positionSize, type HealthState } from "./risk.ts";
import { decideExit, type StrategyParams, type ExitParams } from "../strategy/strategy.ts";
import { enqueue } from "../jobs/queue.ts";
import { notify } from "../shared/outbox.ts";
import type { VaultMode, VaultPort } from "../near/vault.ts";
import { evaluateMarkets, newFunnel, vetEntry, bump, variantConfig, SignalTracker, type Funnel, type VariantConfig } from "./evaluate.ts";
import type { ShadowBook } from "./shadow.ts";

export interface HuntDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  log: Logger;
  market: MarketDataProvider;
  safety: SafetyChecker;
  exec: ExecutionAdapter;
  instanceId: string;
  /** Vault contract: new entries need AUTO_HUNT active there too (time-lock passed, not vetoed). */
  vault?: VaultPort;
  /** Paper-only comparison books fed with the same snapshots. */
  shadows?: ShadowBook[];
}

export function strategyParams(cfg: Config): StrategyParams {
  return variantConfig(cfg, cfg.STRATEGY_VARIANT).params;
}
export function exitParams(cfg: Config): ExitParams {
  return variantConfig(cfg, cfg.STRATEGY_VARIANT).exits;
}

export interface TickReport {
  settled: number;
  exits: number;
  entries: number;
  scanned: number;
  paused: string[];
  writeOffs: number;
}

type DiscoveryAware = MarketDataProvider & {
  observe?: (m: TokenMarket) => void;
  migratedAt?: (mint: string) => number | undefined;
  stats?: () => { watchlist: number; newSinceLast: Record<string, number>; hotCurve: number; freshGraduates: number };
  promote?: (mint: string) => void;
};

export class HuntEngine {
  readonly pm: PositionManager;
  readonly vc: VariantConfig;
  readonly tracker = new SignalTracker();
  lastFunnel?: Funnel;
  private lastScan = 0;
  private lastPositionCheck = 0;
  private discovery = new Map<string, DiscoveryEvent>();

  private d: HuntDeps;
  constructor(d: HuntDeps) {
    this.d = d;
    this.vc = variantConfig(d.cfg, d.cfg.STRATEGY_VARIANT);
    this.pm = new PositionManager(d.db, d.clock, d.cfg, d.exec, d.log.child({ mod: "positions" }));
  }

  get shadows(): ShadowBook[] {
    return this.d.shadows ?? [];
  }

  private get market(): DiscoveryAware {
    return this.d.market as DiscoveryAware;
  }

  private vaultCache?: { at: number; mode: VaultMode | null; paused: boolean };
  /** Vault effective mode, cached 30s (an RPC view in live mode). */
  private async vaultMode(): Promise<{ mode: VaultMode; paused: boolean } | null> {
    if (!this.d.vault) return null;
    const now = this.d.clock.now().getTime();
    if (!this.vaultCache || now - this.vaultCache.at > 30_000) {
      try {
        const st = await this.d.vault.status();
        this.vaultCache = { at: now, mode: st.effective_mode, paused: st.paused };
      } catch (e) {
        this.d.log.warn("vault status unavailable", { error: String(e) });
        this.vaultCache = { at: now, mode: null, paused: false };
      }
    }
    return this.vaultCache.mode ? { mode: this.vaultCache.mode, paused: this.vaultCache.paused } : { mode: "Inactive", paused: false };
  }

  /** DB lease so two workers never trade at once. */
  async acquireLease(): Promise<boolean> {
    const now = this.d.clock.now();
    const cur = await getState<{ id: string; until: string }>(this.d.db, "hunt_lease");
    if (cur && cur.id !== this.d.instanceId && new Date(cur.until) > now) return false;
    await setState(this.d.db, "hunt_lease", { id: this.d.instanceId, until: new Date(now.getTime() + 60_000).toISOString() });
    const again = await getState<{ id: string }>(this.d.db, "hunt_lease");
    return again?.id === this.d.instanceId;
  }

  private async health(update: (h: HealthState) => void) {
    const h = await getHealth(this.d.db);
    update(h);
    await setState(this.d.db, "trading_health", h);
  }

  async tick(opts: { force?: boolean } = {}): Promise<TickReport> {
    const rep: TickReport = { settled: 0, exits: 0, entries: 0, scanned: 0, paused: [], writeOffs: 0 };
    if (!(await this.acquireLease())) return rep;
    const now = this.d.clock.now().getTime();
    const mode = await currentMode(this.d.db);
    const hunting = mode === "AUTO_HUNT";

    // 1. in-flight orders
    for (const o of await this.pm.pendingOrders()) {
      try {
        if (o.status === "planned") {
          if (o.side === "buy" && (!hunting || now - new Date(o.created_at).getTime() > 2 * 60_000)) continue; // cancelled below
          await this.pm.execute(o.id);
        } else await this.pm.settle(o.id);
        rep.settled++;
      } catch (e) {
        await this.rpcFailure(e, "settle");
      }
    }
    if (!hunting) await this.pm.cancelUnsentBuys(`mode is ${mode}`);

    // 2. positions (real + shadow)
    if (opts.force || now - this.lastPositionCheck >= this.d.cfg.POSITION_CHECK_INTERVAL_SECONDS * 1000) {
      this.lastPositionCheck = now;
      const r = await this.managePositions(hunting, now);
      rep.exits += r.exits;
      rep.writeOffs += r.writeOffs;
    }

    // Wind-down complete → send idle capital home (bridge enforces the economic minimum).
    if (!hunting) {
      const open = await this.pm.openPositions();
      const pending = await this.pm.pendingOrders();
      if (!open.length && !pending.length && mode === "DISTRIBUTE") {
        await enqueue(this.d.db, this.d.clock, { type: "bridge.return", key: `bridge-return:${new Date(now).toISOString().slice(0, 13)}`, payload: {} });
      }
    }

    // 3. scan + entries
    const verdict = await canOpenPositions(this.d.db, this.d.cfg, this.d.clock, this.d.exec.mode, await this.vaultMode());
    await this.recordStatus(verdict.ok ? "active" : "paused", verdict.reasons);
    if (!verdict.ok) rep.paused = verdict.reasons;
    // Shadow books keep scanning while real entries are paused, so the comparison never stalls.
    if ((verdict.ok || this.shadows.length) && (opts.force || now - this.lastScan >= this.d.cfg.SCAN_INTERVAL_SECONDS * 1000)) {
      this.lastScan = now;
      try {
        const s = await this.scan(now, verdict.ok);
        rep.scanned = s.scanned;
        rep.entries = s.entries;
        await this.health((h) => (h.rpcFailures = 0));
      } catch (e) {
        await this.rpcFailure(e, "scan");
      }
    }
    return rep;
  }

  private async rpcFailure(e: unknown, where: string) {
    this.d.log.warn("trading engine error", { where, error: String(e) });
    await this.health((h) => (h.rpcFailures = (h.rpcFailures ?? 0) + 1));
  }

  private async recordStatus(state: "active" | "paused", reasons: string[]) {
    const prev = await getState<{ state: string; reasons: string[] }>(this.d.db, "trading_status");
    await setState(this.d.db, "trading_status", { state, reasons, at: this.d.clock.now().toISOString(), exec: this.d.exec.mode, variant: this.vc.name });
    const pausedBy = reasons.find((r) => /emergency|reconciled|RPC|not enabled/.test(r));
    if (state === "paused" && pausedBy && (prev?.state !== "paused" || !prev.reasons.includes(pausedBy))) {
      await notify(this.d.db, this.d.clock, `pause:${pausedBy}:${this.d.clock.now().toISOString().slice(0, 13)}`, "pause", `⏸️ <b>AUTO HUNT paused</b>: ${pausedBy}. Open positions are still managed; no new entries.`);
    }
  }

  private async managePositions(hunting: boolean, now: number) {
    let exits = 0;
    let writeOffs = 0;
    const open = (await this.pm.openPositions()).filter((p) => p.status === "open");
    const shadowMints = this.shadows.flatMap((s) => [...s.positions.keys()]);
    const mints = [...new Set([...open.map((p) => p.mint), ...shadowMints])];
    if (!mints.length) return { exits, writeOffs };
    let markets = new Map<string, TokenMarket>();
    try {
      markets = new Map((await this.d.market.snapshot(mints)).map((m) => [m.mint, m]));
      // Record held-token observations too, so replays can evaluate exits.
      for (const m of markets.values()) {
        if (!open.some((p) => p.mint === m.mint)) continue;
        await this.d.db.query("INSERT INTO market_observations(mint, observed_at, source, data, decision) VALUES ($1,$2,$3,$4::jsonb,'position')", [m.mint, new Date(now).toISOString(), this.d.market.name, JSON.stringify(m)]);
      }
    } catch (e) {
      this.d.log.warn("market snapshot for positions failed", { error: String(e) });
    }
    for (const s of this.shadows) {
      try {
        await s.manage(now, markets);
      } catch (e) {
        this.d.log.warn("shadow manage failed", { variant: s.vc.name, error: String(e) });
      }
    }
    if (!open.length) return { exits, writeOffs };
    const decision = await currentDecision(this.d.db);
    const windDownDeadline = decision && !hunting ? new Date(decision.executed_at).getTime() + this.d.cfg.WINDDOWN_MAX_HOURS * 3_600_000 : null;
    const ep = this.vc.exits;

    for (const p of open) {
      let value: bigint | null = null;
      try {
        const q = await this.d.exec.quoteSell(p.mint, BigInt(p.token_amount));
        value = q ? q.outAmount : null;
      } catch (e) {
        this.d.log.warn("sell quote failed", { mint: p.mint, error: String(e) });
      }
      await this.pm.mark(p, value);
      if (windDownDeadline && now > windDownDeadline && p.exit_attempts >= 3) {
        await this.pm.writeOff(p, `could not be sold within the ${this.d.cfg.WINDDOWN_MAX_HOURS}h wind-down`);
        writeOffs++;
        continue;
      }
      if (value === null && p.exit_attempts >= 10 && now - new Date(p.opened_at).getTime() > this.d.cfg.MAX_POSITION_HOLD_HOURS * 3_600_000) {
        await this.pm.writeOff(p, "no executable route after max hold (likely rugged)");
        writeOffs++;
        continue;
      }
      const view = {
        remainingCost: BigInt(p.remaining_cost_lamports),
        peakValue: BigInt(p.peak_value_lamports),
        lastValue: p.last_value_lamports ? BigInt(p.last_value_lamports) : null,
        takeProfitDone: p.take_profit_done,
        openedAt: new Date(p.opened_at).getTime(),
        exitAttempts: p.exit_attempts,
        entryVolumeM5: p.entry_signals?.volumeM5 ?? null,
        entryLiquidityUsd: p.entry_signals?.liquidityUsd ?? null,
      };
      const dec = decideExit(view, value, markets.get(p.mint) ?? null, now, hunting, ep);
      if (dec.action === "sell") {
        try {
          if (await this.pm.exit(p, dec.fractionBps, dec.reason, dec.slippageBps)) exits++;
        } catch (e) {
          await this.rpcFailure(e, "exit");
        }
        if (dec.fractionBps >= 10_000) this.tracker.cooldown.set(p.mint, now + this.d.cfg.REENTRY_COOLDOWN_HOURS * 3_600_000);
      } else if (value === null) {
        await this.d.db.query("UPDATE trading_positions SET exit_attempts = exit_attempts + 1 WHERE id=$1", [p.id]);
      }
    }
    return { exits, writeOffs };
  }

  private async scan(now: number, entriesAllowed: boolean): Promise<{ scanned: number; entries: number }> {
    const cands = await this.d.market.candidates(now);
    for (const c of cands) this.discovery.set(c.mint, { ...(this.discovery.get(c.mint) ?? {}), ...c });
    const discStats = this.market.stats?.() ?? null;
    const markets = cands.length ? await this.d.market.snapshot(cands.map((c) => c.mint)) : [];
    for (const m of markets) this.market.observe?.(m);
    const migratedAt = (mint: string) => this.market.migratedAt?.(mint);
    const discovery = discStats ? { watchlist: discStats.watchlist, newSinceLast: discStats.newSinceLast, hotCurve: discStats.hotCurve, freshGraduates: discStats.freshGraduates } : null;

    // Shadow variants judge the very same snapshots.
    for (const s of this.shadows) {
      try {
        await s.onScan(markets, now, { candidates: cands.length, discovery, migratedAt, disc: this.discovery });
      } catch (e) {
        this.d.log.warn("shadow scan failed", { variant: s.vc.name, error: String(e) });
      }
    }
    if (!entriesAllowed) return { scanned: markets.length, entries: 0 };

    const f = newFunnel(this.vc.name, new Date(now));
    f.discovery = discovery;
    f.candidates = cands.length;
    f.snapshots = markets.length;
    f.noPair = Math.max(0, cands.length - markets.length);
    const open = await this.pm.openPositions();
    const { ranked, scoresByMint } = evaluateMarkets(markets, now, this.vc, this.tracker, new Set(open.map((p) => p.mint)), migratedAt, f);

    // Keep interesting tokens on the watchlist; drop ones that can never qualify.
    for (const m of markets) {
      const s = scoresByMint.get(m.mint)!;
      if (s.score >= this.vc.params.entryScore * 0.8 || s.pass) {
        await this.d.db.query(
          "INSERT INTO market_observations(mint, observed_at, source, data, score, decision, reasons) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)",
          [m.mint, new Date(now).toISOString(), this.d.market.name, JSON.stringify(m), s.score, s.pass ? "signal" : "watch", JSON.stringify({ rejects: s.rejects, notes: s.notes, components: s.components })],
        );
        this.market.promote?.(m.mint);
      } else if (s.rejects.some((r) => /too old|no SOL price|venue/.test(r))) {
        this.d.market.drop(m.mint);
      }
    }

    let entries = 0;
    let openCount = open.length;
    for (const { m, s, why } of ranked) {
      const pending = await this.pm.pendingBuyLamports();
      const { size, why: sizeWhy } = await positionSize(this.d.db, this.d.cfg, openCount, pending);
      if (size === 0n) {
        bump(f.sizingSkipped, sizeWhy);
        continue;
      }
      const disc = this.discovery.get(m.mint);
      let v;
      try {
        v = await vetEntry(m, size, this.vc, { safety: this.d.safety, quoteBuy: (a, b) => this.d.exec.quoteBuy(a, b), quoteSell: (a, b) => this.d.exec.quoteSell(a, b) }, disc, f);
      } catch (e) {
        bump(f.quoteRejected, `API error: ${String(e instanceof Error ? e.message : e).slice(0, 60)}`);
        continue;
      }
      if (!v.ok) {
        this.tracker.cooldown.set(m.mint, now + v.cooldownMs);
        this.d.log.info("entry rejected", { mint: m.mint, stage: v.stage, reason: v.reason });
        continue;
      }
      const signals = {
        variant: this.vc.name,
        score: s.score,
        why,
        components: s.components,
        notes: s.notes,
        safety: v.safety,
        roundTripLossPct: v.roundTripLossPct,
        priceImpactPct: v.buyQ.priceImpactPct,
        volumeM5: m.volume.m5,
        liquidityUsd: m.liquidityUsd,
        marketCapUsd: m.marketCapUsd,
        dexId: m.dexId,
        graduateAgeMin: s.graduateAgeMin,
        discovery: disc?.source,
      };
      const pid = await this.pm.open(m, size, s.score, signals);
      if (!pid) continue;
      const st = await this.d.db.query<{ status: string; exit_reason: string | null }>("SELECT status, exit_reason FROM trading_positions WHERE id=$1", [pid]);
      if (st.rows[0]?.status === "failed") {
        // A failed entry puts the token on cooldown so the engine does not burn fees retrying it.
        bump(f.entryFailed, st.rows[0].exit_reason ?? "entry failed");
        this.tracker.cooldown.set(m.mint, now + 3_600_000);
      } else {
        entries++;
        openCount++;
        f.executed++;
      }
    }
    this.lastFunnel = f;
    await this.d.db.query("INSERT INTO scan_funnel(at, variant, data) VALUES ($1,$2,$3::jsonb)", [f.at, f.variant, JSON.stringify(f)]);
    return { scanned: markets.length, entries };
  }
}

export type { PositionRow };
