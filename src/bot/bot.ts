/**
 * Telegram bot (grammY). Group: pinned governance message with inline vote
 * buttons. DM: wallet linking, power, claims. All money logic lives in the
 * services; the bot only authenticates the Telegram user, rate-limits, and renders.
 *
 * Telegram updates arrive either by long polling or by webhook; webhook
 * requests are authenticated with TELEGRAM_WEBHOOK_SECRET (see api/server.ts).
 * Callback data is strictly validated against a fixed set of values.
 */
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { App } from "../app.ts";
import { audit, getState, setState } from "../db/index.ts";
import { upsertUser, createChallenge, castVote, userWallets, unlinkWallet, AuthError, type UserRow } from "../governance/wallets.ts";
import { computeLiveTally, currentMode } from "../governance/cycle.ts";
import { requestClaim, claimableByAccount } from "../distribution/claims.ts";
import { creditDepositTx, recordDeposit } from "../treasury/treasury.ts";
import { SimNearChain } from "../near/chain.ts";
import { formatAsset, formatUnits, parseUnits, NEAR_DECIMALS } from "../shared/money.ts";
import type { UserFromGetMe } from "grammy/types";
import { esc } from "../shared/outbox.ts";
import { DISCLOSURES, HELP, MODE_LABEL, governanceMessage, pnlMessage, powerLine, statusMessage, tradesMessage, treasuryMessage, voteKeyboard } from "./views.ts";
import type { Choice } from "../governance/engine.ts";
import { RateLimiter } from "../market/dexscreener.ts";

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

class UserLimiter {
  private m = new Map<number, { tokens: number; at: number }>();
  private perMinute: any;
  private burst: any;
  constructor(perMinute = 20, burst = 6) {
    this.perMinute = perMinute;
    this.burst = burst;}
  allow(id: number): boolean {
    const now = Date.now();
    const s = this.m.get(id) ?? { tokens: this.burst, at: now };
    s.tokens = Math.min(this.burst, s.tokens + ((now - s.at) / 60_000) * this.perMinute);
    s.at = now;
    if (s.tokens < 1) {
      this.m.set(id, s);
      return false;
    }
    s.tokens -= 1;
    this.m.set(id, s);
    return true;
  }
}

export function createBot(app: App, opts: { botInfo?: UserFromGetMe } = {}) {
  const { cfg, db, clock } = app;
  const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN || "0:test", opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  const limiter = new UserLimiter();
  const isAdmin = (ctx: Context) => !!ctx.from && cfg.adminIds.has(ctx.from.id);
  const isPrivate = (ctx: Context) => ctx.chat?.type === "private";

  bot.use(async (ctx, next) => {
    if (ctx.from && !isAdmin(ctx) && !limiter.allow(ctx.from.id)) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Slow down a little 🙂" }).catch(() => {});
      return;
    }
    await next();
  });

  const user = async (ctx: Context): Promise<UserRow> => upsertUser(db, { id: ctx.from!.id, username: ctx.from!.username, first_name: ctx.from!.first_name });
  const dmOnly = async (ctx: Context) => {
    if (isPrivate(ctx)) return false;
    const me = cfg.TELEGRAM_BOT_USERNAME || ctx.me?.username;
    await ctx.reply(`For your privacy, use this in a direct message${me ? `: https://t.me/${me}` : ""}.`);
    return true;
  };

  bot.command("start", async (ctx) => {
    await user(ctx);
    await ctx.reply(
      [
        "<b>Welcome to BAGFLIP</b> 🦉",
        "",
        `A public treasury filled by creator tax rewards. ${esc(cfg.MEME_TOKEN_SYMBOL)} holders decide what it does — continuously, weighted by holdings:`,
        "💰 <b>DISTRIBUTE</b> rewards to holders, or",
        "🔥 <b>AUTO HUNT</b> — let an autonomous bot gamble them on Solana meme tokens. It can lose everything.",
        "",
        "1. /connect your NEAR wallet (you sign a message; no funds move)",
        "2. /vote once — your choice stays active until you change it",
        "3. Every day at 00:00 MYT the weighted majority sets the mode.",
        "",
        "/help for all commands · /disclosures for risks",
      ].join("\n"),
      HTML,
    );
  });

  bot.command("help", (ctx) => ctx.reply(HELP(cfg), HTML));
  bot.command("disclosures", (ctx) => ctx.reply(DISCLOSURES(cfg), HTML));

  bot.command("connect", async (ctx) => {
    if (await dmOnly(ctx)) return;
    const u = await user(ctx);
    try {
      const ch = await createChallenge(db, clock, cfg, u);
      const url = `${cfg.PUBLIC_URL}/connect?c=${encodeURIComponent(ch.id)}`;
      const kb = new InlineKeyboard();
      if (url.startsWith("https://")) kb.webApp("🔐 Verify NEAR wallet", url);
      else kb.url("🔐 Verify NEAR wallet", url);
      await ctx.reply(
        [
          "<b>Connect a NEAR wallet</b>",
          "Open the verification page and sign the message with your wallet. This proves ownership without moving funds.",
          `This link is single-use and expires in ${cfg.AUTH_CHALLENGE_TTL_MINUTES} minutes.`,
          "",
          "⚠️ BAGFLIP will <b>never</b> ask for your seed phrase, private key or password.",
        ].join("\n"),
        { ...HTML, reply_markup: kb },
      );
    } catch (e) {
      await ctx.reply(e instanceof AuthError ? e.message : "Could not start verification, try again shortly.");
    }
  });

  bot.command("disconnect", async (ctx) => {
    if (await dmOnly(ctx)) return;
    const u = await user(ctx);
    const acct = String(ctx.match ?? "").trim().toLowerCase();
    if (!acct) return void (await ctx.reply("Usage: /disconnect yourname.near"));
    const ok = await unlinkWallet(db, clock, u.id, acct);
    await ctx.reply(ok ? `Unlinked <code>${esc(acct)}</code>. Its vote no longer counts.` : "That wallet is not linked to you.", HTML);
  });

  const sendVote = async (ctx: Context) => {
    const text = await governanceMessage(db, cfg, app.prices, clock.now());
    let mine = "";
    if (ctx.from) {
      const u = await user(ctx);
      const ws = await userWallets(db, u.id);
      mine = ws.length ? `\n\nYour vote: <b>${ws[0]!.choice ? MODE_LABEL[ws[0]!.choice] : "none yet"}</b> (${ws.length} wallet${ws.length > 1 ? "s" : ""})` : "\n\n<i>Connect a wallet in DM (/connect) to vote.</i>";
    }
    await ctx.reply(text + (isPrivate(ctx) ? mine : ""), { ...HTML, reply_markup: voteKeyboard() });
  };
  bot.command("vote", sendVote);

  bot.callbackQuery(/^v:(D|H)$/, async (ctx) => {
    const choice: Choice = ctx.match![1] === "D" ? "DISTRIBUTE" : "AUTO_HUNT";
    const u = await user(ctx);
    try {
      const r = await castVote(db, clock, u.id, choice);
      await ctx.answerCallbackQuery({
        text: r.changed ? `Vote recorded: ${choice === "DISTRIBUTE" ? "DISTRIBUTE" : "AUTO HUNT"} on ${r.wallets} wallet(s). It stays active until you change it.` : `You already vote ${choice === "DISTRIBUTE" ? "DISTRIBUTE" : "AUTO HUNT"}.`,
        show_alert: false,
      });
      if (r.changed) void refreshGovernanceMessage(app, bot).catch(() => {});
    } catch (e) {
      const me = cfg.TELEGRAM_BOT_USERNAME || ctx.me?.username;
      await ctx.answerCallbackQuery({ text: e instanceof AuthError ? `${e.message}${me ? ` DM @${me}` : ""}` : "Vote failed, try again.", show_alert: true });
    }
  });

  bot.command("status", async (ctx) => ctx.reply(await statusMessage(db, cfg, app.prices, clock.now()), HTML));
  bot.command("treasury", async (ctx) => ctx.reply(await treasuryMessage(db, cfg, app.prices), HTML));
  bot.command("trades", async (ctx) => ctx.reply(await tradesMessage(db, cfg), HTML));
  bot.command("pnl", async (ctx) => ctx.reply(await pnlMessage(db, cfg, app.prices), HTML));

  bot.command("power", async (ctx) => {
    if (await dmOnly(ctx)) return;
    const u = await user(ctx);
    const ws = await userWallets(db, u.id);
    if (!ws.length) return void (await ctx.reply("No verified wallets yet. Use /connect."));
    let bal = new Map<string, bigint>();
    try {
      const block = await app.chain.finalBlock();
      bal = await app.chain.ftBalances(cfg.MEME_TOKEN_CONTRACT_ID, ws.map((w) => w.account_id), block);
    } catch {
      /* show without balances */
    }
    const total = ws.reduce((s, w) => s + (bal.get(w.account_id) ?? 0n), 0n);
    await ctx.reply(
      [
        "<b>Your voting power</b>",
        ...ws.map((w) => powerLine(cfg, w.account_id, bal.has(w.account_id) ? bal.get(w.account_id)! : null, w.choice)),
        "",
        `Current total: <b>${formatUnits(total, cfg.MEME_TOKEN_DECIMALS, 2)}</b> ${esc(cfg.MEME_TOKEN_SYMBOL)}`,
        "<i>Binding weight is re-read at the 00:00 MYT snapshot block. Buying or selling changes it at the next snapshot.</i>",
      ].join("\n"),
      HTML,
    );
  });

  bot.command("claim", async (ctx) => {
    if (await dmOnly(ctx)) return;
    const u = await user(ctx);
    const ws = await userWallets(db, u.id);
    if (!ws.length) return void (await ctx.reply("Connect a NEAR wallet first with /connect."));
    const c = await claimableByAccount(db, ws.map((w) => w.account_id));
    const total = [...c.values()].reduce((s, v) => s + v, 0n);
    if (total === 0n) return void (await ctx.reply("You have nothing claimable right now. Rewards appear here after a DISTRIBUTE payout snapshot."));
    await ctx.reply(
      [
        "<b>Claimable rewards</b>",
        ...ws.map((w) => `• <code>${esc(w.account_id)}</code>: ${formatAsset(c.get(w.account_id) ?? 0n, "NEAR")}`),
        "",
        `Payouts are made by the vault contract <code>${esc(cfg.TREASURY_NEAR_ADDRESS)}</code>, only to the wallet named in the on-chain payout list, after its guardian veto window.`,
        `Prefer to claim yourself? Proofs: ${esc(cfg.PUBLIC_URL)}/public/proofs/&lt;your-account&gt;`,
      ].join("\n"),
      { ...HTML, reply_markup: new InlineKeyboard().text(`Claim ${formatAsset(total, "NEAR")}`, "claim:go") },
    );
  });

  bot.callbackQuery("claim:go", async (ctx) => {
    const u = await user(ctx);
    const r = await requestClaim({ db, clock, cfg, prices: app.prices, log: app.log, vault: app.vault }, u.id);
    if (r.status === "queued") {
      await ctx.answerCallbackQuery({ text: "Claim queued." });
      await ctx.reply(`✅ Claim queued: ${r.claims.map((c) => `${formatAsset(c.amount, "NEAR")} → ${esc(c.accountId)}${c.activatesAt && c.activatesAt > clock.now() ? ` (vault releases it after ${c.activatesAt.toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}`).join(", ")}. You'll get a message when the vault pays it.`, HTML);
    } else await ctx.answerCallbackQuery({ text: r.reason, show_alert: true });
  });

  // ───────────── admin ─────────────
  const admin = (name: string, fn: (ctx: Context & { match: string }) => Promise<unknown>) =>
    bot.command(name, async (ctx) => {
      if (!isAdmin(ctx)) return;
      await audit(db, `tg:${ctx.from!.id}`, `cmd:${name}`, { args: String(ctx.match ?? "") });
      try {
        await fn(ctx as never);
      } catch (e) {
        await ctx.reply(`Error: ${esc(String(e instanceof Error ? e.message : e))}`, HTML);
      }
    });

  admin("pause", async (ctx) => {
    await setState(db, "emergency_pause", true);
    await ctx.reply("⏸️ Emergency pause ON. No new trades or treasury transfers. Open positions are still monitored.");
  });
  admin("resume", async (ctx) => {
    await setState(db, "emergency_pause", false);
    await ctx.reply("▶️ Emergency pause OFF.");
  });
  admin("deposit", async (ctx) => {
    const hash = ctx.match.trim();
    if (!hash) return ctx.reply("Usage: /deposit <near_tx_hash>");
    const r = await creditDepositTx({ db, clock, cfg, chain: app.chain, prices: app.prices }, hash, `tg:${ctx.from!.id}`);
    await ctx.reply(`Credited ${r.credited} transfer(s); ${r.unattributed} unattributed.`);
  });
  admin("post_governance", async (ctx) => {
    if (!cfg.TELEGRAM_GROUP_ID) return ctx.reply("TELEGRAM_GROUP_ID not set");
    await setState(db, "governance_message", null);
    await refreshGovernanceMessage(app, bot, { forceNew: true });
    await ctx.reply("Governance message posted and pinned.");
  });
  admin("admin", async (ctx) => {
    const s = await getState(db, "trading_status");
    const r = await getState(db, "reconcile_report");
    const jobs = await db.query<{ type: string; status: string; n: string }>("SELECT type, status, count(*)::text AS n FROM jobs WHERE status <> 'done' GROUP BY type, status");
    await ctx.reply(`<pre>${esc(JSON.stringify({ mode: await currentMode(db), env: cfg.BAGFLIP_ENV, exec: app.exec.mode, trading: s, reconcile: r, jobs: jobs.rows }, null, 1)).slice(0, 3500)}</pre>`, HTML);
  });

  // Development-only simulation commands (never registered outside development).
  if (cfg.BAGFLIP_ENV === "development" && app.chain instanceof SimNearChain) {
    const sim = app.chain;
    admin("sim_deposit", async (ctx) => {
      const amt = parseUnits(ctx.match.trim() || "1", NEAR_DECIMALS);
      const id = `sim-${clock.now().getTime()}`;
      await recordDeposit({ db, clock, cfg, chain: app.chain, prices: app.prices }, { txHash: id, receiptId: id, sender: cfg.CREATOR_WALLET_ADDRESS || "creator.sim", amount: amt, source: "sim" });
      await ctx.reply(`Simulated deposit of ${formatAsset(amt, "NEAR")}.`);
    });
    admin("sim_balance", async (ctx) => {
      const [acct, amount] = ctx.match.trim().split(/\s+/);
      if (!acct || !amount) return ctx.reply("Usage: /sim_balance account.near 1000");
      await sim.setBalance(acct.toLowerCase(), parseUnits(amount, cfg.MEME_TOKEN_DECIMALS));
      await ctx.reply(`Simulated ${cfg.MEME_TOKEN_SYMBOL} balance set.`);
    });
  }

  bot.catch((err) => app.log.error("bot handler error", { error: err.error, update: err.ctx.update.update_id }));
  return bot;
}

let lastRefresh = 0;
/** Keep ONE pinned governance message in the group up to date (debounced). */
export async function refreshGovernanceMessage(app: App, bot: Bot, opts: { forceNew?: boolean } = {}) {
  const { cfg, db } = app;
  if (!cfg.TELEGRAM_GROUP_ID || !cfg.TELEGRAM_BOT_TOKEN) return;
  if (!opts.forceNew && Date.now() - lastRefresh < 20_000) return;
  lastRefresh = Date.now();
  await computeLiveTally({ db, chain: app.chain, clock: app.clock, cfg }).catch((e) => app.log.warn("tally failed", { error: String(e) }));
  const text = await governanceMessage(db, cfg, app.prices, app.clock.now());
  const cur = await getState<{ chatId: string; messageId: number } | null>(db, "governance_message");
  if (cur && !opts.forceNew) {
    try {
      await bot.api.editMessageText(cur.chatId, cur.messageId, text, { ...HTML, reply_markup: voteKeyboard() });
      return;
    } catch (e) {
      if (/message is not modified/.test(String(e))) return;
      if (!/message to edit not found|MESSAGE_ID_INVALID/.test(String(e))) throw e;
    }
  }
  const m = await bot.api.sendMessage(cfg.TELEGRAM_GROUP_ID, text, { ...HTML, reply_markup: voteKeyboard() });
  await bot.api.pinChatMessage(cfg.TELEGRAM_GROUP_ID, m.message_id, { disable_notification: true }).catch((e) => app.log.warn("pin failed (bot needs pin rights)", { error: String(e) }));
  await setState(db, "governance_message", { chatId: cfg.TELEGRAM_GROUP_ID, messageId: m.message_id });
}

/** Drain the notification outbox to Telegram (respecting group rate limits). */
export async function drainOutbox(app: App, bot: Bot, limiter = new RateLimiter(0.3, 3)) {
  const r = await app.db.query<{ id: string; text: string; chat: string; attempts: number }>(
    "SELECT id, text, chat, attempts FROM notifications WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 10",
  );
  for (const n of r.rows) {
    const targets =
      n.chat === "group" ? (app.cfg.TELEGRAM_GROUP_ID ? [app.cfg.TELEGRAM_GROUP_ID] : []) : n.chat === "admins" ? [...app.cfg.adminIds].map(String) : n.chat.startsWith("user:") ? [n.chat.slice(5)] : [];
    try {
      for (const t of targets) {
        await limiter.take();
        await bot.api.sendMessage(t, n.text, HTML);
      }
      await app.db.query("UPDATE notifications SET sent_at=now() WHERE id=$1", [n.id]);
    } catch (e) {
      await app.db.query("UPDATE notifications SET attempts=attempts+1, last_error=$2 WHERE id=$1", [n.id, String(e).slice(0, 500)]);
    }
  }
  return r.rows.length;
}
