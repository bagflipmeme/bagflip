import { z } from "zod";
import { NEAR_DECIMALS, SOL_DECIMALS, parseUnits } from "./money.ts";
import { registerSecret } from "./log.ts";

/**
 * All configuration is read once from the environment and validated.
 * Unsafe combinations (live trading without explicit enablement, live mode
 * without Postgres, keys in the wrong environment) are rejected at boot.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `not a number: ${v}` });
        return z.NEVER;
      }
      return n;
    });
const str = (def = "") => z.string().optional().transform((v) => (v === undefined ? def : v.trim()));
const list = () =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  NODE_ENV: str("development"),
  BAGFLIP_ENV: z.enum(["development", "paper", "live"]).optional().default("development"),
  ROLE: z.enum(["all", "bot", "api", "worker"]).optional().default("all"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  PORT: num(8080),
  PUBLIC_URL: str("http://localhost:8080"),
  ADMIN_API_TOKEN: str(),

  DATABASE_URL: str(),
  PGLITE_DATA_DIR: str("./data/pglite"),

  TELEGRAM_BOT_TOKEN: str(),
  TELEGRAM_BOT_USERNAME: str(),
  TELEGRAM_GROUP_ID: str(),
  TELEGRAM_ADMIN_IDS: list(),
  TELEGRAM_WEBHOOK_SECRET: str(),

  NEAR_NETWORK: z.enum(["mainnet", "testnet"]).optional().default("mainnet"),
  NEAR_RPC_URL: str("https://rpc.mainnet.fastnear.com"),
  NEAR_ARCHIVAL_RPC_URL: str(),
  FASTNEAR_API_URL: str("https://api.fastnear.com"),
  FASTNEAR_TX_API_URL: str("https://tx.main.fastnear.com"),
  MEME_TOKEN_CONTRACT_ID: str(),
  MEME_TOKEN_SYMBOL: str("BAGFLIP"),
  MEME_TOKEN_DECIMALS: num(18),
  CREATOR_WALLET_ADDRESS: str(),
  TREASURY_NEAR_ADDRESS: str(),
  /** Bot account that calls the vault (its key should be a function-call key restricted to the vault). */
  OPERATOR_ACCOUNT_ID: str(),
  OPERATOR_PRIVATE_KEY: str(),
  /** Mirrors of the vault's init parameters (authoritative on chain; used by SimVault and the deploy script). */
  VAULT_MODE_DELAY_HOURS: num(12),
  VAULT_DISTRIBUTION_DELAY_HOURS: num(24),
  VAULT_ADMIN_DELAY_HOURS: num(48),
  VAULT_DAILY_HUNT_CAP_NEAR: str("50"),
  VAULT_GUARDIANS: list(),
  VAULT_GUARDIAN_THRESHOLD: num(2),
  DEPOSIT_ALLOWED_SENDERS: list(),
  EXCLUDED_HOLDER_ACCOUNTS: list(),
  NEP413_RECIPIENT: str("bagflip-treasury-bot"),
  AUTH_CHALLENGE_TTL_MINUTES: num(10),
  NEAR_FEE_RESERVE: str("0.5"),

  SOLANA_RPC_URL: str("https://api.mainnet-beta.solana.com"),
  TRADING_WALLET_ADDRESS: str(),
  SOLANA_TRADING_PRIVATE_KEY: str(),
  SOL_FEE_RESERVE: str("0.01"),

  ONECLICK_BASE_URL: str("https://1click.chaindefuser.com"),
  ONECLICK_API_KEY: str(),
  BRIDGE_SLIPPAGE_BPS: num(100),
  BRIDGE_DEADLINE_MINUTES: num(60),

  JUPITER_BASE_URL: str("https://api.jup.ag/swap/v2"),
  JUPITER_API_KEY: str(),
  PUMPPORTAL_BASE_URL: str("https://pumpportal.fun"),
  PUMPPORTAL_WS_URL: str("wss://pumpportal.fun/api/data"),
  PUMPPORTAL_DISCOVERY: bool(true),
  DEXSCREENER_BASE_URL: str("https://api.dexscreener.com"),
  EXECUTION_VENUE: z.enum(["auto", "jupiter", "pumpportal"]).optional().default("auto"),

  TIMEZONE: str("Asia/Kuala_Lumpur"),
  DAILY_DECISION_HOUR: num(0),
  DAILY_DECISION_MINUTE: num(0),

  VOTING_INITIAL_QUORUM_PERCENT: num(5),
  VOTING_MIN_QUORUM_PERCENT: num(3),
  VOTING_MIN_DISTINCT_WALLETS: num(3),

  MIN_CROSS_CHAIN_TRANSFER_USD: num(20),
  MIN_DISTRIBUTION_POOL_USD: num(20),
  MIN_CLAIM_PAYOUT_USD: num(1),
  MIN_ELIGIBLE_TOKEN_BALANCE: str("1"),
  NOTIFY_MIN_DEPOSIT_USD: num(2),

  MAX_TREASURY_TRADE_ALLOCATION_PERCENT: num(100),
  MAX_POSITION_HOLD_HOURS: num(24),
  MAX_CONCURRENT_POSITIONS: num(2),
  POSITION_SIZE_PERCENT: num(50),
  MIN_POSITION_SOL: str("0.05"),
  MAX_POSITION_SOL: str("0"),
  ENTRY_SCORE_THRESHOLD: num(0.65),
  STOP_LOSS_PERCENT: num(30),
  TAKE_PROFIT_PERCENT: num(80),
  TAKE_PROFIT_SELL_PERCENT: num(50),
  TRAILING_ACTIVATE_PERCENT: num(40),
  TRAILING_STOP_PERCENT: num(25),
  STALE_EXIT_HOURS: num(3),
  MAX_ROUNDTRIP_COST_PERCENT: num(12),
  MAX_PRICE_IMPACT_PERCENT: num(4),
  MAX_FIXED_COST_PERCENT: num(3),
  TRADE_SLIPPAGE_BPS: num(1500),
  EXIT_SLIPPAGE_BPS: num(2500),
  EMERGENCY_EXIT_SLIPPAGE_BPS: num(5000),
  PRIORITY_FEE_LAMPORTS: num(100_000),
  WINDDOWN_MAX_HOURS: num(6),
  REENTRY_COOLDOWN_HOURS: num(6),
  SCAN_INTERVAL_SECONDS: num(30),
  POSITION_CHECK_INTERVAL_SECONDS: num(15),
  RECONCILE_INTERVAL_SECONDS: num(120),
  RPC_FAILURE_PAUSE_THRESHOLD: num(5),

  PAPER_EXTRA_SLIPPAGE_BPS: num(150),
  PAPER_TX_FAILURE_RATE: num(0.05),
  PAPER_SEED: num(42),

  LIVE_TRADING_ENABLED: bool(false),
  LIVE_TRANSFERS_ENABLED: bool(false),
  EMERGENCY_PAUSE: bool(false),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  nearFeeReserve: bigint;
  solFeeReserve: bigint;
  minPositionLamports: bigint;
  maxPositionLamports: bigint;
  minEligibleTokenBalance: bigint;
  vaultDailyHuntCap: bigint;
  adminIds: Set<number>;
  boundary: { timezone: string; hour: number; minute: number };
  /** True when real treasury NEAR can move (bridge, claims). */
  liveTransfers: boolean;
  /** True when real Solana orders can be sent. */
  liveTrading: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const c = parsed.data;
  for (const s of [c.TELEGRAM_BOT_TOKEN, c.OPERATOR_PRIVATE_KEY, c.SOLANA_TRADING_PRIVATE_KEY, c.ONECLICK_API_KEY, c.JUPITER_API_KEY, c.ADMIN_API_TOKEN, c.TELEGRAM_WEBHOOK_SECRET, c.DATABASE_URL]) {
    registerSecret(s);
  }

  const errors: string[] = [];
  if (c.BAGFLIP_ENV !== "development") {
    if (!c.MEME_TOKEN_CONTRACT_ID) errors.push("MEME_TOKEN_CONTRACT_ID is required outside development");
    if (!c.TREASURY_NEAR_ADDRESS) errors.push("TREASURY_NEAR_ADDRESS is required outside development");
  }
  if (c.BAGFLIP_ENV === "live") {
    if (!c.DATABASE_URL) errors.push("DATABASE_URL (PostgreSQL) is required in live mode; PGlite is for development/paper only");
    if (!c.TRADING_WALLET_ADDRESS) errors.push("TRADING_WALLET_ADDRESS is required in live mode");
    if (c.LIVE_TRADING_ENABLED && !c.SOLANA_TRADING_PRIVATE_KEY) errors.push("LIVE_TRADING_ENABLED requires SOLANA_TRADING_PRIVATE_KEY");
    if (c.LIVE_TRANSFERS_ENABLED && (!c.OPERATOR_PRIVATE_KEY || !c.OPERATOR_ACCOUNT_ID)) errors.push("LIVE_TRANSFERS_ENABLED requires OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY (the vault has no keys)");
    if (c.OPERATOR_ACCOUNT_ID && (c.OPERATOR_ACCOUNT_ID === c.TREASURY_NEAR_ADDRESS || c.OPERATOR_ACCOUNT_ID === c.CREATOR_WALLET_ADDRESS)) {
      errors.push("OPERATOR_ACCOUNT_ID must be a separate bot account (not the vault, not the creator)");
    }
    if (c.TREASURY_NEAR_ADDRESS && c.TREASURY_NEAR_ADDRESS === c.CREATOR_WALLET_ADDRESS) {
      errors.push("TREASURY_NEAR_ADDRESS must not be the creator wallet");
    }
  } else {
    if (c.SOLANA_TRADING_PRIVATE_KEY || c.OPERATOR_PRIVATE_KEY) {
      errors.push("Private keys must only be configured when BAGFLIP_ENV=live");
    }
    if (c.LIVE_TRADING_ENABLED || c.LIVE_TRANSFERS_ENABLED) errors.push("LIVE_* flags require BAGFLIP_ENV=live");
  }
  if (c.MAX_TREASURY_TRADE_ALLOCATION_PERCENT < 0 || c.MAX_TREASURY_TRADE_ALLOCATION_PERCENT > 100) {
    errors.push("MAX_TREASURY_TRADE_ALLOCATION_PERCENT must be within 0..100");
  }
  if (c.DAILY_DECISION_HOUR < 0 || c.DAILY_DECISION_HOUR > 23 || c.DAILY_DECISION_MINUTE < 0 || c.DAILY_DECISION_MINUTE > 59) {
    errors.push("DAILY_DECISION_HOUR/MINUTE out of range");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: c.TIMEZONE });
  } catch {
    errors.push(`Unknown TIMEZONE ${c.TIMEZONE}`);
  }
  if (errors.length) throw new Error(`Unsafe configuration:\n${errors.map((e) => ` - ${e}`).join("\n")}`);

  return {
    ...c,
    nearFeeReserve: parseUnits(c.NEAR_FEE_RESERVE, NEAR_DECIMALS),
    solFeeReserve: parseUnits(c.SOL_FEE_RESERVE, SOL_DECIMALS),
    minPositionLamports: parseUnits(c.MIN_POSITION_SOL, SOL_DECIMALS),
    maxPositionLamports: parseUnits(c.MAX_POSITION_SOL, SOL_DECIMALS),
    minEligibleTokenBalance: parseUnits(c.MIN_ELIGIBLE_TOKEN_BALANCE, c.MEME_TOKEN_DECIMALS),
    vaultDailyHuntCap: parseUnits(c.VAULT_DAILY_HUNT_CAP_NEAR, NEAR_DECIMALS),
    adminIds: new Set(c.TELEGRAM_ADMIN_IDS.map(Number).filter(Number.isFinite)),
    boundary: { timezone: c.TIMEZONE, hour: c.DAILY_DECISION_HOUR, minute: c.DAILY_DECISION_MINUTE },
    liveTransfers: c.BAGFLIP_ENV === "live" && c.LIVE_TRANSFERS_ENABLED,
    liveTrading: c.BAGFLIP_ENV === "live" && c.LIVE_TRADING_ENABLED,
  };
}

/** Config for tests: development defaults plus overrides. */
export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    BAGFLIP_ENV: "development",
    MEME_TOKEN_CONTRACT_ID: "bagflip.test.near",
    TREASURY_NEAR_ADDRESS: "bagflip-treasury.test.near",
    CREATOR_WALLET_ADDRESS: "creator.test.near",
    TRADING_WALLET_ADDRESS: "TradingWa11et1111111111111111111111111111111",
    VOTING_INITIAL_QUORUM_PERCENT: "0",
    VOTING_MIN_QUORUM_PERCENT: "0",
    VOTING_MIN_DISTINCT_WALLETS: "1",
    ...over,
  });
}
