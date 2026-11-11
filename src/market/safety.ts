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
}
export const DEFAULT_LIMITS: SafetyLimits = { maxTop1Pct: 12, maxTop10Pct: 35, maxCreatorPct: 8 };

export class OnChainSafety implements SafetyChecker {
  private cache = new Map<string, { at: number; r: SafetyReport }>();
  private sol: SolanaChain;
  private limits: SafetyLimits;
  private poolOwners: (m: TokenMarket) => string[];
  constructor(sol: SolanaChain, limits: SafetyLimits = DEFAULT_LIMITS, poolOwners: (m: TokenMarket) => string[] = (m) => [m.pairAddress]) {
    this.sol = sol;
    this.limits = limits;
    this.poolOwners = poolOwners;}

  async check(m: TokenMarket, creator?: string, bondingCurve?: string): Promise<SafetyReport> {
    const c = this.cache.get(m.mint);
    if (c && Date.now() - c.at < 10 * 60_000) return c.r;
    const reasons: string[] = [];
    const facts: Record<string, unknown> = {};
    const info = await this.sol.mintInfo(m.mint);
    if (!info) return { ok: false, reasons: ["mint account not found"], facts };
    facts.program = info.program === TOKEN_2022_PROGRAM ? "token-2022" : info.program === TOKEN_PROGRAM ? "spl-token" : info.program;
    if (info.program !== TOKEN_PROGRAM && info.program !== TOKEN_2022_PROGRAM) reasons.push("unknown token program");
    if (info.mintAuthority) reasons.push("mint authority still active (supply can be inflated)");
    if (info.freezeAuthority) reasons.push("freeze authority active (holders can be frozen)");
    const risky = info.extensions.filter((e) => RISKY_2022_EXTENSIONS.has(e));
    if (risky.length) reasons.push(`risky Token-2022 extensions: ${risky.join(", ")}`);
    facts.extensions = info.extensions;

    const holders = await this.sol.largestHolders(m.mint);
    const exclude = new Set([...this.poolOwners(m), bondingCurve].filter(Boolean) as string[]);
    const supply = info.supply > 0n ? info.supply : 1n;
    const nonPool = holders.filter((h) => !exclude.has(h.owner));
    const pct = (a: bigint) => Number((a * 10_000n) / supply) / 100;
    const top1 = nonPool[0] ? pct(nonPool[0].amount) : 0;
    const top10 = pct(nonPool.slice(0, 10).reduce((s, h) => s + h.amount, 0n));
    facts.top1Pct = top1;
    facts.top10Pct = top10;
    if (top1 > this.limits.maxTop1Pct) reasons.push(`largest non-pool holder owns ${top1.toFixed(1)}%`);
    if (top10 > this.limits.maxTop10Pct) reasons.push(`top-10 non-pool holders own ${top10.toFixed(1)}%`);
    if (creator) {
      const ch = holders.find((h) => h.owner === creator);
      const cp = ch ? pct(ch.amount) : 0;
      facts.creatorPct = cp;
      if (cp > this.limits.maxCreatorPct) reasons.push(`creator wallet still holds ${cp.toFixed(1)}%`);
    }
    const r = { ok: reasons.length === 0, reasons, facts };
    this.cache.set(m.mint, { at: Date.now(), r });
    return r;
  }
}
