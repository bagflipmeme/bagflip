/**
 * Entry point. ROLE=all runs bot + api + worker in one process (cheapest
 * deployment for a $5–$10/day treasury). ROLE=bot|api|worker splits them.
 * Run exactly ONE worker; the hunt engine also holds a DB lease.
 */
import { webhookCallback } from "grammy";
import { loadConfig } from "./shared/config.ts";
import { buildApp } from "./app.ts";
import { createBot, drainOutbox, refreshGovernanceMessage } from "./bot/bot.ts";
import { createApiServer } from "./api/server.ts";
import { startWorker } from "./worker/worker.ts";

const cfg = loadConfig();
const app = await buildApp(cfg);
const role = cfg.ROLE;
app.log.info("BAGFLIP starting", { role, env: cfg.BAGFLIP_ENV, exec: app.exec.mode, liveTrading: cfg.liveTrading, liveTransfers: cfg.liveTransfers });

const hasBot = !!cfg.TELEGRAM_BOT_TOKEN;
const bot = hasBot ? createBot(app) : undefined;

if (role === "all" || role === "api") {
  const hook = bot && cfg.TELEGRAM_WEBHOOK_SECRET ? webhookCallback(bot, "http") : undefined;
  createApiServer(app, hook).listen(cfg.PORT, () => app.log.info("http listening", { port: cfg.PORT }));
}

if (bot && (role === "all" || role === "bot")) {
  await bot.init();
  await bot.api.setMyCommands([
    { command: "start", description: "Intro to BAGFLIP" },
    { command: "vote", description: "DISTRIBUTE or AUTO HUNT" },
    { command: "status", description: "Mode, votes, next decision" },
    { command: "treasury", description: "Treasury balances" },
    { command: "connect", description: "Verify a NEAR wallet" },
    { command: "power", description: "Your voting power" },
    { command: "trades", description: "AUTO HUNT trades" },
    { command: "pnl", description: "Trading performance" },
    { command: "claim", description: "Claim rewards" },
    { command: "help", description: "All commands" },
  ]);
  if (cfg.TELEGRAM_WEBHOOK_SECRET) {
    await bot.api.setWebhook(`${cfg.PUBLIC_URL}/telegram/webhook`, { secret_token: cfg.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
    app.log.info("telegram webhook set");
  } else {
    await bot.api.deleteWebhook();
    void bot.start({ allowed_updates: ["message", "callback_query"] });
    app.log.info("telegram long polling started", { bot: bot.botInfo.username });
  }
  // Outbox + pinned governance message loops.
  setInterval(() => void drainOutbox(app, bot).catch((e) => app.log.warn("outbox", { error: String(e) })), 3_000);
  setInterval(() => void refreshGovernanceMessage(app, bot).catch((e) => app.log.warn("governance message", { error: String(e) })), 5 * 60_000);
} else if (!hasBot) {
  app.log.warn("TELEGRAM_BOT_TOKEN not set: bot disabled");
}

if (role === "all" || role === "worker") {
  const w = await startWorker(app);
  const shutdown = async () => {
    app.log.info("shutting down");
    w.stop();
    await bot?.stop().catch(() => {});
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
