/**
 * The only web page BAGFLIP serves: a minimal Telegram Mini App that asks a NEAR
 * wallet to sign the NEP-413 challenge. Wallet connection uses NEAR Connect
 * (@hot-labs/near-connect: HOT, Meteor, Intear, Nightly, ...).
 * The page never sees keys; it forwards {accountId, publicKey, signature} to
 * the backend, which does all verification.
 */
export function connectPage(nonceOk: boolean): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BAGFLIP wallet check</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#0f1115;--fg:#e9ecf1;--mut:#9aa3b2;--acc:#ff6b2c;--ok:#3ecf8e;--bad:#ff5d5d;--card:#181b22}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--fg:#14161b;--mut:#5b6472;--card:#fff}}
body{margin:0;background:var(--tg-theme-bg-color,var(--bg));color:var(--tg-theme-text-color,var(--fg));font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:520px;margin:0 auto;padding:20px 16px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--tg-theme-hint-color,var(--mut));margin:8px 0}
.card{background:var(--tg-theme-secondary-bg-color,var(--card));border-radius:14px;padding:14px;margin:14px 0}
pre{white-space:pre-wrap;word-break:break-word;font-size:13px;margin:0}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--tg-theme-button-color,var(--acc));color:var(--tg-theme-button-text-color,#fff);font-size:16px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5}
.status{margin-top:12px;font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad)}
details{margin-top:14px;color:var(--tg-theme-hint-color,var(--mut))}textarea{width:100%;min-height:90px;box-sizing:border-box;border-radius:8px;padding:8px;font:13px monospace}
</style></head><body><main>
<h1>Verify your NEAR wallet</h1>
<p>Your wallet will ask you to <b>sign a message</b>. Signing proves you own the account. It does not send a transaction or move funds.</p>
<p><b>Never</b> enter a seed phrase or private key anywhere for BAGFLIP.</p>
<div class="card"><pre id="msg">${nonceOk ? "Loading challenge…" : "Invalid link. Run /connect in the bot again."}</pre></div>
<button id="meteor" disabled>Sign with Meteor Wallet</button>
<button id="go" disabled style="margin-top:10px;background:#3b3f4a">Other wallets (HOT, Intear, …)</button>
<div id="st" class="status"></div>
<p id="tghint" style="display:none">Opened inside Telegram? Wallet windows can be blocked here — open this link in your browser instead (desktop Chrome with the Meteor extension works best).</p>
<details><summary>Advanced: paste a NEP-413 signature</summary>
<p>Sign the exact message above with recipient and base64 nonce shown below, then paste JSON <code>{"accountId","publicKey","signature"}</code>.</p>
<pre id="raw"></pre><textarea id="manual"></textarea><button id="send">Submit signature</button></details>
</main>
<script type="module">
const tg = window.Telegram?.WebApp; tg?.ready(); tg?.expand();
const id = new URLSearchParams(location.search).get("c");
const st = document.getElementById("st"), go = document.getElementById("go");
const show = (t, cls) => { st.textContent = t; st.className = "status " + (cls||""); };
let ch;
async function submit(signed) {
  show("Verifying on the server…");
  const r = await fetch("/api/link", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: id, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, initData: tg?.initData || "" }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { show("✅ " + j.accountId + " verified. You can close this and /vote in the bot.", "ok"); tg?.HapticFeedback?.notificationOccurred("success"); setTimeout(() => tg?.close(), 2500); }
  else show("❌ " + (j.error || "Verification failed"), "bad");
}
async function load() {
  if (!id) return;
  const r = await fetch("/api/challenge/" + encodeURIComponent(id));
  if (!r.ok) { document.getElementById("msg").textContent = "This link expired or was already used. Run /connect again."; return; }
  ch = await r.json();
  document.getElementById("msg").textContent = ch.message;
  document.getElementById("raw").textContent = "recipient: " + ch.recipient + "\\nnonce (base64): " + ch.nonceB64;
  go.disabled = false;
  document.getElementById("meteor").disabled = false;
  if (tg?.initData) document.getElementById("tghint").style.display = "block";
}
go.onclick = async () => {
  go.disabled = true;
  try {
    show("Opening wallet selector…");
    const { NearConnector } = await import("https://esm.sh/@hot-labs/near-connect@0.12.0");
    const nonce = Uint8Array.from(atob(ch.nonceB64), c => c.charCodeAt(0));
    const connector = new NearConnector({ network: "mainnet" });
    const viaEvent = new Promise((res) => connector.on("wallet:signInAndSignMessage", (t) => res(t?.accounts?.[0]?.signedMessage || null)));
    await connector.connect({ signMessageParams: { message: ch.message, recipient: ch.recipient, nonce } });
    show("Waiting for the wallet signature…");
    // Some wallets connect without returning the signed message: ask them to sign directly.
    let signed = await Promise.race([viaEvent, new Promise((r) => setTimeout(() => r(null), 4000))]);
    if (!signed) { const w = await connector.wallet(); signed = await w.signMessage({ message: ch.message, recipient: ch.recipient, nonce }); }
    if (!signed || !signed.signature) throw new Error("The wallet returned no signature");
    await submit(signed);
  } catch (e) { show("❌ " + (e?.message || e), "bad"); go.disabled = false; }
};
// Meteor through the official NEAR Wallet Selector module: it runs in this page (no sandbox), talks to
// the Meteor browser extension directly, and falls back to Meteor's web wallet window.
const mb = document.getElementById("meteor");
// Preload so the click opens Meteor immediately (browsers only allow popups right after a click).
const meteorReady = (async () => {
  const [{ setupWalletSelector }, { setupMeteorWallet }, { Buffer }] = await Promise.all([
    import("https://esm.sh/@near-wallet-selector/core@10.1.4"),
    import("https://esm.sh/@near-wallet-selector/meteor-wallet@10.1.4"),
    import("https://esm.sh/buffer@6.0.3"),
  ]);
  const selector = await setupWalletSelector({ network: "mainnet", modules: [setupMeteorWallet()] });
  return { wallet: await selector.wallet("meteor-wallet"), Buffer };
})();
meteorReady.catch(() => {});
mb.onclick = async () => {
  mb.disabled = true;
  try {
    show("Opening Meteor…");
    const { wallet, Buffer } = await meteorReady;
    show("Approve the signature in Meteor…");
    const signed = await wallet.signMessage({ message: ch.message, recipient: ch.recipient, nonce: Buffer.from(ch.nonceB64, "base64") });
    if (!signed || !signed.signature) throw new Error("Meteor returned no signature");
    await submit(signed);
  } catch (e) { show("❌ " + (e?.message || e), "bad"); mb.disabled = false; }
};
document.getElementById("send").onclick = async () => {
  try { await submit(JSON.parse(document.getElementById("manual").value)); } catch (e) { show("❌ Invalid JSON", "bad"); }
};
load();
</script></body></html>`;
}
