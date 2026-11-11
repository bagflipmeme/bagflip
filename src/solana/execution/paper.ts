/**
 * PAPER execution: real Jupiter quotes (real routes, real price impact) with a
 * conservative fill model — extra adverse slippage, network + priority fees,
 * token-account rent, and a seeded probability of a failed transaction that
 * still burns its fee. No transaction is ever signed or sent.
 */
import type { JupiterClient } from "./jupiter.ts";
import {
  ATA_RENT_LAMPORTS,
  BASE_FEE_LAMPORTS,
  PrepareError,
  type ExecutionAdapter,
  type OrderIntent,
  type PreparedOrder,
  type SettleResult,
  type SwapQuote,
} from "./types.ts";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface QuoteSource {
  quote(side: "buy" | "sell", mint: string, amount: bigint): Promise<SwapQuote | null>;
}

export class PaperExecution implements ExecutionAdapter {
  readonly mode = "paper" as const;
  private rng: () => number;
  private held = new Map<string, bigint>();

  private quotes: QuoteSource | JupiterClient;
  private opts: { extraSlippageBps: number; failureRate: number; priorityFeeLamports: number; seed: number; ledgerSol: () => Promise<bigint> };
  constructor(
    quotes: QuoteSource | JupiterClient,
    opts: { extraSlippageBps: number; failureRate: number; priorityFeeLamports: number; seed: number; ledgerSol: () => Promise<bigint> },
  ) {
    this.quotes = quotes;
    this.opts = opts;
    this.rng = mulberry32(opts.seed);
  }

  quoteBuy(mint: string, lamports: bigint) {
    return this.quotes.quote("buy", mint, lamports);
  }
  quoteSell(mint: string, tokens: bigint) {
    return this.quotes.quote("sell", mint, tokens);
  }

  async prepare(o: OrderIntent): Promise<PreparedOrder> {
    const q = await this.quotes.quote(o.side, o.mint, o.amountIn);
    if (!q) throw new PrepareError("no route", "no_route");
    const fee = BASE_FEE_LAMPORTS + BigInt(this.opts.priorityFeeLamports);
    const out = (q.outAmount * BigInt(10_000 - this.opts.extraSlippageBps)) / 10_000n;
    const minOut = (q.outAmount * BigInt(10_000 - o.slippageBps)) / 10_000n;
    const failed = this.rng() < this.opts.failureRate || out < minOut;
    const result: SettleResult = failed
      ? { state: "failed", feeLamports: fee, error: out < minOut ? "slippage exceeded (paper)" : "simulated network failure (paper)" }
      : {
          state: "confirmed",
          settlement:
            o.side === "buy"
              ? { sol: o.amountIn + fee + ATA_RENT_LAMPORTS, tokens: out, feeLamports: fee, tokenDecimals: null }
              : { sol: out - fee, tokens: o.amountIn, feeLamports: fee, tokenDecimals: null },
        };
    return {
      signature: `paper-${o.clientOrderId}`,
      lastValidBlockHeight: null,
      expectedOut: q.outAmount,
      minOut,
      venue: `paper/${q.venue}`,
      payload: JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)),
      quote: q.raw ?? null,
    };
  }

  async broadcast() {}

  async settle(o: { side: "buy" | "sell"; mint: string; payload?: string }): Promise<SettleResult> {
    if (!o.payload) return { state: "expired" };
    const r = JSON.parse(o.payload, (_k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as SettleResult;
    if (r.state === "confirmed") {
      const cur = this.held.get(o.mint) ?? 0n;
      this.held.set(o.mint, o.side === "buy" ? cur + r.settlement.tokens : cur - r.settlement.tokens);
    }
    return r;
  }

  solBalance() {
    return this.opts.ledgerSol();
  }
  async tokenBalance(mint: string) {
    return this.held.get(mint) ?? 0n;
  }
  async closeTokenAccount() {
    // Paper fills charge ATA rent on buy; model its recovery on close.
    return { signature: "paper-close", lamports: ATA_RENT_LAMPORTS - BASE_FEE_LAMPORTS };
  }
}
