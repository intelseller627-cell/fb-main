# fb-main

Facebook executor for Intelseller's **Ad Hub**. Same idea as `wa-main` for WhatsApp: Intelseller (users, schedules, campaigns, earnings) talks to this service **server-to-server**; this service holds the live Facebook sessions using the bundled `fca-unofficial-updated`.

## Deploy (Railway)
1. New Railway service → upload/push this folder.
2. Add a **separate MySQL service** in the same Railway project (fb-main's own database, NOT Intelseller's) and set `FBMAIN_DATABASE_URL` to its `MYSQL_URL` reference. Tables are created automatically.
3. Variables: `FBMAIN_API_KEY` (32+ random chars), `FB_ENC_KEY` (long random string), `ADMIN_PASSWORD` (12+ chars). See `.env.example`.
4. Copy the service's public URL, then on the **Intelseller** project set:
   - `FBMAIN_API_URL=https://<your-fb-main>.up.railway.app` (or `FBMAIN_API_URL_1 … _10` for several instances — automatic failover)
   - `FBMAIN_API_KEY=` the exact same key
5. Redeploy Intelseller. `/ad-hub/promote/facebook` now works.

## Admin dashboard
Open `https://<your-fb-main-url>/admin` and sign in with the `ADMIN_PASSWORD` Railway variable (12+ characters; without it the dashboard stays disabled). You can see every connected account (name, Facebook id, status, ON/OFF, usage, whether it came from Intelseller or from you), switch accounts on/off, reconnect with fresh cookies, view inbox / unreplied / group chats, remove accounts, and **add your own account** (tagged "Admin"). Login is rate-limited (5 wrong tries locks that IP for 15 min), the session cookie is HttpOnly + SameSite=Strict, and cookies are never shown or returned by any endpoint.

## Separate data
fb-main keeps its own database (`FBMAIN_DATABASE_URL`: tables `fb_accounts` and `fb_state`, Facebook sessions AES-encrypted inside). It never touches Intelseller's database. If `FBMAIN_DATABASE_URL` is not set it falls back to encrypted files in `DATA_DIR`, which then needs a Railway Volume. Intelseller only stores its users' own rows plus the `remote_id` fb-main gives back, and calls this API to do the work.

## What it can do
| Feature | Works out of the box? | How |
|---|---|---|
| DM people who messaged the account (inbox) | ✅ | Messenger via fca |
| DM chats nobody replied to | ✅ | thread list: their message is last |
| Post into a Messenger **group chat** | ✅ | `sendMessage` to the group thread |
| Facebook **Story** / timeline **post** / **Facebook Group** post | ⚙️ needs setup | fca has no feed/story API. Each kind stays OFF (HTTP 501 `not_configured`, switch disabled in the UI) until you set its `FB_PUBLISH_*_DOCID` + `_VARS` |

### Enabling Story / Post / Group posting
Facebook has no official API for this on personal accounts. In a desktop browser: open DevTools → Network, filter `graphql`, publish a test post/story, and copy the request's `doc_id` and `variables`. Put `doc_id` in `FB_PUBLISH_<KIND>_DOCID`, and the `variables` JSON in `FB_PUBLISH_<KIND>_VARS` with the message text replaced by `{{text}}`, your user id by `{{actor}}`, the group id by `{{groupId}}`, and random ids by `{{session}}` / `{{clientId}}`. These ids change when Facebook updates its site, so expect to refresh them occasionally. Text posts only; image upload for feed posts is not implemented. **Not tested against live Facebook.**

## Safety built in
- **AppState/cookie login only.** The vendored fca originally POSTed email/password to a third-party server (`minhdong.site`) and wrote plaintext cookies to `Fca_Database/database.sqlite`. Both are removed in this copy. Never put email/password login back.
- Sessions are stored **AES-256-GCM encrypted** (`FB_ENC_KEY`), file mode 0600.
- API requires `x-api-key` (constant-time compare). Service refuses to start without a strong key.
- DMs are **only** sent to threads where the other person has already messaged the account (checked on every send). Anyone who replies `STOP` is blocked forever. Per-thread cooldown (24h), hourly/daily DM caps, daily publish cap, one send at a time per account. The wait between DMs is set by Intelseller per promoter (`gapMs`, clamped to `FB_DM_GAP_FLOOR_MS`–`FB_DM_GAP_CEIL_MS`, default 10s–5min); if a request sends no `gapMs`, the old random 25–70s gap is used.
- Each account has a master ON/OFF switch (`POST /api/accounts/:id/enabled`).

## API (all need `x-api-key`)
`GET /health` (no key) · `GET /api/capabilities` · `POST /api/accounts` · `GET|DELETE /api/accounts/:id` · `POST /api/accounts/:id/{enabled,reconnect,send,publish,optout}` · `GET /api/accounts/:id/threads?kind=inbox|unreplied|groups`

## Honest limits
Automating personal Facebook accounts breaks Facebook's terms; accounts can get checkpointed or banned (that is why the limits above exist). Sessions expire; users must re-paste fresh cookies when status shows **Signed out**. Tested here with a stubbed Facebook login only — please test with a throwaway account first.

## Higher volume (Intelseller "daily drip")
`POST /api/accounts/:id/send` accepts `caps: {perHour, perDay}`, clamped to `FB_DM_PER_HOUR_MAX` (150) / `FB_DM_PER_DAY_MAX` (1500); without it the normal `FB_DM_PER_HOUR` / `FB_DM_PER_DAY` apply. `GET .../threads` accepts `pages` (1–10 older pages per folder), `want` (max rows, ≤1500) and `cooldownMs` (drop opted-out people and anyone messaged inside that window) so Intelseller can find enough people.

## Messaging people who never wrote first
`requireInbound: false` on `POST .../send` skips the "they messaged this account first" check (Intelseller's "DM everyone in your chats" surface uses it). STOP opt-outs, the per-thread cooldown, rate caps and spacing still apply.

## Archived chats, message requests and the full scan
`GET .../threads` now also reads the ARCHIVED folder (alongside INBOX, PENDING, OTHER) and may page up to 60 pages per folder. `POST .../send` accepts `acceptRequest: true` to accept a message request (PENDING / OTHER) before sending. `POST .../scan` starts a background count of every one-to-one chat (up to `FB_SCAN_MAX_THREADS`, default 20000); `GET .../scan?cooldownMs=&listLimit=` returns progress, totals, a per-folder breakdown and the newest people.

## Paging note
Facebook returns small pages from `getThreadList`, so a short page does not mean "no more chats". `listThreads` and the scan keep paging until a page is empty (or nothing new for 2–3 pages). `POST .../scan/cancel` stops a running scan; the status adds `pages`, `oldestAt`, `doneFolders`, `cancelled` and `warning`. Default `FB_SCAN_MAX_PAGES` is now 1500.

## Diagnostic
`GET /api/accounts/:id/diag` runs the thread-list query once per folder (plus a second page) and returns, per page: number of chats, one-to-one vs group, newest/oldest timestamps and any extra fields Facebook includes (`count`, `page_info`, ...). Use it to see what Facebook itself returns when the scan finds fewer chats than expected.

## Friends list
`GET /api/accounts/:id/friends[?refresh=1&cooldownMs=&listLimit=]` returns friend totals (ready / recently messaged / opted out), how many contacts Facebook sent that are not friends, and the first `listLimit` friends A–Z. `GET /api/accounts/:id/friends/pool?cooldownMs=&want=` returns eligible friends (`userId`, `name`), shuffled. The list comes from the library's `getFriendsList` (`/chat/user_info_all`), cached for 10 minutes. A friend's user id is the thread id for sending.
