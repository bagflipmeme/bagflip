/**
 * Treasury service: deposit recognition, balance categories, reservations and
 * the capital the trading engine is allowed to use.
 *
 * Only transfers into TREASURY_NEAR_ADDRESS from an allowed sender (the creator
 * wallet by default) are credited. Anything else is recorded as an
 * unattributed inflow and never silently becomes trading capital. The creator
 * wallet itself is never read for funds, swept, or signed for.
 */
import type { Db, Tx } from "../db/index.ts";
import { getState, setState, audit, advisoryXactLock } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { NearChain, IncomingTransfer } from "../near/chain.ts";
import { A, postJournal, allBalances, bal } from "./ledger.ts";
import type { PriceOracle } from "./prices.ts";
import { formatAsset, formatUsd, toUsdMicro, bps, max } from "../shared/money.ts";
import { notify } from "../shared/outbox.ts";
import { enqueue } from "../jobs/queue.ts";
import { currentMode } from "../governance/cycle.ts";

/** Senders whose inflows are bridge settlements, not deposits (credited by the bridge workflow). */
const BRIDGE_SENDERS = new Set(["intents.near"]);

export interface TreasuryDeps {
  db: Db;
  clock: Clock;
  cfg: Config;
  chain: NearChain;
  prices: PriceOracle;
}

export function allowedSenders(cfg: Config): Set<string> {
  return new Set([cfg.CREATOR_WALLET_ADDRESS, ...cfg.DEPOSIT_ALLOWED_SENDERS].filter(Boolean).map((s) => s.toLowerCase()));
}

export interface DepositInput {
  txHash: string;
  receiptId: string;
  sender: string;
  amount: bigint;
  blockHeight?: bigint;
  blockTimestamp?: Date;
  source: "scanner" | "admin" | "sim";
}

export async function recordDeposit(d: TreasuryDeps, i: DepositInput): Promise<{ created: boolean; depositId?: string }> {
  if (i.amount <= 0n) throw new Error("Deposit amount must be positive");
  const priceNear = await d.prices.usd("NEAR");
  return d.db.tx(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO treasury_deposits(tx_hash, receipt_id, sender, asset, amount, block_height, block_timestamp, source, created_at)
       VALUES ($1,$2,$3,'NEAR',$4,$5,$6,$7,$8) ON CONFLICT (receipt_id) DO NOTHING RETURNING id`,
      [i.txHash, i.receiptId, i.sender, i.amount.toString(), i.blockHeight?.toString() ?? null, i.blockTimestamp?.toISOString() ?? null, i.source, d.clock.now().toISOString()],
    );
    if (!ins.rows[0]) return { created: false };
    const id = ins.rows[0].id;
    const j = await postJournal(tx, d.clock, {
      key: `deposit:${i.receiptId}`,
      kind: "deposit",
      refType: "treasury_deposit",
      refId: id,
      entries: [
        { account: A.deposits, asset: "NEAR", amount: -i.amount },
        { account: A.available, asset: "NEAR", amount: i.amount },
      ],
    });
    // treasury_deposits is not append-only: journal_id is linked once here.
    await tx.query("UPDATE treasury_deposits SET journal_id=$2 WHERE id=$1", [id, j.journalId]);
    const usd = priceNear ? toUsdMicro(i.amount, "NEAR", priceNear) : null;
    if (usd !== null && usd >= BigInt(Math.round(d.cfg.NOTIFY_MIN_DEPOSIT_USD * 1e6))) {
      await notify(tx, d.clock, `deposit:${i.receiptId}`, "deposit", `💸 <b>Reward deposit received</b>\n${formatAsset(i.amount, "NEAR")} (${formatUsd(usd)}) entered the BAGFLIP treasury.${i.source === "sim" ? "\n<i>(simulated)</i>" : ""}`);
    }
    // Route the new funds according to the active mode.
    await enqueue(tx, d.clock, { type: "treasury.route", key: `route:deposit:${id}`, payload: { trigger: `deposit:${id}` } });
    return { created: true, depositId: id };
  });
}

/** Scan the treasury account for new incoming transfers (paper/live). */
export async function scanDeposits(d: TreasuryDeps): Promise<{ credited: number; unattributed: number }> {
  const treasury = d.cfg.TREASURY_NEAR_ADDRESS;
  let cursor = await getState<string>(d.db, "deposit_scan_cursor");
  if (cursor === undefined) {
    // First run: start from now. Historical deposits are credited by an admin with /deposit <tx>.
    const head = await d.chain.finalBlock();
    await setState(d.db, "deposit_scan_cursor", head.height.toString());
    return { credited: 0, unattributed: 0 };
  }
  const transfers = await d.chain.incomingTransfers(treasury, BigInt(cursor));
  const res = await creditTransfers(d, transfers, "scanner");
  const maxH = transfers.reduce((m, t) => (t.blockHeight > m ? t.blockHeight : m), BigInt(cursor));
  await setState(d.db, "deposit_scan_cursor", maxH.toString());
  return res;
}

export async function creditTransfers(d: TreasuryDeps, transfers: IncomingTransfer[], source: "scanner" | "admin") {
  const allowed = allowedSenders(d.cfg);
  let credited = 0;
  let unattributed = 0;
  for (const t of transfers) {
    const sender = t.sender.toLowerCase();
    if (BRIDGE_SENDERS.has(sender)) continue;
    if (allowed.has(sender)) {
      const r = await recordDeposit(d, { ...t, source });
      if (r.created) credited++;
    } else {
      const r = await d.db.query(
        `INSERT INTO unattributed_inflows(chain, tx_hash, receipt_id, sender, asset, amount, created_at) VALUES ('near',$1,$2,$3,'NEAR',$4,$5)
         ON CONFLICT (receipt_id) DO NOTHING RETURNING id`,
        [t.txHash, t.receiptId, t.sender, t.amount.toString(), d.clock.now().toISOString()],
      );
      if (r.rows.length) unattributed++;
    }
  }
  return { credited, unattributed };
}

/** Admin: credit a specific transaction after on-chain verification. */
export async function creditDepositTx(d: TreasuryDeps, txHash: string, actor: string) {
  const transfers = await d.chain.transfersInTx(txHash, d.cfg.TREASURY_NEAR_ADDRESS);
  if (!transfers.length) throw new Error("No successful transfer into the treasury found in that transaction");
  const r = await creditTransfers(d, transfers, "admin");
  await audit(d.db, actor, "credit_deposit_tx", { txHash, ...r });
  return r;
}

export interface TreasurySummary {
  near: {
    available: bigint;
    distributionPool: bigint;
    claimable: bigint;
    bridgeOutbound: bigint;
    totalDeposited: bigint;
    totalDistributed: bigint;
    fees: bigint;
    total: bigint;
  };
  sol: {
    tradingAvailable: bigint;
    positionsCost: bigint;
    bridgeInbound: bigint;
    realizedPnl: bigint;
    fees: bigint;
  };
  unrealizedValueLamports: bigint;
  priceNear: number | null;
  priceSol: number | null;
  totalUsdMicro: bigint | null;
}

export async function treasurySummary(db: Tx, prices: PriceOracle): Promise<TreasurySummary> {
  const m = await allBalances(db);
  const near = {
    available: bal(m, A.available, "NEAR"),
    distributionPool: bal(m, A.distPool, "NEAR"),
    claimable: bal(m, A.claimable, "NEAR"),
    bridgeOutbound: bal(m, A.bridgeOut, "NEAR"),
    totalDeposited: -bal(m, A.deposits, "NEAR"),
    totalDistributed: bal(m, A.distributed, "NEAR"),
    fees: bal(m, A.fees, "NEAR"),
    total: 0n,
  };
  near.total = near.available + near.distributionPool + near.claimable + near.bridgeOutbound;
  const sol = {
    tradingAvailable: bal(m, A.tradingAvailable, "SOL"),
    positionsCost: bal(m, A.positions, "SOL"),
    bridgeInbound: bal(m, A.bridgeIn, "SOL"),
    realizedPnl: -bal(m, A.pnl, "SOL"),
    fees: bal(m, A.fees, "SOL"),
  };
  const u = await db.query<{ v: string }>(
    "SELECT COALESCE(SUM(COALESCE(last_value_lamports, remaining_cost_lamports)),0)::text AS v FROM trading_positions WHERE status IN ('open','closing','opening')",
  );
  const unrealizedValueLamports = BigInt(u.rows[0]!.v);
  const [pn, ps] = await Promise.all([prices.usd("NEAR"), prices.usd("SOL")]);
  const totalUsdMicro =
    pn && ps ? toUsdMicro(near.total, "NEAR", pn) + toUsdMicro(sol.tradingAvailable + sol.bridgeInbound + unrealizedValueLamports, "SOL", ps) : null;
  return { near, sol, unrealizedValueLamports, priceNear: pn, priceSol: ps, totalUsdMicro };
}

/**
 * NEAR the trading engine may receive: unreserved available balance minus the
 * operational fee reserve, capped at MAX_TREASURY_TRADE_ALLOCATION_PERCENT.
 * Distribution pool and claimable funds are separate accounts and can never
 * appear here.
 */
export function tradableNear(cfg: Config, available: bigint): bigint {
  const free = max(0n, available - cfg.nearFeeReserve);
  return bps(free, Math.round(cfg.MAX_TREASURY_TRADE_ALLOCATION_PERCENT * 100));
}

/**
 * Route treasury funds after a deposit or a mode change:
 *  DISTRIBUTE → move available (minus reserve) into the distribution pool.
 *  AUTO_HUNT  → ask the bridge to fund the trading wallet (batched by threshold).
 *  INACTIVE   → hold.
 */
export async function routeTreasury(d: TreasuryDeps, trigger: string): Promise<{ action: string; amount?: bigint }> {
  const mode = await currentMode(d.db);
  if (mode === "DISTRIBUTE") {
    return d.db.tx(async (tx) => {
      await advisoryXactLock(tx, "ledger");
      const m = await allBalances(tx);
      const avail = bal(m, A.available, "NEAR");
      const amount = max(0n, avail - d.cfg.nearFeeReserve);
      if (amount === 0n) return { action: "none" };
      // Key on the cumulative deposit+route position so the same funds are never moved twice.
      const seq = await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_journals WHERE kind='dist_reserve'");
      await postJournal(tx, d.clock, {
        key: `dist-reserve:${seq.rows[0]!.n}:${amount}`,
        kind: "dist_reserve",
        memo: "DISTRIBUTE mode: reserve available rewards for distribution",
        entries: [
          { account: A.available, asset: "NEAR", amount: -amount },
          { account: A.distPool, asset: "NEAR", amount },
        ],
      });
      await enqueue(tx, d.clock, { type: "distribution.run", key: `dist-run:${trigger}`, payload: {} });
      return { action: "reserved_for_distribution", amount };
    });
  }
  if (mode === "AUTO_HUNT") {
    await enqueue(d.db, d.clock, { type: "bridge.fund_trading", key: `fund:${trigger}`, payload: {} });
    return { action: "fund_trading_requested" };
  }
  return { action: "hold" };
}
