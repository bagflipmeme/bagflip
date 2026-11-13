/** Minimal NEAR JSON-RPC client. Every read can be pinned to a block height. */

// Process-wide pacing (~15 req/s) so snapshots of hundreds of accounts stay under public RPC limits.
let nextSlot = 0;
async function pace(gapMs = 66) {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + gapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export class NearRpcError extends Error {
  public data?: unknown;
  constructor(message: string, data?: unknown) {
    super(message);
    this.data = data;
  }
}

export interface BlockRef {
  height: bigint;
  hash: string;
  timestamp: Date;
}

export type BlockId = { finality: "final" } | { block_id: number | string };

export class NearRpc {
  private url: string;
  private archivalUrl?: string;
  private timeoutMs: any;
  constructor(url: string, archivalUrl?: string, timeoutMs = 20_000) {
    this.url = url;
    this.archivalUrl = archivalUrl;
    this.timeoutMs = timeoutMs;}

  async call<T>(method: string, params: unknown, archival = false): Promise<T> {
    const url = archival && this.archivalUrl ? this.archivalUrl : this.url;
    let lastErr: unknown;
    // Free RPC endpoints rate-limit hard; snapshots of hundreds of accounts must survive 429s.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await pace();
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "bagflip", method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw new NearRpcError(`NEAR RPC HTTP ${res.status}`);
        if (!res.ok) throw new NearRpcError(`NEAR RPC HTTP ${res.status}`);
        const j = (await res.json()) as { result?: T; error?: { name?: string; cause?: { name?: string }; data?: unknown; message?: string } };
        if (j.error) {
          const name = j.error.cause?.name ?? j.error.name ?? "RPC_ERROR";
          throw new NearRpcError(`NEAR RPC ${name}: ${JSON.stringify(j.error.data ?? j.error.message).slice(0, 300)}`, j.error);
        }
        return j.result as T;
      } catch (e) {
        lastErr = e;
        const transient = !(e instanceof NearRpcError) || /HTTP (429|5\d\d)|TIMEOUT/.test(e.message);
        if (!transient) throw e;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 250));
      }
    }
    throw lastErr;
  }

  async block(ref: BlockId): Promise<BlockRef> {
    const b = await this.call<{ header: { height: number; hash: string; timestamp_nanosec: string } }>(
      "block",
      ref,
      "block_id" in ref,
    );
    return { height: BigInt(b.header.height), hash: b.header.hash, timestamp: new Date(Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n)) };
  }

  async viewAt<T>(contract: string, method: string, args: Record<string, unknown>, blockHeight?: bigint): Promise<T> {
    const r = await this.call<{ result: number[] }>(
      "query",
      {
        request_type: "call_function",
        ...(blockHeight !== undefined ? { block_id: Number(blockHeight) } : { finality: "final" }),
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
      blockHeight !== undefined,
    );
    return JSON.parse(Buffer.from(r.result).toString()) as T;
  }

  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; blockHash: string; permission: "FullAccess" | { FunctionCall: unknown } } | null> {
    try {
      const r = await this.call<{ nonce?: number | string; block_hash: string; permission: "FullAccess" | { FunctionCall: unknown }; error?: string }>("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
      // Some RPCs answer a missing key with HTTP 200 and { error: "access key ... does not exist" }.
      if (r.error || r.nonce === undefined) return null;
      return { nonce: BigInt(r.nonce), blockHash: r.block_hash, permission: r.permission };
    } catch (e) {
      if (e instanceof NearRpcError && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/.test(e.message)) return null;
      throw e;
    }
  }

  async accountBalance(accountId: string): Promise<{ amount: bigint; locked: bigint; storageUsage: bigint }> {
    const r = await this.call<{ amount: string; locked: string; storage_usage: number }>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return { amount: BigInt(r.amount), locked: BigInt(r.locked), storageUsage: BigInt(r.storage_usage) };
  }

  async txStatus(txHash: string, senderId: string): Promise<TxStatusResult> {
    try {
      const r = await this.call<RawTxStatus>("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
      return { state: r.status && "Failure" in r.status ? "failure" : r.status && "SuccessValue" in r.status ? "success" : "pending", raw: r };
    } catch (e) {
      if (e instanceof NearRpcError && /UNKNOWN_TRANSACTION|TIMEOUT_ERROR|doesn't exist/i.test(e.message)) return { state: "unknown" };
      throw e;
    }
  }

  /** Broadcast a signed transaction. Re-broadcasting the same bytes is idempotent on NEAR. */
  async sendSigned(signedTxBase64: string): Promise<{ hash: string; state: "success" | "failure" | "pending"; raw?: RawTxStatus }> {
    try {
      const r = await this.call<RawTxStatus>("send_tx", { signed_tx_base64: signedTxBase64, wait_until: "FINAL" });
      const state = r.status && "Failure" in r.status ? "failure" : r.status && "SuccessValue" in r.status ? "success" : "pending";
      return { hash: r.transaction.hash, state, raw: r };
    } catch (e) {
      if (e instanceof NearRpcError && /TIMEOUT_ERROR/.test(e.message)) return { hash: "", state: "pending" };
      throw e;
    }
  }
}

export interface RawTxStatus {
  status?: { SuccessValue?: string; Failure?: unknown };
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  transaction_outcome: { block_hash: string; outcome: { tokens_burnt: string; receipt_ids: string[] } };
  receipts_outcome: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[]; tokens_burnt: string; status: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown } } }[];
  receipts?: { receipt_id: string; predecessor_id: string; receiver_id: string; receipt: { Action?: { actions: unknown[]; signer_id: string } } }[];
}

export interface TxStatusResult {
  state: "success" | "failure" | "pending" | "unknown";
  raw?: RawTxStatus;
}
