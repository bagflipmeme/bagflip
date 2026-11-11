/**
 * NEAR Intents 1Click API client (https://docs.agentsonintents.com).
 * Verified on 2026-11-09 against https://1click.chaindefuser.com:
 *  - GET  /v0/tokens           (wNEAR = nep141:wrap.near, SOL = nep141:sol.omft.near)
 *  - POST /v0/quote            (dry quotes NEAR→SOL and SOL→NEAR both returned ~17-20s routes)
 *  - GET  /v0/status?depositAddress=
 *  - POST /v0/deposit/submit
 * Auth: optional partner JWT in X-API-Key; without it 1Click adds 25 bps.
 */

export const ASSET = {
  WNEAR: "nep141:wrap.near",
  SOL: "nep141:sol.omft.near",
} as const;

export type OneClickStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface QuoteRequest {
  originAsset: string;
  destinationAsset: string;
  amount: bigint;
  recipient: string;
  refundTo: string;
  slippageBps: number;
  deadline: Date;
  dry: boolean;
}

export interface Quote {
  depositAddress: string | null;
  depositMemo: string | null;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  amountInUsd: number | null;
  amountOutUsd: number | null;
  deadline: string | null;
  timeEstimateSeconds: number;
  signature: string | null;
  correlationId: string | null;
  raw: unknown;
}

export interface StatusResult {
  status: OneClickStatus;
  amountOut: bigint | null;
  refundedAmount: bigint | null;
  refundReason: string | null;
  originTxHashes: string[];
  destinationTxHashes: string[];
  raw: unknown;
}

export interface BridgeProvider {
  readonly name: string;
  quote(q: QuoteRequest): Promise<Quote>;
  status(depositAddress: string, memo?: string | null): Promise<StatusResult>;
  submitDeposit(txHash: string, depositAddress: string, nearSender?: string): Promise<void>;
}

export class OneClickError extends Error {
  public httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export class OneClickClient implements BridgeProvider {
  readonly name = "oneclick";
  private baseUrl: string;
  private apiKey?: string;
  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: this.headers(), signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          msg = (JSON.parse(text) as { message?: string }).message ?? msg;
        } catch {
          /* not JSON */
        }
        throw new OneClickError(`1Click ${path} HTTP ${res.status}: ${msg}`, res.status);
      }
      return JSON.parse(text) as T;
    }
  }

  async quote(q: QuoteRequest): Promise<Quote> {
    const body = {
      dry: q.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: q.slippageBps,
      originAsset: q.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: q.destinationAsset,
      amount: q.amount.toString(),
      refundTo: q.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: q.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: q.deadline.toISOString(),
      referral: "bagflip",
      quoteWaitingTimeMs: 3000,
    };
    const j = await this.req<{
      quote: {
        depositAddress?: string;
        depositMemo?: string;
        amountIn: string;
        amountOut: string;
        minAmountOut: string;
        amountInUsd?: string;
        amountOutUsd?: string;
        deadline?: string;
        timeEstimate: number;
      };
      signature?: string;
      correlationId?: string;
    }>("/v0/quote", { method: "POST", body: JSON.stringify(body) });
    return {
      depositAddress: j.quote.depositAddress ?? null,
      depositMemo: j.quote.depositMemo ?? null,
      amountIn: BigInt(j.quote.amountIn),
      amountOut: BigInt(j.quote.amountOut),
      minAmountOut: BigInt(j.quote.minAmountOut),
      amountInUsd: j.quote.amountInUsd ? Number(j.quote.amountInUsd) : null,
      amountOutUsd: j.quote.amountOutUsd ? Number(j.quote.amountOutUsd) : null,
      deadline: j.quote.deadline ?? null,
      timeEstimateSeconds: j.quote.timeEstimate,
      signature: j.signature ?? null,
      correlationId: j.correlationId ?? null,
      raw: j,
    };
  }

  async status(depositAddress: string, memo?: string | null): Promise<StatusResult> {
    const u = new URLSearchParams({ depositAddress });
    if (memo) u.set("depositMemo", memo);
    const j = await this.req<{
      status: OneClickStatus;
      swapDetails?: {
        amountOut?: string;
        refundedAmount?: string;
        refundReason?: string;
        originChainTxHashes?: { hash: string }[];
        destinationChainTxHashes?: { hash: string }[];
      };
    }>(`/v0/status?${u}`);
    const sd = j.swapDetails ?? {};
    return {
      status: j.status,
      amountOut: sd.amountOut && sd.amountOut !== "0" ? BigInt(sd.amountOut) : null,
      refundedAmount: sd.refundedAmount && sd.refundedAmount !== "0" ? BigInt(sd.refundedAmount) : null,
      refundReason: sd.refundReason ?? null,
      originTxHashes: (sd.originChainTxHashes ?? []).map((h) => h.hash),
      destinationTxHashes: (sd.destinationChainTxHashes ?? []).map((h) => h.hash),
      raw: j,
    };
  }

  async submitDeposit(txHash: string, depositAddress: string, nearSender?: string) {
    await this.req("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ txHash, depositAddress, ...(nearSender ? { nearSenderAccount: nearSender } : {}) }) });
  }
}

/**
 * Deterministic in-process bridge for development, paper mode and tests.
 * Converts at FixedPrices with a 0.3% fee; outcomes can be scripted.
 */
export class SimBridge implements BridgeProvider {
  readonly name = "sim";
  private seq = 0;
  private transfers = new Map<string, { q: QuoteRequest; out: bigint; polls: number; outcome: "success" | "refund" | "fail" }>();
  nextOutcome: "success" | "refund" | "fail" = "success";
  quoteError: Error | null = null;

  private priceUsd: (asset: "NEAR" | "SOL") => number;
  constructor(priceUsd: (asset: "NEAR" | "SOL") => number) {
    this.priceUsd = priceUsd;}

  private convert(q: QuoteRequest): bigint {
    const fromNear = q.originAsset === ASSET.WNEAR;
    const pIn = this.priceUsd(fromNear ? "NEAR" : "SOL");
    const pOut = this.priceUsd(fromNear ? "SOL" : "NEAR");
    const decIn = fromNear ? 24 : 9;
    const decOut = fromNear ? 9 : 24;
    // amountOut = amountIn * pIn/pOut * 10^(decOut-decIn) * 0.997
    const num = q.amount * BigInt(Math.round(pIn * 1e9)) * 997n * 10n ** BigInt(decOut);
    const den = BigInt(Math.round(pOut * 1e9)) * 1000n * 10n ** BigInt(decIn);
    return num / den;
  }

  async quote(q: QuoteRequest): Promise<Quote> {
    if (this.quoteError) throw this.quoteError;
    const out = this.convert(q);
    const addr = q.dry ? null : `sim-deposit-${++this.seq}`;
    if (addr) this.transfers.set(addr, { q, out, polls: 0, outcome: this.nextOutcome });
    const fromNear = q.originAsset === ASSET.WNEAR;
    const usdIn = (Number(q.amount) / 10 ** (fromNear ? 24 : 9)) * this.priceUsd(fromNear ? "NEAR" : "SOL");
    return {
      depositAddress: addr,
      depositMemo: null,
      amountIn: q.amount,
      amountOut: out,
      minAmountOut: (out * BigInt(10_000 - q.slippageBps)) / 10_000n,
      amountInUsd: usdIn,
      amountOutUsd: usdIn * 0.997,
      deadline: q.deadline.toISOString(),
      timeEstimateSeconds: 20,
      signature: "sim",
      correlationId: `sim-${this.seq}`,
      raw: { simulated: true },
    };
  }

  async status(depositAddress: string): Promise<StatusResult> {
    const t = this.transfers.get(depositAddress);
    if (!t) throw new OneClickError("unknown deposit address", 404);
    t.polls++;
    const base = { refundReason: null, originTxHashes: [`sim-origin-${depositAddress}`], raw: { simulated: true } };
    if (t.polls < 2) return { ...base, status: "PROCESSING", amountOut: null, refundedAmount: null, destinationTxHashes: [] };
    if (t.outcome === "refund") return { ...base, status: "REFUNDED", amountOut: null, refundedAmount: t.q.amount, refundReason: "SIMULATED", destinationTxHashes: [] };
    if (t.outcome === "fail") return { ...base, status: "FAILED", amountOut: null, refundedAmount: null, destinationTxHashes: [] };
    return { ...base, status: "SUCCESS", amountOut: t.out, refundedAmount: null, destinationTxHashes: [`sim-dest-${depositAddress}`] };
  }

  async submitDeposit() {}
}
