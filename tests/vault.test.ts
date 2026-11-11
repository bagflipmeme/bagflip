import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { makeHarness, pump, setMode, deposit, balances, integrity, hotToken, huntTwice, type Harness } from "./harness.ts";
import { parseUnits, NEAR_DECIMALS } from "../src/shared/money.ts";
import { fundTrading } from "../src/bridge/bridge.ts";
import { requestClaim, payClaim } from "../src/distribution/claims.ts";
import { proofsFor, snapshotHash, watchVault, syncSeats } from "../src/distribution/vault-sync.ts";
import { BAG } from "./helpers.ts";
import { buildPayoutTree, leafHash, verifyProof } from "../src/distribution/merkle.ts";
import type { SimVault } from "../src/near/vault.ts";
import { silentLogger } from "../src/shared/log.ts";

let h: Harness;
afterEach(async () => {
  await h?.db.close();
  h = undefined as never;
});

const NEAR = (n: string) => parseUnits(n, NEAR_DECIMALS);
const HOUR = 3_600_000;
const vaultOf = (x: Harness) => x.app.vault as SimVault;
const claimDeps = (x: Harness) => ({ db: x.db, clock: x.clock, cfg: x.cfg, prices: x.app.prices, log: silentLogger, vault: x.app.vault });
const vdeps = (x: Harness) => ({ db: x.db, clock: x.clock, cfg: x.cfg, log: silentLogger, vault: x.app.vault, chain: x.chain });

describe("Merkle payout lists (shared with the Rust contract)", () => {
  it("matches the vectors the contract tests verify", () => {
    const cases = JSON.parse(readFileSync("contracts/vault/test-vectors/merkle.json", "utf8")) as {
      epoch: number;
      root: string;
      data_hash: string;
      leaves: { account_id: string; amount: string; leaf: string; proof: string[] }[];
    }[];
    for (const c of cases) {
      const t = buildPayoutTree(BigInt(c.epoch), c.leaves.map((l) => ({ accountId: l.account_id, amount: BigInt(l.amount) })));
      expect(t.root).toBe(c.root);
      expect(t.dataHash).toBe(c.data_hash);
      for (const l of c.leaves) {
        expect(leafHash(BigInt(c.epoch), l.account_id, BigInt(l.amount)).toString("hex")).toBe(l.leaf);
        expect(t.proofs.get(l.account_id)).toEqual(l.proof);
        expect(verifyProof(c.root, BigInt(c.epoch), l.account_id, BigInt(l.amount), l.proof)).toBe(true);
        expect(verifyProof(c.root, BigInt(c.epoch), "mallory.near", BigInt(l.amount), l.proof)).toBe(false);
      }
    }
  });
});

describe("vault-governed treasury", () => {
  it("AUTO HUNT is time-locked in the vault: no funding or entries until the delay passes", async () => {
    h = await makeHarness({ VAULT_MODE_DELAY_HOURS: "12" });
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    let b = await balances(h);
    expect(b.bridgeOut).toBe(0n);
    expect(b.solAvailable).toBe(0n);
    expect(await fundTrading(h.app.bridge)).toMatchObject({ started: false, reason: "vault_auto_hunt_timelocked" });
    const sync = await h.db.query<{ mode: string; snapshot_hash: string; status: string }>("SELECT mode, snapshot_hash, status FROM vault_mode_syncs ORDER BY cycle_id DESC LIMIT 1");
    expect(sync.rows[0]).toMatchObject({ mode: "AutoHunt", status: "done" });
    const r = await h.app.hunt.tick({ force: true });
    expect(r.paused).toContain("vault has not activated AUTO HUNT yet (time-lock or council veto)");

    h.clock.advance(13 * HOUR);
    expect(await fundTrading(h.app.bridge)).toMatchObject({ started: true });
    await pump(h);
    b = await balances(h);
    expect(b.solAvailable > 0n).toBe(true);
  });

  it("a council veto of the AUTO HUNT activation keeps the treasury out of trading", async () => {
    h = await makeHarness({ VAULT_MODE_DELAY_HOURS: "12" });
    await setMode(h, "AUTO_HUNT");
    vaultOf(h).vetoMode();
    h.clock.advance(13 * HOUR);
    await deposit(h, "20");
    await pump(h);
    expect((await balances(h)).solAvailable).toBe(0n);
    expect(await fundTrading(h.app.bridge)).toMatchObject({ started: false, reason: "vault_mode_not_auto_hunt" });
  });

  it("the vault's rolling 24h cap bounds how much can reach the trading wallet", async () => {
    h = await makeHarness({ VAULT_DAILY_HUNT_CAP_NEAR: "8" });
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "30");
    await pump(h);
    const t = await h.db.query<{ amount_in: string; status: string }>("SELECT amount_in, status FROM bridge_transfers");
    expect(t.rows).toEqual([{ amount_in: NEAR("8").toString(), status: "success" }]);
    expect(await fundTrading(h.app.bridge)).toMatchObject({ started: false, reason: "nothing_to_transfer" });
    h.clock.advance(25 * HOUR);
    expect(await fundTrading(h.app.bridge)).toMatchObject({ started: true, amount: NEAR("8") });
  });

  it("switching to DISTRIBUTE is instant in the vault and stops new trading", async () => {
    h = await makeHarness({ VAULT_MODE_DELAY_HOURS: "0" });
    await setMode(h, "AUTO_HUNT");
    await deposit(h, "20");
    await pump(h);
    hotToken(h, "VLTtoken111");
    await huntTwice(h);
    await setMode(h, "DISTRIBUTE");
    expect((await h.app.vault.status()).effective_mode).toBe("Distribute");
    hotToken(h, "VLTtoken222");
    await huntTwice(h);
    expect((await h.db.query("SELECT 1 FROM trading_positions WHERE mint='VLTtoken222'")).rows).toHaveLength(0);
  });

  it("claims wait for the payout list's veto window, then the vault pays the listed account", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "5", VAULT_DISTRIBUTION_DELAY_HOURS: "24" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "10.5");
    await pump(h);
    const vd = await h.db.query<{ status: string; root: string; activates_at: string }>("SELECT status, root, activates_at FROM vault_distributions");
    expect(vd.rows[0]!.status).toBe("proposed");
    const onChain = await h.app.vault.distribution(1);
    expect(onChain!.root).toBe(vd.rows[0]!.root);

    const r = await requestClaim(claimDeps(h), h.users.alice.user.id);
    expect(r.status).toBe("queued");
    await pump(h, 3);
    expect((await h.db.query("SELECT status FROM reward_claims")).rows[0]).toEqual({ status: "pending" });
    expect((await balances(h)).distributed).toBe(0n);

    h.clock.advance(25 * HOUR);
    await pump(h, 3);
    expect((await h.db.query("SELECT status FROM reward_claims")).rows[0]).toEqual({ status: "paid" });
    expect(await h.app.vault.isClaimed(1, "alice.near")).toBe(true);
    expect((await balances(h)).distributed).toBe(NEAR("6"));
  });

  it("anyone can verify and self-claim with published proofs; the bot books it without paying twice", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "5" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "10.5");
    await pump(h);
    const proofs = await proofsFor(h.db, "carol.near"); // never registered with the bot
    expect(proofs).toHaveLength(1);
    const p = proofs[0]!;
    expect(verifyProof(p.root, BigInt(p.epoch), "carol.near", BigInt(p.amount), p.proof)).toBe(true);

    // Bob claims directly on the vault, then also asks the bot.
    const bob = (await proofsFor(h.db, "bob.near"))[0]!;
    const tx = await h.app.vault.prepare({ method: "claim_many", args: { account_id: "bob.near", items: [{ epoch: bob.epoch, amount: bob.amount, proof: bob.proof }] } });
    expect((await h.app.vault.send(tx)).events.map((e) => e.event)).toContain("claimed");
    const r = await requestClaim(claimDeps(h), h.users.bob.user.id);
    expect(r.status).toBe("queued");
    await h.runner.drain();
    const c = await h.db.query<{ status: string; tx_hash: string }>("SELECT status, tx_hash FROM reward_claims");
    expect(c.rows[0]!.status).toBe("paid");
    expect(c.rows[0]!.tx_hash).toMatch(/^self-claim:/);
    expect((await balances(h)).distributed).toBe(NEAR("3"));
    expect((await integrity(h)).ok).toBe(true);
  });

  it("a council veto returns the list's money to the pool and cancels claims against it", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "5", VAULT_DISTRIBUTION_DELAY_HOURS: "24" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "10.5");
    await pump(h);
    await requestClaim(claimDeps(h), h.users.alice.user.id);
    vaultOf(h).vetoDistribution(1);
    expect(await watchVault(vdeps(h))).toEqual({ vetoed: 1 });
    const b = await balances(h);
    expect(b.claimable).toBe(0n);
    expect(b.pool).toBe(NEAR("10"));
    expect((await h.db.query("SELECT status FROM reward_claims")).rows[0]).toEqual({ status: "cancelled" });
    expect((await h.db.query("SELECT status FROM vault_distributions")).rows[0]).toEqual({ status: "vetoed" });
    // The pool is re-distributed from a fresh snapshot under a new epoch.
    await h.db.query("UPDATE jobs SET status='done' WHERE type='distribution.run'");
    const { runDistribution } = await import("../src/distribution/distribution.ts");
    h.clock.advance(HOUR);
    const r = await runDistribution({ db: h.db, clock: h.clock, cfg: h.cfg, chain: h.chain, prices: h.app.prices, holders: h.app.holders });
    expect(r).toMatchObject({ created: true });
    await pump(h, 3);
    expect((await h.db.query("SELECT epoch, status FROM vault_distributions ORDER BY epoch")).rows).toEqual([
      { epoch: "1", status: "vetoed" },
      { epoch: "2", status: "proposed" },
    ]);
    expect((await integrity(h)).ok).toBe(true);
  });

  it("each daily decision is mirrored to the vault with the hash of its published snapshot", async () => {
    h = await makeHarness();
    const r = await setMode(h, "AUTO_HUNT");
    const row = await h.db.query<{ snapshot_hash: string; mode: string }>("SELECT snapshot_hash, mode FROM vault_mode_syncs WHERE cycle_id=$1", [r.cycleId]);
    expect(row.rows[0]!.snapshot_hash).toBe(await snapshotHash(h.db, r.cycleId));
    const st = await h.app.vault.status();
    expect(st.effective_mode).toBe("AutoHunt");
    expect(st.pending_mode?.cycle_id ?? st.mode_cycle).toBe(r.cycleId); // matured, applied lazily on the next call
  });

  it("a paused vault blocks claims until the council unpauses", async () => {
    h = await makeHarness({ MIN_DISTRIBUTION_POOL_USD: "5" });
    await setMode(h, "DISTRIBUTE");
    await deposit(h, "10.5");
    await pump(h);
    vaultOf(h).paused = true;
    const r = await requestClaim(claimDeps(h), h.users.alice.user.id);
    expect(r.status).toBe("queued");
    const claimId = (r as { claims: { claimId: string }[] }).claims[0]!.claimId;
    await expect(payClaim(claimDeps(h), claimId)).rejects.toThrow(/vault is paused/);
    expect((await h.db.query("SELECT status FROM reward_claims")).rows[0]).toEqual({ status: "pending" });
    vaultOf(h).paused = false;
    expect(await payClaim(claimDeps(h), claimId)).toBe("paid");
  });
});

describe("Holder Council (top holders, contested on chain)", () => {
  it("the bot seats the actual top holders; a bigger holder takes the smallest seat; pools and dust never sit", async () => {
    h = await makeHarness({ VAULT_COUNCIL_SEATS: "2", VAULT_MIN_SEAT_BALANCE: "2000", EXCLUDED_HOLDER_ACCOUNTS: "pool.near" });
    await h.chain.setBalance("pool.near", BAG(1_000_000)); // excluded protocol account
    expect(await syncSeats(vdeps(h), h.app.holders)).toEqual({ nominated: ["alice.near", "bob.near"] }); // carol (1000) is below the minimum
    expect((await h.app.vault.seats()).map((x) => x.account_id).sort()).toEqual(["alice.near", "bob.near"]);

    // A new whale buys in: it replaces the smallest seat (bob).
    await h.chain.setBalance("whale.near", BAG(50_000));
    expect(await syncSeats(vdeps(h), h.app.holders)).toEqual({ nominated: ["whale.near"] });
    expect((await h.app.vault.seats()).map((x) => x.account_id).sort()).toEqual(["alice.near", "whale.near"]);

    // The vault itself re-checks balances: nobody can be seated over a larger holder.
    const tx = await h.app.vault.prepare({ method: "claim_seat", args: { candidate: "carol.near", replace: "alice.near" } });
    expect((await h.app.vault.send(tx)).events.map((e) => e.event)).toEqual(["seat_rejected"]);
    const bad = await h.app.vault.prepare({ method: "claim_seat", args: { candidate: "pool.near", replace: "alice.near" } });
    expect((await h.app.vault.send(bad)).state).toBe("failure");
    // Nothing to change: a second run nominates no one.
    expect(await syncSeats(vdeps(h), h.app.holders)).toEqual({ nominated: [] });
  });
});
