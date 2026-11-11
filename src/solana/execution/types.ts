/**
 * Execution adapters turn a strategy decision into a Solana transaction.
 * The strategy never talks to a venue directly. Every adapter is two-phase:
 *   prepare()   → quote, build, SIMULATE and sign; returns the signature
 *   broadcast() → send (after the caller has persisted the signature)
 *   settle()    → read the confirmed result back from chain
 * so a crash at any point is recoverable without placing a duplicate order.
 */

export type ExecMode = "simulated" | "paper" | "live";

export interface SwapQuote {
  side: "buy" | "sell";
  mint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
  feeBps: number;
  venue: string;
  raw?: unknown;
}

export interface OrderIntent {
  clientOrderId: string;
  side: "buy" | "sell";
  mint: string;
  /** buy: lamports in; sell: token base units in */
  amountIn: bigint;
  slippageBps: number;
}

export interface PreparedOrder {
  signature: string;
  lastValidBlockHeight: bigint | null;
  expectedOut: bigint;
  minOut: bigint;
  venue: string;
  /** Opaque data broadcast() needs (signed tx, request id...). */
  payload: string;
  quote: unknown;
}

export interface Settlement {
  /** Lamports that left the wallet for a buy (positive) / net lamports received for a sell (positive). */
  sol: bigint;
  /** Tokens received (buy) or sent (sell), positive. */
  tokens: bigint;
  feeLamports: bigint;
  tokenDecimals: number | null;
}

export type SettleResult =
  | { state: "confirmed"; settlement: Settlement }
  | { state: "failed"; feeLamports: bigint; error: string }
  | { state: "expired" }
  | { state: "pending" };

export class PrepareError extends Error {
  public code: "no_route" | "simulation_failed" | "quote_failed" | "rpc" | "not_enabled";
  constructor(message: string, code: "no_route" | "simulation_failed" | "quote_failed" | "rpc" | "not_enabled") {
    super(message);
    this.code = code;
  }
}

export interface ExecutionAdapter {
  readonly mode: ExecMode;
  quoteBuy(mint: string, lamports: bigint): Promise<SwapQuote | null>;
  quoteSell(mint: string, tokens: bigint): Promise<SwapQuote | null>;
  prepare(o: OrderIntent): Promise<PreparedOrder>;
  broadcast(p: PreparedOrder): Promise<void>;
  settle(o: { signature: string; side: "buy" | "sell"; mint: string; lastValidBlockHeight: bigint | null; payload?: string }): Promise<SettleResult>;
  solBalance(): Promise<bigint>;
  tokenBalance(mint: string): Promise<bigint>;
  /** Recover rent from an emptied token account (live); returns lamports recovered. */
  closeTokenAccount?(mint: string): Promise<{ signature: string; lamports: bigint } | null>;
}

/** Fixed per-trade costs used for economic viability checks. */
export const ATA_RENT_LAMPORTS = 2_039_280n;
export const BASE_FEE_LAMPORTS = 5_000n;
