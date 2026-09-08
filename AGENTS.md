# AGENTS.md — MSX Lookout

Muscat Stock Exchange tracker. Keep changes small, boring, and in scope.

This file is the public map for people and agents. Owner-only notes live
in gitignored files (`LOCAL.md`, `progress.md`, `bugs.md`, …). If
`LOCAL.md` exists, read it next. **Do not copy private notes into this
file or into commits. Never `git add -f` those files.**

---

## Non-negotiable

1. Simple code. No extra scripts, files, or abstractions "for later."
2. Short file names. Keep the existing layout.
3. One-line comments only. No `// =====` banners.
4. One phase at a time. Stop when that deliverable is done.
5. Only tools already in the stack. If something else looks better, say
   so and wait — do not add it.
6. **Never read or crawl `.env`.**
7. Update `.gitignore` when new untracked junk shows up.
8. If unsure, ask. Do not invent redesigns.
9. Commit messages: short and plain. One-line subject unless the change
   actually needs a body.
10. **Never fill another person's email, name, or secrets.** If you find
    a likely value, say where and ask them to type it.

---

## What to open, by job

| Job | Open these |
|---|---|
| Any work | this file, then `LOCAL.md` if it exists |
| Feature tour | `readme.md` |
| Schema change | `supabase/migrations/*.sql` — not `schema.sql` / `logic.sql` |
| Frontend | `web/index.html` only (inline JS/CSS, no build) |
| Public JSON API | `supabase/functions/app/app.ts` (`handleData` switch) |
| Daily prices / circulars / dividends | `supabase/functions/ingest/` + root `msx-client.ts` / `stockanalysis.ts` |
| Company list refresh | `supabase/functions/refresh/refresh.ts` |
| Digest email | `supabase/functions/digest/digest.ts` + root `email.ts` |
| Desktop chrome / updater | `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json` |

`schema.sql` and `logic.sql` are **read-only snapshots**. Edit migrations.

---

## Architecture (do not re-discover)

```
MSX.om hidden JSON API
  -> ingest (daily cron)     -> stock_prices (append-only), corporate_actions
  -> refresh (monthly cron)  -> companies
  -> backfill.ts / seed.ts   -> one-time history / company list
        |
        v
  Supabase Postgres
        |
        v
  app Edge Function  POST /data  (action string) + GET /excel
        |
        +-- web/index.html  (GitHub Pages + the file Tauri wraps)
        +-- digest / backup Edge Functions (own cron)
```

- **Deno/TypeScript everywhere.** No Node, no npm, no bundler, no frontend
  framework. Edit `web/index.html` directly.
- **MSX is the only price source.** If it is down, say so and show the last
  confirmed price + timestamp. Never silently fall back to another vendor.
- All MSX HTTP lives in root `msx-client.ts` (`msxPost`, `MARKET_NUM`,
  `isTradingDay`). Function dirs keep a 4-line stub re-export so local
  `deno check` resolves. Same pattern for `cadence.ts`, `stockanalysis.ts`,
  `email.ts`, `excel.ts`.
- `app` is fully open: no auth, CORS wide open — intentional. `ingest` /
  `refresh` / `digest` / `backup` require `x-ingest-key` = `INGEST_SECRET`.
  Do not add auth to `/data` unless that is the task.
- The window calls `/functions/v1/app/data` on the linked Supabase project.
- Updater: GitHub Releases `…/releases/latest/download/latest.json`.

### `/data` actions (`app.ts`)

`home` `search` `browse` `detail` `verify` `watch` `unwatch` `save` `remove`
`weeks` `compare` `ohlc` `weekly` `companies` `get_settings` `save_settings`
`list_exports` `export_url` `run_ingest_now` `run_refresh_now`

Reads: `api()`. Mutations: **`apiWrite(action, params)`** — queue in
`localStorage` (`msx-writeq`) first, then the server; replay on reconnect.
`run_ingest_now` / `run_refresh_now` stay on `api()` (online-only).

`fillGapIfStale` in `app.ts`: if a ticker's latest price is **>7 days** old,
backfill the last 7 MSX weekdays on detail. A 1–2 day weekend gap must stay
a no-op. Do not lower that threshold casually.

### Cadence

`cadence.ts` → `isCadenceDue`. Unparseable `last_*` stamps count as never-ran
(`hoursSince = Infinity`), otherwise a corrupt timestamp parks the job forever.
`FREQ_HOURS`: daily 20, weekly 150, monthly 648.

### Email (easy to get wrong)

Every outbound mail (digest, listing heads-up, price alerts, ops-failure)
uses `resolveSavedRecipient` against `app_settings.digest_email`. Blank
Settings email = **skip send**. Env vars are not used as a recipient.
Clearing the Settings field does **not** wipe `stock_prices`, `companies`,
`dividends`, or `corporate_actions` — `save_settings` PATCHes only the
`app_settings` singleton.

Every send is also gated by `email_master_enabled` + its own toggle. Off
means off. `notify_listings` defaults **off**; `notify_failures` defaults
**on**. Do not flip the master kill switch off to silence one kind of
mail — that also silences ops alerts. If Settings is empty, ops failures
only hit the function log.

`email.ts` is the one HTML shell (`emailShell`) + the one Resend call
(`sendEmail`).

---

## Commands

```bash
deno task dev          # serve web/ at :8000  (NOT /web/index.html)
deno task check        # type-check every entry point
deno task test         # pure-function tests only
deno task seed         # one-time companies (needs .env)
deno task backfill     # one-time history (needs .env)

cargo tauri dev        # native window; runs deno task dev for you
cargo tauri build      # MSI + NSIS; bakes current web/ into the binary

supabase link --project-ref <your-project>
supabase db push
supabase functions deploy
supabase functions serve
```

Gate: `deno task check` + `deno task test`. Both run in CI
(`.github/workflows/test.yml`) and before backend deploy. `web/index.html`
is **not** type-checked — `web_invariants_test.ts` is the static regression
net for chrome/scroll/z-index/close-labels; a real window is the UI gate.

Push to `main` that touches `supabase/**`, `msx-client.ts`, `cadence.ts`,
`excel.ts`, `stockanalysis.ts`, or `email.ts` deploys backend
(`.github/workflows/deploy-backend.yml`). Tags `v*.*.*` build the signed
installer (`.github/workflows/release.yml`).

---

## Frontend (`web/index.html`)

Tabs: `#tb-home` My Stocks, `#tb-browse`, `#tb-compare`, `#tb-charts`.
Settings gear opens `#settings-modal`. Updater is a pane inside Settings.
Command palette: Ctrl+K.

Chrome stack (keep this, or tabs/titlebar fail on scroll):

- `#chrome` wraps `#tbar` + `header` + `nav`, `position:sticky; top:0; z-index:6`
- `#tbar` is the custom titlebar (drag + min/max/close). Shown only when
  `__TAURI__` (or internals) exists; retry ~10s because WebView2 injects late.
- `header` is **not** sticky (that used to cover the tabs on scroll)
- `nav` gap is **padding** 34px, not margin (rows used to show through)
- `.loading-overlay` z-index **2** (must stay below `#chrome`; `#settings-modal`
  stays above)
- Tab click: `window.scrollTo(0, 0)`
- `#tbar-close` aria-label **"Close window"**; `#settings-close` **"Close
  settings"** — two controls named "Close" made UI Automation quit the app

Button roles — match one, do not invent a fourth:

| Role | Class | Use |
|---|---|---|
| Selection | `.tpick-opt` | scope/view/frequency chips |
| Committing action | `.btn-pill` | Run comparison, Save position, Check this price |
| Inline / dismiss | `.btn-inline` | Clear, Cancel, Download Excel |

Two confirmations — do not conflate:

- `.done` (green, persistent) = updater "UP TO DATE"
- Settings saves (`#set-general-save`, `#set-updater-save`) flash `.saved`
  (gray), lock 1.5s, revert. Connection light (`#conn-dot` / `#conn-lbl`)
  carries whether it synced: ONLINE / OFFLINE · N PENDING / SYNCING.

Do not add new `.btn` / `.btn.primary` (legacy glass). Charts empty-state
copy lives in **`#ch-bd-name`**, not `#chart`.

---

## Desktop (Tauri 2)

- `decorations: false`, `withGlobalTauri: true`, `frontendDist: ../web`
- `devUrl`: `http://localhost:8000/?nocache=1` — the file-server **caches
  `index.html`**. A plain reload after an edit is a whole class of false
  "the fix didn't work" sessions.
- `src-tauri/src/lib.rs` also `set_decorations(false)` at setup (Windows has
  been seen to re-add `WS_CAPTION`). `WS_CAPTION` set on the HWND **does not
  mean a native caption is drawn**. Look at pixels and client height (~800),
  not the style bit.
- Window perms in `src-tauri/capabilities/default.json`: `core:window:*`
  close/minimize/toggle-maximize/start-dragging, plus updater + process.
- Launch the built app: `.\src-tauri\target\release\app.exe`
- **Do not redirect stdout/stderr** on that process — closing the pipe kills
  the GUI. One instance at a time.
- **Release `app.exe` ≠ live HTML.** `cargo tauri build` snapshots `web/` at
  build time. `cargo tauri dev` is what tracks `index.html`. Do not verify a
  frontend fix against an old installer binary.

---

## Circles — check these before "fixing"

1. **Cached `index.html`.** After an edit, load `http://localhost:8000/?nocache=1`.
   Tauri `devUrl` already has the query. If the window looks unchanged, you
   are probably on stale HTML, not a failed CSS change.
2. **Pixel clicks miss.** CDP screenshot pixels ≠ CSS pixels; PowerShell
   `mouse_event` + DPI is the same trap. Drive the UI with **UI Automation
   Invoke by Name** or JS event dispatch. Do not "fix" the app because a
   click landed on body text.
3. **Minimized PrintWindow.** Rect `-32000,-32000`. Restore (`SW_RESTORE`)
   before capture.
4. **`#chart` reads empty** on a working Charts empty state. The text is in
   `#ch-bd-name`.
5. **`.cmp-switch` knob looks stuck** in a background/CDP tab because
   CSSTransition sits at `currentTime: 0`. Finish animations before measuring.
   Do not "fix" a switch that is not broken.
6. **Migrations win** over `schema.sql` / `logic.sql`. Those files are snapshots.
7. **Charts redesign is design work**, not a restyle of the four Plotly views.
8. **Shared DB / no auth** is a later deliverable, not a polish-pass bug.
   CORS-open `/data` that 500s on junk is the known tradeoff.
9. **PowerShell:** no `&&`. Chain with `;`. `Invoke-WebRequest` needs
   `-SkipHttpErrorCheck` or use `HttpWebRequest` when fuzzing `/data`.
10. **`mouse_event` wheel** with `[uint32](-120)` is wrong; use a signed
    int or SendKeys PGDN.

---

## Verify before calling UI work done

1. `deno task check` and `deno task test`.
2. Real window: `cargo tauri dev` (or `?nocache=1` in the browser).
3. Exercise the change: click, type, switch tabs, scroll a **long** page
   (Browse), open Settings, dismiss it. A single top-of-Home screenshot
   will not catch chrome-on-scroll.
4. If you touched shared state (`apiWrite`, settings, watchlist), check
   every tab that reads it.
5. Capture: UI Automation + PrintWindow, window restored, not minimized.
6. Do not declare a frontend fix verified against a stale `app.exe`.

If you could not open a real window, say so. `web_invariants_test.ts` is
the static net, not a substitute for clicking.
