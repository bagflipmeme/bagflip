/**
 * Cross-chain capital movement between the NEAR treasury and the Solana
 * trading wallet through NEAR Intents 1Click.
 *
 * State machine (bridge_transfers.status):
 *   quoted → submitting → deposited → processing → success | refunded | failed
 *   quoted/submitting → expired (deposit provably never landed; reservation reversed)
 *
 * Accounting:
 *   reserve:  NEAR treasury:available → bridge:outbound      (at quote)
 *   settle:   bridge:outbound → fx → SOL trading:available   (only after 1Click SUCCESS
 *             AND the destination tx is verified on the destination chain)
 *   refund:   bridge:outbound → treasury:available (refunded amount), shortfall → fees
 *   failed:   funds stay in bridge:outbound until an admin resolves; never assumed lost or arrived.
 * The reverse direction mirrors this with trading:available → bridge:inbound.
 */
import type { Db } from "../db/index.ts";
import { getState } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { Logger } from "../shared/log.ts";
import { A, balance, postJournal } from "../treasury/ledger.ts";
import type { PriceOracle } from "../treasury/prices.ts";
import { tradableNear } from "../treasury/treasury.ts";
import { currentMode } from "../governance/cycle.ts";
import { enqueue, RetryLater } from "../jobs/queue.ts";
import { notify } from "../shared/outbox.ts";
import { formatAsset, max, toUsdMicro, type Asset } from "../shared/money.ts";
import { ASSET, type BridgeProvider } from "./oneclick.ts";
import type { VaultPort } from "../near/vault.ts";
import { WRAP_STORAGE_DEPOSIT } from "./depositors.ts";
import type { Depositor, PreparedDeposit } from "./depositors.ts";

export type Direction = "NEAR_TO_SOL" | "SOL_TO_NEAR";

export interface DestinationVerifier {
  verify(direction: Direction, destTxHashes: string[]): Promise<boolean>;
}
export const trustSimulated: DestinationVerifier = { verify: async () => true };

export interface BridgeDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  prices: PriceOracle;
  provider: BridgeProvider;
  nearDepositor: Depositor;
  solDepositor: Depositor;
  verifier: DestinationVerifier;
  /** The vault contract: the NEAR side of every trading allocation goes through it. */
  vault?: VaultPort;
  log: Logger;
}

interface Row {
  id: string;
  direction: Direction;
  status: string;
  amount_in: string;
  deposit_address: string | null;
  deposit_memo: string | null;
  deadline: string | null;
  origin_tx_hash: string | null;
  signed_tx: string | null;
  created_at: string;
}

const side = (dir: Direction) =>
  dir === "NEAR_TO_SOL"
    ? { inAsset: "NEAR" as Asset, outAsset: "SOL" as Asset, from: A.available, transit: A.bridgeOut, to: A.tradingAvailable }
    : { inAsset: "SOL" as Asset, outAsset: "NEAR" as Asset, from: A.tradingAvailable, transit: A.bridgeIn, to: A.available };

export async function isPaused(db: Db, cfg: Config): Promise<boolean> {
  return cfg.EMERGENCY_PAUSE || (await getState<boolean>(db, "emergency_pause")) === true;
}

async function inFlight(db: Db, dir: Direction) {
  const r = await db.query("SELECT 1 FROM bridge_transfers WHERE direction=$1 AND status IN ('quoted','submitting','deposited','processing')", [dir]);
  return r.rows.length > 0;
}

export type StartResult = { started: true; transferId: string; amount: bigint } | { started: false; reason: string };

async function start(d: BridgeDeps, dir: Direction, amount: bigint, reason: string): Promise<StartResult> {
  const s = side(dir);
  if (amount <= 0n) return { started: false, reason: "nothing_to_transfer" };
  if (await inFlight(d.db, dir)) return { started: false, reason: "transfer_in_flight" };
  const price = await d.prices.usd(s.inAsset);
  if (!price) return { started: false, reason: "no_price" };
  const usd = toUsdMicro(amount, s.inAsset, price);
  if (usd < BigInt(Math.round(d.cfg.MIN_CROSS_CHAIN_TRANSFER_USD * 1e6))) return { started: false, reason: "below_min_transfer" };

  const deadline = new Date(d.clock.now().getTime() + d.cfg.BRIDGE_DEADLINE_MINUTES * 60_000);
  const recipient = dir === "NEAR_TO_SOL" ? d.cfg.TRADING_WALLET_ADDRESS : d.cfg.TREASURY_NEAR_ADDRESS;
  const refundTo = dir === "NEAR_TO_SOL" ? d.cfg.TREASURY_NEAR_ADDRESS : d.cfg.TRADING_WALLET_ADDRESS;
  const q = await d.provider.quote({
    originAsset: dir === "NEAR_TO_SOL" ? ASSET.WNEAR : ASSET.SOL,
    destinationAsset: dir === "NEAR_TO_SOL" ? ASSET.SOL : ASSET.WNEAR,
    amount,
    recipient,
    refundTo,
    slippageBps: d.cfg.BRIDGE_SLIPPAGE_BPS,
    deadline,
    dry: false,
  });
  if (!q.depositAddress) throw new Error("1Click returned no deposit address for a non-dry quote");
  if (q.amountIn !== amount) throw new Error(`1Click quote amountIn ${q.amountIn} != requested ${amount}`);
  if (q.amountInUsd && q.amountOutUsd && 1 - q.amountOutUsd / q.amountInUsd > 0.05) {
    return { started: false, reason: "bridge_cost_too_high" };
  }

  const id = await d.db.tx(async (tx) => {
    const now = d.clock.now().toISOString();
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO bridge_transfers(idempotency_key, direction, status, amount_in, amount_out_expected, min_amount_out, deposit_address, deposit_memo,
         quote, quote_signature, correlation_id, deadline, created_at, updated_at)
       VALUES ($1,$2,'quoted',$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$12) RETURNING id`,
      [
        `${dir}:${q.depositAddress}`,
        dir,
        amount.toString(),
        q.amountOut.toString(),
        q.minAmountOut.toString(),
        q.depositAddress,
        q.depositMemo,
        JSON.stringify(q.raw),
        q.signature,
        q.correlationId,
        (q.deadline ? new Date(q.deadline) : deadline).toISOString(),
        now,
      ],
    );
    const tid = ins.rows[0]!.id;
    await postJournal(tx, d.clock, {
      key: `bridge-reserve:${tid}`,
      kind: "bridge_reserve",
      refType: "bridge_transfer",
      refId: tid,
      memo: reason,
      entries: [
        { account: s.from, asset: s.inAsset, amount: -amount },
        { account: s.transit, asset: s.inAsset, amount },
      ],
    });
    await enqueue(tx, d.clock, { type: "bridge.poll", key: `bridge-poll:${tid}`, payload: { id: tid }, maxAttempts: 500 });
    return tid;
  });
  d.log.info("bridge transfer quoted", { id, dir, amount });
  await submit(d, id);
  return { started: true, transferId: id, amount };
}

/** AUTO HUNT: move eligible, unreserved NEAR to the Solana trading wallet. */
export async function fundTrading(d: BridgeDeps): Promise<StartResult> {
  if ((await currentMode(d.db)) !== "AUTO_HUNT") return { started: false, reason: "mode_not_auto_hunt" };
  if (await isPaused(d.db, d.cfg)) return { started: false, reason: "emergency_pause" };
  if (d.cfg.BAGFLIP_ENV === "live" && !d.cfg.liveTransfers) return { started: false, reason: "live_transfers_disabled" };
  const avail = await balance(d.db, A.available, "NEAR");
  let amount = tradableNear(d.cfg, avail);
  if (d.vault) {
    // The vault decides: AUTO_HUNT must be active on chain (time-lock passed, not vetoed) and the
    // amount must fit its rolling 24h cap and unreserved balance.
    const st = await d.vault.status();
    if (st.paused) return { started: false, reason: "vault_paused" };
    if (st.effective_mode !== "AutoHunt") return { started: false, reason: st.pending_mode ? "vault_auto_hunt_timelocked" : "vault_mode_not_auto_hunt" };
    const remaining = BigInt(st.hunt_remaining_24h);
    if (remaining < amount) amount = remaining;
    if (!d.vault.simulated) {
      const free = BigInt(st.free_balance) - WRAP_STORAGE_DEPOSIT - 1n;
      if (free < amount) amount = free > 0n ? free : 0n;
    }
  }
  return start(d, "NEAR_TO_SOL", amount, "AUTO HUNT funding");
}

/** DISTRIBUTE / wind-down: return idle Solana capital to the NEAR treasury. */
export async function returnToTreasury(d: BridgeDeps): Promise<StartResult> {
  if (await isPaused(d.db, d.cfg)) return { started: false, reason: "emergency_pause" };
  if (d.cfg.BAGFLIP_ENV === "live" && !d.cfg.liveTransfers) return { started: false, reason: "live_transfers_disabled" };
  const avail = await balance(d.db, A.tradingAvailable, "SOL");
  return start(d, "SOL_TO_NEAR", max(0n, avail - d.cfg.solFeeReserve), "Return trading capital to treasury");
}

function prepared(row: Row): PreparedDeposit {
  const p = JSON.parse(row.signed_tx ?? "{}") as { signed?: string; lvbh?: string };
  return { hash: row.origin_tx_hash ?? "", signed: p.signed ?? "", lastValidBlockHeight: p.lvbh ? BigInt(p.lvbh) : undefined };
}

async function load(db: Db, id: string): Promise<Row> {
  const r = await db.query<Row>("SELECT * FROM bridge_transfers WHERE id=$1", [id]);
  if (!r.rows[0]) throw new Error(`bridge transfer ${id} not found`);
  return r.rows[0];
}

async function setStatus(db: Db, clock: Clock, id: string, status: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c} = $${i + 4}`).join(", ");
  await db.query(`UPDATE bridge_transfers SET status=$2, updated_at=$3${sets ? ", " + sets : ""} WHERE id=$1`, [
    id,
    status,
    clock.now().toISOString(),
    ...cols.map((c) => {
      const v = extra[c];
      return typeof v === "bigint" ? v.toString() : v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    }),
  ]);
}

/** Reverse a reservation when the deposit provably never left. */
async function reverse(d: BridgeDeps, row: Row, status: "expired" | "failed", error: string) {
  const s = side(row.direction);
  const amt = BigInt(row.amount_in);
  await d.db.tx(async (tx) => {
    await postJournal(tx, d.clock, {
      key: `bridge-reverse:${row.id}`,
      kind: "bridge_reverse",
      refType: "bridge_transfer",
      refId: row.id,
      memo: error,
      entries: [
        { account: s.transit, asset: s.inAsset, amount: -amt },
        { account: s.from, asset: s.inAsset, amount: amt },
      ],
    });
    await tx.query("UPDATE bridge_transfers SET status=$2, error=$3, updated_at=$4, settled_at=$4 WHERE id=$1", [row.id, status, error, d.clock.now().toISOString()]);
  });
}

async function submit(d: BridgeDeps, id: string) {
  const row = await load(d.db, id);
  if (row.status !== "quoted") return;
  if (row.deadline && new Date(row.deadline).getTime() - d.clock.now().getTime() < 2 * 60_000) {
    await reverse(d, row, "expired", "quote expired before deposit was sent");
    return;
  }
  const dep = row.direction === "NEAR_TO_SOL" ? d.nearDepositor : d.solDepositor;
  const p = await dep.prepare(row.deposit_address!, BigInt(row.amount_in));
  // Persist the signed deposit BEFORE broadcasting.
  await setStatus(d.db, d.clock, id, "submitting", {
    origin_tx_hash: p.hash,
    signed_tx: JSON.stringify({ signed: p.signed, lvbh: p.lastValidBlockHeight?.toString() }),
  });
  await dep.broadcast(p);
}

/** Drive one transfer forward. Throws RetryLater while waiting on chain/1Click. */
export async function pollTransfer(d: BridgeDeps, id: string): Promise<string> {
  const row = await load(d.db, id);
  const s = side(row.direction);
  const amtIn = BigInt(row.amount_in);
  const dep = row.direction === "NEAR_TO_SOL" ? d.nearDepositor : d.solDepositor;

  if (row.status === "quoted") {
    await submit(d, id);
    throw new RetryLater("deposit submitted", 5_000);
  }
  if (row.status === "submitting") {
    const st = await dep.state(prepared(row));
    if (st.feePaid > 0n) {
      await d.db.tx((tx) =>
        postJournal(tx, d.clock, {
          key: `bridge-fee:${row.id}`,
          kind: "network_fee",
          refType: "bridge_transfer",
          refId: row.id,
          entries: [
            { account: s.from, asset: s.inAsset, amount: -st.feePaid },
            { account: A.fees, asset: s.inAsset, amount: st.feePaid },
          ],
        }),
      );
    }
    if (st.state === "pending") throw new RetryLater("deposit tx pending", 10_000);
    if (st.state === "not_landed") {
      await reverse(d, row, "expired", "deposit transaction expired without landing");
      return "expired";
    }
    if (st.state === "failed") {
      await reverse(d, row, "failed", "deposit transaction failed on chain");
      await alert(d, row, "Bridge deposit transaction failed on chain; funds were not sent.");
      return "failed";
    }
    await setStatus(d.db, d.clock, id, "deposited");
    await d.provider
      .submitDeposit(row.origin_tx_hash!, row.deposit_address!, row.direction === "NEAR_TO_SOL" ? d.cfg.TREASURY_NEAR_ADDRESS : undefined)
      .catch((e) => d.log.warn("1Click deposit/submit failed (non-fatal)", { error: e }));
    throw new RetryLater("deposit landed; waiting for 1Click", 10_000);
  }
  if (row.status !== "deposited" && row.status !== "processing") return row.status;

  const st = await d.provider.status(row.deposit_address!, row.deposit_memo);
  await setStatus(d.db, d.clock, id, row.status, { status_raw: st.raw });
  switch (st.status) {
    case "PENDING_DEPOSIT":
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
    case "INCOMPLETE_DEPOSIT": {
      if (row.status !== "processing") await setStatus(d.db, d.clock, id, "processing");
      if (row.deadline && d.clock.now().getTime() > new Date(row.deadline).getTime() + 6 * 3_600_000) {
        await alert(d, row, `Bridge transfer still ${st.status} 6h after its deadline.`);
      }
      throw new RetryLater(`1Click ${st.status}`, 15_000);
    }
    case "SUCCESS": {
      if (!st.amountOut || st.amountOut <= 0n) throw new RetryLater("1Click SUCCESS without amountOut yet", 15_000);
      if (!(await d.verifier.verify(row.direction, st.destinationTxHashes))) throw new RetryLater("destination transfer not yet confirmed on chain", 15_000);
      const refunded = st.refundedAmount ?? 0n;
      await d.db.tx(async (tx) => {
        await postJournal(tx, d.clock, {
          key: `bridge-settle:${row.id}`,
          kind: "bridge_settle",
          refType: "bridge_transfer",
          refId: row.id,
          entries: [
            { account: s.transit, asset: s.inAsset, amount: -amtIn },
            { account: A.fx, asset: s.inAsset, amount: amtIn - refunded },
            { account: s.from, asset: s.inAsset, amount: refunded },
            { account: A.fx, asset: s.outAsset, amount: -st.amountOut! },
            { account: s.to, asset: s.outAsset, amount: st.amountOut! },
          ],
        });
        await tx.query(
          "UPDATE bridge_transfers SET status='success', amount_out=$2, refunded_amount=$3, dest_tx_hashes=$4::jsonb, settled_at=$5, updated_at=$5 WHERE id=$1",
          [row.id, st.amountOut!.toString(), refunded.toString(), JSON.stringify(st.destinationTxHashes), d.clock.now().toISOString()],
        );
        for (const h of st.destinationTxHashes) {
          await tx.query(
            "INSERT INTO chain_transactions(chain, hash, kind, ref_type, ref_id, status, simulated, created_at) VALUES ($1,$2,'bridge_out','bridge_transfer',$3,'confirmed',$4,$5) ON CONFLICT DO NOTHING",
            [row.direction === "NEAR_TO_SOL" ? "solana" : "near", h, row.id, d.provider.name === "sim", d.clock.now().toISOString()],
          );
        }
        if (row.origin_tx_hash) {
          await tx.query(
            "INSERT INTO chain_transactions(chain, hash, kind, ref_type, ref_id, status, simulated, created_at) VALUES ($1,$2,'bridge_deposit','bridge_transfer',$3,'confirmed',$4,$5) ON CONFLICT DO NOTHING",
            [row.direction === "NEAR_TO_SOL" ? "near" : "solana", row.origin_tx_hash, row.id, d.provider.name === "sim", d.clock.now().toISOString()],
          );
        }
      });
      d.log.info("bridge transfer settled", { id, amountOut: st.amountOut });
      if (row.direction === "SOL_TO_NEAR") await enqueue(d.db, d.clock, { type: "treasury.route", key: `route:bridge:${row.id}`, payload: { trigger: `bridge:${row.id}` } });
      return "success";
    }
    case "REFUNDED": {
      const refunded = st.refundedAmount ?? 0n;
      await d.db.tx(async (tx) => {
        await postJournal(tx, d.clock, {
          key: `bridge-refund:${row.id}`,
          kind: "bridge_refund",
          refType: "bridge_transfer",
          refId: row.id,
          memo: st.refundReason ?? undefined,
          entries: [
            { account: s.transit, asset: s.inAsset, amount: -amtIn },
            { account: s.from, asset: s.inAsset, amount: refunded },
            { account: A.fees, asset: s.inAsset, amount: amtIn - refunded },
          ],
        });
        await tx.query("UPDATE bridge_transfers SET status='refunded', refunded_amount=$2, error=$3, settled_at=$4, updated_at=$4 WHERE id=$1", [
          row.id,
          refunded.toString(),
          st.refundReason,
          d.clock.now().toISOString(),
        ]);
      });
      await alert(d, row, `Cross-chain transfer was refunded (${formatAsset(refunded, s.inAsset)} returned${st.refundReason ? `, reason ${st.refundReason}` : ""}).`);
      return "refunded";
    }
    case "FAILED": {
      await setStatus(d.db, d.clock, id, "failed", { error: "1Click reported FAILED" });
      await alert(d, row, "Cross-chain transfer FAILED at 1Click. Funds remain booked as in-transit until an operator resolves it.");
      return "failed";
    }
  }
}

async function alert(d: BridgeDeps, row: Row, msg: string) {
  await notify(d.db, d.clock, `bridge-alert:${row.id}:${msg.slice(0, 40)}`, "failure", `⚠️ <b>Treasury operation issue</b>\n${msg}\nTransfer #${row.id} (${row.direction}).`);
}

/** Restart recovery: make sure every in-flight transfer has a poll job. */
export async function recoverBridge(d: BridgeDeps) {
  const r = await d.db.query<{ id: string }>("SELECT id FROM bridge_transfers WHERE status IN ('quoted','submitting','deposited','processing')");
  for (const row of r.rows) {
    await d.db.query("UPDATE jobs SET status='queued', run_at=$2 WHERE key=$1 AND status IN ('done','dead')", [`bridge-poll:${row.id}`, d.clock.now().toISOString()]);
    await enqueue(d.db, d.clock, { type: "bridge.poll", key: `bridge-poll:${row.id}`, payload: { id: row.id }, maxAttempts: 500 });
  }
  return r.rows.length;
}
