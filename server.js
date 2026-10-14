import express from "express";
import crypto from "crypto";
import * as mgr from "./lib/accountManager.js";
import { createAdminRouter } from "./lib/admin.js";
import { init as initStore, storageMode } from "./lib/store.js";

const API_KEY = process.env.FBMAIN_API_KEY || "";
if (!API_KEY || API_KEY.length < 24) { console.error("FBMAIN_API_KEY is missing or too short (use 32+ random characters). Refusing to start."); process.exit(1); }
const keyBuf = Buffer.from(API_KEY);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(createAdminRouter()); // /admin (ADMIN_PASSWORD) — mounted BEFORE the API-key gate and its own JSON parsing
app.use(express.json({ limit: "256kb" }));

app.get("/health", (req, res) => res.json({ ok: true, service: "fb-main", ts: Date.now() }));

app.use((req, res, next) => {
  const got = Buffer.from(String(req.get("x-api-key") || ""));
  if (got.length !== keyBuf.length || !crypto.timingSafeEqual(got, keyBuf)) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const h = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("[fb-main]", req.method, req.path, e.message);
    res.status(status).json({ error: String(e.message || "Server error").slice(0, 300), code: e.code, full: e.full, retryAfterSec: e.retryAfterSec });
  }
};

app.get("/api/capabilities", h(async () => mgr.capabilities()));
app.post("/api/accounts", h(async (r) => mgr.createAccount({ label: r.body.label, appState: r.body.appState || r.body.cookie, source: "intelseller" })));
app.get("/api/accounts/:id", h(async (r) => mgr.getAccount(r.params.id)));
app.delete("/api/accounts/:id", h(async (r) => { mgr.removeAccount(r.params.id); return { ok: true }; }));
app.post("/api/accounts/:id/enabled", h(async (r) => mgr.setEnabled(r.params.id, !!r.body.enabled)));
app.post("/api/accounts/:id/reconnect", h(async (r) => mgr.reconnect(r.params.id, r.body.appState || r.body.cookie)));
app.get("/api/accounts/:id/threads", h(async (r) => ({ threads: await mgr.listThreads(r.params.id, { kind: r.query.kind, limit: r.query.limit, minAgeHours: Number(r.query.minAgeHours) || 0, pages: r.query.pages, want: r.query.want, cooldownMs: r.query.cooldownMs }) })));
app.post("/api/accounts/:id/scan", h(async (r) => mgr.startScan(r.params.id)));
app.get("/api/accounts/:id/scan", h(async (r) => mgr.scanSummary(r.params.id, { cooldownMs: Number(r.query.cooldownMs) || 0, listLimit: Math.min(Number(r.query.listLimit) || 300, 500) })));
app.post("/api/accounts/:id/scan/cancel", h(async (r) => mgr.cancelScan(r.params.id)));
app.get("/api/accounts/:id/diag", h(async (r) => mgr.diagThreads(r.params.id)));
app.post("/api/accounts/:id/send", h(async (r) => mgr.sendDm(r.params.id, r.body)));
app.post("/api/accounts/:id/publish", h(async (r) => mgr.publish(r.params.id, r.body)));
app.post("/api/accounts/:id/optout", h(async (r) => { mgr.optOut(r.params.id, r.body.threadId, r.body.optedOut !== false); return { ok: true }; }));

app.use((err, req, res, next) => { console.error("[fb-main] unhandled error on", req.method, req.path, "-", err?.stack || err); res.status(500).json({ error: "Server error" }); });

const port = process.env.PORT || 3000;
initStore()
  .then(() => app.listen(port, () => { console.log(`[fb-main] listening on ${port} (storage: ${storageMode()})`); mgr.boot(); }))
  .catch((e) => { console.error("[fb-main] storage init failed:", e.message); process.exit(1); });
