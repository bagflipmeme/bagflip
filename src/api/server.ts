/**
 * HTTP surface (node:http, no framework):
 *   GET  /health                        liveness + DB check
 *   GET  /connect?c=<challenge>         wallet verification Mini App
 *   GET  /api/challenge/:id             challenge text for the page
 *   POST /api/link                      verify NEP-413 signature and link wallet
 *   POST /telegram/webhook              Telegram updates (secret-token authenticated)
 *   GET  /public/decisions[/:cycle]     audit: decisions + per-wallet snapshot rows
 *   GET  /public/ledger                 audit: latest journals with entries
 *   GET  /public/distributions/:id      audit: a distribution's entitlements
 *   GET  /admin/status, POST /admin/pause   (Bearer ADMIN_API_TOKEN)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import { audit, getState, setState } from "../db/index.ts";
import { getChallenge, verifyAndLink, AuthError } from "../governance/wallets.ts";
import { validateInitData } from "./telegram-auth.ts";
import { connectPage } from "./connect-page.ts";
import { treasurySummary } from "../treasury/treasury.ts";
import { currentDecision } from "../governance/cycle.ts";
import { notify, esc } from "../shared/outbox.ts";
import { payoutTree, proofsFor, canonicalSnapshot } from "../distribution/vault-sync.ts";
import { sha256Hex } from "../distribution/merkle.ts";
import { funnelReport, experimentReport } from "../trading/report.ts";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const ipHits = new Map<string, { n: number; reset: number }>();
function rateLimited(req: IncomingMessage, perMinute = 30) {
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
  const now = Date.now();
  const h = ipHits.get(ip);
  if (!h || h.reset < now) {
    ipHits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  h.n++;
  return h.n > perMinute;
}

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApiServer(app: App, telegramWebhook?: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void) {
  const { cfg, db } = app;
  const isAdmin = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    return !!cfg.ADMIN_API_TOKEN && h.startsWith("Bearer ") && safeEq(h.slice(7), cfg.ADMIN_API_TOKEN);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      res.setHeader("x-content-type-options", "nosniff");
      if (req.method === "GET" && path === "/health") {
        await db.query("SELECT 1");
        return json(res, 200, { ok: true, env: cfg.BAGFLIP_ENV, mode: (await currentDecision(db))?.effective_mode ?? "INACTIVE" });
      }

      if (req.method === "POST" && path === "/telegram/webhook" && telegramWebhook) {
        const tok = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
        if (!cfg.TELEGRAM_WEBHOOK_SECRET || !safeEq(tok, cfg.TELEGRAM_WEBHOOK_SECRET)) return json(res, 401, { error: "unauthorized" });
        return telegramWebhook(req, res);
      }

      if (req.method === "GET" && path === "/connect") {
        const c = url.searchParams.get("c") ?? "";
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org https://esm.sh; connect-src 'self' https: wss:; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; frame-src https:; frame-ancestors https://web.telegram.org https://*.telegram.org",
        });
        return res.end(connectPage(/^[A-Za-z0-9_-]{10,40}$/.test(c)));
      }

      if (req.method === "GET" && path.startsWith("/api/challenge/")) {
        if (rateLimited(req)) return json(res, 429, { error: "rate limited" });
        const ch = await getChallenge(db, decodeURIComponent(path.slice("/api/challenge/".length)));
        if (!ch || ch.used_at || new Date(ch.expires_at) < app.clock.now()) return json(res, 404, { error: "expired or unknown" });
        return json(res, 200, { message: ch.message, nonceB64: ch.nonce_b64, recipient: ch.recipient, expiresAt: ch.expires_at });
      }

      if (req.method === "POST" && path === "/api/link") {
        if (rateLimited(req, 10)) return json(res, 429, { error: "rate limited" });
        const body = JSON.parse(await readBody(req)) as { challengeId?: string; accountId?: string; publicKey?: string; signature?: string; initData?: string };
        if (!body.challengeId || !body.accountId || !body.publicKey || !body.signature) return json(res, 400, { error: "missing fields" });
        let telegramUserId: number | undefined;
        if (body.initData) {
          const v = validateInitData(body.initData, cfg.TELEGRAM_BOT_TOKEN);
          if (!v.ok) return json(res, 401, { error: "Telegram session could not be verified" });
          telegramUserId = v.userId;
        }
        try {
          const r = await verifyAndLink(db, app.chain, app.clock, { challengeId: body.challengeId, accountId: body.accountId, publicKey: body.publicKey, signature: body.signature, telegramUserId });
          const u = await db.query<{ telegram_id: string }>("SELECT telegram_id FROM users WHERE id=$1", [r.userId]);
          if (u.rows[0]) {
            await notify(db, app.clock, `linked:${r.walletId}`, "admin", `✅ Wallet <code>${esc(r.accountId)}</code> verified. Use /vote to choose DISTRIBUTE or AUTO HUNT.`, `user:${u.rows[0].telegram_id}`);
          }
          return json(res, 200, { ok: true, accountId: r.accountId, alreadyLinked: r.alreadyLinked });
        } catch (e) {
          if (e instanceof AuthError) return json(res, 400, { error: e.message, code: e.code });
          throw e;
        }
      }

      if (req.method === "GET" && path === "/public/decisions") {
        const r = await db.query("SELECT cycle_id, boundary_at, block_height, block_hash, previous_mode, effective_mode, changed, reason, weight_distribute, weight_hunt, eligible_supply, distinct_wallets, quorum_met FROM governance_decisions ORDER BY boundary_at DESC LIMIT 60");
        return json(res, 200, r.rows);
      }
      if (req.method === "GET" && path.startsWith("/public/decisions/")) {
        const cycle = decodeURIComponent(path.slice("/public/decisions/".length));
        const d = await db.query<{ id: string }>("SELECT * FROM governance_decisions WHERE cycle_id=$1", [cycle]);
        if (!d.rows[0]) return json(res, 404, { error: "not found" });
        const e = await db.query("SELECT account_id, choice, balance, counted, note FROM governance_snapshot_entries WHERE decision_id=$1 ORDER BY balance DESC", [d.rows[0].id]);
        const dd = d.rows[0] as unknown as { block_height: string; block_hash: string; effective_mode: string };
        const byAccount = [...(e.rows as { account_id: string }[])].sort((a, b) => (a.account_id < b.account_id ? -1 : 1));
        const canonical = canonicalSnapshot(cycle, dd, byAccount as never);
        // snapshot_hash is what the vault records with propose_mode for this cycle
        return json(res, 200, { decision: d.rows[0], snapshot: e.rows, canonical, snapshot_hash: sha256Hex(canonical) });
      }
      if (req.method === "GET" && path.startsWith("/public/proofs/")) {
        const acct = decodeURIComponent(path.slice("/public/proofs/".length)).toLowerCase();
        if (!/^[a-z0-9._-]{2,64}$/.test(acct)) return json(res, 400, { error: "bad account" });
        const proofs = await proofsFor(db, acct);
        return json(res, 200, {
          vault: cfg.TREASURY_NEAR_ADDRESS,
          account_id: acct,
          claims: proofs,
          how_to_claim: `near call ${cfg.TREASURY_NEAR_ADDRESS} claim '{"epoch":<epoch>,"account_id":"${acct}","amount":"<amount>","proof":[...]}' --accountId <any-account> --gas 100000000000000`,
        });
      }
      if (req.method === "GET" && path === "/public/vault") {
        return json(res, 200, { vault: cfg.TREASURY_NEAR_ADDRESS, status: await app.vault.status(), council: await app.vault.seats(), distributions: (await db.query("SELECT event_id, epoch, root, data_hash, total, status, tx_hash, activates_at FROM vault_distributions ORDER BY event_id DESC LIMIT 50")).rows, mode_syncs: (await db.query("SELECT * FROM vault_mode_syncs ORDER BY cycle_id DESC LIMIT 30")).rows });
      }
      if (req.method === "GET" && path === "/public/ledger") {
        const j = await db.query("SELECT j.id, j.kind, j.ref_type, j.ref_id, j.memo, j.created_at, json_agg(json_build_object('account', e.account, 'asset', e.asset, 'amount', e.amount::text)) AS entries FROM ledger_journals j JOIN ledger_entries e ON e.journal_id=j.id GROUP BY j.id ORDER BY j.id DESC LIMIT 100");
        const txs = await db.query("SELECT chain, hash, kind, status, simulated, created_at FROM chain_transactions ORDER BY id DESC LIMIT 100");
        return json(res, 200, { journals: j.rows, transactions: txs.rows, summary: await treasurySummary(db, app.prices) });
      }
      if (req.method === "GET" && path.startsWith("/public/distributions/")) {
        const id = path.slice("/public/distributions/".length);
        if (!/^\d+$/.test(id)) return json(res, 400, { error: "bad id" });
        const ev = await db.query("SELECT * FROM distribution_events WHERE id=$1", [id]);
        if (!ev.rows[0]) return json(res, 404, { error: "not found" });
        const ent = await db.query("SELECT account_id, balance, amount FROM distribution_entitlements WHERE event_id=$1 ORDER BY amount DESC", [id]);
        const vd = (await db.query("SELECT epoch, root, data_hash, total, status, tx_hash, activates_at FROM vault_distributions WHERE event_id=$1", [id])).rows[0] ?? null;
        // canonical = the exact JSON whose sha256 is the on-chain data_hash (verify before the veto window ends)
        const canonical = vd ? (await payoutTree(db, id)).canonical : null;
        return json(res, 200, { event: ev.rows[0], vault: vd, canonical, entitlements: ent.rows });
      }

      if (path.startsWith("/admin/")) {
        if (!isAdmin(req)) return json(res, 401, { error: "unauthorized" });
        if (req.method === "GET" && path === "/admin/status") {
          return json(res, 200, {
            env: cfg.BAGFLIP_ENV,
            exec: app.exec.mode,
            decision: await currentDecision(db),
            treasury: await treasurySummary(db, app.prices),
            trading: await getState(db, "trading_status"),
            health: await getState(db, "trading_health"),
            reconcile: await getState(db, "reconcile_report"),
            jobs: (await db.query("SELECT type, status, count(*)::int AS n FROM jobs GROUP BY type, status")).rows,
            bridge: (await db.query("SELECT id, direction, status, amount_in, amount_out, error, updated_at FROM bridge_transfers ORDER BY id DESC LIMIT 10")).rows,
            unattributed: (await db.query("SELECT * FROM unattributed_inflows WHERE status='open'")).rows,
          });
        }
        if (req.method === "GET" && path === "/admin/funnel") {
          const hours = Number(url.searchParams.get("hours") ?? 24);
          const variants = [app.hunt.vc.name, ...app.hunt.shadows.map((s) => s.label)];
          return json(res, 200, await Promise.all(variants.map((v) => funnelReport(db, v, hours))));
        }
        if (req.method === "GET" && path === "/admin/experiment") {
          return json(res, 200, await experimentReport(db, app.hunt.shadows));
        }
        if (req.method === "POST" && path === "/admin/pause") {
          const body = JSON.parse((await readBody(req)) || "{}") as { paused?: boolean };
          await setState(db, "emergency_pause", body.paused === true);
          await audit(db, "admin-api", "emergency_pause", { paused: body.paused === true });
          return json(res, 200, { paused: body.paused === true });
        }
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      app.log.error("http error", { path, error: e });
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  });
}
