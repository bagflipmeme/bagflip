/** Market snapshot for one token, normalized from DexScreener-style pair data. */
export interface TokenMarket {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  quoteMint: string;
  priceUsd: number | null;
  /** SOL per whole token. */
  priceNative: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  pairCreatedAt: number | null;
  volume: { m5: number; h1: number; h6: number; h24: number };
  txns: { m5: { buys: number; sells: number }; h1: { buys: number; sells: number } };
  priceChange: { m5: number; h1: number; h6: number; h24: number };
  observedAt: number;
}

export interface DiscoveryEvent {
  mint: string;
  source: "new_token" | "migration" | "profile" | "boost" | "sim";
  at: number;
  creator?: string;
  bondingCurve?: string;
}

export interface MarketDataProvider {
  readonly name: string;
  /** Candidate mints worth checking now (the provider manages its own watchlist). */
  candidates(now: number): Promise<DiscoveryEvent[]>;
  /** Fresh market data for up to ~30 mints per call. */
  snapshot(mints: string[]): Promise<TokenMarket[]>;
  /** Called when the scanner decides a mint is no longer interesting. */
  drop(mint: string): void;
}

export interface SafetyReport {
  ok: boolean;
  reasons: string[];
  facts: Record<string, unknown>;
}

export interface SafetyChecker {
  check(m: TokenMarket, creator?: string, bondingCurve?: string): Promise<SafetyReport>;
}
