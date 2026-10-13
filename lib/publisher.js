import crypto from "crypto";
// Feed publishing (story / timeline post / Facebook-group post).
// IMPORTANT: fca-unofficial only covers Messenger. Facebook has no public API for personal-account
// posting, and the internal GraphQL "doc_id"s for composer mutations change often and are NOT shipped
// with fca. So each kind is OFF until you supply a working doc_id + variables template (copied from
// your own browser's Network tab while posting), via Railway variables:
//   FB_PUBLISH_STORY_DOCID / FB_PUBLISH_STORY_VARS
//   FB_PUBLISH_POST_DOCID  / FB_PUBLISH_POST_VARS
//   FB_PUBLISH_GROUP_DOCID / FB_PUBLISH_GROUP_VARS
// *_VARS is a JSON string; the placeholders {{actor}} {{text}} {{groupId}} {{session}} {{clientId}}
// are replaced (JSON-escaped) before sending. Until configured, publish returns 501 not_configured.
const KINDS = {
  story: { doc: "FB_PUBLISH_STORY_DOCID", vars: "FB_PUBLISH_STORY_VARS", name: "ComposerStoryCreateMutation" },
  post: { doc: "FB_PUBLISH_POST_DOCID", vars: "FB_PUBLISH_POST_VARS", name: "ComposerStoryCreateMutation" },
  group_post: { doc: "FB_PUBLISH_GROUP_DOCID", vars: "FB_PUBLISH_GROUP_VARS", name: "ComposerStoryCreateMutation" },
};

export function capabilities() {
  const out = {};
  for (const [k, c] of Object.entries(KINDS)) out[k] = !!(process.env[c.doc] && process.env[c.vars]);
  return { publish: out, dm: true, chat_group: true };
}

const jsonEsc = (s) => JSON.stringify(String(s ?? "")).slice(1, -1);

export async function publish(api, userId, { kind, text, linkUrl, groupId }) {
  const c = KINDS[kind];
  if (!c) { const e = new Error("Unknown publish kind."); e.status = 400; throw e; }
  const doc = process.env[c.doc], tpl = process.env[c.vars];
  if (!doc || !tpl) {
    const e = new Error(`Facebook ${kind.replace("_", " ")} publishing is not configured on fb-main yet (set ${c.doc} and ${c.vars}).`);
    e.status = 501; e.code = "not_configured"; throw e;
  }
  if (kind === "group_post" && !/^\d{5,25}$/.test(String(groupId || ""))) { const e = new Error("A numeric groupId is required."); e.status = 400; throw e; }
  const body = [String(text || "").trim(), linkUrl ? String(linkUrl) : ""].filter(Boolean).join("\n\n").slice(0, 5000);
  if (!body) { const e = new Error("Nothing to post."); e.status = 400; throw e; }
  const vars = tpl
    .replace(/\{\{actor\}\}/g, jsonEsc(userId))
    .replace(/\{\{text\}\}/g, jsonEsc(body))
    .replace(/\{\{groupId\}\}/g, jsonEsc(groupId || ""))
    .replace(/\{\{session\}\}/g, jsonEsc(cryptoRandom()))
    .replace(/\{\{clientId\}\}/g, jsonEsc(cryptoRandom()));
  try { JSON.parse(vars); } catch { const e = new Error(`${c.vars} is not valid JSON after substitution.`); e.status = 500; throw e; }
  const res = await api.graphqlRaw(doc, c.name, vars);
  return { ok: true, raw: JSON.stringify(res).slice(0, 300) };
}
function cryptoRandom() { return crypto.randomBytes(12).toString("hex"); }
