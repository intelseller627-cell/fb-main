// Admin dashboard for fb-main. Protected by ADMIN_PASSWORD (Railway variable). Separate from the Intelseller API key.
import crypto from "crypto";
import express from "express";
import { ADMIN_HTML, ADMIN_JS } from "./adminPage.js";
import * as mgr from "./accountManager.js";
import { storageMode } from "./store.js";

const SESSION_MS = 8 * 3600_000;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function createAdminRouter() {
  const router = express.Router();
  const PASS = process.env.ADMIN_PASSWORD || "";
  const enabled = PASS.length >= 12;
  if (!enabled) console.warn("[fb-main] ADMIN_PASSWORD missing or shorter than 12 characters — /admin is DISABLED.");
  const sessions = new Map(); // token -> expiry
  const fails = new Map();    // ip -> {n, until}

  router.use("/admin", (req, res, next) => {
    res.set({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    if (!enabled) return res.status(503).type("text").send("Admin is disabled: set ADMIN_PASSWORD (12+ characters) on fb-main.");
    next();
  });

  const cookie = (req, name) => (String(req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(name + "=")) || "").slice(name.length + 1);
  const valid = (req) => { const t = cookie(req, "fbadm"); const exp = t && sessions.get(t); if (exp && exp > Date.now()) return t; if (t) sessions.delete(t); return null; };
  const setCookie = (req, res, val, maxAgeSec) => {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.append("Set-Cookie", `fbadm=${val}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`);
  };
  setInterval(() => { const n = Date.now(); for (const [k, v] of sessions) if (v < n) sessions.delete(k); for (const [k, v] of fails) if (v.until < n && v.n < 5) fails.delete(k); }, 600_000).unref?.();

  router.get("/admin", (req, res) => res.type("html").send(ADMIN_HTML));
  router.get("/admin/app.js", (req, res) => res.type("js").send(ADMIN_JS));

  const api = express.Router();
  api.use(express.json({ limit: "256kb" }));
  api.use((req, res, next) => { // CSRF: custom header + SameSite=Strict cookie
    if (req.method !== "GET" && req.get("x-requested-with") !== "fbadmin") return res.status(403).json({ error: "Forbidden" });
    next();
  });

  api.post("/login", async (req, res) => {
    const ip = req.ip || "?";
    const f = fails.get(ip) || { n: 0, until: 0 };
    if (f.n >= 5 && f.until > Date.now()) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const ok = crypto.timingSafeEqual(sha(req.body?.password || ""), sha(PASS));
    if (!ok) {
      fails.set(ip, { n: f.until > Date.now() || f.n < 5 ? f.n + 1 : 1, until: Date.now() + 15 * 60_000 });
      await new Promise((r) => setTimeout(r, 700));
      return res.status(401).json({ error: "Wrong password" });
    }
    fails.delete(ip);
    const t = crypto.randomBytes(32).toString("hex");
    sessions.set(t, Date.now() + SESSION_MS);
    setCookie(req, res, t, SESSION_MS / 1000);
    res.json({ ok: true });
  });
  api.post("/logout", (req, res) => { const t = valid(req); if (t) sessions.delete(t); setCookie(req, res, "", 0); res.json({ ok: true }); });

  api.use((req, res, next) => (valid(req) ? next() : res.status(401).json({ error: "Not signed in" })));
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: String(e.message || "Server error").slice(0, 300), code: e.code }); }
  };
  api.get("/accounts", h(async () => {
    const accounts = mgr.listAccounts();
    return { accounts, caps: mgr.capabilities(), storage: storageMode(), summary: {
      total: accounts.length, connected: accounts.filter((a) => a.status === "connected").length,
      needsAttention: accounts.filter((a) => a.status === "logged_out" || a.status === "disconnected").length,
      off: accounts.filter((a) => !a.enabled).length,
    } };
  }));
  api.post("/accounts", h(async (r) => mgr.createAccount({ label: r.body.label, appState: r.body.appState, source: "admin" })));
  api.post("/accounts/:id/enabled", h(async (r) => mgr.setEnabled(r.params.id, !!r.body.enabled)));
  api.post("/accounts/:id/reconnect", h(async (r) => mgr.reconnect(r.params.id, r.body.appState || undefined)));
  api.delete("/accounts/:id", h(async (r) => { mgr.removeAccount(r.params.id); return { ok: true }; }));
  api.get("/accounts/:id/threads", h(async (r) => ({ threads: await mgr.listThreads(r.params.id, { kind: r.query.kind, limit: 50, minAgeHours: Number(r.query.minAgeHours) || 0 }) })));

  router.use("/admin/api", api);
  return router;
}
