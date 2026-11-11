/**
 * Holder discovery for distributions. Registered voters are NOT enough: every
 * holder is entitled to a share, registered or not (they can /connect later
 * and claim). Discovery only finds *candidate* accounts; entitlements always
 * use balances read via RPC at one snapshot block.
 *
 * FastNearHolderIndex scans every transaction that touched the token contract
 * (FastNEAR tx API, verified 2026-11-09: 4,275 txs for a test token) and
 * collects every account named in NEP-141 ft_mint / ft_transfer / ft_burn
 * events. It is incremental (cursor = highest block processed) and marks itself
 * complete once it has walked back to the contract's first transaction.
 * FastNEAR's /v1/ft/{token}/top (top 100) is merged in as a cross-check.
 */
import type { Db } from "../db/index.ts";
import { getState, setState } from "../db/index.ts";
import { fetchRetry } from "../shared/http.ts";
import type { Logger } from "../shared/log.ts";

export interface HolderDiscovery {
  accounts: string[];
  source: string;
  complete: boolean;
}

export interface HolderSource {
  discover(): Promise<HolderDiscovery>;
}

export function accountsFromEventLog(log: string): string[] {
  if (!log.startsWith("EVENT_JSON:")) return [];
  try {
    const e = JSON.parse(log.slice(11)) as { standard?: string; event?: string; data?: Record<string, unknown>[] };
    if (e.standard !== "nep141" || !Array.isArray(e.data)) return [];
    const out: string[] = [];
    for (const d of e.data) for (const k of ["owner_id", "old_owner_id", "new_owner_id"]) if (typeof d[k] === "string") out.push(d[k] as string);
    return out;
  } catch {
    return [];
  }
}

export class FastNearHolderIndex implements HolderSource {
  private db: Db;
  private token: string;
  private txApi: string;
  private api: string;
  private log: Logger;
  constructor(
    db: Db,
    token: string,
    txApi: string,
    api: string,
    log: Logger,
  ) {
    this.db = db;
    this.token = token;
    this.txApi = txApi;
    this.api = api;
    this.log = log;}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchRetry(`${this.txApi}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`FastNEAR ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async sync(): Promise<{ newTxs: number; complete: boolean }> {
    const cursor = BigInt((await getState<string>(this.db, `holder_cursor:${this.token}`)) ?? "0");
    let complete = (await getState<boolean>(this.db, `holder_complete:${this.token}`)) ?? false;
    const hashes: string[] = [];
    let maxH = cursor;
    let resume: string | undefined;
    let reachedStart = false;
    for (let page = 0; page < 200; page++) {
      const j = await this.post<{ account_txs: { transaction_hash: string; tx_block_height: number }[]; resume_token?: string }>("/v0/account", {
        account_id: this.token,
        ...(resume ? { resume_token: resume } : {}),
      });
      let stop = false;
      for (const t of j.account_txs) {
        const h = BigInt(t.tx_block_height);
        if (h <= cursor) {
          stop = true;
          break;
        }
        if (h > maxH) maxH = h;
        hashes.push(t.transaction_hash);
      }
      if (stop) break;
      if (!j.resume_token || !j.account_txs.length) {
        reachedStart = true;
        break;
      }
      resume = j.resume_token;
    }
    const seen = new Set<string>();
    for (let i = 0; i < hashes.length; i += 20) {
      const j = await this.post<{ transactions: { receipts: { execution_outcome: { outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } } }[] }[] }>(
        "/v0/transactions",
        { tx_hashes: hashes.slice(i, i + 20) },
      );
      for (const tx of j.transactions) {
        for (const r of tx.receipts ?? []) {
          const o = r.execution_outcome.outcome;
          if (o.executor_id !== this.token || "Failure" in (o.status ?? {})) continue;
          for (const l of o.logs) for (const a of accountsFromEventLog(l)) seen.add(a);
        }
      }
    }
    for (const a of seen) {
      await this.db.query(
        `INSERT INTO holder_index(account_id, first_seen_block, last_seen_block, updated_at) VALUES ($1,$2,$2,now())
         ON CONFLICT (account_id) DO UPDATE SET last_seen_block = GREATEST(holder_index.last_seen_block, EXCLUDED.last_seen_block), updated_at = now()`,
        [a, maxH.toString()],
      );
    }
    if (cursor === 0n && reachedStart) complete = true;
    await setState(this.db, `holder_cursor:${this.token}`, maxH.toString());
    await setState(this.db, `holder_complete:${this.token}`, complete);
    this.log.info("holder index synced", { newTxs: hashes.length, accounts: seen.size, complete });
    return { newTxs: hashes.length, complete };
  }

  async top(): Promise<string[]> {
    try {
      const res = await fetchRetry(`${this.api}/v1/ft/${this.token}/top`);
      if (!res.ok) return [];
      const j = (await res.json()) as { accounts: { account_id: string }[] };
      return j.accounts.map((a) => a.account_id);
    } catch {
      return [];
    }
  }

  async discover(): Promise<HolderDiscovery> {
    const { complete } = await this.sync();
    const idx = await this.db.query<{ account_id: string }>("SELECT account_id FROM holder_index");
    const accounts = new Set([...idx.rows.map((r) => r.account_id), ...(await this.top())]);
    return { accounts: [...accounts], source: complete ? "fastnear-events(complete)+top" : "fastnear-events(partial)+top", complete };
  }
}

export class StaticHolderSource implements HolderSource {
  private fn: () => Promise<string[]>;
  private name: any;
  constructor(fn: () => Promise<string[]>, name = "sim") {
    this.fn = fn;
    this.name = name;}
  async discover() {
    return { accounts: await this.fn(), source: this.name, complete: true };
  }
}
