import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, pump, setMode, deposit, balances, integrity, hotToken, huntTwice, type Harness } from "./harness.ts";
import { parseUnits, NEAR_DECIMALS } from "../src/shared/money.ts";
import { A, postJournal, LedgerError } from "../src/treasury/ledger.ts";
import { tradableNear } from "../src/treasury/treasury.ts";
import { requestClaim, payClaim, claimableByAccount } from "../src/distribution/claims.ts";
import { HuntEngine } from "../src/trading/hunt.ts";
import { SimulatedExecution } from "../src/solana/execution/simulated.ts";
import { silentLogger } from "../src/shared/log.ts";
import type { SimBridge } from "../src/bridge/oneclick.ts";

let h: Harness;
afterEach(async () => {
  await h?.db.close();
  h = undefined as never;
});

const NEAR = (n: string) => parseUnits(n, NEAR_DECIMALS);

describe("treasury + AUTO HUNT", () => {
  it("scenario 8: rewards arriving during AUTO HUNT are bridged to the trading wallet (after real settlement only)", async () => {
    h = await makeHarness();
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "10");
    await h.runner.drain();
    // Reserved and in flight, NOT yet credited on Solana.
    let b = await balances(h);
    expect(b.bridgeOut).toBe(NEAR("9.5"));
    expect(b.solAvailable).toBe(0n);
    await pump(h);
    b = await balances(h);
    expect(b.bridgeOut).toBe(0n);
    // fee reserve stays on NEAR, minus the vault's wrap.near storage deposit for the 1Click address
    expect(b.nearAvailable).toBe(h.cfg.nearFeeReserve - 1_250_000_000_000_000_000_000n);
    expect(b.solAvailable > 0n).toBe(true);
    const t = await h.db.query<{ status: string }>("SELECT status FROM bridge_transfers");
    expect(t.rows.map((r) => r.status)).toEqual(["success"]);
    expect((await integrity(h)).ok).toBe(true);
  });

  it("scenarios 9+10: AUTO HUNT can lose all trading capital; new rewards fund it again", async () => {
    h = await makeHarness({ POSITION_SIZE_PERCENT: "100", MAX_CONCURRENT_POSITIONS: "1" });
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "10");
    await pump(h);
    const funded = (await balances(h)).solAvailable;
    hotToken(h, "RUGtoken111");
    await huntTwice(h);
    let pos = await h.db.query<{ status: string; cost_lamports: string }>("SELECT status, cost_lamports FROM trading_positions");
    expect(pos.rows).toHaveLength(1);
    expect(pos.rows[0]!.status).toBe("open");

    h.market.rug("RUGtoken111");
    h.clock.advance(20_000);
    await h.app.hunt.tick({ force: true });
    pos = await h.db.query("SELECT status, exit_reason, realized_pnl_lamports FROM trading_positions");
    expect(pos.rows[0]).toMatchObject({ status: "closed", exit_reason: "crash" });
    const b = await balances(h);
    expect(b.positions).toBe(0n);
    expect(b.pnl < 0n).toBe(true);
    expect(-b.pnl > (funded * 95n) / 100n).toBe(true); // ~everything lost
    expect(b.solAvailable >= 0n).toBe(true);

    // Nothing left to trade: no new entries even with a hot token around.
    hotToken(h, "HOTtoken222");
    const r = await huntTwice(h);
    expect(r.entries).toBe(0);
    expect((await h.db.query("SELECT 1 FROM trading_positions WHERE mint='HOTtoken222'")).rows).toHaveLength(0);

    // Scenario 10: new rewards arrive → trading capital restored → hunting resumes.
    await deposit(h, "10");
    await pump(h);
    expect((await balances(h)).solAvailable > funded / 2n).toBe(true);
    h.clock.advance(30_000);
    await huntTwice(h);
    expect((await h.db.query("SELECT status FROM trading_positions WHERE mint='HOTtoken222'")).rows[0]).toMatchObject({ status: "open" });
    expect((await integrity(h)).ok).toBe(true);
  });

  it("scenario 11: DISTRIBUTE wins while positions are open → no new buys, unwind, return, distribute", async () => {
    h = await makeHarness();
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    hotToken(h, "OPENtoken11");
    await huntTwice(h);
    expect((await h.db.query("SELECT status FROM trading_positions")).rows[0]).toMatchObject({ status: "open" });

    const r = await setMode(h, "DISTRIBUTE");
    expect(r.decision!.changed).toBe(true);
    hotToken(h, "NEWtoken222");
    await huntTwice(h);
    // Wind-down sold the open position; no new entries.
    const pos = await h.db.query<{ mint: string; status: string; exit_reason: string }>("SELECT mint, status, exit_reason FROM trading_positions ORDER BY id");
    expect(pos.rows).toEqual([{ mint: "OPENtoken11", status: "closed", exit_reason: "wind_down" }]);
    const ts = await h.db.query<{ value: { state: string; reasons: string[] } }>("SELECT value FROM system_state WHERE key='trading_status'");
    expect(ts.rows[0]!.value.reasons).toContain("governance mode is not AUTO HUNT");

    // Idle SOL returns to NEAR, gets reserved, and is distributed pro-rata.
    await pump(h, 20);
    const b = await balances(h);
    expect(b.solAvailable < h.cfg.solFeeReserve + 1n).toBe(true);
    expect(b.claimable > 0n).toBe(true);
    const ent = await h.db.query<{ account_id: string; amount: string; balance: string }>("SELECT account_id, amount, balance FROM distribution_entitlements ORDER BY account_id");
    expect(ent.rows.map((e) => e.account_id)).toEqual(["alice.near", "bob.near", "carol.near"]); // unregistered carol included
    const [alice, bob, carol] = ent.rows.map((e) => BigInt(e.amount));
    expect(alice! / carol!).toBe(6n);
    expect(bob! / carol!).toBe(3n);
    expect((await integrity(h)).ok).toBe(true);
  });

  it("scenario 12: funds too small for fees → no trade is attempted", async () => {
    h = await makeHarness({ MIN_CROSS_CHAIN_TRANSFER_USD: "0", MIN_POSITION_SOL: "0.05" });
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "0.6"); // ~0.1 NEAR tradable → ~0.004 SOL
    await pump(h);
    const b = await balances(h);
    expect(b.solAvailable > 0n && b.solAvailable < parseUnits("0.05", 9)).toBe(true);
    hotToken(h, "HOTtoken333");
    const r = await huntTwice(h);
    expect(r.entries).toBe(0);
    expect((await h.db.query("SELECT 1 FROM trading_orders")).rows).toHaveLength(0);
  });

  it("scenario 13: refunded or failed cross-chain transfers never credit Solana", async () => {
    h = await makeHarness();
    await setMode(h, "AUTO_HUNT");
    const sim = h.app.bridge.provider as SimBridge;
    sim.nextOutcome = "refund";
    await deposit(h, "10");
    await pump(h);
    let b = await balances(h);
    expect(b.solAvailable).toBe(0n);
    expect(b.bridgeOut).toBe(0n);
    // 1Click refunded everything; only the vault's wrap.near storage deposit for the 1Click address is spent.
    const STORAGE = 1_250_000_000_000_000_000_000n;
    expect(b.nearAvailable).toBe(NEAR("10") - STORAGE);
    expect((await h.db.query("SELECT status FROM bridge_transfers")).rows[0]).toMatchObject({ status: "refunded" });
    expect((await h.db.query("SELECT 1 FROM notifications WHERE kind='failure'")).rows.length).toBeGreaterThan(0);

    sim.nextOutcome = "fail";
    h.clock.advance(120_000);
    await h.app.db.query("UPDATE jobs SET status='done' WHERE type='bridge.fund_trading'");
    const { fundTrading } = await import("../src/bridge/bridge.ts");
    await fundTrading(h.app.bridge);
    await pump(h);
    b = await balances(h);
    expect(b.solAvailable).toBe(0n);
    expect(b.bridgeOut).toBe(NEAR("9.5") - STORAGE); // stays in transit until an operator resolves it
    expect((await h.db.query("SELECT status FROM bridge_transfers ORDER BY id")).rows.map((r) => (r as { status: string }).status)).toEqual(["refunded", "failed"]);

    // Quote errors (expired quote / API down) leave nothing reserved; the job retries later.
    sim.quoteError = new Error("1Click /v0/quote HTTP 503");
    await deposit(h, "10");
    await h.runner.drain();
    b = await balances(h);
    expect(b.nearAvailable).toBe(NEAR("10.5") - STORAGE);
    expect(b.bridgeOut).toBe(NEAR("9.5") - STORAGE);
    const j = await h.db.query<{ status: string; last_error: string }>("SELECT status, last_error FROM jobs WHERE type='bridge.fund_trading' ORDER BY id DESC LIMIT 1");
    expect(j.rows[0]).toMatchObject({ status: "queued" });
    expect(j.rows[0]!.last_error).toMatch(/503/);
    expect((await integrity(h)).ok).toBe(true);
  });

  it("scenario 17: money reserved for distribution can never be traded", async () => {
    h = await makeHarness();
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "4"); // below $20: reserved into the pool and accumulating
    await h.runner.drain();
    let b = await balances(h);
    expect(b.pool).toBe(NEAR("3.5"));
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "10");
    await pump(h);
    b = await balances(h);
    expect(b.pool).toBe(NEAR("3.5")); // untouched
    expect(tradableNear(h.cfg, b.nearAvailable)).toBe(0n);
    // Direct attempt to move pool money to trading is rejected by the ledger.
    await expect(
      h.db.tx((tx) =>
        postJournal(tx, h.clock, {
          key: "steal",
          kind: "x",
          entries: [
            { account: A.available, asset: "NEAR", amount: -NEAR("1") },
            { account: A.bridgeOut, asset: "NEAR", amount: NEAR("1") },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it("scenario 18: a failed or expired submission never books a trade", async () => {
    h = await makeHarness();
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    const before = await balances(h);
    hotToken(h, "FAILtoken11");

    h.market.failNext = "chain";
    await huntTwice(h);
    let pos = await h.db.query<{ status: string; token_amount: string }>("SELECT status, token_amount FROM trading_positions");
    expect(pos.rows[0]).toMatchObject({ status: "failed", token_amount: "0" });
    let b = await balances(h);
    expect(b.positions).toBe(0n);
    expect(b.pnl).toBe(0n);
    expect(before.solAvailable - b.solAvailable).toBe(105_000n); // only the network fee

    // The failed token is on cooldown, so the engine moves on instead of burning fees again.
    hotToken(h, "EXPtoken111");
    h.market.failNext = "expire";
    h.clock.advance(60_000);
    await huntTwice(h);
    pos = await h.db.query("SELECT status FROM trading_positions WHERE mint='EXPtoken111'");
    expect(pos.rows[0]).toMatchObject({ status: "failed" });
    b = await balances(h);
    expect(before.solAvailable - b.solAvailable).toBe(105_000n); // expired → no ledger effect
    const orders = await h.db.query<{ status: string }>("SELECT status FROM trading_orders ORDER BY id");
    expect(orders.rows.map((o) => o.status)).toEqual(["failed", "expired"]);
    expect((await integrity(h)).ok).toBe(true);
  });

  it("scenario 15: a worker restart while a trade is open recovers and manages it", async () => {
    h = await makeHarness();
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    hotToken(h, "OPENtoken99");
    await huntTwice(h);

    // "Crash": a brand-new engine instance with a fresh adapter over the same DB + market.
    const exec2 = new SimulatedExecution(h.market, async () => (await balances(h)).solAvailable);
    const engine2 = new HuntEngine({ db: h.db, clock: h.clock, cfg: h.cfg, log: silentLogger, market: h.app.market, safety: h.app.safety, exec: exec2, instanceId: "after-restart" });
    // The old lease blocks the new instance until it expires.
    expect((await engine2.tick({ force: true })).scanned).toBe(0);
    h.clock.advance(61_000);
    h.market.movePrice("OPENtoken99", 2.2); // +120% → take profit
    await engine2.tick({ force: true });
    const pos = await h.db.query<{ status: string; take_profit_done: boolean }>("SELECT status, take_profit_done FROM trading_positions");
    expect(pos.rows[0]).toMatchObject({ status: "open", take_profit_done: true });
    const sells = await h.db.query("SELECT 1 FROM trading_orders WHERE side='sell' AND status='confirmed'");
    expect(sells.rows).toHaveLength(1);
    expect((await integrity(h)).ok).toBe(true);
  });

  it("scenario 15b: an order persisted before a crash is settled exactly once after restart", async () => {
    h = await makeHarness();
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    hotToken(h, "CRASHtoken1");
    // First engine: its broadcast succeeds but settle "crashes" (pending forever).
    const exec = h.app.exec as SimulatedExecution;
    const realSettle = exec.settle.bind(exec);
    exec.settle = async () => ({ state: "pending" });
    await huntTwice(h);
    let o = await h.db.query<{ status: string; signature: string }>("SELECT status, signature FROM trading_orders");
    expect(o.rows[0]!.status).toBe("submitting");
    expect(o.rows[0]!.signature).toBeTruthy();
    expect((await balances(h)).positions).toBe(0n);
    // Restart: settlement recovered from the persisted signature.
    exec.settle = realSettle;
    h.clock.advance(5_000);
    await h.app.hunt.tick();
    await h.app.hunt.tick();
    o = await h.db.query("SELECT status FROM trading_orders");
    expect(o.rows).toEqual([{ status: "confirmed" }]);
    const j = await h.db.query("SELECT count(*)::int AS n FROM ledger_journals WHERE kind='trade_buy'");
    expect(j.rows[0]).toEqual({ n: 1 });
  });
});

describe("distribution + claims", () => {
  it("scenario 14: retrying a completed claim pays nothing twice", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "5" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "10.5"); // 10 NEAR into the pool
    await pump(h);
    const ev = await h.db.query<{ allocated_amount: string; holder_count: number }>("SELECT allocated_amount, holder_count FROM distribution_events");
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.holder_count).toBe(3);
    // $100-style example: 6000/3000/1000 → 60% / 30% / 10%
    const c = await claimableByAccount(h.db, ["alice.near", "bob.near", "carol.near"]);
    expect(c.get("alice.near")).toBe(NEAR("6"));
    expect(c.get("bob.near")).toBe(NEAR("3"));
    expect(c.get("carol.near")).toBe(NEAR("1"));

    const deps = { db: h.db, clock: h.clock, cfg: h.cfg, prices: h.app.prices, log: silentLogger, vault: h.app.vault };
    const r1 = await requestClaim(deps, h.users.alice.user.id);
    expect(r1.status).toBe("queued");
    await h.runner.drain();
    const claim = await h.db.query<{ id: string; status: string; amount: string }>("SELECT id, status, amount FROM reward_claims");
    expect(claim.rows[0]).toMatchObject({ status: "paid", amount: NEAR("6").toString() });

    // Retry: nothing to claim, and re-running the payout job is a no-op.
    const r2 = await requestClaim(deps, h.users.alice.user.id);
    expect(r2.status).toBe("nothing");
    expect(await payClaim(deps, claim.rows[0]!.id)).toBe("paid");
    const b = await balances(h);
    expect(b.distributed).toBe(NEAR("6"));
    expect(b.claimable).toBe(NEAR("4")); // bob + carol stay reserved
    const paid = await h.db.query("SELECT count(*)::int AS n FROM ledger_journals WHERE kind='claim_payout'");
    expect(paid.rows[0]).toEqual({ n: 1 });
    expect((await integrity(h)).ok).toBe(true);
  });

  it("small pools accumulate until the distribution minimum is reached", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "20" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "3"); // 2.5 NEAR ≈ $8.75
    await pump(h);
    expect((await h.db.query("SELECT 1 FROM distribution_events")).rows).toHaveLength(0);
    await deposit(h, "4"); // +4 NEAR → 6.5 NEAR ≈ $22.75
    await pump(h);
    expect((await h.db.query("SELECT 1 FROM distribution_events")).rows).toHaveLength(1);
    expect((await balances(h)).pool < NEAR("0.000001")).toBe(true); // only rounding dust remains
  });

  it("switching DISTRIBUTE → AUTO HUNT keeps reserved and claimable rewards out of trading", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "5" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "10.5");
    await pump(h);
    const claimable = (await balances(h)).claimable;
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "10");
    await pump(h);
    const b = await balances(h);
    expect(b.claimable).toBe(claimable);
    expect(b.bridgeOut).toBe(0n);
    expect(b.solAvailable > 0n).toBe(true);
  });
});
