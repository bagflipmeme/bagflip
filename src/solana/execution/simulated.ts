/**
 * Fully simulated Solana market for BAGFLIP_ENV=development and automated tests.
 * Tokens trade on constant-product pools (1% fee). Tests can move prices,
 * rug a pool, make a token unsellable, or make the next submission fail.
 * Everything is labeled simulated; nothing touches a network.
 */
import { ATA_RENT_LAMPORTS, BASE_FEE_LAMPORTS, PrepareError, type ExecutionAdapter, type OrderIntent, type PreparedOrder, type SettleResult, type SwapQuote } from "./types.ts";
import type { DiscoveryEvent, MarketDataProvider, TokenMarket } from "../../market/types.ts";

export interface SimToken {
  mint: string;
  symbol: string;
  solReserve: bigint;
  tokenReserve: bigint;
  decimals: number;
  sellable: boolean;
  /** Metrics the market-data feed reports for this token. */
  metrics: Partial<Omit<TokenMarket, "mint" | "symbol" | "priceNative">>;
  createdAt: number;
}

export class SimMarket {
  tokens = new Map<string, SimToken>();
  failNext: "none" | "prepare" | "chain" | "expire" = "none";
  solUsd = 85;

  addToken(t: Partial<SimToken> & { mint: string }) {
    const tok: SimToken = {
      symbol: t.symbol ?? t.mint.slice(0, 4).toUpperCase(),
      solReserve: t.solReserve ?? 80_000_000_000n, // 80 SOL
      tokenReserve: t.tokenReserve ?? 400_000_000_000_000n, // 400M tokens, 6 decimals
      decimals: t.decimals ?? 6,
      sellable: t.sellable ?? true,
      metrics: t.metrics ?? {},
      createdAt: t.createdAt ?? Date.now() - 2 * 3_600_000,
      ...t,
    } as SimToken;
    this.tokens.set(tok.mint, tok);
    return tok;
  }

  /** Multiply the token price by `factor` (adjusts SOL reserve, keeps tokens). */
  movePrice(mint: string, factor: number) {
    const t = this.tokens.get(mint)!;
    t.solReserve = (t.solReserve * BigInt(Math.round(factor * 1e6))) / 1_000_000n;
  }

  rug(mint: string) {
    const t = this.tokens.get(mint)!;
    t.solReserve = t.solReserve / 1000n;
  }

  /** SOL per whole token */
  price(mint: string): number {
    const t = this.tokens.get(mint)!;
    return Number(t.solReserve) / 1e9 / (Number(t.tokenReserve) / 10 ** t.decimals);
  }

  swapOut(mint: string, side: "buy" | "sell", amountIn: bigint): bigint {
    const t = this.tokens.get(mint);
    if (!t) return 0n;
    const inAfterFee = (amountIn * 99n) / 100n;
    if (side === "buy") return (t.tokenReserve * inAfterFee) / (t.solReserve + inAfterFee);
    return (t.solReserve * inAfterFee) / (t.tokenReserve + inAfterFee);
  }

  apply(mint: string, side: "buy" | "sell", amountIn: bigint, out: bigint) {
    const t = this.tokens.get(mint)!;
    if (side === "buy") {
      t.solReserve += amountIn;
      t.tokenReserve -= out;
    } else {
      t.tokenReserve += amountIn;
      t.solReserve -= out;
    }
  }
}

export class SimulatedExecution implements ExecutionAdapter {
  readonly mode = "simulated" as const;
  private wallet = new Map<string, bigint>();
  private results = new Map<string, SettleResult>();
  private n = 0;
  solWallet: bigint | null = null;

  public market: SimMarket;
  private ledgerSol: () => Promise<bigint>;
  constructor(market: SimMarket, ledgerSol: () => Promise<bigint>) {
    this.market = market;
    this.ledgerSol = ledgerSol;}

  async quote(side: "buy" | "sell", mint: string, amount: bigint): Promise<SwapQuote | null> {
    const t = this.market.tokens.get(mint);
    if (!t || (side === "sell" && !t.sellable)) return null;
    const out = this.market.swapOut(mint, side, amount);
    if (out <= 0n) return null;
    const reserveIn = side === "buy" ? t.solReserve : t.tokenReserve;
    return { side, mint, inAmount: amount, outAmount: out, priceImpactPct: (Number(amount) / Number(reserveIn + amount)) * 100, feeBps: 100, venue: "sim-cpmm" };
  }
  quoteBuy(mint: string, lamports: bigint) {
    return this.quote("buy", mint, lamports);
  }
  quoteSell(mint: string, tokens: bigint) {
    return this.quote("sell", mint, tokens);
  }

  async prepare(o: OrderIntent): Promise<PreparedOrder> {
    if (this.market.failNext === "prepare") {
      this.market.failNext = "none";
      throw new PrepareError("simulated RPC outage while preparing", "rpc");
    }
    const q = await this.quote(o.side, o.mint, o.amountIn);
    if (!q) throw new PrepareError("no route (simulated)", "no_route");
    const sig = `sim-${o.clientOrderId}-${++this.n}`;
    const minOut = (q.outAmount * BigInt(10_000 - o.slippageBps)) / 10_000n;
    const fee = BASE_FEE_LAMPORTS + 100_000n;
    let r: SettleResult;
    if (this.market.failNext === "chain") {
      this.market.failNext = "none";
      r = { state: "failed", feeLamports: fee, error: "simulated on-chain failure" };
    } else if (this.market.failNext === "expire") {
      this.market.failNext = "none";
      r = { state: "expired" };
    } else {
      // Fill happens at execution time: re-quote then (price may have moved).
      r = { state: "pending" };
    }
    this.results.set(sig, r);
    return { signature: sig, lastValidBlockHeight: 0n, expectedOut: q.outAmount, minOut, venue: "sim", payload: JSON.stringify({ ...o, amountIn: o.amountIn.toString(), minOut: minOut.toString() }), quote: null };
  }

  async broadcast(p: PreparedOrder) {
    const pre = this.results.get(p.signature);
    if (!pre || pre.state !== "pending") return;
    const o = JSON.parse(p.payload) as { side: "buy" | "sell"; mint: string; amountIn: string; minOut: string };
    const amountIn = BigInt(o.amountIn);
    const out = this.market.swapOut(o.mint, o.side, amountIn);
    const fee = BASE_FEE_LAMPORTS + 100_000n;
    const t = this.market.tokens.get(o.mint);
    if (!t || out < BigInt(o.minOut) || (o.side === "sell" && !t.sellable)) {
      this.results.set(p.signature, { state: "failed", feeLamports: fee, error: "slippage/route failure (simulated)" });
      return;
    }
    this.market.apply(o.mint, o.side, amountIn, out);
    const cur = this.wallet.get(o.mint) ?? 0n;
    this.wallet.set(o.mint, o.side === "buy" ? cur + out : cur - amountIn);
    this.results.set(p.signature, {
      state: "confirmed",
      settlement:
        o.side === "buy"
          ? { sol: amountIn + fee + ATA_RENT_LAMPORTS, tokens: out, feeLamports: fee, tokenDecimals: t.decimals }
          : { sol: out - fee, tokens: amountIn, feeLamports: fee, tokenDecimals: t.decimals },
    });
  }

  async settle(o: { signature: string }): Promise<SettleResult> {
    return this.results.get(o.signature) ?? { state: "expired" };
  }

  async solBalance() {
    return this.solWallet ?? this.ledgerSol();
  }
  async tokenBalance(mint: string) {
    return this.wallet.get(mint) ?? 0n;
  }
  async closeTokenAccount() {
    return { signature: "sim-close", lamports: ATA_RENT_LAMPORTS - BASE_FEE_LAMPORTS };
  }
}

/** Market-data feed over the simulated market. */
export class SimMarketData implements MarketDataProvider {
  readonly name = "sim";
  private market: SimMarket;
  constructor(market: SimMarket) {
    this.market = market;}
  async candidates(now: number): Promise<DiscoveryEvent[]> {
    return [...this.market.tokens.values()].map((t) => ({ mint: t.mint, source: "sim" as const, at: now }));
  }
  async snapshot(mints: string[]): Promise<TokenMarket[]> {
    const now = Date.now();
    return mints
      .map((m) => this.market.tokens.get(m))
      .filter((t): t is SimToken => !!t)
      .map((t) => {
        const p = this.market.price(t.mint);
        return {
          mint: t.mint,
          symbol: t.symbol,
          name: `${t.symbol} (simulated)`,
          pairAddress: `pool-${t.mint}`,
          dexId: "pumpswap",
          quoteMint: "So11111111111111111111111111111111111111112",
          priceUsd: p * this.market.solUsd,
          priceNative: p,
          liquidityUsd: (Number(t.solReserve) / 1e9) * this.market.solUsd * 2,
          marketCapUsd: p * this.market.solUsd * 1e9,
          pairCreatedAt: t.createdAt,
          volume: { m5: 6000, h1: 24_000, h6: 60_000, h24: 90_000 },
          txns: { m5: { buys: 60, sells: 30 }, h1: { buys: 600, sells: 400 } },
          priceChange: { m5: 8, h1: 40, h6: 80, h24: 120 },
          observedAt: now,
          ...t.metrics,
        };
      });
  }
  drop() {}
}

/** Safety checker for simulated tokens: everything passes unless flagged. */
export const simSafety = {
  async check() {
    return { ok: true, reasons: [], facts: { simulated: true } };
  },
};
