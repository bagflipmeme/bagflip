/**
 * PositionManager: the only code that creates orders and books trades.
 *
 * Order lifecycle (trading_orders.status): planned → submitting → confirmed | failed | expired
 *  - planned:     row exists, nothing signed. Safe to cancel.
 *  - submitting:  signed; signature + payload persisted BEFORE broadcast.
 *  - confirmed:   settlement read back from chain; ledger journal posted (key trade:<orderId>).
 *  - failed:      landed but reverted — the network fee is booked, nothing else.
 *  - expired:     provably never landed — no ledger effect.
 * A failed or expired submission never produces a position or P&L.
 */
import type { Db } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { Logger } from "../shared/log.ts";
import { A, postJournal } from "../treasury/ledger.ts";
import { notify, esc } from "../shared/outbox.ts";
import { formatAsset } from "../shared/money.ts";
import { PrepareError, type ExecutionAdapter, type Settlement } from "../solana/execution/types.ts";
import type { TokenMarket } from "../market/types.ts";
import { solscanTx } from "../solana/rpc.ts";

export interface PositionRow {
  id: string;
  mint: string;
  symbol: string | null;
  status: string;
  token_amount: string;
  tokens_bought: string;
  cost_lamports: string;
  remaining_cost_lamports: string;
  proceeds_lamports: string;
  fees_lamports: string;
  realized_pnl_lamports: string;
  peak_value_lamports: string;
  last_value_lamports: string | null;
  take_profit_done: boolean;
  entry_signals: { volumeM5?: number; liquidityUsd?: number } | null;
  exit_reason: string | null;
  exit_attempts: number;
  opened_at: string;
  closed_at: string | null;
  exec_mode: string;
  token_decimals: number | null;
}

interface OrderRow {
  id: string;
  client_order_id: string;
  position_id: string;
  side: "buy" | "sell";
  status: string;
  amount_in: string;
  signature: string | null;
  last_valid_block_height: string | null;
  slippage_bps: number;
  reason: string | null;
  payload: string | null;
  created_at: string;
}

export class PositionManager {
  private db: Db;
  private clock: Clock;
  private cfg: Config;
  private exec: ExecutionAdapter;
  private log: Logger;
  constructor(
    db: Db,
    clock: Clock,
    cfg: Config,
    exec: ExecutionAdapter,
    log: Logger,
  ) {
    this.db = db;
    this.clock = clock;
    this.cfg = cfg;
    this.exec = exec;
    this.log = log;}

  get mode() {
    return this.exec.mode;
  }

  async openPositions(): Promise<PositionRow[]> {
    const r = await this.db.query<PositionRow>("SELECT * FROM trading_positions WHERE status IN ('opening','open','closing') ORDER BY id");
    return r.rows;
  }

  async pendingOrders(): Promise<OrderRow[]> {
    const r = await this.db.query<OrderRow>("SELECT * FROM trading_orders WHERE status IN ('planned','submitting') ORDER BY id");
    return r.rows;
  }

  async pendingBuyLamports(): Promise<bigint> {
    const r = await this.db.query<{ s: string }>("SELECT COALESCE(SUM(amount_in),0)::text AS s FROM trading_orders WHERE side='buy' AND status IN ('planned','submitting')");
    return BigInt(r.rows[0]!.s);
  }

  /** Create the position + buy order atomically, then execute it. Returns null if the mint is already held. */
  async open(m: TokenMarket, sizeLamports: bigint, score: number, signals: Record<string, unknown>): Promise<string | null> {
    const ids = await this.db
      .tx(async (tx) => {
        const now = this.clock.now().toISOString();
        const p = await tx.query<{ id: string }>(
          `INSERT INTO trading_positions(mint, symbol, name, pair_address, dex_id, exec_mode, status, entry_score, entry_signals, opened_at)
           VALUES ($1,$2,$3,$4,$5,$6,'opening',$7,$8::jsonb,$9) RETURNING id`,
          [m.mint, m.symbol, m.name, m.pairAddress, m.dexId, this.exec.mode, score, JSON.stringify(signals), now],
        );
        const pid = p.rows[0]!.id;
        const o = await tx.query<{ id: string }>(
          `INSERT INTO trading_orders(client_order_id, position_id, side, status, venue, amount_in, slippage_bps, reason, created_at)
           VALUES ($1,$2,'buy','planned','pending',$3,$4,'entry',$5) RETURNING id`,
          [`buy:${pid}`, pid, sizeLamports.toString(), this.cfg.TRADE_SLIPPAGE_BPS, now],
        );
        return { pid, oid: o.rows[0]!.id };
      })
      .catch((e) => {
        if (/positions_one_active_per_mint|duplicate key/.test(String(e))) return null;
        throw e;
      });
    if (!ids) return null;
    await this.execute(ids.oid);
    return ids.pid;
  }

  /** Request a sell of `fractionBps` of the remaining tokens. */
  async exit(pos: PositionRow, fractionBps: number, reason: string, slippageBps: number): Promise<string | null> {
    const held = BigInt(pos.token_amount);
    if (held <= 0n) return null;
    const amount = fractionBps >= 10_000 ? held : (held * BigInt(fractionBps)) / 10_000n;
    if (amount <= 0n) return null;
    const oid = await this.db.tx(async (tx) => {
      const lock = await tx.query("SELECT 1 FROM trading_orders WHERE position_id=$1 AND status IN ('planned','submitting') FOR UPDATE", [pos.id]);
      if (lock.rows.length) return null; // an order for this position is already in flight
      const n = await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM trading_orders WHERE position_id=$1 AND side='sell'", [pos.id]);
      await tx.query("UPDATE trading_positions SET status='closing', exit_reason=$2 WHERE id=$1", [pos.id, reason]);
      const o = await tx.query<{ id: string }>(
        `INSERT INTO trading_orders(client_order_id, position_id, side, status, venue, amount_in, slippage_bps, reason, created_at)
         VALUES ($1,$2,'sell','planned','pending',$3,$4,$5,$6) RETURNING id`,
        [`sell:${pos.id}:${n.rows[0]!.n}`, pos.id, amount.toString(), slippageBps, reason, this.clock.now().toISOString()],
      );
      return o.rows[0]!.id;
    });
    if (oid) await this.execute(oid);
    return oid;
  }

  private async loadOrder(id: string): Promise<OrderRow & { mint: string }> {
    const r = await this.db.query<OrderRow & { mint: string }>(
      "SELECT o.*, p.mint FROM trading_orders o JOIN trading_positions p ON p.id = o.position_id WHERE o.id=$1",
      [id],
    );
    return r.rows[0]!;
  }

  /** planned → submitting (persist) → broadcast → settle. */
  async execute(orderId: string) {
    const o = await this.loadOrder(orderId);
    if (o.status !== "planned") return this.settle(orderId);
    let prepared;
    try {
      prepared = await this.exec.prepare({ clientOrderId: o.client_order_id, side: o.side, mint: o.mint, amountIn: BigInt(o.amount_in), slippageBps: o.slippage_bps });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn("order prepare failed", { orderId, error: msg });
      await this.failUnsent(o, msg, e instanceof PrepareError ? e.code : "rpc");
      return;
    }
    await this.db.query(
      `UPDATE trading_orders SET status='submitting', signature=$2, last_valid_block_height=$3, payload=$4, expected_out=$5, min_out=$6, venue=$7, quote=$8::jsonb, submitted_at=$9
       WHERE id=$1 AND status='planned'`,
      [orderId, prepared.signature, prepared.lastValidBlockHeight?.toString() ?? null, prepared.payload, prepared.expectedOut.toString(), prepared.minOut.toString(), prepared.venue, JSON.stringify(prepared.quote ?? null), this.clock.now().toISOString()],
    );
    await this.db.query(
      "INSERT INTO chain_transactions(chain, hash, kind, ref_type, ref_id, status, simulated, created_at) VALUES ('solana',$1,$2,'trading_order',$3,'submitted',$4,$5) ON CONFLICT DO NOTHING",
      [prepared.signature, o.side, orderId, this.exec.mode !== "live", this.clock.now().toISOString()],
    );
    try {
      await this.exec.broadcast(prepared);
    } catch (e) {
      // Broadcast errors are not failures: the signature may still land. settle() decides.
      this.log.warn("broadcast error; will settle from chain", { orderId, error: String(e) });
    }
    await this.settle(orderId);
  }

  /** The order never left: no chain effect. */
  private async failUnsent(o: OrderRow, error: string, code: string) {
    await this.db.tx(async (tx) => {
      await tx.query("UPDATE trading_orders SET status='failed', error=$2, settled_at=$3 WHERE id=$1 AND status='planned'", [o.id, `${code}: ${error}`.slice(0, 1000), this.clock.now().toISOString()]);
      if (o.side === "buy") await tx.query("UPDATE trading_positions SET status='failed', exit_reason=$2, closed_at=$3 WHERE id=$1", [o.position_id, `entry not sent: ${code}`, this.clock.now().toISOString()]);
      else await tx.query("UPDATE trading_positions SET status='open', exit_attempts=exit_attempts+1 WHERE id=$1", [o.position_id]);
    });
  }

  async settle(orderId: string) {
    const o = await this.loadOrder(orderId);
    if (o.status !== "submitting" || !o.signature) return;
    const r = await this.exec.settle({
      signature: o.signature,
      side: o.side,
      mint: o.mint,
      lastValidBlockHeight: o.last_valid_block_height ? BigInt(o.last_valid_block_height) : null,
      payload: o.payload ?? undefined,
    });
    if (r.state === "pending") return;
    const now = this.clock.now().toISOString();
    if (r.state === "expired") {
      await this.db.tx(async (tx) => {
        await tx.query("UPDATE trading_orders SET status='expired', error='never landed (blockhash expired)', settled_at=$2 WHERE id=$1 AND status='submitting'", [o.id, now]);
        await tx.query("UPDATE chain_transactions SET status='expired' WHERE chain='solana' AND hash=$1", [o.signature]);
        if (o.side === "buy") await tx.query("UPDATE trading_positions SET status='failed', exit_reason='entry expired', closed_at=$2 WHERE id=$1", [o.position_id, now]);
        else await tx.query("UPDATE trading_positions SET status='open', exit_attempts=exit_attempts+1 WHERE id=$1", [o.position_id]);
      });
      return;
    }
    if (r.state === "failed") {
      await this.db.tx(async (tx) => {
        const upd = await tx.query("UPDATE trading_orders SET status='failed', error=$2, fee_lamports=$3, settled_at=$4 WHERE id=$1 AND status='submitting' RETURNING id", [o.id, r.error.slice(0, 1000), r.feeLamports.toString(), now]);
        if (!upd.rows.length) return;
        await tx.query("UPDATE chain_transactions SET status='failed' WHERE chain='solana' AND hash=$1", [o.signature]);
        await postJournal(tx, this.clock, {
          key: `trade-fee:${o.id}`,
          kind: "network_fee",
          refType: "trading_order",
          refId: o.id,
          memo: "fee of a reverted transaction",
          entries: [
            { account: A.tradingAvailable, asset: "SOL", amount: -r.feeLamports },
            { account: A.fees, asset: "SOL", amount: r.feeLamports },
          ],
        });
        await tx.query("UPDATE trading_positions SET fees_lamports = fees_lamports + $2 WHERE id=$1", [o.position_id, r.feeLamports.toString()]);
        if (o.side === "buy") await tx.query("UPDATE trading_positions SET status='failed', exit_reason='entry reverted on chain', closed_at=$2 WHERE id=$1", [o.position_id, now]);
        else await tx.query("UPDATE trading_positions SET status='open', exit_attempts=exit_attempts+1 WHERE id=$1", [o.position_id]);
      });
      return;
    }
    if (o.side === "buy") await this.applyBuy(o, r.settlement);
    else await this.applySell(o, r.settlement);
  }

  private async applyBuy(o: OrderRow & { mint: string }, s: Settlement) {
    if (s.tokens <= 0n) throw new Error(`buy ${o.id} confirmed but no tokens arrived; refusing to book`);
    const now = this.clock.now().toISOString();
    const pos = await this.db.tx(async (tx) => {
      const upd = await tx.query(
        "UPDATE trading_orders SET status='confirmed', actual_in=$2, actual_out=$3, fee_lamports=$4, settled_at=$5 WHERE id=$1 AND status='submitting' RETURNING id",
        [o.id, s.sol.toString(), s.tokens.toString(), s.feeLamports.toString(), now],
      );
      if (!upd.rows.length) return null;
      await tx.query("UPDATE chain_transactions SET status='confirmed' WHERE chain='solana' AND hash=$1", [o.signature]);
      await postJournal(tx, this.clock, {
        key: `trade:${o.id}`,
        kind: "trade_buy",
        refType: "trading_order",
        refId: o.id,
        entries: [
          { account: A.tradingAvailable, asset: "SOL", amount: -s.sol },
          { account: A.positions, asset: "SOL", amount: s.sol },
        ],
      });
      const p = await tx.query<PositionRow>(
        `UPDATE trading_positions SET status='open', tokens_bought=$2, token_amount=$2, cost_lamports=$3, remaining_cost_lamports=$3,
           fees_lamports = fees_lamports + $4, peak_value_lamports=$3, last_value_lamports=$3, last_marked_at=$5, token_decimals=COALESCE($6, token_decimals)
         WHERE id=$1 RETURNING *`,
        [o.position_id, s.tokens.toString(), s.sol.toString(), s.feeLamports.toString(), now, s.tokenDecimals],
      );
      const pr = p.rows[0]!;
      await notify(
        tx,
        this.clock,
        `pos-open:${pr.id}`,
        "position_open",
        `🔥 <b>AUTO HUNT entered $${esc(pr.symbol ?? "?")}</b>\nSize: ${formatAsset(s.sol, "SOL")}${this.modeTag()}\n<code>${pr.mint}</code>${this.exec.mode === "live" ? `\n<a href="${solscanTx(o.signature!)}">tx</a>` : ""}`,
      );
      return pr;
    });
    if (pos) this.log.info("position opened", { positionId: pos.id, mint: pos.mint, cost: s.sol });
  }

  private modeTag() {
    return this.exec.mode === "live" ? "" : ` <i>(${this.exec.mode})</i>`;
  }

  private async applySell(o: OrderRow & { mint: string }, s: Settlement) {
    const now = this.clock.now().toISOString();
    const closed = await this.db.tx(async (tx) => {
      const upd = await tx.query(
        "UPDATE trading_orders SET status='confirmed', actual_in=$2, actual_out=$3, fee_lamports=$4, settled_at=$5 WHERE id=$1 AND status='submitting' RETURNING id",
        [o.id, s.tokens.toString(), s.sol.toString(), s.feeLamports.toString(), now],
      );
      if (!upd.rows.length) return null;
      await tx.query("UPDATE chain_transactions SET status='confirmed' WHERE chain='solana' AND hash=$1", [o.signature]);
      const p = (await tx.query<PositionRow>("SELECT * FROM trading_positions WHERE id=$1 FOR UPDATE", [o.position_id])).rows[0]!;
      const held = BigInt(p.token_amount);
      const remainingCost = BigInt(p.remaining_cost_lamports);
      const sold = s.tokens > held ? held : s.tokens;
      const costPortion = sold >= held ? remainingCost : (remainingCost * sold) / held;
      const left = held - sold;
      const pnl = s.sol - costPortion;
      await postJournal(tx, this.clock, {
        key: `trade:${o.id}`,
        kind: "trade_sell",
        refType: "trading_order",
        refId: o.id,
        entries: [
          { account: A.positions, asset: "SOL", amount: -costPortion },
          { account: A.tradingAvailable, asset: "SOL", amount: s.sol },
          { account: A.pnl, asset: "SOL", amount: -pnl },
        ],
      });
      const isClosed = left === 0n;
      const peak = BigInt(p.peak_value_lamports);
      const newPeak = held > 0n ? (peak * left) / held : 0n;
      const r = await tx.query<PositionRow>(
        `UPDATE trading_positions SET token_amount=$2, remaining_cost_lamports=$3, proceeds_lamports = proceeds_lamports + $4,
           realized_pnl_lamports = realized_pnl_lamports + $5, fees_lamports = fees_lamports + $6, peak_value_lamports=$7,
           take_profit_done = take_profit_done OR $8, status=$9, closed_at=$10, exit_attempts=0
         WHERE id=$1 RETURNING *`,
        [
          p.id,
          left.toString(),
          (remainingCost - costPortion).toString(),
          s.sol.toString(),
          pnl.toString(),
          s.feeLamports.toString(),
          newPeak.toString(),
          o.reason === "take_profit",
          isClosed ? "closed" : "open",
          isClosed ? now : null,
        ],
      );
      const pr = r.rows[0]!;
      const total = BigInt(pr.realized_pnl_lamports);
      const pct = Number(BigInt(pr.cost_lamports)) > 0 ? (Number(total) / Number(BigInt(pr.cost_lamports))) * 100 : 0;
      await notify(
        tx,
        this.clock,
        `pos-sell:${o.id}`,
        "position_close",
        `${pnl >= 0n ? "🟢" : "🔴"} <b>AUTO HUNT ${isClosed ? "closed" : "trimmed"} $${esc(pr.symbol ?? "?")}</b> (${esc(o.reason ?? "exit")})\nReceived ${formatAsset(s.sol, "SOL")}, P&L ${pnl >= 0n ? "+" : ""}${formatAsset(pnl, "SOL")}${isClosed ? ` · position ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : ""}${this.modeTag()}${this.exec.mode === "live" ? `\n<a href="${solscanTx(o.signature!)}">tx</a>` : ""}`,
      );
      return isClosed ? pr : null;
    });
    if (closed && this.exec.closeTokenAccount) await this.recoverRent(closed);
  }

  /** Close the emptied token account and book the recovered rent. */
  private async recoverRent(pos: PositionRow) {
    try {
      const r = await this.exec.closeTokenAccount!(pos.mint);
      if (!r || r.lamports <= 0n) return;
      await this.db.tx(async (tx) => {
        const j = await postJournal(tx, this.clock, {
          key: `ata-close:${pos.id}`,
          kind: "rent_recovered",
          refType: "trading_position",
          refId: pos.id,
          entries: [
            { account: A.tradingAvailable, asset: "SOL", amount: r.lamports },
            { account: A.pnl, asset: "SOL", amount: -r.lamports },
          ],
        });
        if (j.created) await tx.query("UPDATE trading_positions SET realized_pnl_lamports = realized_pnl_lamports + $2, proceeds_lamports = proceeds_lamports + $2 WHERE id=$1", [pos.id, r.lamports.toString()]);
      });
    } catch (e) {
      this.log.warn("token account close failed", { positionId: pos.id, error: String(e) });
    }
  }

  async mark(pos: PositionRow, value: bigint | null) {
    if (value === null) return;
    await this.db.query(
      "UPDATE trading_positions SET last_value_lamports=$2, last_marked_at=$3, peak_value_lamports=GREATEST(peak_value_lamports, $2) WHERE id=$1",
      [pos.id, value.toString(), this.clock.now().toISOString()],
    );
  }

  /** Record a position that cannot be sold or recovered. Tokens stay recorded; cost becomes a realized loss. */
  async writeOff(pos: PositionRow, reason: string) {
    await this.db.tx(async (tx) => {
      const p = (await tx.query<PositionRow>("SELECT * FROM trading_positions WHERE id=$1 FOR UPDATE", [pos.id])).rows[0]!;
      if (!["open", "closing"].includes(p.status)) return;
      const pending = await tx.query("SELECT 1 FROM trading_orders WHERE position_id=$1 AND status IN ('planned','submitting')", [p.id]);
      if (pending.rows.length) return;
      const rc = BigInt(p.remaining_cost_lamports);
      if (rc > 0n) {
        await postJournal(tx, this.clock, {
          key: `writeoff:${p.id}`,
          kind: "write_off",
          refType: "trading_position",
          refId: p.id,
          memo: reason,
          entries: [
            { account: A.positions, asset: "SOL", amount: -rc },
            { account: A.pnl, asset: "SOL", amount: rc },
          ],
        });
      }
      await tx.query(
        "UPDATE trading_positions SET status='written_off', exit_reason=$2, remaining_cost_lamports=0, realized_pnl_lamports = realized_pnl_lamports - $3, closed_at=$4 WHERE id=$1",
        [p.id, reason, rc.toString(), this.clock.now().toISOString()],
      );
      await notify(tx, this.clock, `writeoff:${p.id}`, "position_close", `🪦 <b>Position written off</b> $${esc(p.symbol ?? "?")}: ${esc(reason)}. ${formatAsset(rc, "SOL")} cost recorded as loss; tokens remain in the trading wallet.`);
    });
  }

  /** Cancel buy orders that were never signed (wind-down, pause). */
  async cancelUnsentBuys(reason: string) {
    const r = await this.db.query<OrderRow>("SELECT * FROM trading_orders WHERE side='buy' AND status='planned'");
    for (const o of r.rows) await this.failUnsent(o, reason, "cancelled");
    return r.rows.length;
  }
}
