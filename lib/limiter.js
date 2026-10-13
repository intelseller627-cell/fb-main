// Per-account safety limits + serialized, jittered sending. Facebook flags bursty/automated accounts,
// so every outbound action goes through here.
import { getState, touchState } from "./store.js";

const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
export const LIMITS = {
  dmPerHour: num("FB_DM_PER_HOUR", 12),
  dmPerDay: num("FB_DM_PER_DAY", 60),
  publishPerDay: num("FB_PUBLISH_PER_DAY", 6),
  dmGapMinMs: num("FB_DM_GAP_MIN_MS", 25_000),
  dmGapMaxMs: num("FB_DM_GAP_MAX_MS", 70_000),
  perThreadCooldownMs: num("FB_THREAD_COOLDOWN_HOURS", 24) * 3600_000,
};

const chains = new Map(); // accountId -> promise tail
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usage(accountId) {
  const s = getState(accountId);
  const now = Date.now();
  s.sends = s.sends.filter((x) => now - x.t < 86_400_000);
  const dm = s.sends.filter((x) => x.kind === "dm");
  return {
    dmLastHour: dm.filter((x) => now - x.t < 3_600_000).length,
    dmLastDay: dm.length,
    publishLastDay: s.sends.filter((x) => x.kind === "publish").length,
    limits: LIMITS,
  };
}

export function checkAllowed(accountId, kind) {
  const u = usage(accountId);
  if (kind === "dm") {
    if (u.dmLastHour >= LIMITS.dmPerHour) return { ok: false, retryAfterSec: 600, reason: "hourly_dm_limit" };
    if (u.dmLastDay >= LIMITS.dmPerDay) return { ok: false, retryAfterSec: 3600, reason: "daily_dm_limit" };
  } else if (u.publishLastDay >= LIMITS.publishPerDay) {
    return { ok: false, retryAfterSec: 3600, reason: "daily_publish_limit" };
  }
  return { ok: true };
}

export function record(accountId, kind) {
  const s = getState(accountId);
  s.sends.push({ t: Date.now(), kind });
  touchState(accountId);
}

/* Runs fn after any earlier job for this account, with a random human-like gap between jobs. */
export function enqueue(accountId, kind, fn) {
  const prev = chains.get(accountId) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const gap = kind === "dm"
      ? LIMITS.dmGapMinMs + Math.random() * (LIMITS.dmGapMaxMs - LIMITS.dmGapMinMs)
      : 5_000 + Math.random() * 10_000;
    const last = enqueue._last.get(accountId) || 0;
    const wait = Math.max(0, last + gap - Date.now());
    if (wait) await sleep(wait);
    try { return await fn(); } finally { enqueue._last.set(accountId, Date.now()); }
  });
  chains.set(accountId, run.catch(() => {}));
  return run;
}
enqueue._last = new Map();
