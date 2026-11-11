/**
 * NearChain: everything BAGFLIP reads from (and, in live mode, writes to) NEAR.
 *
 * RpcNearChain talks to real NEAR RPC + FastNEAR indexer APIs.
 * SimNearChain is the BAGFLIP_ENV=development stand-in: balances and access keys
 * come from the sim_* tables, blocks are derived from the clock, and nothing
 * leaves the machine.
 */
import type { Db } from "../db/index.ts";
import type { Clock } from "../shared/time.ts";
import { NearRpc, type BlockRef } from "./rpc.ts";
import { fetchRetry } from "../shared/http.ts";

export const WRAP_NEAR = "wrap.near";

export interface IncomingTransfer {
  txHash: string;
  receiptId: string;
  sender: string;
  /** NEAR-equivalent yocto amount (native NEAR or wNEAR). */
  amount: bigint;
  kind: "native" | "wnear";
  blockHeight: bigint;
  blockTimestamp: Date;
}

export interface NearChain {
  readonly simulated: boolean;
  finalBlock(): Promise<BlockRef>;
  /** First block with timestamp >= ts (for late snapshots). Null if not resolvable. */
  blockAtOrAfter(ts: Date): Promise<BlockRef | null>;
  ftBalances(token: string, accounts: string[], block: BlockRef): Promise<Map<string, bigint>>;
  ftTotalSupply(token: string, block: BlockRef): Promise<bigint>;
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
  /** Native + wNEAR balance actually held by an account (for reconciliation). */
  nearHoldings(accountId: string): Promise<{ native: bigint; wrapped: bigint }>;
  /** New incoming transfers to `account`, newest first, stopping at sinceBlock. */
  incomingTransfers(account: string, sinceBlock: bigint): Promise<IncomingTransfer[]>;
  /** All incoming transfers to `account` inside one transaction. */
  transfersInTx(txHash: string, account: string): Promise<IncomingTransfer[]>;
}

// ───────────────────────────── real chain ─────────────────────────────

interface FastTxReceipt {
  receipt: {
    block_height: number;
    block_timestamp: number | string;
    predecessor_id: string;
    receiver_id: string;
    receipt_id: string;
    receipt: { Action?: { actions: Array<Record<string, any>> } };
  };
  execution_outcome: { outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } };
}
interface FastTx {
  transaction: { hash: string; signer_id: string };
  receipts: FastTxReceipt[];
}

/** Pure parser shared by the scanner and manual deposit verification. */
export function parseIncoming(tx: FastTx, account: string, wrapContract = WRAP_NEAR): IncomingTransfer[] {
  const out: IncomingTransfer[] = [];
  for (const r of tx.receipts ?? []) {
    const rec = r.receipt;
    const ok = r.execution_outcome?.outcome?.status && !("Failure" in r.execution_outcome.outcome.status);
    if (!ok) continue;
    const ts = new Date(Number(BigInt(String(rec.block_timestamp)) / 1_000_000n));
    // Native transfers (skip "system" gas refunds).
    if (rec.receiver_id === account && rec.predecessor_id !== "system") {
      for (const a of rec.receipt.Action?.actions ?? []) {
        const dep = a?.Transfer?.deposit;
        if (dep && BigInt(dep) > 0n) {
          out.push({ txHash: tx.transaction.hash, receiptId: `${rec.receipt_id}:native`, sender: rec.predecessor_id, amount: BigInt(dep), kind: "native", blockHeight: BigInt(rec.block_height), blockTimestamp: ts });
        }
      }
    }
    // wNEAR NEP-141 transfers into the account.
    if (r.execution_outcome.outcome.executor_id === wrapContract) {
      r.execution_outcome.outcome.logs.forEach((log, i) => {
        if (!log.startsWith("EVENT_JSON:")) return;
        try {
          const e = JSON.parse(log.slice(11));
          if (e.standard !== "nep141" || e.event !== "ft_transfer") return;
          (e.data as Array<{ old_owner_id: string; new_owner_id: string; amount: string }>).forEach((d, j) => {
            if (d.new_owner_id === account && BigInt(d.amount) > 0n) {
              out.push({ txHash: tx.transaction.hash, receiptId: `${rec.receipt_id}:ft:${i}:${j}`, sender: d.old_owner_id, amount: BigInt(d.amount), kind: "wnear", blockHeight: BigInt(rec.block_height), blockTimestamp: ts });
            }
          });
        } catch {
          /* malformed log */
        }
      });
    }
  }
  return out;
}

export class RpcNearChain implements NearChain {
  readonly simulated = false;
  public rpc: NearRpc;
  private fastTxApi: string;
  private wrapContract: any;
  constructor(
    rpc: NearRpc,
    fastTxApi: string,
    wrapContract = WRAP_NEAR,
  ) {
    this.rpc = rpc;
    this.fastTxApi = fastTxApi;
    this.wrapContract = wrapContract;}

  finalBlock() {
    return this.rpc.block({ finality: "final" });
  }

  async blockAtOrAfter(ts: Date): Promise<BlockRef | null> {
    const head = await this.finalBlock();
    if (head.timestamp < ts) return null;
    // ~1 block/sec; binary search a window bounded by elapsed seconds * 3.
    const elapsedS = BigInt(Math.ceil((head.timestamp.getTime() - ts.getTime()) / 1000));
    let lo = head.height - elapsedS * 3n - 100n;
    let hi = head.height;
    let best: BlockRef = head;
    try {
      while (lo <= hi) {
        const mid = (lo + hi) / 2n;
        let b: BlockRef | null = null;
        // Some heights are skipped; probe forward a few.
        for (let k = 0n; k < 5n && !b; k++) {
          try {
            b = await this.rpc.block({ block_id: Number(mid + k) });
          } catch {
            /* missing height */
          }
        }
        if (!b) {
          lo = mid + 5n;
          continue;
        }
        if (b.timestamp >= ts) {
          best = b;
          hi = mid - 1n;
        } else lo = mid + 1n;
      }
      return best;
    } catch {
      return null; // garbage-collected on a non-archival node
    }
  }

  async ftBalances(token: string, accounts: string[], block: BlockRef) {
    const out = new Map<string, bigint>();
    const queue = [...new Set(accounts)];
    const worker = async () => {
      for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
        const bal = await this.rpc.viewAt<string>(token, "ft_balance_of", { account_id: a }, block.height);
        out.set(a, BigInt(bal));
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    return out;
  }

  async ftTotalSupply(token: string, block: BlockRef) {
    return BigInt(await this.rpc.viewAt<string>(token, "ft_total_supply", {}, block.height));
  }

  async isFullAccessKey(accountId: string, publicKey: string) {
    const k = await this.rpc.accessKey(accountId, publicKey);
    return k?.permission === "FullAccess";
  }

  async nearHoldings(accountId: string) {
    const [acc, wrapped] = await Promise.all([
      this.rpc.accountBalance(accountId),
      this.rpc.viewAt<string>(this.wrapContract, "ft_balance_of", { account_id: accountId }).then(BigInt),
    ]);
    return { native: acc.amount, wrapped };
  }

  private async fetchTxs(hashes: string[]): Promise<FastTx[]> {
    const out: FastTx[] = [];
    for (let i = 0; i < hashes.length; i += 20) {
      const res = await fetchRetry(`${this.fastTxApi}/v0/transactions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hashes: hashes.slice(i, i + 20) }) });
      if (!res.ok) throw new Error(`FastNEAR tx API HTTP ${res.status}`);
      out.push(...((await res.json()) as { transactions: FastTx[] }).transactions);
    }
    return out;
  }

  async incomingTransfers(account: string, sinceBlock: bigint) {
    const hashes: string[] = [];
    let resume: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await fetchRetry(`${this.fastTxApi}/v0/account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: account, is_real_receiver: true, ...(resume ? { resume_token: resume } : {}) }) });
      if (!res.ok) throw new Error(`FastNEAR account API HTTP ${res.status}`);
      const j = (await res.json()) as { account_txs: { transaction_hash: string; tx_block_height: number; is_success: boolean }[]; resume_token?: string };
      let reachedOld = false;
      for (const t of j.account_txs) {
        if (BigInt(t.tx_block_height) <= sinceBlock) {
          reachedOld = true;
          break;
        }
        if (t.is_success) hashes.push(t.transaction_hash);
      }
      if (reachedOld || !j.resume_token || j.account_txs.length === 0) break;
      resume = j.resume_token;
    }
    const txs = await this.fetchTxs(hashes);
    return txs.flatMap((t) => parseIncoming(t, account, this.wrapContract));
  }

  async transfersInTx(txHash: string, account: string) {
    const [tx] = await this.fetchTxs([txHash]);
    return tx ? parseIncoming(tx, account, this.wrapContract) : [];
  }
}

// ───────────────────────────── simulated chain ─────────────────────────────

const SIM_GENESIS = Date.UTC(2026, 0, 1);

export class SimNearChain implements NearChain {
  readonly simulated = true;
  private db: Db;
  private clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.db = db;
    this.clock = clock;}

  private ref(t: Date): BlockRef {
    const h = BigInt(Math.floor((t.getTime() - SIM_GENESIS) / 1000));
    return { height: h, hash: `sim-${h}`, timestamp: new Date(SIM_GENESIS + Number(h) * 1000) };
  }
  async finalBlock() {
    return this.ref(this.clock.now());
  }
  async blockAtOrAfter(ts: Date) {
    return this.ref(new Date(Math.ceil(ts.getTime() / 1000) * 1000));
  }
  async ftBalances(_token: string, accounts: string[]) {
    const r = await this.db.query<{ account_id: string; balance: string }>(
      "SELECT account_id, balance FROM sim_near_balances WHERE account_id = ANY($1::text[])",
      [accounts],
    );
    const m = new Map<string, bigint>(accounts.map((a) => [a, 0n]));
    for (const row of r.rows) m.set(row.account_id, BigInt(row.balance));
    return m;
  }
  async ftTotalSupply() {
    const r = await this.db.query<{ s: string | null }>("SELECT COALESCE(SUM(balance),0)::text AS s FROM sim_near_balances");
    return BigInt(r.rows[0]?.s ?? "0");
  }
  async isFullAccessKey(accountId: string, publicKey: string) {
    const r = await this.db.query("SELECT 1 FROM sim_near_keys WHERE account_id=$1 AND public_key=$2", [accountId, publicKey]);
    return r.rows.length > 0;
  }
  async nearHoldings() {
    return { native: 0n, wrapped: 0n };
  }
  async incomingTransfers() {
    return [];
  }
  async transfersInTx() {
    return [];
  }

  // dev helpers
  async setBalance(accountId: string, balance: bigint) {
    await this.db.query(
      `INSERT INTO sim_near_balances(account_id, balance) VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET balance = EXCLUDED.balance`,
      [accountId, balance.toString()],
    );
  }
  async addKey(accountId: string, publicKey: string) {
    await this.db.query("INSERT INTO sim_near_keys(account_id, public_key) VALUES ($1,$2) ON CONFLICT DO NOTHING", [accountId, publicKey]);
  }
  async allHolders(): Promise<string[]> {
    const r = await this.db.query<{ account_id: string }>("SELECT account_id FROM sim_near_balances WHERE balance > 0");
    return r.rows.map((x) => x.account_id);
  }
}
