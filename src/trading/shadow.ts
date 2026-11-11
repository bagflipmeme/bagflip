/**
 * Shadow paper books: run several strategy variants side by side on the SAME scanner data, each with
 * its own virtual capital, signals, cooldowns and positions. Fills use the paper fill model on real
 * executable quotes (extra adverse slippage, network fees, token-account rent, random failed
 * transactions), exits use executable sell quotes. Nothing is ever signed or sent, and the BAGFLIP
 * ledger is never touched — this exists only to compare variants honestly.
 *
 * Closed trades and every scan funnel are persisted; open shadow positions live in memory (a restart
 * closes the experiment's open book, which is reported).
 */
import type { Db } from "../db/index.ts";
import type { Clock } from "../shared/time.ts";
import type { Logger } from "../shared/log.ts";
import type { DiscoveryEvent, SafetyChecker, TokenMarket } from "../market/types.ts";
import { ATA_RENT_LAMPORTS, BASE_FEE_LAMPORTS, type ExecutionAdapter } from "../solana/execution/types.ts";
import { decideExit } from "../strategy/strategy.ts";
import { evaluateMarkets, newFunnel, vetEntry, bump, reasonKey, SignalTracker, type Funnel, type VariantConfig } from "./evaluate.ts";

interface ShadowPos {
  mint: string;
  symbol: string;
  tokens: bigint;
  cost: bigint;
  remainingCost: bigint;
  proceeds: bigint;
  peak: bigint;
  last: bigint | null;
  tpDone: boolean;
  openedAt: number;
  exitAttempts: number;
  volM5: number;
  liq: number | null;
  score: number;
  why: string;
}

export interface ShadowStats {
  entries: number;
  closed: number;
  wins: number;
  losses: number;
  realized: bigint;
  entryFailures: number;
  exitFailures: number;
  holdMinutesTotal: number;
}

export interface ShadowOptions {
  startLamports: bigint;
  maxConcurrent: number;
  sizePct: number;
  minPositionLamports: number | bigint;
  priorityFeeLamports: number;
  tradeSlippageBps: number;
  reentryCooldownMs: number;
}

export class ShadowBook {
  readonly vc: VariantConfig;
  readonly tracker = new SignalTracker();
  readonly positions = new Map<string, ShadowPos>();
  readonly startedAt: number;
  cash: bigint;
  stats: ShadowStats = { entries: 0, closed: 0, wins: 0, losses: 0, realized: 0n, entryFailures: 0, exitFailures: 0, holdMinutesTotal: 0 };
  lastFunnel?: Funnel;
  private db: Db;
  private clock: Clock;
  private exec: ExecutionAdapter;
  private safety: SafetyChecker;
  private log: Logger;
  private o: ShadowOptions;
  private n = 0;

  constructor(db: Db, clock: Clock, vc: VariantConfig, exec: ExecutionAdapter, safety: SafetyChecker, log: Logger, o: ShadowOptions) {
    this.db = db;
    this.clock = clock;
    this.vc = vc;
    this.exec = exec;
    this.safety = safety;
    this.log = log;
    this.o = o;
    this.cash = o.startLamports;
    this.startedAt = clock.now().getTime();
  }

  get label() {
    return `shadow:${this.vc.name}`;
  }

  private fixedCosts(): bigint {
    return 2n * (BASE_FEE_LAMPORTS + BigInt(this.o.priorityFeeLamports)) + ATA_RENT_LAMPORTS;
  }

  private sizeFor(): { size: bigint; why: string } {
    if (this.positions.size >= this.o.maxConcurrent) return { size: 0n, why: "max concurrent positions reached" };
    const free = this.cash - this.fixedCosts();
    if (free <= 0n) return { size: 0n, why: "insufficient capital for fees" };
    const invested = [...this.positions.values()].reduce((s, p) => s + p.remainingCost, 0n);
    let size = ((this.cash + invested) * BigInt(Math.round(this.o.sizePct * 100))) / 10_000n;
    if (size > free) size = free;
    if (size < BigInt(this.o.minPositionLamports)) return { size: 0n, why: "position below minimum size" };
    return { size, why: "ok" };
  }

  /** Evaluate one scan's snapshots and open positions for this variant. */
  async onScan(
    markets: TokenMarket[],
    now: number,
    meta: { candidates: number; discovery: Funnel["discovery"]; migratedAt: (mint: string) => number | undefined; disc: Map<string, DiscoveryEvent> },
  ): Promise<Funnel> {
    const f = newFunnel(this.label, new Date(now));
    f.discovery = meta.discovery;
    f.candidates = meta.candidates;
    f.snapshots = markets.length;
    f.noPair = Math.max(0, meta.candidates - markets.length);
    const { ranked } = evaluateMarkets(markets, now, this.vc, this.tracker, new Set(this.positions.keys()), meta.migratedAt, f);
    for (const r of ranked) {
      const { size, why } = this.sizeFor();
      if (size === 0n) {
        bump(f.sizingSkipped, why);
        continue;
      }
      let v;
      try {
        v = await vetEntry(r.m, size, this.vc, { safety: this.safety, quoteBuy: (a, b) => this.exec.quoteBuy(a, b), quoteSell: (a, b) => this.exec.quoteSell(a, b) }, meta.disc.get(r.m.mint), f);
      } catch (e) {
        bump(f.quoteRejected, `API error: ${reasonKey(String(e instanceof Error ? e.message : e)).slice(0, 60)}`);
        this.log.warn("shadow vet failed", { variant: this.vc.name, error: String(e) });
        continue;
      }
      if (!v.ok) {
        this.tracker.cooldown.set(r.m.mint, now + v.cooldownMs);
        continue;
      }
      await this.buy(r.m, size, r.s.score, r.why, now, f);
    }
    this.lastFunnel = f;
    await this.db.query("INSERT INTO scan_funnel(at, variant, data) VALUES ($1,$2,$3::jsonb)", [f.at, f.variant, JSON.stringify(f)]);
    return f;
  }

  private async buy(m: TokenMarket, size: bigint, score: number, why: string, now: number, f: Funnel) {
    try {
      const p = await this.exec.prepare({ clientOrderId: `${this.label}:buy:${m.mint}:${++this.n}`, side: "buy", mint: m.mint, amountIn: size, slippageBps: this.o.tradeSlippageBps });
      const st = await this.exec.settle({ signature: p.signature, side: "buy", mint: m.mint, lastValidBlockHeight: p.lastValidBlockHeight, payload: p.payload });
      if (st.state === "confirmed") {
        this.cash -= st.settlement.sol;
        this.positions.set(m.mint, {
          mint: m.mint,
          symbol: m.symbol,
          tokens: st.settlement.tokens,
          cost: st.settlement.sol,
          remainingCost: st.settlement.sol,
          proceeds: 0n,
          peak: st.settlement.sol,
          last: st.settlement.sol,
          tpDone: false,
          openedAt: now,
          exitAttempts: 0,
          volM5: m.volume.m5,
          liq: m.liquidityUsd,
          score,
          why,
        });
        this.stats.entries++;
        f.executed++;
        return;
      }
      if (st.state === "failed") this.cash -= st.feeLamports;
      this.stats.entryFailures++;
      bump(f.entryFailed, st.state === "failed" ? st.error.replace(/\s*\(paper\)/, "") : st.state);
    } catch (e) {
      this.stats.entryFailures++;
      bump(f.entryFailed, "no route at execution");
      this.log.debug("shadow buy failed", { error: String(e) });
    }
    this.tracker.cooldown.set(m.mint, now + 3_600_000);
  }

  /** Mark and exit open positions with executable sell quotes. */
  async manage(now: number, markets: Map<string, TokenMarket>) {
    for (const p of [...this.positions.values()]) {
      let value: bigint | null = null;
      try {
        const q = await this.exec.quoteSell(p.mint, p.tokens);
        value = q ? q.outAmount : null;
      } catch {
        value = null;
      }
      const dec = decideExit(
        { remainingCost: p.remainingCost, peakValue: p.peak, lastValue: p.last, takeProfitDone: p.tpDone, openedAt: p.openedAt, exitAttempts: p.exitAttempts, entryVolumeM5: p.volM5, entryLiquidityUsd: p.liq },
        value,
        markets.get(p.mint) ?? null,
        now,
        true,
        this.vc.exits,
      );
      if (value !== null) {
        p.last = value;
        if (value > p.peak) p.peak = value;
      }
      if (dec.action === "hold") {
        if (value === null) p.exitAttempts++;
        // A position with no route for the full max hold is written off, as in the real engine.
        if (value === null && p.exitAttempts >= 10 && now - p.openedAt > this.vc.exits.maxHoldHours * 3_600_000) await this.close(p, now, 0n, "written_off");
        continue;
      }
      await this.sell(p, dec.fractionBps, dec.reason, dec.slippageBps, now);
    }
  }

  private async sell(p: ShadowPos, fractionBps: number, reason: string, slippageBps: number, now: number) {
    const amount = fractionBps >= 10_000 ? p.tokens : (p.tokens * BigInt(fractionBps)) / 10_000n;
    try {
      const pr = await this.exec.prepare({ clientOrderId: `${this.label}:sell:${p.mint}:${++this.n}`, side: "sell", mint: p.mint, amountIn: amount, slippageBps });
      const st = await this.exec.settle({ signature: pr.signature, side: "sell", mint: p.mint, lastValidBlockHeight: pr.lastValidBlockHeight, payload: pr.payload });
      if (st.state !== "confirmed") {
        if (st.state === "failed") this.cash -= st.feeLamports;
        this.stats.exitFailures++;
        p.exitAttempts++;
        return;
      }
      const sold = st.settlement.tokens > p.tokens ? p.tokens : st.settlement.tokens;
      const costPortion = sold >= p.tokens ? p.remainingCost : (p.remainingCost * sold) / p.tokens;
      this.cash += st.settlement.sol;
      p.proceeds += st.settlement.sol;
      p.peak = p.tokens > 0n ? (p.peak * (p.tokens - sold)) / p.tokens : 0n;
      p.tokens -= sold;
      p.remainingCost -= costPortion;
      p.exitAttempts = 0;
      if (reason === "take_profit") p.tpDone = true;
      if (p.tokens === 0n) {
        // Token-account rent comes back when the emptied account is closed.
        const rent = (await this.exec.closeTokenAccount?.(p.mint))?.lamports ?? 0n;
        this.cash += rent;
        p.proceeds += rent;
        await this.close(p, now, 0n, reason);
      }
    } catch {
      this.stats.exitFailures++;
      p.exitAttempts++;
    }
  }

  private async close(p: ShadowPos, now: number, extra: bigint, reason: string) {
    this.positions.delete(p.mint);
    const pnl = p.proceeds + extra - p.cost;
    this.stats.closed++;
    this.stats.realized += pnl;
    if (pnl > 0n) this.stats.wins++;
    else this.stats.losses++;
    this.stats.holdMinutesTotal += (now - p.openedAt) / 60_000;
    this.tracker.cooldown.set(p.mint, now + this.o.reentryCooldownMs);
    await this.db.query(
      `INSERT INTO shadow_trades(variant, mint, symbol, opened_at, closed_at, cost_lamports, proceeds_lamports, pnl_lamports, exit_reason, entry_score, entry_why)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [this.vc.name, p.mint, p.symbol, new Date(p.openedAt).toISOString(), new Date(now).toISOString(), p.cost.toString(), (p.proceeds + extra).toString(), pnl.toString(), reason, p.score, p.why],
    );
  }

  summary() {
    const marked = [...this.positions.values()].reduce((s, p) => s + (p.last ?? p.remainingCost), 0n);
    const equity = this.cash + marked;
    const unrealized = [...this.positions.values()].reduce((s, p) => s + ((p.last ?? p.remainingCost) - p.remainingCost), 0n);
    return {
      variant: this.vc.name,
      startedAt: new Date(this.startedAt).toISOString(),
      startLamports: this.o.startLamports.toString(),
      cashLamports: this.cash.toString(),
      equityLamports: equity.toString(),
      netPnlLamports: (equity - this.o.startLamports).toString(),
      returnPct: Math.round((Number(equity - this.o.startLamports) / Number(this.o.startLamports)) * 10_000) / 100,
      realizedLamports: this.stats.realized.toString(),
      unrealizedLamports: unrealized.toString(),
      entries: this.stats.entries,
      closed: this.stats.closed,
      wins: this.stats.wins,
      losses: this.stats.losses,
      winRatePct: this.stats.closed ? Math.round((this.stats.wins / this.stats.closed) * 1000) / 10 : 0,
      entryFailures: this.stats.entryFailures,
      exitFailures: this.stats.exitFailures,
      avgHoldMinutes: this.stats.closed ? Math.round(this.stats.holdMinutesTotal / this.stats.closed) : 0,
      open: [...this.positions.values()].map((p) => ({ symbol: p.symbol, mint: p.mint, cost: p.cost.toString(), marked: (p.last ?? p.remainingCost).toString(), why: p.why })),
    };
  }
}
