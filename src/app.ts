/**
 * Composition root: builds every service for the configured environment.
 *
 *              development        paper                       live
 * NEAR reads   SimNearChain       real RPC + FastNEAR         real RPC + FastNEAR
 * market data  SimMarketData      DexScreener + PumpPortal    DexScreener + PumpPortal
 * execution    SimulatedExecution PaperExecution (Jupiter     LiveExecution (Jupiter V2 /
 *                                 quotes, modeled fills)      PumpPortal, signed & sent)*
 * bridge       SimBridge          SimBridge (virtual)         1Click*
 * vault        SimVault (same     SimVault                    vault contract (operator
 *              rules in-process)                              key calls it)*
 * (* only when LIVE_TRADING_ENABLED / LIVE_TRANSFERS_ENABLED and keys are set)
 */
import { randomBytes } from "node:crypto";
import { openDb, type Db } from "./db/index.ts";
import type { Config } from "./shared/config.ts";
import { createLogger, type Logger } from "./shared/log.ts";
import { systemClock, type Clock } from "./shared/time.ts";
import { NearRpc } from "./near/rpc.ts";
import { RpcNearChain, SimNearChain, type NearChain } from "./near/chain.ts";
import { NearSigner } from "./near/signer.ts";
import { FixedPrices, OneClickPrices, type PriceOracle } from "./treasury/prices.ts";
import { OneClickClient, SimBridge, type BridgeProvider } from "./bridge/oneclick.ts";
import { VaultDepositor, SolTradingDepositor, VirtualDepositor, type Depositor } from "./bridge/depositors.ts";
import { RpcVault, SimVault, type VaultPort } from "./near/vault.ts";
import { trustSimulated, type BridgeDeps, type DestinationVerifier } from "./bridge/bridge.ts";
import { SolanaChain, TradingKeypair } from "./solana/rpc.ts";
import { JupiterClient } from "./solana/execution/jupiter.ts";
import { LiveExecution } from "./solana/execution/live.ts";
import { PaperExecution } from "./solana/execution/paper.ts";
import { SimMarket, SimMarketData, SimulatedExecution, simSafety } from "./solana/execution/simulated.ts";
import type { ExecutionAdapter } from "./solana/execution/types.ts";
import { DexScreenerMarket } from "./market/dexscreener.ts";
import { OnChainSafety } from "./market/safety.ts";
import type { MarketDataProvider, SafetyChecker } from "./market/types.ts";
import { HuntEngine } from "./trading/hunt.ts";
import { A, balance } from "./treasury/ledger.ts";
import { FastNearHolderIndex, StaticHolderSource, type HolderSource } from "./distribution/holders.ts";

export interface App {
  cfg: Config;
  db: Db;
  clock: Clock;
  log: Logger;
  chain: NearChain;
  nearRpc?: NearRpc;
  prices: PriceOracle;
  bridge: BridgeDeps;
  exec: ExecutionAdapter;
  market: MarketDataProvider;
  safety: SafetyChecker;
  hunt: HuntEngine;
  holders: HolderSource;
  sol?: SolanaChain;
  simMarket?: SimMarket;
  vault: VaultPort;
  instanceId: string;
  close(): Promise<void>;
}

export async function buildApp(cfg: Config, opts: { db?: Db; clock?: Clock; log?: Logger } = {}): Promise<App> {
  const log = opts.log ?? createLogger(cfg.LOG_LEVEL, { app: "bagflip", env: cfg.BAGFLIP_ENV });
  const clock = opts.clock ?? systemClock;
  const db = opts.db ?? (await openDb(cfg.DATABASE_URL ? { url: cfg.DATABASE_URL } : { dataDir: cfg.PGLITE_DATA_DIR }));
  const instanceId = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const dev = cfg.BAGFLIP_ENV === "development";

  // NEAR
  let chain: NearChain;
  let nearRpc: NearRpc | undefined;
  if (dev) chain = new SimNearChain(db, clock);
  else {
    nearRpc = new NearRpc(cfg.NEAR_RPC_URL, cfg.NEAR_ARCHIVAL_RPC_URL || undefined);
    chain = new RpcNearChain(nearRpc, cfg.FASTNEAR_TX_API_URL);
  }

  // Prices
  const prices: PriceOracle = dev ? new FixedPrices({ NEAR: 3.5, SOL: 85 }) : new OneClickPrices(cfg.ONECLICK_BASE_URL);

  // Solana + execution + market data
  let exec: ExecutionAdapter;
  let market: MarketDataProvider;
  let safety: SafetyChecker;
  let sol: SolanaChain | undefined;
  let simMarket: SimMarket | undefined;
  let tradingKp: TradingKeypair | undefined;
  const ledgerSol = () => balance(db, A.tradingAvailable, "SOL");
  if (dev) {
    simMarket = new SimMarket();
    exec = new SimulatedExecution(simMarket, ledgerSol);
    market = new SimMarketData(simMarket);
    safety = simSafety;
  } else {
    sol = new SolanaChain(cfg.SOLANA_RPC_URL);
    const jup = new JupiterClient(cfg.JUPITER_BASE_URL, cfg.JUPITER_API_KEY || undefined);
    const ds = new DexScreenerMarket(cfg.DEXSCREENER_BASE_URL, log.child({ mod: "market" }), { pumpPortalWs: cfg.PUMPPORTAL_DISCOVERY ? cfg.PUMPPORTAL_WS_URL : undefined });
    market = ds;
    safety = new OnChainSafety(sol);
    if (cfg.liveTrading) {
      tradingKp = new TradingKeypair(cfg.SOLANA_TRADING_PRIVATE_KEY, cfg.TRADING_WALLET_ADDRESS);
      exec = new LiveExecution(sol, tradingKp, jup, { venue: cfg.EXECUTION_VENUE, pumpPortalBase: cfg.PUMPPORTAL_BASE_URL, priorityFeeLamports: cfg.PRIORITY_FEE_LAMPORTS, log: log.child({ mod: "exec" }) });
    } else {
      exec = new PaperExecution(jup, {
        extraSlippageBps: cfg.PAPER_EXTRA_SLIPPAGE_BPS,
        failureRate: cfg.PAPER_TX_FAILURE_RATE,
        priorityFeeLamports: cfg.PRIORITY_FEE_LAMPORTS,
        seed: cfg.PAPER_SEED,
        ledgerSol,
      });
    }
  }

  // Bridge
  let provider: BridgeProvider;
  // Vault: the real contract in live mode (signing only when live transfers are enabled), otherwise
  // an in-process model of the same rules so dev/paper/tests exercise identical time-locks and caps.
  let vault: VaultPort;
  if (cfg.BAGFLIP_ENV === "live" && nearRpc) {
    const operator = cfg.liveTransfers ? new NearSigner(nearRpc, cfg.OPERATOR_ACCOUNT_ID, cfg.OPERATOR_PRIVATE_KEY) : undefined;
    vault = new RpcVault(nearRpc, cfg.TREASURY_NEAR_ADDRESS, operator);
  } else {
    vault = new SimVault(cfg.TREASURY_NEAR_ADDRESS || "bagflip.sim", clock, {
      modeDelayMs: cfg.VAULT_MODE_DELAY_HOURS * 3_600_000,
      distributionDelayMs: cfg.VAULT_DISTRIBUTION_DELAY_HOURS * 3_600_000,
      dailyHuntCap: cfg.vaultDailyHuntCap,
    });
  }
  const nearDepositor: Depositor = new VaultDepositor(vault);
  let solDepositor: Depositor = new VirtualDepositor();
  let verifier: DestinationVerifier = trustSimulated;
  if (cfg.liveTransfers && nearRpc) {
    provider = new OneClickClient(cfg.ONECLICK_BASE_URL, cfg.ONECLICK_API_KEY || undefined);
    if (tradingKp && sol) solDepositor = new SolTradingDepositor(sol, tradingKp);
    const solChain = sol;
    const nchain = chain;
    verifier = {
      async verify(dir, hashes) {
        if (!hashes.length) return false;
        if (dir === "NEAR_TO_SOL") {
          for (const h of hashes) if ((await solChain!.signatureState(h)).state === "confirmed") return true;
          return false;
        }
        for (const h of hashes) if ((await nchain.transfersInTx(h, cfg.TREASURY_NEAR_ADDRESS)).length) return true;
        return false;
      },
    };
  } else {
    const fp = prices;
    const cache: Record<string, number> = { NEAR: 3.5, SOL: 85 };
    provider = new SimBridge((a) => cache[a]!);
    // keep the simulated conversion rate near real prices in paper mode
    if (!dev) {
      void (async () => {
        for (const a of ["NEAR", "SOL"] as const) {
          const p = await fp.usd(a).catch(() => null);
          if (p) cache[a] = p;
        }
      })();
    }
  }
  const bridge: BridgeDeps = { db, clock, cfg, prices, provider, nearDepositor, solDepositor, verifier, vault, log: log.child({ mod: "bridge" }) };

  const holders: HolderSource =
    chain instanceof SimNearChain
      ? new StaticHolderSource(() => (chain as SimNearChain).allHolders())
      : new FastNearHolderIndex(db, cfg.MEME_TOKEN_CONTRACT_ID, cfg.FASTNEAR_TX_API_URL, cfg.FASTNEAR_API_URL, log.child({ mod: "holders" }));

  const hunt = new HuntEngine({ db, clock, cfg, log: log.child({ mod: "hunt" }), market, safety, exec, instanceId, vault });

  return {
    cfg,
    db,
    clock,
    log,
    chain,
    nearRpc,
    prices,
    bridge,
    exec,
    market,
    safety,
    hunt,
    holders,
    sol,
    simMarket,
    vault,
    instanceId,
    async close() {
      (market as { stop?: () => void }).stop?.();
      await db.close();
    },
  };
}
