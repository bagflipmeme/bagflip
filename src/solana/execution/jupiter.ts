/**
 * Jupiter Swap API V2 (verified 2026-11-09 at developers.jup.ag):
 *   GET  {base}/order?inputMint&outputMint&amount&taker[&slippageBps]  → { transaction (base64|null), requestId, outAmount, priceImpactPct, feeBps, router, ... }
 *   POST {base}/execute { signedTransaction, requestId }               → { status, signature, code, error, ... }
 * Keyless use is limited to 0.5 req/s; set JUPITER_API_KEY (x-api-key) for production.
 * A keyless quote for a live Pump.fun bonding-curve token routed through label "Pump.fun".
 */
import { VersionedTransaction } from "@solana/web3.js";
import { RateLimiter } from "../../market/dexscreener.ts";
import { WSOL_MINT } from "../rpc.ts";
import type { SwapQuote } from "./types.ts";

export interface JupiterOrder {
  transaction: string | null;
  requestId: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  feeBps?: number;
  router?: string;
  slippageBps?: number;
  errorCode?: number;
  errorMessage?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

export class JupiterClient {
  private limiter: RateLimiter;
  private baseUrl: string;
  private apiKey?: string;
  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.limiter = new RateLimiter(apiKey ? 1 : 0.5, 1);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async order(p: { inputMint: string; outputMint: string; amount: bigint; taker?: string; slippageBps?: number }): Promise<JupiterOrder | null> {
    await this.limiter.take();
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString() });
    if (p.taker) q.set("taker", p.taker);
    if (p.slippageBps !== undefined) q.set("slippageBps", String(p.slippageBps));
    const res = await fetch(`${this.baseUrl}/order?${q}`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (res.status === 400 || res.status === 404) return null; // no route / bad mint
    if (!res.ok) throw new Error(`Jupiter /order HTTP ${res.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as JupiterOrder;
    if (!j.outAmount || j.outAmount === "0") return null;
    if (p.taker && j.transaction === "") throw new Error(`Jupiter order error ${j.errorCode}: ${j.errorMessage}`);
    return j;
  }

  async execute(signedTransaction: string, requestId: string): Promise<{ status: string; signature?: string; error?: string; code?: number }> {
    await this.limiter.take();
    const res = await fetch(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ signedTransaction, requestId }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Jupiter /execute HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }

  async quote(side: "buy" | "sell", mint: string, amount: bigint): Promise<SwapQuote | null> {
    const o = await this.order(side === "buy" ? { inputMint: WSOL_MINT, outputMint: mint, amount } : { inputMint: mint, outputMint: WSOL_MINT, amount });
    if (!o) return null;
    return toQuote(side, mint, o);
  }
}

export function toQuote(side: "buy" | "sell", mint: string, o: JupiterOrder): SwapQuote {
  return {
    side,
    mint,
    inAmount: BigInt(o.inAmount),
    outAmount: BigInt(o.outAmount),
    priceImpactPct: Math.abs(Number(o.priceImpactPct ?? 0)) * 100,
    feeBps: o.feeBps ?? 0,
    venue: `jupiter:${o.routePlan?.[0]?.swapInfo?.label ?? o.router ?? "?"}`,
    raw: { requestId: o.requestId, router: o.router },
  };
}

export const deserializeTx = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
