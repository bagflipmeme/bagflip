import { afterEach, describe, expect, it } from "vitest";
import { createBot } from "../src/bot/bot.ts";
import { makeHarness, setMode, type Harness } from "./harness.ts";
import { linkedUser, BAG } from "./helpers.ts";

let h: Harness;
afterEach(async () => {
  await h?.db.close();
  h = undefined as never;
});

const botInfo = { id: 1, is_bot: true as const, first_name: "BAGFLIP", username: "bagflip_test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as never;

function testBot(harness: Harness) {
  const calls: { method: string; payload: Record<string, any> }[] = [];
  const bot = createBot(harness.app, { botInfo });
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: method === "sendMessage" ? { message_id: calls.length, date: 0, chat: { id: 1, type: "private" } } : true } as never;
  });
  let uid = 1;
  const msg = (from: number, text: string, chatType: "private" | "supergroup" = "private") =>
    bot.handleUpdate({
      update_id: uid++,
      message: { message_id: uid, date: 0, chat: chatType === "private" ? { id: from, type: "private", first_name: "u" } : { id: -100, type: "supergroup", title: "g" }, from: { id: from, is_bot: false, first_name: "u" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] },
    } as never);
  const tap = (from: number, data: string) =>
    bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), from: { id: from, is_bot: false, first_name: "u" }, chat_instance: "c", data, message: { message_id: 5, date: 0, chat: { id: -100, type: "supergroup", title: "g" } } } } as never);
  return { calls, msg, tap };
}

describe("telegram bot", () => {
  it("renders /start, /status, /treasury, /trades, /pnl, /help without errors", async () => {
    h = await makeHarness();
    const b = testBot(h);
    const cmds = ["/start", "/status", "/treasury", "/trades", "/pnl", "/help", "/disclosures"];
    for (const [i, c] of cmds.entries()) await b.msg(7 + i, c); // separate users: one user is rate-limited after a burst of 6
    const texts = b.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);
    expect(texts).toHaveLength(7);
    expect(texts[1]).toContain("BAGFLIP GOVERNANCE");
    expect(texts[1]).toContain("Next Decision");
    expect(texts[2]).toContain("Reserved for distribution");
  });

  it("vote buttons record a persistent vote for a verified user, and refuse unverified users", async () => {
    h = await makeHarness();
    const b = testBot(h);
    await linkedUser(h, "dave.near", BAG(500), { telegramId: 555 });
    await b.tap(555, "v:H");
    const ack = b.calls.find((c) => c.method === "answerCallbackQuery")!;
    expect(ack.payload.text).toMatch(/Vote recorded: AUTO HUNT/);
    const v = await h.db.query("SELECT v.choice FROM votes v JOIN wallets w ON w.id=v.wallet_id WHERE w.account_id='dave.near'");
    expect(v.rows).toEqual([{ choice: "AUTO_HUNT" }]);

    await b.tap(556, "v:D"); // no wallet
    const ack2 = b.calls.filter((c) => c.method === "answerCallbackQuery")[1]!;
    expect(ack2.payload.text).toMatch(/Connect a NEAR wallet/);
    expect(ack2.payload.show_alert).toBe(true);
    // forged callback data is ignored
    await b.tap(555, "v:X");
    expect(b.calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(2);
  });

  it("keeps private flows in DM and issues single-use connect links", async () => {
    h = await makeHarness({ PUBLIC_URL: "https://bagflip.example" });
    const b = testBot(h);
    await b.msg(9, "/connect", "supergroup");
    expect(b.calls.at(-1)!.payload.text).toMatch(/direct message/);
    await b.msg(9, "/connect");
    const kb = b.calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0];
    expect(kb.web_app.url).toMatch(/^https:\/\/bagflip\.example\/connect\?c=/);
    expect(b.calls.at(-1)!.payload.text).toMatch(/never<\/b> ask for your seed phrase/);
  });

  it("admin commands are ignored for non-admins and audited for admins", async () => {
    h = await makeHarness({ TELEGRAM_ADMIN_IDS: "1000001" });
    const b = testBot(h);
    await b.msg(5, "/pause");
    expect(b.calls).toHaveLength(0);
    await b.msg(1000001, "/pause");
    expect(b.calls.at(-1)!.payload.text).toMatch(/Emergency pause ON/);
    const a = await h.db.query("SELECT action FROM admin_audit");
    expect(a.rows).toEqual([{ action: "cmd:pause" }]);
    // Emergency pause blocks new entries.
    await setMode(h, "AUTO_HUNT");
    const r = await h.app.hunt.tick({ force: true });
    expect(r.paused).toContain("emergency pause is active");
  });
});
