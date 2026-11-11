/**
 * HuntEngine: the autonomous AUTO HUNT loop. One tick:
 *   1. settle in-flight orders (always, any mode)
 *   2. mark + manage open positions with executable sell quotes (always) —
 *      in any mode other than AUTO HUNT this is the wind-down
 *   3. if new entries are allowed: scan → score → confirm → safety → size →
 *      round-trip quote check → open
 * Only one engine instance acts at a time (DB lease), and every effect goes
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
import { scoreToken, confirmEntry, decideExit, DEFAULT_PARAMS, type StrategyParams, type ExitParams } from "../strategy/strategy.ts";
import { enqueue } from "../jobs/queue.ts";
import { notify } from "../shared/outbox.ts";
import type { VaultMode, VaultPort } from "../near/vault.ts";

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
}

export function strategyParams(cfg: Config): StrategyParams {
  return { ...DEFAULT_PARAMS, entryScore: cfg.ENTRY_SCORE_THRESHOLD };
}
export function exitParams(cfg: Config): ExitParams {
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

export interface TickReport {
  settled: number;
  exits: number;
  entries: number;
  scanned: number;
  paused: string[];
  writeOffs: number;
}

export class HuntEngine {
  readonly pm: PositionManager;
  private lastScan = 0;
  private lastPositionCheck = 0;
  private signals = new Map<string, { score: number; priceNative: number; at: number }>();
  private discovery = new Map<string, DiscoveryEvent>();
  private cooldown = new Map<string, number>();

  private d: HuntDeps;
  constructor(d: HuntDeps) {
    this.d = d;
    this.pm = new PositionManager(d.db, d.clock, d.cfg, d.exec, d.log.child({ mod: "positions" }));
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

    // 2. positions
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

    // 3. entries
    const verdict = await canOpenPositions(this.d.db, this.d.cfg, this.d.clock, this.d.exec.mode, await this.vaultMode());
    await this.recordStatus(verdict.ok ? "active" : "paused", verdict.reasons);
    if (!verdict.ok) {
      rep.paused = verdict.reasons;
      return rep;
    }
    if (opts.force || now - this.lastScan >= this.d.cfg.SCAN_INTERVAL_SECONDS * 1000) {
      this.lastScan = now;
      try {
        const s = await this.scan(now);
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
    await setState(this.d.db, "trading_status", { state, reasons, at: this.d.clock.now().toISOString(), exec: this.d.exec.mode });
    const pausedBy = reasons.find((r) => /emergency|reconciled|RPC|not enabled/.test(r));
    if (state === "paused" && pausedBy && (prev?.state !== "paused" || !prev.reasons.includes(pausedBy))) {
      await notify(this.d.db, this.d.clock, `pause:${pausedBy}:${this.d.clock.now().toISOString().slice(0, 13)}`, "pause", `⏸️ <b>AUTO HUNT paused</b>: ${pausedBy}. Open positions are still managed; no new entries.`);
    }
  }

  private async managePositions(hunting: boolean, now: number) {
    let exits = 0;
    let writeOffs = 0;
    const open = (await this.pm.openPositions()).filter((p) => p.status === "open");
    if (!open.length) return { exits, writeOffs };
    let markets = new Map<string, TokenMarket>();
    try {
      markets = new Map((await this.d.market.snapshot(open.map((p) => p.mint))).map((m) => [m.mint, m]));
      // Record held-token observations too, so replays can evaluate exits.
      for (const m of markets.values()) {
        await this.d.db.query("INSERT INTO market_observations(mint, observed_at, source, data, decision) VALUES ($1,$2,$3,$4::jsonb,'position')", [m.mint, new Date(now).toISOString(), this.d.market.name, JSON.stringify(m)]);
      }
    } catch (e) {
      this.d.log.warn("market snapshot for positions failed", { error: String(e) });
    }
    const decision = await currentDecision(this.d.db);
    const windDownDeadline = decision && !hunting ? new Date(decision.executed_at).getTime() + this.d.cfg.WINDDOWN_MAX_HOURS * 3_600_000 : null;
    const ep = exitParams(this.d.cfg);

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
        if (dec.fractionBps >= 10_000) this.cooldown.set(p.mint, now + this.d.cfg.REENTRY_COOLDOWN_HOURS * 3_600_000);
      } else if (value === null) {
        await this.d.db.query("UPDATE trading_positions SET exit_attempts = exit_attempts + 1 WHERE id=$1", [p.id]);
      }
    }
    return { exits, writeOffs };
  }

  private async scan(now: number): Promise<{ scanned: number; entries: number }> {
    const cands = await this.d.market.candidates(now);
    for (const c of cands) if (!this.discovery.has(c.mint)) this.discovery.set(c.mint, c);
    if (!cands.length) return { scanned: 0, entries: 0 };
    const markets = await this.d.market.snapshot(cands.map((c) => c.mint));
    const open = await this.pm.openPositions();
    const held = new Set(open.map((p) => p.mint));
    const params = strategyParams(this.d.cfg);
    let entries = 0;
    const ranked: { m: TokenMarket; s: ReturnType<typeof scoreToken> }[] = [];

    for (const m of markets) {
      const s = scoreToken(m, now, params);
      if (s.score >= params.entryScore * 0.8 || s.pass) {
        await this.d.db.query(
          "INSERT INTO market_observations(mint, observed_at, source, data, score, decision, reasons) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb)",
          [m.mint, new Date(now).toISOString(), this.d.market.name, JSON.stringify(m), s.score, s.pass ? "signal" : "watch", JSON.stringify({ rejects: s.rejects, notes: s.notes, components: s.components })],
        );
        (this.d.market as { promote?: (m: string) => void }).promote?.(m.mint);
      } else if (s.rejects.some((r) => /too old|no SOL price|venue/.test(r))) {
        this.d.market.drop(m.mint);
      }
      const prev = this.signals.get(m.mint);
      const cur = { score: s.score, priceNative: m.priceNative ?? 0, at: now };
      if (s.pass) {
        const conf = confirmEntry(prev, cur, params.entryScore);
        this.signals.set(m.mint, cur);
        if (conf.confirmed && !held.has(m.mint) && (this.cooldown.get(m.mint) ?? 0) < now) ranked.push({ m, s });
      } else this.signals.delete(m.mint);
    }

    ranked.sort((a, b) => b.s.score - a.s.score);
    for (const { m, s } of ranked.slice(0, 1)) {
      const pending = await this.pm.pendingBuyLamports();
      const { size, why } = await positionSize(this.d.db, this.d.cfg, open.length, pending);
      if (size === 0n) {
        this.d.log.info("entry skipped", { mint: m.mint, why });
        break;
      }
      const disc = this.discovery.get(m.mint);
      const safety = await this.d.safety.check(m, disc?.creator, disc?.bondingCurve);
      if (!safety.ok) {
        this.d.log.info("entry rejected by safety", { mint: m.mint, reasons: safety.reasons });
        this.cooldown.set(m.mint, now + 3_600_000);
        continue;
      }
      // Executable round trip: can we buy at acceptable impact AND sell back right now?
      const buyQ = await this.d.exec.quoteBuy(m.mint, size);
      if (!buyQ) continue;
      if (buyQ.priceImpactPct > this.d.cfg.MAX_PRICE_IMPACT_PERCENT) {
        this.d.log.info("entry rejected: price impact", { mint: m.mint, impact: buyQ.priceImpactPct });
        continue;
      }
      const sellQ = await this.d.exec.quoteSell(m.mint, buyQ.outAmount);
      if (!sellQ) {
        this.d.log.info("entry rejected: no sell route (possible honeypot)", { mint: m.mint });
        this.cooldown.set(m.mint, now + 6 * 3_600_000);
        continue;
      }
      const roundTripLossPct = (1 - Number(sellQ.outAmount) / Number(size)) * 100;
      if (roundTripLossPct > this.d.cfg.MAX_ROUNDTRIP_COST_PERCENT) {
        this.d.log.info("entry rejected: round-trip cost", { mint: m.mint, roundTripLossPct });
        continue;
      }
      const signals = {
        score: s.score,
        components: s.components,
        notes: s.notes,
        safety: safety.facts,
        roundTripLossPct,
        priceImpactPct: buyQ.priceImpactPct,
        volumeM5: m.volume.m5,
        liquidityUsd: m.liquidityUsd,
        marketCapUsd: m.marketCapUsd,
        dexId: m.dexId,
        discovery: disc?.source,
      };
      const pid = await this.pm.open(m, size, s.score, signals);
      if (pid) {
        const st = await this.d.db.query<{ status: string }>("SELECT status FROM trading_positions WHERE id=$1", [pid]);
        // A failed entry puts the token on cooldown so the engine does not burn fees retrying it.
        if (st.rows[0]?.status === "failed") this.cooldown.set(m.mint, now + 3_600_000);
        else entries++;
      }
    }
    return { scanned: markets.length, entries };
  }
}

export type { PositionRow };
