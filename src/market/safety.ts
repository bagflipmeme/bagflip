/**
 * On-chain token safety checks run only for candidates that already scored
 * well (they cost RPC calls). Rejects tokens that can be frozen, re-minted,
 * taxed or blocked on transfer, and tokens whose supply is concentrated in a
 * few non-pool wallets (dump risk), including a known creator wallet.
 */
import type { SolanaChain } from "../solana/rpc.ts";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../solana/rpc.ts";
import type { SafetyChecker, SafetyReport, TokenMarket } from "./types.ts";

const RISKY_2022_EXTENSIONS = new Set(["transferFeeConfig", "permanentDelegate", "nonTransferable", "transferHook", "defaultAccountState", "confidentialTransferMint", "pausableConfig"]);

export interface SafetyLimits {
  maxTop1Pct: number;
  maxTop10Pct: number;
  maxCreatorPct: number;
  /** Reject when holder-concentration data is unavailable (e.g. a public RPC refuses getTokenLargestAccounts). */
  requireConcentration?: boolean;
}
export const DEFAULT_LIMITS: SafetyLimits = { maxTop1Pct: 12, maxTop10Pct: 35, maxCreatorPct: 8, requireConcentration: true };

export const AGGRESSIVE_LIMITS: SafetyLimits = { maxTop1Pct: 20, maxTop10Pct: 50, maxCreatorPct: 12, requireConcentration: false };

interface SafetyFacts {
  program: string;
  knownProgram: boolean;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  risky: string[];
  extensions: string[];
  top1: number | null;
  top10: number | null;
  creatorPct: number | null;
}

export class OnChainSafety implements SafetyChecker {
  private cache = new Map<string, { at: number; f: SafetyFacts | null }>();
  private sol: SolanaChain;
  private limits: SafetyLimits;
  private poolOwners: (m: TokenMarket) => string[];
  constructor(sol: SolanaChain, limits: SafetyLimits = DEFAULT_LIMITS, poolOwners: (m: TokenMarket) => string[] = (m) => [m.pairAddress]) {
    this.sol = sol;
    this.limits = limits;
    this.poolOwners = poolOwners;
  }

  private async facts(m: TokenMarket, creator?: string, bondingCurve?: string): Promise<SafetyFacts | null> {
    const c = this.cache.get(m.mint);
    if (c && Date.now() - c.at < 10 * 60_000) return c.f;
    const info = await this.sol.mintInfo(m.mint);
    if (!info) {
      this.cache.set(m.mint, { at: Date.now(), f: null });
      return null;
    }
    // Public RPCs often refuse getTokenLargestAccounts: concentration then becomes "unknown".
    const holders = await this.sol.largestHolders(m.mint).catch(() => null);
    const exclude = new Set([...this.poolOwners(m), bondingCurve].filter(Boolean) as string[]);
    const supply = info.supply > 0n ? info.supply : 1n;
    const nonPool = holders ? holders.filter((h) => !exclude.has(h.owner)) : [];
    const pct = (a: bigint) => Number((a * 10_000n) / supply) / 100;
    const ch = creator && holders ? holders.find((h) => h.owner === creator) : undefined;
    const f: SafetyFacts = {
      program: info.program === TOKEN_2022_PROGRAM ? "token-2022" : info.program === TOKEN_PROGRAM ? "spl-token" : info.program,
      knownProgram: info.program === TOKEN_PROGRAM || info.program === TOKEN_2022_PROGRAM,
      mintAuthority: !!info.mintAuthority,
      freezeAuthority: !!info.freezeAuthority,
      risky: info.extensions.filter((e) => RISKY_2022_EXTENSIONS.has(e)),
      extensions: info.extensions,
      top1: holders ? (nonPool[0] ? pct(nonPool[0].amount) : 0) : null,
      top10: holders ? pct(nonPool.slice(0, 10).reduce((s, h) => s + h.amount, 0n)) : null,
      creatorPct: creator && holders ? (ch ? pct(ch.amount) : 0) : null,
    };
    this.cache.set(m.mint, { at: Date.now(), f });
    return f;
  }

  /**
   * Essential checks (never relaxed by any variant): known token program, no mint authority, no freeze
   * authority, no risky Token-2022 extensions. Concentration limits depend on the variant's `limits`.
   */
  async check(m: TokenMarket, creator?: string, bondingCurve?: string, limits: SafetyLimits = this.limits): Promise<SafetyReport> {
    const f = await this.facts(m, creator, bondingCurve);
    if (!f) return { ok: false, reasons: ["mint account not found"], facts: {} };
    const reasons: string[] = [];
    if (!f.knownProgram) reasons.push("unknown token program");
    if (f.mintAuthority) reasons.push("mint authority still active (supply can be inflated)");
    if (f.freezeAuthority) reasons.push("freeze authority active (holders can be frozen)");
    if (f.risky.length) reasons.push(`risky Token-2022 extensions: ${f.risky.join(", ")}`);
    if (f.top1 === null || f.top10 === null) {
      if (limits.requireConcentration) reasons.push("holder concentration unavailable (RPC refused)");
    } else {
      if (f.top1 > limits.maxTop1Pct) reasons.push(`largest non-pool holder owns ${f.top1.toFixed(1)}%`);
      if (f.top10 > limits.maxTop10Pct) reasons.push(`top-10 non-pool holders own ${f.top10.toFixed(1)}%`);
    }
    if (f.creatorPct !== null && f.creatorPct > limits.maxCreatorPct) reasons.push(`creator wallet still holds ${f.creatorPct.toFixed(1)}%`);
    return { ok: reasons.length === 0, reasons, facts: { program: f.program, extensions: f.extensions, top1Pct: f.top1, top10Pct: f.top10, creatorPct: f.creatorPct } };
  }
}
