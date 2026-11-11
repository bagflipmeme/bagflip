/**
 * Read-only checks of every external integration. Moves no funds, signs nothing.
 *   node scripts/verify-live.ts
 * Uses MEME_TOKEN_CONTRACT_ID (default: the BAGFLIP token) and optional
 * TELEGRAM_BOT_TOKEN / TREASURY_NEAR_ADDRESS / TRADING_WALLET_ADDRESS from env.
 */
import { NearRpc } from "../src/near/rpc.ts";
import { RpcNearChain } from "../src/near/chain.ts";
import { OneClickClient, ASSET } from "../src/bridge/oneclick.ts";
import { JupiterClient } from "../src/solana/execution/jupiter.ts";
import { SolanaChain } from "../src/solana/rpc.ts";
import { DexScreenerMarket } from "../src/market/dexscreener.ts";
import { FastNearHolderIndex } from "../src/distribution/holders.ts";
import { silentLogger } from "../src/shared/log.ts";
import { formatUnits } from "../src/shared/money.ts";

const env = process.env;
const token = env.MEME_TOKEN_CONTRACT_ID || "bagflip.v2-launchpad.justhoot.near";
const results: { check: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    results.push({ check: name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ check: name, ok: false, detail: String(e instanceof Error ? e.message : e).slice(0, 200) });
  }
}

const rpc = new NearRpc(env.NEAR_RPC_URL || "https://rpc.mainnet.fastnear.com");
const chain = new RpcNearChain(rpc, env.FASTNEAR_TX_API_URL || "https://tx.main.fastnear.com");
let block: Awaited<ReturnType<typeof chain.finalBlock>> | undefined;

await check("NEAR RPC final block", async () => {
  block = await chain.finalBlock();
  return `height ${block.height} at ${block.timestamp.toISOString()}`;
});
await check(`token metadata ${token}`, async () => {
  const m = await rpc.viewAt<{ symbol: string; decimals: number; name: string }>(token, "ft_metadata", {});
  return `${m.name} (${m.symbol}), ${m.decimals} decimals`;
});
await check("token supply + balances pinned to one block", async () => {
  const supply = await chain.ftTotalSupply(token, block!);
  const top = await fetch(`${env.FASTNEAR_API_URL || "https://api.fastnear.com"}/v1/ft/${token}/top`).then((r) => r.json() as Promise<{ accounts: { account_id: string }[] }>);
  const sample = top.accounts.slice(0, 3).map((a) => a.account_id);
  const bals = await chain.ftBalances(token, sample, block!);
  return `supply ${formatUnits(supply, 18, 0)}; ${[...bals].map(([a, b]) => `${a}=${formatUnits(b, 18, 0)}`).join(", ")} @${block!.height}`;
});
await check("FastNEAR holder index (first page)", async () => {
  const idx = new FastNearHolderIndex(null as never, token, env.FASTNEAR_TX_API_URL || "https://tx.main.fastnear.com", env.FASTNEAR_API_URL || "https://api.fastnear.com", silentLogger);
  const t = await idx.top();
  return `${t.length} top holders listed`;
});
if (env.TREASURY_NEAR_ADDRESS) {
  await check(`treasury ${env.TREASURY_NEAR_ADDRESS} holdings`, async () => {
    const h = await chain.nearHoldings(env.TREASURY_NEAR_ADDRESS!);
    return `native ${formatUnits(h.native, 24, 4)} NEAR, wNEAR ${formatUnits(h.wrapped, 24, 4)}`;
  });
}

const oc = new OneClickClient(env.ONECLICK_BASE_URL || "https://1click.chaindefuser.com", env.ONECLICK_API_KEY || undefined);
await check("1Click dry quote 5 wNEAR → SOL", async () => {
  const q = await oc.quote({
    originAsset: ASSET.WNEAR,
    destinationAsset: ASSET.SOL,
    amount: 5n * 10n ** 24n,
    recipient: env.TRADING_WALLET_ADDRESS || "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    refundTo: env.TREASURY_NEAR_ADDRESS || "near",
    slippageBps: 100,
    deadline: new Date(Date.now() + 3_600_000),
    dry: true,
  });
  return `out ${formatUnits(q.amountOut, 9, 6)} SOL (min ${formatUnits(q.minAmountOut, 9, 6)}), ~${q.timeEstimateSeconds}s, $${q.amountInUsd} → $${q.amountOutUsd}`;
});
await check("1Click dry quote 0.2 SOL → wNEAR", async () => {
  const q = await oc.quote({
    originAsset: ASSET.SOL,
    destinationAsset: ASSET.WNEAR,
    amount: 200_000_000n,
    recipient: env.TREASURY_NEAR_ADDRESS || "near",
    refundTo: env.TRADING_WALLET_ADDRESS || "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    slippageBps: 100,
    deadline: new Date(Date.now() + 3_600_000),
    dry: true,
  });
  return `out ${formatUnits(q.amountOut, 24, 4)} wNEAR, ~${q.timeEstimateSeconds}s`;
});

const ds = new DexScreenerMarket(env.DEXSCREENER_BASE_URL || "https://api.dexscreener.com", silentLogger);
let sampleMint: string | undefined;
await check("DexScreener discovery + pair snapshot", async () => {
  const c = await ds.candidates(Date.now());
  const snap = await ds.snapshot(c.slice(0, 30).map((x) => x.mint));
  const pump = snap.filter((m) => ["pumpfun", "pumpswap"].includes(m.dexId));
  sampleMint = (pump[0] ?? snap[0])?.mint;
  return `${c.length} candidates, ${snap.length} SOL pairs (${pump.length} pump.fun/pumpswap)`;
});
const jup = new JupiterClient(env.JUPITER_BASE_URL || "https://api.jup.ag/swap/v2", env.JUPITER_API_KEY || undefined);
await check("Jupiter Swap V2 quote (0.05 SOL buy + sell back)", async () => {
  if (!sampleMint) throw new Error("no sample mint");
  const b = await jup.quote("buy", sampleMint, 50_000_000n);
  if (!b) throw new Error(`no route for ${sampleMint}`);
  const s = await jup.quote("sell", sampleMint, b.outAmount);
  return `${sampleMint.slice(0, 8)}… via ${b.venue}; round trip ${s ? ((1 - Number(s.outAmount) / 5e7) * 100).toFixed(2) + "% cost" : "no sell route"}`;
});
const sol = new SolanaChain(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
await check("Solana RPC + mint safety facts", async () => {
  const h = await sol.blockHeight();
  if (!sampleMint) return `block height ${h}`;
  const mi = await sol.mintInfo(sampleMint);
  return `block height ${h}; ${sampleMint.slice(0, 8)}… mintAuthority=${mi?.mintAuthority ?? "none"} freeze=${mi?.freezeAuthority ?? "none"}`;
});
if (env.TRADING_WALLET_ADDRESS) await check("trading wallet balance", async () => `${formatUnits(await sol.balanceLamports(env.TRADING_WALLET_ADDRESS!), 9, 6)} SOL`);
if (env.TELEGRAM_BOT_TOKEN) {
  await check("Telegram getMe", async () => {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`).then((x) => x.json() as Promise<{ ok: boolean; result?: { username: string } }>);
    if (!r.ok) throw new Error("token rejected");
    return `@${r.result!.username}`;
  });
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
