// Encrypted-at-rest account store + small per-account thread state (JSON files on a Railway volume).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import mysql from "mysql2/promise";

/* STORAGE: fb-main has its OWN database (never Intelseller's). Set FBMAIN_DATABASE_URL to a MySQL URL
   (Railway: add a separate MySQL service and reference its MYSQL_URL). If it is not set, falls back to
   encrypted JSON files in DATA_DIR (needs a Railway Volume to survive redeploys). */
const DB_URL = process.env.FBMAIN_DATABASE_URL || "";
const USE_DB = !!DB_URL;
let pool = null;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const ACC_DIR = path.join(DATA_DIR, "accounts");
const STATE_DIR = path.join(DATA_DIR, "state");
if (!USE_DB) { fs.mkdirSync(ACC_DIR, { recursive: true }); fs.mkdirSync(STATE_DIR, { recursive: true }); }
const accCache = new Map(); // id -> record (db mode)
export const storageMode = () => (USE_DB ? "database" : "files");

const SECRET = process.env.FB_ENC_KEY || process.env.FBMAIN_API_KEY || "";
if (!process.env.FB_ENC_KEY) {
  console.warn("[fb-main] FB_ENC_KEY is not set — falling back to a key derived from FBMAIN_API_KEY. Set FB_ENC_KEY (any long random string) so Facebook sessions are encrypted with their own key.");
}
const KEY = crypto.scryptSync(SECRET || "insecure-default", "fb-main-appstate-v1", 32);

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}
export function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}

const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "");
const accFile = (id) => path.join(ACC_DIR, `${safeId(id)}.json`);
const stateFile = (id) => path.join(STATE_DIR, `${safeId(id)}.json`);

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function serialize(rec) {
  const { appState, ...rest } = rec;
  const out = { ...rest };
  if (appState) out.appStateEnc = encrypt(JSON.stringify(appState));
  else if (rec.appStateEnc) out.appStateEnc = rec.appStateEnc;
  return out;
}
function hydrate(raw) {
  if (raw.appStateEnc) raw.appState = JSON.parse(decrypt(raw.appStateEnc));
  return raw;
}
const dbWrite = (sql, params) => pool.query(sql, params).catch((e) => console.error("[fb-main] database write failed:", e.message));

export async function init() {
  if (!USE_DB) return;
  pool = mysql.createPool({ uri: DB_URL, waitForConnections: true, connectionLimit: 5, connectTimeout: 15000 });
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_accounts (id VARCHAR(64) PRIMARY KEY, data MEDIUMTEXT NOT NULL, updated_at BIGINT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fb_state (id VARCHAR(64) PRIMARY KEY, data MEDIUMTEXT NOT NULL, updated_at BIGINT NOT NULL)`);
  const [st] = await pool.query("SELECT id, data FROM fb_state");
  for (const r of st) { try { _state.set(r.id, normState(JSON.parse(r.data))); } catch {} }
  console.log(`[fb-main] storage: database (${st.length} state rows)`);
}

export function saveAccount(rec) {
  const out = serialize(rec);
  if (USE_DB) {
    accCache.set(rec.id, out);
    dbWrite("INSERT INTO fb_accounts (id, data, updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at)", [rec.id, JSON.stringify(out), Date.now()]);
  } else atomicWrite(accFile(rec.id), JSON.stringify(out));
}
/* Every stored account, decrypted — used once at boot. */
export async function loadAllAccounts() {
  const recs = [];
  if (USE_DB) {
    const [rows] = await pool.query("SELECT id, data FROM fb_accounts");
    for (const r of rows) { try { const raw = JSON.parse(r.data); accCache.set(r.id, raw); recs.push(hydrate(raw)); } catch (e) { console.error("[fb-main] could not read account", r.id, e.message); } }
  } else {
    for (const f of fs.readdirSync(ACC_DIR).filter((x) => x.endsWith(".json"))) {
      try { recs.push(hydrate(JSON.parse(fs.readFileSync(path.join(ACC_DIR, f), "utf8")))); } catch (e) { console.error("[fb-main] could not read account file", f, e.message); }
    }
  }
  return recs;
}
export function deleteAccount(id) {
  if (USE_DB) {
    accCache.delete(id); _state.delete(id); _dirty.delete(id);
    dbWrite("DELETE FROM fb_accounts WHERE id=?", [id]); dbWrite("DELETE FROM fb_state WHERE id=?", [id]);
    return;
  }
  for (const f of [accFile(id), stateFile(id)]) { try { fs.unlinkSync(f); } catch {} }
}

/* Per-account state: opted-out threads + send counters (survive restarts). */
const _state = new Map();
const _dirty = new Set();
function normState(s) {
  s = s || {};
  s.optedOut = s.optedOut || {};   // threadId -> ts
  s.lastAdAt = s.lastAdAt || {};   // threadId -> ts (last ad DM we sent to that thread)
  s.sends = s.sends || [];         // [{t, kind}] rolling window for rate limits
  return s;
}
export function getState(id) {
  if (_state.has(id)) return _state.get(id);
  let s = {};
  if (!USE_DB) { try { s = JSON.parse(fs.readFileSync(stateFile(id), "utf8")); } catch {} }
  s = normState(s);
  _state.set(id, s);
  return s;
}
export function touchState(id) { _dirty.add(id); }
setInterval(() => {
  for (const id of _dirty) {
    const st = _state.get(id); if (!st) continue;
    if (USE_DB) dbWrite("INSERT INTO fb_state (id, data, updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at)", [id, JSON.stringify(st), Date.now()]);
    else { try { atomicWrite(stateFile(id), JSON.stringify(st)); } catch {} }
  }
  _dirty.clear();
}, 5000).unref();
