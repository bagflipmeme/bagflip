/**
 * Worker: durable job handlers + periodic loops (scheduler, deposit scanner,
 * live tally, reconciliation, hunt engine). Safe to restart at any time:
 * state lives in Postgres and every handler is idempotent.
 */
import type { App } from "../app.ts";
import { JobRunner, enqueue, upsertRecurring, type Job } from "../jobs/queue.ts";
import { runDailyDecision, scheduleDecisions, computeLiveTally, currentDecision } from "../governance/cycle.ts";
import { routeTreasury, scanDeposits } from "../treasury/treasury.ts";
import { fundTrading, pollTransfer, recoverBridge, returnToTreasury } from "../bridge/bridge.ts";
import { runDistribution } from "../distribution/distribution.ts";
import { payClaim } from "../distribution/claims.ts";
import { proposeDistribution, syncMode, syncSeats, watchVault } from "../distribution/vault-sync.ts";
import { reconcile } from "../trading/reconcile.ts";
import { notify } from "../shared/outbox.ts";
import { decisionAnnouncement } from "../bot/views.ts";
import type { Mode } from "../governance/engine.ts";

export function registerHandlers(app: App, runner: JobRunner) {
  const gov = { db: app.db, chain: app.chain, clock: app.clock, cfg: app.cfg };
  const treas = { db: app.db, clock: app.clock, cfg: app.cfg, chain: app.chain, prices: app.prices };

  runner.register("governance.decide", async (job: Job) => {
    const r = await runDailyDecision(gov, new Date(job.payload.boundary as string));
    await scheduleDecisions(gov); // arm the next day
    return { cycleId: r.cycleId, created: r.created, mode: r.mode };
  });

  runner.register("governance.apply", async (job: Job) => {
    const mode = job.payload.mode as Mode;
    const changed = job.payload.changed as boolean;
    if (mode === "DISTRIBUTE") {
      if (changed) await app.hunt.pm.cancelUnsentBuys("DISTRIBUTE won");
      // Positions are unwound by the hunt engine's wind-down; idle funds route to the pool.
      await routeTreasury(treas, `apply:${job.payload.cycleId}`);
      await enqueue(app.db, app.clock, { type: "distribution.run", key: `dist-run:cycle:${job.payload.cycleId}`, payload: {} });
    } else if (mode === "AUTO_HUNT") {
      await routeTreasury(treas, `apply:${job.payload.cycleId}`);
    }
    // Mirror the decision into the vault (AUTO_HUNT activation is time-locked there).
    await enqueue(app.db, app.clock, { type: "vault.sync_mode", key: `vault-mode:${job.payload.cycleId}`, payload: { cycleId: job.payload.cycleId }, maxAttempts: 500 });
    return { mode, changed };
  });

  const vdeps = { db: app.db, clock: app.clock, cfg: app.cfg, log: app.log.child({ mod: "vault" }), vault: app.vault, chain: app.chain };
  runner.register("vault.sync_mode", async (job: Job) => syncMode(vdeps, job.payload.cycleId as string));
  runner.register("vault.propose_distribution", async (job: Job) => proposeDistribution(vdeps, String(job.payload.eventId)));

  runner.register("notify.decision", async (job: Job) => {
    const d = await app.db.query("SELECT * FROM governance_decisions WHERE cycle_id=$1", [job.payload.cycleId]);
    const row = d.rows[0] as Parameters<typeof decisionAnnouncement>[0] | undefined;
    if (!row) return null;
    await notify(app.db, app.clock, `decision:${row.cycle_id}`, row.changed ? "mode_change" : "decision", decisionAnnouncement(row, app.cfg));
    return null;
  });

  runner.register("treasury.route", async (job: Job) => routeTreasury(treas, String(job.payload.trigger ?? job.key)));
  runner.register("bridge.fund_trading", async () => fundTrading(app.bridge));
  runner.register("bridge.return", async () => returnToTreasury(app.bridge));
  runner.register("bridge.poll", async (job: Job) => pollTransfer(app.bridge, job.payload.id as string));
  runner.register("distribution.run", async () => runDistribution({ db: app.db, clock: app.clock, cfg: app.cfg, chain: app.chain, prices: app.prices, holders: app.holders }));
  runner.register("claim.pay", async (job: Job) =>
    payClaim(
      {
        db: app.db,
        clock: app.clock,
        cfg: app.cfg,
        prices: app.prices,
        log: app.log.child({ mod: "claims" }),
        vault: app.vault,
      },
      job.payload.claimId as string,
    ),
  );

  // Recurring maintenance jobs (re-armed after each run).
  const every = (type: string, seconds: number, fn: () => Promise<unknown>) => {
    runner.register(type, async () => {
      try {
        return await fn();
      } finally {
        await upsertRecurring(app.db, app.clock, { type, key: `recurring:${type}`, runAt: new Date(app.clock.now().getTime() + seconds * 1000) });
      }
    });
  };
  every("treasury.scan_deposits", 60, async () => (app.chain.simulated ? { skipped: "simulated chain" } : scanDeposits(treas)));
  every("governance.tally", 300, async () => computeLiveTally(gov));
  every("trading.reconcile", app.cfg.RECONCILE_INTERVAL_SECONDS, async () => reconcile(app.db, app.cfg, app.clock, app.exec, app.chain));
  every("vault.watch", 60, async () => watchVault(vdeps));
  every("vault.sync_seats", 6 * 3600, async () => syncSeats(vdeps, app.holders));
  every("treasury.route_periodic", 3600, async () => routeTreasury(treas, `periodic:${app.clock.now().toISOString().slice(0, 13)}`));
}

export async function startWorker(app: App) {
  const runner = new JobRunner(app.db, app.clock, app.log.child({ mod: "jobs" }), app.instanceId, 5 * 60_000, async (job, err) => {
    await notify(app.db, app.clock, `job-dead:${job.key}`, "failure", `⚠️ Background job <code>${job.type}</code> failed permanently: ${err.slice(0, 200)}`, "admins");
  });
  registerHandlers(app, runner);

  // Boot recovery: governance schedule, in-flight bridge transfers, recurring jobs.
  await scheduleDecisions({ db: app.db, chain: app.chain, clock: app.clock, cfg: app.cfg });
  const recovered = await recoverBridge(app.bridge);
  for (const t of ["treasury.scan_deposits", "governance.tally", "trading.reconcile", "treasury.route_periodic", "vault.watch", "vault.sync_seats"]) {
    await upsertRecurring(app.db, app.clock, { type: t, key: `recurring:${t}` });
    // A recurring job left 'running' by a crash is picked up again once its lease expires.
  }
  const dec = await currentDecision(app.db);
  const open = await app.hunt.pm.openPositions();
  app.log.info("worker started", { mode: dec?.effective_mode ?? "INACTIVE", openPositions: open.length, recoveredBridgeTransfers: recovered, exec: app.exec.mode });

  if (app.market && "startDiscoveryStream" in app.market) (app.market as { startDiscoveryStream(): void }).startDiscoveryStream();

  // Development: a few clearly-simulated tokens on a random walk so the full loop can be exercised.
  if (app.simMarket) {
    const sm = app.simMarket;
    const t0 = app.clock.now().getTime();
    for (const [i, sym] of ["SIMDOG", "SIMCAT", "SIMOWL"].entries()) {
      sm.addToken({ mint: `SIM${sym}${"1".repeat(30)}`, symbol: sym, createdAt: t0 - (2 + i) * 3_600_000, metrics: { marketCapUsd: 150_000 + i * 50_000, liquidityUsd: 40_000, pairCreatedAt: t0 - (2 + i) * 3_600_000 } });
    }
    setInterval(() => {
      for (const t of sm.tokens.values()) sm.movePrice(t.mint, 0.94 + Math.random() * 0.13);
    }, 15_000).unref();
  }

  void runner.loop(1000);
  let stopped = false;
  const huntLoop = async () => {
    while (!stopped) {
      try {
        await app.hunt.tick();
      } catch (e) {
        app.log.error("hunt tick failed", { error: e });
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  };
  void huntLoop();
  return {
    runner,
    stop() {
      stopped = true;
      runner.stop();
    },
  };
}
