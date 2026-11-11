import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUnits, formatUnits, toUsdMicro, formatUsd, bps } from "../src/shared/money.ts";
import { allocate } from "../src/distribution/distribution.ts";
import { scoreToken, confirmEntry, decideExit, DEFAULT_PARAMS, type ExitParams } from "../src/strategy/strategy.ts";
import { parseIncoming } from "../src/near/chain.ts";
import { accountsFromEventLog } from "../src/distribution/holders.ts";
import { OneClickClient } from "../src/bridge/oneclick.ts";
import { PaperExecution } from "../src/solana/execution/paper.ts";
import { normalizePair } from "../src/market/dexscreener.ts";
import { replay } from "../src/strategy/replay.ts";
import type { TokenMarket } from "../src/market/types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("fixed-point money", () => {
  it("parses and formats without floating point", () => {
    expect(parseUnits("1.5", 24)).toBe(1_500_000_000_000_000_000_000_000n);
    expect(parseUnits("0.1", 9) + parseUnits("0.2", 9)).toBe(parseUnits("0.3", 9));
    expect(formatUnits(1_500_000_000_000_000_000_000_000n, 24)).toBe("1.5");
    expect(() => parseUnits("1e5", 9)).toThrow();
    expect(bps(1000n, 2500)).toBe(250n);
    expect(formatUsd(toUsdMicro(parseUnits("10", 24), "NEAR", 3.5))).toBe("$35.00");
  });
});

describe("pro-rata allocation", () => {
  it("matches the brief's $100 → 10/30/60 example exactly", () => {
    const r = allocate(100_000_000n, [
      { accountId: "a", balance: 10n },
      { accountId: "b", balance: 30n },
      { accountId: "c", balance: 60n },
    ]);
    expect(r.allocations.map((x) => x.amount)).toEqual([10_000_000n, 30_000_000n, 60_000_000n]);
    expect(r.dust).toBe(0n);
  });
  it("never allocates more than the pool; dust stays", () => {
    const r = allocate(10n, [
      { accountId: "a", balance: 1n },
      { accountId: "b", balance: 1n },
      { accountId: "c", balance: 1n },
    ]);
    expect(r.allocated).toBe(9n);
    expect(r.dust).toBe(1n);
    expect(r.allocated + r.dust).toBe(10n);
  });
});

const now = Date.UTC(2026, 10, 9, 12);
const mk = (o: Partial<TokenMarket> = {}): TokenMarket => ({
  mint: "M",
  symbol: "M",
  name: "M",
  pairAddress: "P",
  dexId: "pumpswap",
  quoteMint: "So11111111111111111111111111111111111111112",
  priceUsd: 0.001,
  priceNative: 0.00001,
  liquidityUsd: 45_000,
  marketCapUsd: 250_000,
  pairCreatedAt: now - 2 * 3_600_000,
  volume: { m5: 10_000, h1: 30_000, h6: 80_000, h24: 120_000 },
  txns: { m5: { buys: 80, sells: 20 }, h1: { buys: 700, sells: 300 } },
  priceChange: { m5: 9, h1: 55, h6: 90, h24: 140 },
  observedAt: now,
  ...o,
});

describe("strategy scoring (explainable)", () => {
  it("passes an igniting fresh graduate and explains why", () => {
    const s = scoreToken(mk(), now);
    expect(s.pass).toBe(true);
    expect(s.score).toBeGreaterThan(0.75);
    expect(s.notes).toContain("fresh Pump.fun graduate");
  });
  it("rejects brand-new launches, dumps, vertical candles, thin liquidity", () => {
    expect(scoreToken(mk({ pairCreatedAt: now - 3 * 60_000 }), now).rejects.join()).toMatch(/too new/);
    expect(scoreToken(mk({ txns: { m5: { buys: 10, sells: 40 }, h1: { buys: 700, sells: 300 } } }), now).rejects.join()).toMatch(/sellers dominate/);
    expect(scoreToken(mk({ priceChange: { m5: 90, h1: 55, h6: 0, h24: 0 } }), now).rejects.join()).toMatch(/vertical/);
    expect(scoreToken(mk({ liquidityUsd: 3000 }), now).rejects.join()).toMatch(/liquidity/);
    expect(scoreToken(mk({ dexId: "orca" }), now).pass).toBe(false);
  });
  it("needs two consecutive confirmations with a non-falling price", () => {
    const a = { score: 0.8, priceNative: 1, at: now };
    expect(confirmEntry(undefined, a, 0.65).confirmed).toBe(false);
    expect(confirmEntry(a, { score: 0.8, priceNative: 1.01, at: now + 30_000 }, 0.65).confirmed).toBe(true);
    expect(confirmEntry(a, { score: 0.8, priceNative: 0.9, at: now + 30_000 }, 0.65).confirmed).toBe(false);
  });
});

describe("exit rules (best-effort triggers)", () => {
  const p: ExitParams = { stopLossPct: 30, takeProfitPct: 80, takeProfitSellPct: 50, trailingActivatePct: 40, trailingStopPct: 25, maxHoldHours: 24, staleHours: 3, exitSlippageBps: 2500, emergencySlippageBps: 5000 };
  const pos = { remainingCost: 1000n, peakValue: 1000n, lastValue: 1000n, takeProfitDone: false, openedAt: now, exitAttempts: 0, entryVolumeM5: 10_000, entryLiquidityUsd: 45_000 };
  it("stop loss, take profit, trailing stop, max hold, wind-down", () => {
    expect(decideExit(pos, 690n, mk(), now, true, p)).toMatchObject({ action: "sell", reason: "stop_loss" });
    expect(decideExit(pos, 1900n, mk(), now, true, p)).toMatchObject({ action: "sell", reason: "take_profit", fractionBps: 5000 });
    expect(decideExit({ ...pos, takeProfitDone: true, peakValue: 2000n, lastValue: 1600n }, 1450n, mk(), now, true, p)).toMatchObject({ reason: "trailing_stop" });
    expect(decideExit(pos, 1100n, mk(), now + 25 * 3_600_000, true, p)).toMatchObject({ reason: "max_hold" });
    expect(decideExit(pos, 1100n, mk(), now, false, p)).toMatchObject({ reason: "wind_down" });
    expect(decideExit(pos, 1100n, mk(), now, true, p).action).toBe("hold");
  });
  it("treats crashes and liquidity collapse as emergencies", () => {
    expect(decideExit(pos, 400n, mk(), now, true, p)).toMatchObject({ reason: "crash", slippageBps: 5000 });
    expect(decideExit(pos, 950n, mk({ liquidityUsd: 10_000 }), now, true, p)).toMatchObject({ reason: "liquidity_collapse" });
  });
  it("escalates slippage after repeated failed exits; cannot price without a route", () => {
    expect(decideExit({ ...pos, exitAttempts: 2 }, 690n, mk(), now, true, p)).toMatchObject({ slippageBps: 5000 });
    expect(decideExit(pos, null, mk(), now, true, p).action).toBe("hold");
  });
});

describe("NEAR deposit parser (FastNEAR tx format)", () => {
  const tx = {
    transaction: { hash: "H1", signer_id: "creator.near" },
    receipts: [
      { receipt: { block_height: 10, block_timestamp: "1794161986531331000", predecessor_id: "creator.near", receiver_id: "treasury.near", receipt_id: "R1", receipt: { Action: { actions: [{ Transfer: { deposit: "5000000000000000000000000" } }] } } }, execution_outcome: { outcome: { executor_id: "treasury.near", logs: [], status: { SuccessValue: "" } } } },
      { receipt: { block_height: 10, block_timestamp: "1794161986531331000", predecessor_id: "system", receiver_id: "treasury.near", receipt_id: "R2", receipt: { Action: { actions: [{ Transfer: { deposit: "123" } }] } } }, execution_outcome: { outcome: { executor_id: "treasury.near", logs: [], status: { SuccessValue: "" } } } },
      { receipt: { block_height: 11, block_timestamp: "1794161986531331000", predecessor_id: "creator.near", receiver_id: "wrap.near", receipt_id: "R3", receipt: { Action: { actions: [] } } }, execution_outcome: { outcome: { executor_id: "wrap.near", logs: ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"creator.near","new_owner_id":"treasury.near","amount":"2000"}]}'], status: { SuccessValue: "" } } } },
      { receipt: { block_height: 11, block_timestamp: "1794161986531331000", predecessor_id: "x.near", receiver_id: "treasury.near", receipt_id: "R4", receipt: { Action: { actions: [{ Transfer: { deposit: "999" } }] } } }, execution_outcome: { outcome: { executor_id: "treasury.near", logs: [], status: { Failure: {} } } } },
    ],
  };
  it("finds native and wNEAR transfers, skips gas refunds and failed receipts", () => {
    const r = parseIncoming(tx as never, "treasury.near");
    expect(r.map((x) => [x.kind, x.sender, x.amount])).toEqual([
      ["native", "creator.near", 5_000_000_000_000_000_000_000_000n],
      ["wnear", "creator.near", 2000n],
    ]);
  });
  it("extracts holder accounts from NEP-141 events", () => {
    expect(accountsFromEventLog('EVENT_JSON:{"standard":"nep141","event":"ft_mint","data":[{"owner_id":"a.near","amount":"1"}]}')).toEqual(["a.near"]);
    expect(accountsFromEventLog('EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[{"old_owner_id":"a","new_owner_id":"b","amount":"1"}]}')).toEqual(["a", "b"]);
    expect(accountsFromEventLog("not json")).toEqual([]);
  });
});

describe("1Click client", () => {
  it("sends the documented quote fields and parses the response", async () => {
    let body: Record<string, unknown> = {};
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ quote: { depositAddress: "abc", amountIn: "100", amountOut: "90", minAmountOut: "89", timeEstimate: 17, amountInUsd: "1", amountOutUsd: "0.99" }, signature: "sig", correlationId: "c" }), { status: 200 });
    });
    const c = new OneClickClient("https://1click.example", "jwt");
    const q = await c.quote({ originAsset: "nep141:wrap.near", destinationAsset: "nep141:sol.omft.near", amount: 100n, recipient: "So1", refundTo: "t.near", slippageBps: 100, deadline: new Date(now), dry: false });
    expect(body).toMatchObject({ swapType: "EXACT_INPUT", depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", recipientType: "DESTINATION_CHAIN", amount: "100", slippageTolerance: 100, dry: false });
    expect(headers["X-API-Key"]).toBe("jwt");
    expect(q).toMatchObject({ depositAddress: "abc", amountOut: 90n, minAmountOut: 89n });
  });
  it("parses status, refunds and API errors", async () => {
    vi.stubGlobal("fetch", async (u: string) =>
      String(u).includes("bad")
        ? new Response(JSON.stringify({ message: "recipient is not valid" }), { status: 400 })
        : new Response(JSON.stringify({ status: "REFUNDED", swapDetails: { refundedAmount: "77", refundReason: "PARTIAL_DEPOSIT", destinationChainTxHashes: [] } }), { status: 200 }),
    );
    const c = new OneClickClient("https://1click.example");
    expect(await c.status("dep")).toMatchObject({ status: "REFUNDED", refundedAmount: 77n, refundReason: "PARTIAL_DEPOSIT" });
    await expect(c.status("bad")).rejects.toThrow(/recipient is not valid/);
  });
});

describe("paper execution", () => {
  it("fills from real quotes minus extra slippage, fees and rent; failures burn only the fee", async () => {
    const quotes = { quote: async (side: "buy" | "sell", mint: string, amount: bigint) => ({ side, mint, inAmount: amount, outAmount: amount * 1000n, priceImpactPct: 0.5, feeBps: 10, venue: "test" }) };
    const ok = new PaperExecution(quotes, { extraSlippageBps: 150, failureRate: 0, priorityFeeLamports: 100_000, seed: 1, ledgerSol: async () => 0n });
    const p = await ok.prepare({ clientOrderId: "o1", side: "buy", mint: "M", amountIn: 100_000_000n, slippageBps: 1500 });
    const s = await ok.settle({ side: "buy", mint: "M", payload: p.payload });
    expect(s).toMatchObject({ state: "confirmed", settlement: { tokens: 98_500_000_000n, sol: 100_000_000n + 105_000n + 2_039_280n } });
    const bad = new PaperExecution(quotes, { extraSlippageBps: 150, failureRate: 1, priorityFeeLamports: 100_000, seed: 1, ledgerSol: async () => 0n });
    const p2 = await bad.prepare({ clientOrderId: "o2", side: "buy", mint: "M", amountIn: 100_000_000n, slippageBps: 1500 });
    expect(await bad.settle({ side: "buy", mint: "M", payload: p2.payload })).toMatchObject({ state: "failed", feeLamports: 105_000n });
  });
});

describe("market data normalization + replay", () => {
  it("normalizes a real DexScreener pumpfun pair (no liquidity field)", () => {
    const m = normalizePair(
      { chainId: "solana", dexId: "pumpfun", pairAddress: "8eFP", baseToken: { address: "CYGd", name: "Greed", symbol: "Greed" }, quoteToken: { address: "So11111111111111111111111111111111111111112" }, priceNative: "0.0000001111", priceUsd: "0.000009532", txns: { m5: { buys: 14, sells: 7 }, h1: { buys: 461, sells: 313 } }, volume: { h24: 24016.65, h1: 24016.65, m5: 1064.37 }, priceChange: { m5: 28.67, h1: 249 }, marketCap: 9532.05, pairCreatedAt: 1794221124000 },
      now,
    );
    expect(m).toMatchObject({ dexId: "pumpfun", liquidityUsd: null, marketCapUsd: 9532.05, priceNative: 1.111e-7 });
    expect(scoreToken(m, now).rejects.join()).toMatch(/market cap below/);
  });
  it("replays recorded observations through the same entry/exit rules", () => {
    const obs: TokenMarket[] = [];
    for (let i = 0; i < 12; i++) {
      const price = 0.00001 * (i < 3 ? 1 + i * 0.01 : 1.5 + i * 0.1); // ignition then run-up
      obs.push(mk({ observedAt: now + i * 60_000, priceNative: price }));
    }
    const r = replay(obs, {
      strategy: DEFAULT_PARAMS,
      exits: { stopLossPct: 30, takeProfitPct: 80, takeProfitSellPct: 50, trailingActivatePct: 40, trailingStopPct: 25, maxHoldHours: 24, staleHours: 3, exitSlippageBps: 2500, emergencySlippageBps: 5000 },
      startLamports: 1_000_000_000n,
      positionPct: 50,
      maxConcurrent: 2,
      feeBps: 125,
      extraSlippageBps: 150,
      networkFeeLamports: 105_000n,
      solUsd: 85,
    });
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.endEquity > 1_000_000_000n).toBe(true);
  });
});
