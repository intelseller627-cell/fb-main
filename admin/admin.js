const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function say(m) { const e = $("msg"); e.textContent = m; e.style.display = "block"; setTimeout(() => (e.style.display = "none"), 3500); }
async function api(path, method, body) {
  const r = await fetch("/admin/api" + path, { method: method || "GET", headers: { "Content-Type": "application/json", "x-requested-with": "fbadmin" }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  const j = await r.json().catch(() => ({ error: "Bad response" }));
  if (r.status === 401 && path !== "/login") show(false);
  if (!r.ok) throw new Error(j.error || "Failed");
  return j;
}
function show(on) { $("login").style.display = on ? "none" : "block"; $("app").style.display = on ? "block" : "none"; }
const pill = (s) => `<span class="pill ${s === "connected" ? "ok" : s === "logged_out" ? "bad" : "warn"}">${esc(s)}</span>`;
const when = (t) => (t ? new Date(t).toLocaleString() : "—");

async function load() {
  try {
    const d = await api("/accounts"); show(true);
    $("stats").innerHTML = [["Total", d.summary.total], ["Connected", d.summary.connected], ["Need attention", d.summary.needsAttention], ["Switched off", d.summary.off]].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");
    const p = d.caps.publish;
    $("caps").textContent = `Storage: ${d.storage} · Feed posting configured → story: ${p.story ? "yes" : "no"}, post: ${p.post ? "yes" : "no"}, group post: ${p.group_post ? "yes" : "no"}`;
    $("list").innerHTML = d.accounts.length ? d.accounts.map((a) => `<div class="card">
      <div class="row"><div><b>${esc(a.label)}</b> ${pill(a.status)} <span class="pill">${a.source === "admin" ? "Admin" : "Intelseller"}</span> ${a.enabled ? "" : '<span class="pill bad">OFF</span>'}</div>
      <div class="sub">${when(a.createdAt)}</div></div>
      <div class="sub">${esc(a.name || "Unknown name")} · ${a.userId ? `<a style="color:#8ab4ff" target="_blank" rel="noopener noreferrer" href="https://www.facebook.com/profile.php?id=${encodeURIComponent(a.userId)}">${esc(a.userId)}</a>` : "no id yet"} · id ${esc(a.id)}</div>
      ${a.error ? `<div class="sub" style="color:#FF5470">${esc(a.error)}</div>` : ""}
      <div class="sub">DMs ${a.usage.dmLastHour}/${a.usage.limits.dmPerHour} this hour · ${a.usage.dmLastDay}/${a.usage.limits.dmPerDay} today · posts ${a.usage.publishLastDay}/${a.usage.limits.publishPerDay} today</div>
      <div class="acts" data-id="${esc(a.id)}">
        <button data-a="toggle" data-on="${a.enabled ? 0 : 1}">${a.enabled ? "Switch OFF" : "Switch ON"}</button>
        <button data-a="recon">Reconnect</button>
        <button data-a="inbox">Inbox</button><button data-a="unreplied">Unreplied</button><button data-a="groups">Group chats</button>
        <button class="d" data-a="remove">Remove</button></div>
      <div class="threads"></div></div>`).join("") : '<div class="sub">No accounts yet.</div>';
  } catch (e) { if (e.message !== "Not signed in") say(e.message); }
}

$("goLogin").onclick = async () => { try { await api("/login", "POST", { password: $("pw").value }); $("pw").value = ""; load(); } catch (e) { say(e.message); } };
$("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("goLogin").click(); });
$("logout").onclick = async () => { await api("/logout", "POST", {}).catch(() => {}); show(false); };
$("refresh").onclick = load;
$("addBtn").onclick = async () => {
  const b = $("addBtn"); b.disabled = true; b.textContent = "Connecting…";
  try { await api("/accounts", "POST", { label: $("aLabel").value, appState: $("aState").value }); $("aState").value = ""; $("aLabel").value = ""; say("Connected"); load(); }
  catch (e) { say(e.message); } finally { b.disabled = false; b.textContent = "Connect account"; }
};
$("list").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-a]"); if (!btn) return;
  const box = btn.closest(".acts"), id = box.dataset.id, a = btn.dataset.a;
  try {
    if (a === "toggle") await api(`/accounts/${id}/enabled`, "POST", { enabled: btn.dataset.on === "1" });
    else if (a === "recon") { const s = prompt("Paste fresh cookies JSON (leave empty to retry with the saved session):"); await api(`/accounts/${id}/reconnect`, "POST", s ? { appState: s } : {}); say("Reconnect attempted"); }
    else if (a === "remove") { if (!confirm("Remove this account from fb-main? Intelseller users using it will lose it.")) return; await api(`/accounts/${id}`, "DELETE"); }
    else { const d = await api(`/accounts/${id}/threads?kind=${a}`); box.parentNode.querySelector(".threads").innerHTML = d.threads.length ? `<table><tr><th>Name</th><th>Last message</th><th>Opted out</th></tr>${d.threads.slice(0, 40).map((t) => `<tr><td>${esc(t.name)}</td><td>${when(t.lastMessageAt)}</td><td>${t.optedOut ? "yes" : ""}</td></tr>`).join("")}</table>` : '<div class="sub">Nothing here.</div>'; return; }
    load();
  } catch (e) { say(e.message); }
});
load(); setInterval(() => { if ($("app").style.display !== "none") load(); }, 30000);
