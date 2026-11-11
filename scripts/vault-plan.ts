/**
 * Print the init arguments and the near-cli-rs commands to deploy, initialize, verify and LOCK the
 * vault. Executes nothing on chain.
 *   node --env-file=.env scripts/vault-plan.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { parseUnits, NEAR_DECIMALS } from "../src/shared/money.ts";

const e = process.env;
const vault = e.TREASURY_NEAR_ADDRESS || "bagflip.near";
const operator = e.OPERATOR_ACCOUNT_ID || "bagflip-bot.near";
const guardians = (e.VAULT_GUARDIANS || "").split(",").map((s) => s.trim()).filter(Boolean);
const threshold = Number(e.VAULT_GUARDIAN_THRESHOLD || 2);
const net = e.NEAR_NETWORK || "mainnet";
const wasm = "contracts/vault/res/bagflip_vault.wasm";

const problems: string[] = [];
if (!e.TRADING_WALLET_ADDRESS) problems.push("TRADING_WALLET_ADDRESS is not set (it is recorded in the vault, publicly)");
if (guardians.length < 3) problems.push("set at least 3 VAULT_GUARDIANS (independent community members)");
if (threshold < 2 || threshold > guardians.length) problems.push("VAULT_GUARDIAN_THRESHOLD should be ≥2 and ≤ number of guardians");
if (guardians.includes(operator)) problems.push("the operator cannot be a guardian");
if (e.CREATOR_WALLET_ADDRESS && guardians.includes(e.CREATOR_WALLET_ADDRESS)) problems.push("avoid making the creator wallet a guardian (it weakens independence)");

const args = {
  operator,
  guardians,
  guardian_threshold: threshold,
  wrap_near: net === "mainnet" ? "wrap.near" : "wrap.testnet",
  trading_recipient: e.TRADING_WALLET_ADDRESS || "<SOLANA_TRADING_WALLET>",
  daily_hunt_cap: parseUnits(e.VAULT_DAILY_HUNT_CAP_NEAR || "50", NEAR_DECIMALS).toString(),
  mode_delay_sec: Math.round(Number(e.VAULT_MODE_DELAY_HOURS || 12) * 3600),
  distribution_delay_sec: Math.round(Number(e.VAULT_DISTRIBUTION_DELAY_HOURS || 24) * 3600),
  admin_delay_sec: Math.round(Number(e.VAULT_ADMIN_DELAY_HOURS || 48) * 3600),
  reserve: parseUnits("1", NEAR_DECIMALS).toString(),
};

const bytes = readFileSync(wasm);
const codeHash = bs58.encode(createHash("sha256").update(bytes).digest());
const json = JSON.stringify(args);
const operatorMethods = "propose_mode, propose_distribution, fund_trading, claim_many, claim, unwrap, apply_pending_mode, pause";

console.log(`BAGFLIP vault plan (${net})
wasm: ${wasm} (${bytes.length} bytes), expected on-chain code_hash: ${codeHash}
${problems.length ? "\n⚠️  Fix before deploying:\n" + problems.map((p) => "   - " + p).join("\n") + "\n" : ""}
init args:
${JSON.stringify(args, null, 2)}

1) Deploy + initialize (from the account that controls ${vault}):
near contract deploy ${vault} use-file ${wasm} with-init-call new json-args '${json}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config ${net} sign-with-keychain send

2) Verify configuration and code hash:
near contract call-function as-read-only ${vault} get_config json-args {} network-config ${net} now
near account view-account-summary ${vault} network-config ${net} now      # code hash must be ${codeHash}

3) Operator key = function-call key that can ONLY call vault methods (put it in OPERATOR_PRIVATE_KEY):
near account add-key ${operator} grant-function-call-access --allowance '2 NEAR' --contract-account-id ${vault} --function-names '${operatorMethods}' autogenerate-new-keypair save-to-keychain network-config ${net} sign-with-keychain send

4) Point the creator reward stream at ${vault} (launchpad setting if available; otherwise forward manually).

5) LOCK — irreversible. List the vault's keys, then delete every one:
near account list-keys ${vault} network-config ${net} now
near account delete-keys ${vault} public-keys <ed25519:...> network-config ${net} sign-with-keychain send

6) Verify it is locked (0 access keys) and publish the account + code hash:
near account list-keys ${vault} network-config ${net} now
`);
