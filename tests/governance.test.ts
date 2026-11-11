import { afterEach, describe, expect, it } from "vitest";
import { decide } from "../src/governance/engine.ts";
import { runDailyDecision, currentMode, scheduleDecisions } from "../src/governance/cycle.ts";
import { JobRunner } from "../src/jobs/queue.ts";
import { silentLogger } from "../src/shared/log.ts";
import { nextBoundary, previousBoundary, cycleIdFor, HOUR } from "../src/shared/time.ts";
import { makeEnv, linkedUser, linkExtraWallet, vote, BAG, type TestEnv } from "./helpers.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.db.close();
  env = undefined as never;
});

/** Advance to the next 00:00 MYT boundary and run the decision. */
async function midnight(e: TestEnv) {
  const b = nextBoundary(e.cfg.boundary, e.clock.now());
  e.clock.set(new Date(b.getTime() + 5_000));
  return runDailyDecision(e, b);
}

describe("boundary math (Asia/Kuala_Lumpur)", () => {
  it("00:00 MYT is 16:00 UTC the previous day", async () => {
    env = await makeEnv();
    const b = nextBoundary(env.cfg.boundary, new Date("2026-11-09T10:00:00Z"));
    expect(b.toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(cycleIdFor(env.cfg.boundary, b)).toBe("2026-11-10");
    expect(previousBoundary(env.cfg.boundary, new Date("2026-11-09T16:00:00Z")).toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(previousBoundary(env.cfg.boundary, new Date("2026-11-09T15:59:59Z")).toISOString()).toBe("2026-11-08T16:00:00.000Z");
  });
});

describe("continuous weighted governance", () => {
  it("scenarios 1-3: 80/20 activates AUTO HUNT, persists with no changes, switches when DISTRIBUTE reaches 55%", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(800));
    const b = await linkedUser(env, "bob.near", BAG(200));
    await vote(env, a.user.id, "AUTO_HUNT");
    await vote(env, b.user.id, "DISTRIBUTE");

    expect(await currentMode(env.db)).toBe("INACTIVE");
    const mon = await midnight(env);
    expect(mon.decision!.effectiveMode).toBe("AUTO_HUNT");
    expect(mon.decision!.weightHunt).toBe(BAG(800));
    expect(mon.decision!.weightDistribute).toBe(BAG(200));

    // Tuesday: nobody touches anything.
    const tue = await midnight(env);
    expect(tue.decision!.effectiveMode).toBe("AUTO_HUNT");
    expect(tue.decision!.changed).toBe(false);

    // Wednesday: 65/35 — still AUTO HUNT.
    await env.chain.setBalance("alice.near", BAG(650));
    await env.chain.setBalance("bob.near", BAG(350));
    expect((await midnight(env)).decision!.effectiveMode).toBe("AUTO_HUNT");

    // Thursday: 45/55 — switch.
    await env.chain.setBalance("alice.near", BAG(450));
    await env.chain.setBalance("bob.near", BAG(550));
    const thu = await midnight(env);
    expect(thu.decision!.effectiveMode).toBe("DISTRIBUTE");
    expect(thu.decision!.changed).toBe(true);

    // Friday: no change → DISTRIBUTE continues.
    expect((await midnight(env)).decision!.effectiveMode).toBe("DISTRIBUTE");
  });

  it("scenario 4: an exact 50/50 tie keeps the previous mode", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(700));
    const b = await linkedUser(env, "bob.near", BAG(300));
    await vote(env, a.user.id, "AUTO_HUNT");
    await vote(env, b.user.id, "DISTRIBUTE");
    await midnight(env);
    await env.chain.setBalance("alice.near", BAG(500));
    await env.chain.setBalance("bob.near", BAG(500));
    const r = await midnight(env);
    expect(r.decision!.effectiveMode).toBe("AUTO_HUNT");
    expect(r.decision!.reason).toMatch(/tie/);
  });

  it("scenario 5: changing a vote replaces the old choice", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(600));
    const b = await linkedUser(env, "bob.near", BAG(400));
    await vote(env, a.user.id, "AUTO_HUNT");
    await vote(env, b.user.id, "DISTRIBUTE");
    expect((await midnight(env)).decision!.effectiveMode).toBe("AUTO_HUNT");
    env.clock.advance(HOUR);
    await vote(env, a.user.id, "DISTRIBUTE");
    const r = await midnight(env);
    expect(r.decision!.weightDistribute).toBe(BAG(1000));
    expect(r.decision!.weightHunt).toBe(0n);
    expect(r.decision!.effectiveMode).toBe("DISTRIBUTE");
    const votes = await env.db.query("SELECT * FROM votes");
    expect(votes.rows).toHaveLength(2);
  });

  it("scenario 6: selling half the holdings halves voting weight at the next snapshot", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(1000));
    await vote(env, a.user.id, "AUTO_HUNT");
    expect((await midnight(env)).decision!.weightHunt).toBe(BAG(1000));
    await env.chain.setBalance("alice.near", BAG(500)); // sold half
    expect((await midnight(env)).decision!.weightHunt).toBe(BAG(500));
  });

  it("scenario 7: tokens moved between wallets are counted once per snapshot; an account can't be linked twice", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(1000));
    await linkExtraWallet(env, a.user, "alice2.near", 0n);
    const b = await linkedUser(env, "bob.near", BAG(1500));
    await vote(env, a.user.id, "AUTO_HUNT");
    await vote(env, b.user.id, "DISTRIBUTE");
    // Alice shuffles the same 1000 tokens into her second wallet during the day.
    await env.chain.setBalance("alice.near", 0n);
    await env.chain.setBalance("alice2.near", BAG(1000));
    const r = await midnight(env);
    // Balances are read at ONE block: the 1000 tokens count exactly once.
    expect(r.decision!.weightHunt).toBe(BAG(1000));
    expect(r.decision!.effectiveMode).toBe("DISTRIBUTE");

    // A second Telegram account proving the same NEAR account takes it over (no double weight).
    const before = await env.db.query("SELECT count(*)::int AS n FROM wallets WHERE account_id='bob.near' AND unlinked_at IS NULL");
    expect(before.rows[0]).toEqual({ n: 1 });
    await linkedUser(env, "bob.near", BAG(1500));
    const after = await env.db.query("SELECT count(*)::int AS n FROM wallets WHERE account_id='bob.near' AND unlinked_at IS NULL");
    expect(after.rows[0]).toEqual({ n: 1 });
  });

  it("zero valid votes and missed quorum never invent or first-activate a mode", async () => {
    env = await makeEnv({ VOTING_INITIAL_QUORUM_PERCENT: "50", VOTING_MIN_QUORUM_PERCENT: "10", VOTING_MIN_DISTINCT_WALLETS: "2" });
    await env.chain.setBalance("whale-nonvoter.near", BAG(10_000));
    expect((await midnight(env)).decision!.effectiveMode).toBe("INACTIVE");
    const a = await linkedUser(env, "alice.near", BAG(100));
    await vote(env, a.user.id, "AUTO_HUNT");
    const r = await midnight(env);
    expect(r.decision!.effectiveMode).toBe("INACTIVE");
    expect(r.decision!.quorumMet).toBe(false);
  });

  it("votes cast after the boundary count toward the next cycle, not the one being decided", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(100));
    await vote(env, a.user.id, "AUTO_HUNT");
    const b = nextBoundary(env.cfg.boundary, env.clock.now());
    env.clock.set(new Date(b.getTime() + 30_000));
    await vote(env, a.user.id, "DISTRIBUTE"); // 30s after midnight
    const r = await runDailyDecision(env, b);
    expect(r.decision!.effectiveMode).toBe("AUTO_HUNT");
  });

  it("scenario 16: a scheduler triggered twice produces exactly one decision", async () => {
    env = await makeEnv();
    const a = await linkedUser(env, "alice.near", BAG(100));
    await vote(env, a.user.id, "AUTO_HUNT");
    const runner = new JobRunner(env.db, env.clock, silentLogger, "w1");
    let runs = 0;
    runner.register("governance.decide", async (job) => {
      runs++;
      return runDailyDecision(env, new Date(job.payload.boundary as string));
    });
    runner.register("governance.apply", async () => null);
    runner.register("notify.decision", async () => null);
    await scheduleDecisions(env);
    await scheduleDecisions(env); // double fire
    const b = nextBoundary(env.cfg.boundary, env.clock.now());
    env.clock.set(new Date(b.getTime() + 1000));
    await scheduleDecisions(env); // fires again after midnight (enqueues the *next* day, and re-enqueue of today is a no-op)
    await runner.drain();
    // Directly invoking the decision again is also a no-op.
    const again = await runDailyDecision(env, b);
    expect(again.created).toBe(false);
    const n = await env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM governance_decisions WHERE cycle_id=$1", [cycleIdFor(env.cfg.boundary, b)]);
    expect(n.rows[0]!.n).toBe(1);
    const applies = await env.db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE type='governance.apply' AND key=$1", [`apply:${cycleIdFor(env.cfg.boundary, b)}`]);
    expect(applies.rows[0]!.n).toBe(1);
  });
});

describe("decide() edge cases", () => {
  const base = { eligibleSupply: 1000n, initialQuorumBps: 0, switchQuorumBps: 0, minDistinctWallets: 1 };
  it("ignores excluded accounts and duplicate accounts", () => {
    const r = decide({
      ...base,
      previousMode: "INACTIVE",
      votes: [
        { accountId: "a", choice: "AUTO_HUNT", balance: 10n, excluded: false },
        { accountId: "a", choice: "AUTO_HUNT", balance: 10n, excluded: false },
        { accountId: "pool", choice: "DISTRIBUTE", balance: 900n, excluded: true },
      ],
    });
    expect(r.weightHunt).toBe(10n);
    expect(r.weightDistribute).toBe(0n);
    expect(r.effectiveMode).toBe("AUTO_HUNT");
  });
  it("a first activation needs a strict majority (tie stays INACTIVE)", () => {
    const r = decide({
      ...base,
      previousMode: "INACTIVE",
      votes: [
        { accountId: "a", choice: "AUTO_HUNT", balance: 10n, excluded: false },
        { accountId: "b", choice: "DISTRIBUTE", balance: 10n, excluded: false },
      ],
    });
    expect(r.effectiveMode).toBe("INACTIVE");
  });
  it("existing mode is preserved when switching quorum is missed", () => {
    const r = decide({
      ...base,
      switchQuorumBps: 5000,
      previousMode: "AUTO_HUNT",
      votes: [{ accountId: "b", choice: "DISTRIBUTE", balance: 100n, excluded: false }],
    });
    expect(r.effectiveMode).toBe("AUTO_HUNT");
    expect(r.quorumMet).toBe(false);
  });
});
