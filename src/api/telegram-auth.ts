/**
 * Telegram Mini App initData validation
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string))
 * data_check_string = all fields except `hash`, sorted, "k=v" joined by "\n".
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function validateInitData(initData: string, botToken: string, maxAgeSeconds = 86_400, nowMs = Date.now()): { ok: true; userId: number } | { ok: false; reason: string } {
  if (!initData || !botToken) return { ok: false, reason: "missing" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no hash" };
  params.delete("hash");
  const dcs = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expect = createHmac("sha256", secret).update(dcs).digest("hex");
  if (expect.length !== hash.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(hash))) return { ok: false, reason: "bad hash" };
  const authDate = Number(params.get("auth_date"));
  if (!authDate || nowMs / 1000 - authDate > maxAgeSeconds) return { ok: false, reason: "expired" };
  try {
    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number };
    if (typeof user.id !== "number") return { ok: false, reason: "no user" };
    return { ok: true, userId: user.id };
  } catch {
    return { ok: false, reason: "bad user" };
  }
}

/** Test helper: build valid initData. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const p = new URLSearchParams(fields);
  const dcs = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  p.set("hash", createHmac("sha256", secret).update(dcs).digest("hex"));
  return p.toString();
}
