import { buildApp, type App } from "../src/app.ts";
import { JobRunner } from "../src/jobs/queue.ts";
import { registerHandlers } from "../src/worker/worker.ts";
import { silentLogger } from "../src/shared/log.ts";
import { nextBoundary } from "../src/shared/time.ts";
import { runDailyDecision } from "../src/governance/cycle.ts";
import { recordDeposit } from "../src/treasury/treasury.ts";
import { allBalances, bal, A, verifyLedgerIntegrity } from "../src/treasury/ledger.ts";
import { parseUnits, NEAR_DECIMALS } from "../src/shared/money.ts";
import type { SimMarket } from "../src/solana/execution/simulated.ts";
import { makeEnv, linkedUser, vote, BAG, type TestEnv } from "./helpers.ts";
import type { Choice } from "../src/governance/engine.ts";

export interface Harness extends TestEnv {
  app: App;
  runner: JobRunner;
  market: SimMarket;
  users: { alice: Awaited<ReturnType<typeof linkedUser>>; bob: Awaited<ReturnType<typeof linkedUser>> };
}

export async function makeHarness(over: Record<string, string> = {}): Promise<Harness> {
  // Vault time-locks default to 0 here; tests/vault.test.ts covers the delays explicitly.
  const env = await makeEnv({ VAULT_MODE_DELAY_HOURS: "0", VAULT_DISTRIBUTION_DELAY_HOURS: "0", ...over });
  const app = await buildApp(env.cfg, { db: env.db, clock: env.clock, log: silentLogger });
  const runner = new JobRunner(env.db, env.clock, silentLogger, "test-worker");
  registerHandlers(app, runner);
  // Two holders with linked wallets; alice is the whale.
  const users = {
    alice: await linkedUser(env, "alice.near", BAG(6000)),
    bob: await linkedUser(env, "bob.near", BAG(3000)),
  };
  await env.chain.setBalance("carol.near", BAG(1000)); // holder who never registered
  return { ...env, app, runner, market: app.simMarket!, users };
}

/** Run jobs and advance time so retry-later steps (bridge polling) progress. */
export async function pump(h: Harness, rounds = 12, stepMs = 20_000) {
  for (let i = 0; i < rounds; i++) {
    await h.runner.drain();
    h.clock.advance(stepMs);
  }
  await h.runner.drain();
}

/** Make `choice` win at the next midnight and run the decision + its jobs. */
export async function setMode(h: Harness, choice: Choice) {
  await vote(h, h.users.alice.user.id, choice);
  await vote(h, h.users.bob.user.id, choice);
  const b = nextBoundary(h.cfg.boundary, h.clock.now());
  h.clock.set(new Date(b.getTime() + 5_000));
  const r = await runDailyDecision(h, b);
  await h.runner.drain();
  return r;
}

export async function deposit(h: Harness, near: string) {
  const id = `sim-dep-${h.clock.now().getTime()}-${Math.random()}`;
  return recordDeposit(
    { db: h.db, clock: h.clock, cfg: h.cfg, chain: h.chain, prices: h.app.prices },
    { txHash: id, receiptId: id, sender: h.cfg.CREATOR_WALLET_ADDRESS, amount: parseUnits(near, NEAR_DECIMALS), source: "sim" },
  );
}

export async function balances(h: Harness) {
  const m = await allBalances(h.db);
  return {
    nearAvailable: bal(m, A.available, "NEAR"),
    pool: bal(m, A.distPool, "NEAR"),
    claimable: bal(m, A.claimable, "NEAR"),
    bridgeOut: bal(m, A.bridgeOut, "NEAR"),
    solAvailable: bal(m, A.tradingAvailable, "SOL"),
    positions: bal(m, A.positions, "SOL"),
    bridgeIn: bal(m, A.bridgeIn, "SOL"),
    pnl: -bal(m, A.pnl, "SOL"),
    distributed: bal(m, A.distributed, "NEAR"),
  };
}

export async function integrity(h: Harness) {
  return verifyLedgerIntegrity(h.db);
}

/** A hot simulated token that the strategy will want to buy. */
export function hotToken(h: Harness, mint: string, over: Record<string, unknown> = {}) {
  return h.market.addToken({
    mint,
    symbol: mint.slice(0, 5).toUpperCase(),
    createdAt: h.clock.now().getTime() - 2 * 3_600_000,
    metrics: {
      pairCreatedAt: h.clock.now().getTime() - 2 * 3_600_000,
      marketCapUsd: 250_000,
      liquidityUsd: 45_000,
      volume: { m5: 10_000, h1: 30_000, h6: 80_000, h24: 120_000 },
      txns: { m5: { buys: 80, sells: 20 }, h1: { buys: 700, sells: 300 } },
      priceChange: { m5: 9, h1: 55, h6: 90, h24: 140 },
      ...over,
    },
  });
}

/** Two forced scans 30s apart (entry needs consecutive confirmation). */
export async function huntTwice(h: Harness) {
  await h.app.hunt.tick({ force: true });
  h.clock.advance(30_000);
  return h.app.hunt.tick({ force: true });
}
