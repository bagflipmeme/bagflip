/** Build the holder index from chain history and print a summary (no treasury needed). */
import { openDb } from "../src/db/index.ts";
import { FastNearHolderIndex } from "../src/distribution/holders.ts";
import { createLogger } from "../src/shared/log.ts";
import { NearRpc } from "../src/near/rpc.ts";
import { RpcNearChain } from "../src/near/chain.ts";

const token = process.env.MEME_TOKEN_CONTRACT_ID || "bagflip.v2-launchpad.justhoot.near";
const db = await openDb(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : { memory: !process.env.PGLITE_DATA_DIR, dataDir: process.env.PGLITE_DATA_DIR });
const idx = new FastNearHolderIndex(db, token, process.env.FASTNEAR_TX_API_URL || "https://tx.main.fastnear.com", process.env.FASTNEAR_API_URL || "https://api.fastnear.com", createLogger("info"));
const t0 = Date.now();
const d = await idx.discover();
const chain = new RpcNearChain(new NearRpc(process.env.NEAR_RPC_URL || "https://rpc.mainnet.fastnear.com"), "");
const block = await chain.finalBlock();
const bals = await chain.ftBalances(token, d.accounts, block);
const nonzero = [...bals].filter(([, b]) => b > 0n);
console.log(JSON.stringify({ candidates: d.accounts.length, holdersWithBalance: nonzero.length, complete: d.complete, source: d.source, block: block.height.toString(), seconds: (Date.now() - t0) / 1000 }));
await db.close();
