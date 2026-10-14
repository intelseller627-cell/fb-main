// Holds one live fca session per Facebook account. AppState/cookie login ONLY (no email/password).
import crypto from "crypto";
import { createRequire } from "module";
import { Readable } from "stream";
import { saveAccount, loadAllAccounts, deleteAccount, getState, touchState } from "./store.js";
import { checkAllowed, record, enqueue, usage, LIMITS } from "./limiter.js";
import { publish as publishToFacebook, capabilities } from "./publisher.js";

const require = createRequire(import.meta.url);
const login = require("fca-unofficial-updated");

const sessions = new Map(); // id -> runtime
const OPT_OUT = /^\s*(stop|unsubscribe|opt[\s-]?out|no more|don'?t message me)\s*[.!]*\s*$/i;
const MAX_ACCOUNTS = Number(process.env.FB_MAX_ACCOUNTS) || 40; // memory guard per instance
const call = (fn, ...args) => new Promise((res, rej) => fn(...args, (e, d) => (e ? rej(e) : res(d))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Accepts the usual exported AppState JSON array, or a raw "c_user=..; xs=.." cookie header string. */
export function parseAppState(input) {
  let arr = input;
  if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("[")) { try { arr = JSON.parse(t); } catch { throw httpErr(400, "AppState is not valid JSON."); } }
    else {
      arr = t.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf("=");
        return { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: ".facebook.com", path: "/", hostOnly: false };
      });
    }
  }
  if (!Array.isArray(arr) || !arr.length) throw httpErr(400, "AppState must be a non-empty cookie array or cookie string.");
  const names = new Set(arr.map((c) => c.key || c.name));
  if (!names.has("c_user") || !names.has("xs")) throw httpErr(400, "AppState must include the c_user and xs cookies (log in to Facebook in a browser first).");
  return arr.map((c) => ({ ...c, key: c.key || c.name }));
}
function httpErr(status, message, extra = {}) { const e = new Error(message); e.status = status; Object.assign(e, extra); return e; }

function view(rt) {
  const rec = rt.rec;
  return {
    id: rec.id, label: rec.label, enabled: rec.enabled !== false, status: rt.status,
    userId: rt.userId || rec.userId || null, name: rt.name || rec.name || null,
    error: rt.error || null, usage: usage(rec.id), createdAt: rec.createdAt, source: rec.source || "api",
  };
}

async function connect(rt) {
  clearTimeout(rt.retryTimer);
  rt.status = "connecting"; rt.error = null;
  try { rt.stop?.(); } catch {}
  rt.stop = null; rt.api = null;
  try {
    const api = await Promise.race([
      new Promise((res, rej) => login({ appState: rt.rec.appState }, {
        selfListen: true, listenEvents: false, updatePresence: false, autoMarkRead: false,
        autoReconnect: true, online: false, forceLogin: false,
      }, (e, a) => (e ? rej(e) : res(a)))),
      sleep(60_000).then(() => { throw new Error("Facebook login timed out"); }),
    ]);
    rt.api = api;
    rt.userId = String(api.getCurrentUserID());
    try { const info = await call(api.getUserInfo, rt.userId); rt.name = info?.[rt.userId]?.name || rt.name; } catch {}
    rt.status = "connected"; rt.attempts = 0;
    rt.rec.userId = rt.userId; rt.rec.name = rt.name;
    saveAccount({ ...rt.rec, appState: api.getAppState() }); // keep the freshest cookies
    startListening(rt);
    rt.saver = rt.saver || setInterval(() => {
      if (rt.api) try { saveAccount({ ...rt.rec, appState: rt.api.getAppState() }); } catch {}
    }, 30 * 60_000).unref();
    console.log(`[fb-main] ${rt.rec.id} connected as ${rt.userId}`);
  } catch (e) {
    const msg = String(e?.error || e?.message || e);
    const dead = /checkpoint|login_blocked|not logged in|logged out|login approval|expired/i.test(msg + JSON.stringify(e || {}).slice(0, 300));
    rt.status = dead ? "logged_out" : "disconnected";
    rt.error = dead ? "Facebook asked for re-verification or the session expired. Export a fresh AppState and reconnect." : msg.slice(0, 200);
    console.error(`[fb-main] ${rt.rec.id} connect failed: ${msg.slice(0, 200)}`);
    if (!dead) scheduleRetry(rt);
  }
}
function scheduleRetry(rt) {
  rt.attempts = (rt.attempts || 0) + 1;
  if (rt.attempts > 8) return;
  const delay = Math.min(30 * 60_000, 15_000 * 2 ** rt.attempts);
  rt.retryTimer = setTimeout(() => connect(rt), delay);
  rt.retryTimer.unref?.();
}

function startListening(rt) {
  const state = getState(rt.rec.id);
  rt.stop = rt.api.listenMqtt((err, ev) => {
    if (err) {
      const msg = String(err?.error || err?.message || err);
      console.warn(`[fb-main] ${rt.rec.id} listen error: ${msg.slice(0, 160)}`);
      if (/not logged in|checkpoint|login_blocked/i.test(msg)) { rt.status = "logged_out"; rt.error = "Session expired — reconnect with a fresh AppState."; }
      else if (rt.status === "connected") { rt.status = "disconnected"; scheduleRetry(rt); }
      return;
    }
    if (!ev || (ev.type !== "message" && ev.type !== "message_reply")) return;
    const tid = String(ev.threadID);
    if (String(ev.senderID) === rt.userId) { rt.sentIds.has(ev.messageID) || (state.lastHumanReplyAt = state.lastHumanReplyAt || {}, state.lastHumanReplyAt[tid] = Date.now(), touchState(rt.rec.id)); return; }
    if (!ev.isGroup && OPT_OUT.test(ev.body || "")) { state.optedOut[tid] = Date.now(); touchState(rt.rec.id); }
  });
}

export async function boot() {
  for (const rec of await loadAllAccounts()) {
    const id = rec.id;
    if (!rec?.appState) continue;
    const rt = { rec, status: "connecting", sentIds: new Set() };
    sessions.set(id, rt);
    setTimeout(() => connect(rt), Math.random() * 20_000); // stagger logins after a restart
  }
  console.log(`[fb-main] restoring ${sessions.size} account(s)`);
}

export async function createAccount({ label, appState, source }) {
  if (sessions.size >= MAX_ACCOUNTS) throw httpErr(503, "This instance is full.", { full: true });
  const state = parseAppState(appState);
  const id = "fb_" + crypto.randomBytes(8).toString("hex");
  const rec = { id, label: String(label || "Facebook").slice(0, 100), enabled: true, createdAt: Date.now(), source: source === "admin" ? "admin" : "intelseller", appState: state };
  const rt = { rec, status: "connecting", sentIds: new Set() };
  sessions.set(id, rt);
  await connect(rt); // fast failure for bad cookies, instead of a silent "connecting" forever
  if (rt.status !== "connected") { sessions.delete(id); deleteAccount(id); throw httpErr(400, rt.error || "Could not log in with that AppState."); }
  return view(rt);
}

export const listAccounts = () => [...sessions.values()].map(view).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
const need = (id) => { const rt = sessions.get(id); if (!rt) throw httpErr(404, "Account not found on this instance."); return rt; };
export const getAccount = (id) => view(need(id));
export function setEnabled(id, enabled) { const rt = need(id); rt.rec.enabled = !!enabled; saveAccount(rt.rec); return view(rt); }
export async function reconnect(id, appState) {
  const rt = need(id);
  if (appState) rt.rec.appState = parseAppState(appState);
  await connect(rt);
  return view(rt);
}
export function removeAccount(id) {
  const rt = sessions.get(id);
  if (rt) { clearTimeout(rt.retryTimer); clearInterval(rt.saver); try { rt.stop?.(); } catch {} sessions.delete(id); }
  deleteAccount(id);
}
export const optOut = (id, threadId, v) => { need(id); const s = getState(id); if (v) s.optedOut[String(threadId)] = Date.now(); else delete s.optedOut[String(threadId)]; touchState(id); };

function live(rt) {
  if (rt.rec.enabled === false) throw httpErr(409, "This account is switched off.", { code: "account_disabled" });
  if (rt.status !== "connected" || !rt.api) throw httpErr(409, "Facebook account is not connected.", { code: "not_connected" });
  return rt.api;
}

/* Threads: kind = inbox (people who messaged you), unreplied (their message is the latest, nobody answered), groups (Messenger group chats). */
export async function listThreads(id, { kind = "inbox", limit = 50, minAgeHours = 0, pages = 1, want, cooldownMs = 0 } = {}) {
  const rt = need(id); const api = live(rt); const st = getState(id);
  limit = Math.min(Math.max(parseInt(limit) || 50, 1), 100);
  pages = Math.min(Math.max(parseInt(pages) || 1, 1), 60);          // pages per folder (older chats), used by Intelseller's daily drip
  cooldownMs = Math.max(0, Number(cooldownMs) || 0);               // >0: drop people who opted out or got an ad inside this window, server-side
  const cap = Math.min(Math.max(parseInt(want) || limit * 2, 1), 1500);
  const out = []; const seen = new Set();
  for (const tag of ["INBOX", "ARCHIVED", "PENDING", "OTHER"]) {
    let before = null;
    for (let p = 0; p < pages && out.length < cap; p++) {
      let list = [];
      try { list = await call(api.getThreadList, limit, before, [tag]); } catch (e) { if (tag === "INBOX" && p === 0) throw e; break; }
      for (const t of list || []) {
        const tid = String(t.threadID);
        if (seen.has(tid)) continue; seen.add(tid);
        const lastTs = Number(t.lastMessageTimestamp || t.timestamp || 0);
        const theirsLast = t.snippetSender && String(t.snippetSender) !== rt.userId;
        const row = {
          threadId: tid, name: t.name || "Facebook user", isGroup: !!t.isGroup, folder: tag,
          lastMessageAt: lastTs, unread: t.unreadCount || 0, lastFromThem: !!theirsLast,
          optedOut: !!st.optedOut[tid], lastAdAt: st.lastAdAt[tid] || 0,
          participants: (t.participantIDs || []).length, image: t.imageSrc || null,
        };
        if (kind === "groups" && !row.isGroup) continue;
        if (kind !== "groups" && row.isGroup) continue;
        if (kind === "unreplied" && !(row.lastFromThem && Date.now() - lastTs >= minAgeHours * 3600_000)) continue;
        if (cooldownMs && (row.optedOut || (row.lastAdAt && Date.now() - row.lastAdAt < cooldownMs))) continue;
        out.push(row);
      }
      if (!list || list.length < limit) break;                     // no older page
      const oldest = Number(list[list.length - 1]?.timestamp);
      if (!Number.isFinite(oldest) || oldest <= 0 || oldest === before) break;
      before = oldest;
      await sleep(700);                                             // be gentle between pages
    }
  }
  out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return out.slice(0, pages > 1 ? cap : limit * 2);
}

/* ───────────── full scan: count every chat (inbox, archived, message requests, spam-filtered) in the background ───────────── */
const scans = new Map(); // accountId -> { state, folder, scanned, startedAt, finishedAt, capped, error, rows }
const SCAN_FOLDERS = ["INBOX", "ARCHIVED", "PENDING", "OTHER"];
const SCAN_MAX = () => Math.min(Number(process.env.FB_SCAN_MAX_THREADS) || 20000, 50000);
const SCAN_MAX_PAGES = () => Math.min(Number(process.env.FB_SCAN_MAX_PAGES) || 200, 500);

export function startScan(id) {
  const rt = need(id); const api = live(rt);
  const cur = scans.get(id);
  if (cur && cur.state === "running") return scanSummary(id);
  const sc = { state: "running", folder: "INBOX", scanned: 0, startedAt: Date.now(), finishedAt: 0, capped: false, error: "", rows: [], seen: new Set() };
  scans.set(id, sc);
  (async () => {
    const maxThreads = SCAN_MAX(), maxPages = SCAN_MAX_PAGES();
    try {
      for (const tag of SCAN_FOLDERS) {
        sc.folder = tag; let before = null;
        for (let p = 0; p < maxPages; p++) {
          let list = [];
          try { list = await call(api.getThreadList, 100, before, [tag]); }
          catch (e) { if (tag === "INBOX" && p === 0) throw e; break; }
          for (const t of list || []) {
            const tid = String(t.threadID);
            if (sc.seen.has(tid)) continue; sc.seen.add(tid);
            if (t.isGroup) continue;
            sc.rows.push({ threadId: tid, name: t.name || "Facebook user", folder: tag, lastAt: Number(t.lastMessageTimestamp || t.timestamp || 0),
              theyWroteLast: !!(t.snippetSender && String(t.snippetSender) !== rt.userId) });
            sc.scanned = sc.rows.length;
          }
          if (sc.rows.length >= maxThreads) { sc.capped = true; break; }
          if (!list || list.length < 100) break;
          const oldest = Number(list[list.length - 1]?.timestamp);
          if (!Number.isFinite(oldest) || oldest <= 0 || oldest === before) break;
          before = oldest;
          await sleep(900);
        }
        if (sc.capped) break;
      }
      sc.state = "done";
    } catch (e) { sc.state = "error"; sc.error = String(e?.message || e).slice(0, 200); }
    sc.finishedAt = Date.now(); sc.seen = null;
  })();
  return scanSummary(id);
}

export function scanSummary(id, { cooldownMs = 0, listLimit = 300 } = {}) {
  const sc = scans.get(id);
  if (!sc) return { state: "idle" };
  const st = getState(id); const now = Date.now();
  const status = (r) => (st.optedOut[r.threadId] ? "opted_out" : (cooldownMs && st.lastAdAt[r.threadId] && now - st.lastAdAt[r.threadId] < cooldownMs ? "recent_ad" : "ready"));
  const rows = sc.rows;
  const out = { state: sc.state, folder: sc.folder, scanned: sc.scanned, startedAt: sc.startedAt, finishedAt: sc.finishedAt, capped: sc.capped, error: sc.error,
    total: rows.length, ready: 0, optedOut: 0, recentAd: 0, theyWroteLast: 0, byFolder: { INBOX: 0, ARCHIVED: 0, PENDING: 0, OTHER: 0 } };
  for (const r of rows) {
    const k = status(r);
    if (k === "ready") out.ready++; else if (k === "opted_out") out.optedOut++; else out.recentAd++;
    if (r.theyWroteLast) out.theyWroteLast++;
    out.byFolder[r.folder] = (out.byFolder[r.folder] || 0) + 1;
  }
  out.youWroteLast = rows.length - out.theyWroteLast;
  out.people = [...rows].sort((a, b) => b.lastAt - a.lastAt).slice(0, listLimit).map((r) => ({ name: String(r.name).slice(0, 60), lastAt: r.lastAt, theyWroteLast: r.theyWroteLast, folder: r.folder, status: status(r) }));
  return out;
}

async function threadHasInbound(rt, threadId) {
  rt.inboundCache = rt.inboundCache || new Map();
  const hit = rt.inboundCache.get(threadId);
  if (hit && Date.now() - hit.t < 10 * 60_000) return hit.v;
  const hist = await call(rt.api.getThreadHistory, threadId, 25, undefined);
  const v = (hist || []).some((m) => String(m.senderID) !== rt.userId);
  rt.inboundCache.set(threadId, { v, t: Date.now() });
  if (rt.inboundCache.size > 2000) rt.inboundCache.delete(rt.inboundCache.keys().next().value);
  return v;
}

async function imageStream(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`image download failed (${r.status})`);
  const ct = r.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) throw new Error("mediaUrl is not an image");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error("image too large (8MB max)");
  const s = Readable.from(buf);
  s.path = "ad." + (ct.includes("png") ? "png" : "jpg");
  return s;
}

const _idem = new Map();
export async function sendDm(id, { threadId, text, imageUrl, requireInbound = true, force = false, idem, gapMs, caps, acceptRequest = false }) {
  const rt = need(id); const api = live(rt); const st = getState(id);
  threadId = String(threadId || "");
  if (!/^\d{5,25}$/.test(threadId)) throw httpErr(400, "Invalid threadId.");
  if (!String(text || "").trim()) throw httpErr(400, "Message text is required.");
  if (idem && _idem.has(idem)) return _idem.get(idem);
  if (st.optedOut[threadId]) throw httpErr(409, "This person asked not to receive messages.", { code: "opted_out" });
  if (!force && st.lastAdAt[threadId] && Date.now() - st.lastAdAt[threadId] < LIMITS.perThreadCooldownMs) throw httpErr(409, "This thread already got an ad recently.", { code: "cooldown" });
  const lim = checkAllowed(id, "dm", caps);
  if (!lim.ok) throw httpErr(429, "Facebook safety limit reached for this account. Try later.", { code: lim.reason, retryAfterSec: lim.retryAfterSec });
  if (requireInbound && !acceptRequest && !(await threadHasInbound(rt, threadId))) throw httpErr(409, "Only people who messaged this account (or its group chats) can be messaged.", { code: "no_inbound" });

  const result = await enqueue(id, "dm", async () => {
    live(rt);
    // A message request (PENDING / spam-filtered OTHER) is accepted first so it moves to the inbox and the reply goes through.
    if (acceptRequest) { try { await call(api.handleMessageRequest, threadId, true); } catch (e) { console.warn("[fb-main] accept request failed:", e?.message || e); } }
    const msg = { body: String(text).slice(0, 2000) };
    if (imageUrl) { try { msg.attachment = await imageStream(imageUrl); } catch (e) { console.warn("[fb-main] image skipped:", e.message); } }
    const info = await call(api.sendMessage, msg, threadId);
    if (info?.messageID) { rt.sentIds.add(info.messageID); if (rt.sentIds.size > 500) rt.sentIds.delete(rt.sentIds.values().next().value); }
    record(id, "dm");
    st.lastAdAt[threadId] = Date.now(); touchState(id);
    return { ok: true, messageId: info?.messageID || null };
  }, { gapMs });
  if (idem) { _idem.set(idem, result); setTimeout(() => _idem.delete(idem), 10 * 60_000).unref?.(); }
  return result;
}

export async function publish(id, body) {
  const rt = need(id); const api = live(rt);
  const lim = checkAllowed(id, "publish");
  if (!lim.ok) throw httpErr(429, "Daily publish limit reached for this account.", { code: lim.reason, retryAfterSec: lim.retryAfterSec });
  return enqueue(id, "publish", async () => {
    live(rt);
    const r = await publishToFacebook(api, rt.userId, body);
    record(id, "publish");
    return r;
  });
}
export { capabilities };
