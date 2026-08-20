# Trip Dashboard — dev notes

Read this before touching anything in this repo. It's written for a fresh
Claude session with no memory of how this got built — assume nothing.

## What this is

A reusable, live-syncing, two-person road trip dashboard. One user (Longfen)
plans road trips with his partner; both need to see and edit the same plan
from their own phones, in real time, without either of them needing a login.
The design language (boarding-pass header, IBM Plex Mono/Sans + Fraunces,
navy/brass/teal palette) is deliberate and established — match it, don't
restyle from scratch on future changes.

## Stack, and why

- **Hosting: GitHub Pages**, repo `qloof/trip-dashboard`, served from `main`
  branch root. Chosen because the user already had a GitHub account — no new
  signup needed, and it's free static hosting.
- **Shared live state: Firebase Realtime Database**, project
  `trip-dashboard-c6f8a`, **Spark (free) plan — do not upgrade to Blaze**
  without an explicit reason; Spark means zero billing risk regardless of
  traffic, which matters because the DB rules are wide open (see below).
- No build step, no framework, no bundler. Plain HTML/CSS/vanilla JS ES
  modules, loaded straight from CDN (Firebase SDK, Leaflet). Keep it that
  way — this is a "minor project" per the user, and adding a build pipeline
  would be a net loss for something this size.
- **Local git clone lives inside Google Drive on purpose**:
  `X:\My Drive\Claude\Trip Dashboard\trip-dashboard\`. This was explicitly
  requested by the user after being warned that Drive-syncing a live `.git`
  folder is somewhat risky (Drive's background sync can collide with git's
  own file rewrites). The user accepted the risk ("it's a minor project").
  If git ever starts behaving strangely (index lock errors, weird partial
  commits), suspect Drive sync first.

## Data model (Firebase Realtime DB)

```
/trips/{tripId}/
  meta/
    title, subtitle, days        (free text, header display)
    lastEditedBy, lastEditedAt   (stamped by every write, see writeValue())
  itinerary/{pushKey}/
    date        ISO yyyy-mm-dd (native <input type="date">) — NOT free text.
                This is the sort key (chronological) and drives the
                "today" highlight and weather lookups. An earlier version
                used a free-text date string ("Mon 8 Dec") — that was wrong,
                broke sorting and made "today" detection impossible, and was
                migrated away from. Don't regress to free text.
    location    free text
    lat, lon    optional numbers — power weather + the map marker. Blank is
                fine; UI degrades gracefully (no weather line, no map pin).
    plan, lodging, alt   free text
  checklists/{w4|w2|dayBefore|onRoad}/{pushKey}/
    text, checked
  budget/{lodging|transport|food|activities|misc}/
    label (fixed), budgeted, actual   — total row is computed client-side,
    never stored.
  contacts/{pushKey}/  { name, ref }
  extras/{pushKey}/    { item, notes }
```

`{pushKey}` = Firebase `push()` ID (chronological by creation, used as
tiebreaker sort / for checklists, contacts, extras where creation order is
fine). Itinerary days sort by `date`, not push key.

### Database rules (already published)

```json
{ "rules": { "trips": { "$tripId": { ".read": true, ".write": true } } } }
```

Open read/write scoped under `/trips/{tripId}`. Trust model = same as a
shared link: anyone with a trip's specific URL can read/write it. No auth.
This was a deliberate simplicity tradeoff, explained to and accepted by the
user. Don't "fix" this into an auth system unless asked — it would break
the whole point (open a link, start editing, no signup).

The `firebaseConfig` object (apiKey etc.) embedded in every page is **not**
a secret — it's meant to be public for Firebase web apps. GitHub's secret
scanner will flag it; that's a false positive, already explained to the
user. Access control is the DB rules above, not the key.

## Folder / URL convention — one subfolder per trip

```
trip-dashboard/                    (repo root)
├── index.html                     generic "engine" copy — NOT a real trip,
│                                   was the original proof-of-concept
│                                   (tripId was random ?trip=xxxxxx once,
│                                   since replaced — see History below)
├── manifest.json, icon.svg, sw.js  shared PWA assets (icon + service worker
│                                   are genuinely shared across all trips;
│                                   manifest.json is duplicated per-folder
│                                   on purpose — see PWA notes below)
├── .gitignore                      repo-root level, not per-subfolder
└── <trip-slug>/
    ├── index.html                  that trip's dashboard, copied from the
    │                                engine template with TRIP_ID/TRIP_LABEL/
    │                                TRIP_SEED filled in
    └── manifest.json                per-trip copy (see below)
```

Live URL: `https://qloof.github.io/trip-dashboard/<trip-slug>/`

### To start a new real trip

1. Copy the engine template — the canonical source is
   `/trip-dashboard/index.html` at repo root, OR ask Claude to regenerate
   from this file's structure (all the render/weather/map logic is
   duplicated per-file by design, see "Why duplicated, not shared" below).
2. In the new file's `<script type="module">`, set:
   - `TRIP_ID` — must equal the folder name (e.g. `'summer-2026'`)
   - `TRIP_LABEL` — short display string for the ticket stub
   - `TRIP_SEED` — an object matching the shape in `GENERIC_SEED` in the
     engine file, with real (or draft) itinerary days, checklist items,
     contacts, budget line items. **Itinerary day `date` fields must be ISO
     `yyyy-mm-dd` strings.** Add `lat`/`lon` for any stop you want weather
     + map support on (plain decimal degrees, e.g. Sydney Opera House is
     `-33.8568, 151.2153`).
3. Update `<title>` and the `<link rel="manifest">`/`<link rel="icon">`
   paths to match (icon can stay pointed at the shared
   `/trip-dashboard/icon.svg`; manifest should be a **new small file in the
   trip's own folder**, not the shared root one — see PWA notes).
4. Create a `manifest.json` in the new trip folder (copy
   `<trip-slug>/manifest.json` pattern from `australia-dec-2026/manifest.json`,
   change `name`/`short_name`).
5. `git add`, commit, push from the local clone
   (`X:\My Drive\Claude\Trip Dashboard\trip-dashboard\`). GitHub Pages
   redeploys automatically in ~1-2 min.
6. Open the new URL once to trigger the seed-on-first-load (see below),
   confirm "Synced" status, confirm the seeded content looks right.

### Why the engine is duplicated per trip, not shared as one file

Considered and rejected: a single shared `index.html` reading `tripId` from
a URL query param (`?trip=xxxxxx`) so one file serves every trip. That's
what the very first version did (see History). The user explicitly asked
to switch to "one index.html per subfolder" with a real, readable per-trip
URL instead of a random code — it reads better and each trip is a
self-contained file you can hand off/archive independently. The tradeoff is
that a change to the shared rendering logic (e.g. a bug fix) has to be
copied into every trip's file by hand (or scripted) rather than being one
change in one place. Given this is a low-traffic personal project with at
most a handful of trips a year, that tradeoff was accepted. If this ever
grows to many trips, revisit — a shared `/trip-dashboard/app.js` imported
by every trip's thin `index.html` would remove the duplication without
giving up per-trip URLs.

## Feature notes (added in the "let's do all of it" round)

- **Weather** (Open-Meteo, `api.open-meteo.com`, no API key). Only returns
  data within ~16 days of today — for anything further out, the UI shows
  "Forecast available once within ~2 weeks of this date" rather than
  nothing. This is expected, not a bug: a trip planned months ahead won't
  show real forecasts until it's actually close. Requires `lat`/`lon` on
  the itinerary day; silently shows nothing if absent.
- **Map** (Leaflet + OpenStreetMap tiles, no API key). New "Map" tab, plots
  every itinerary day with valid `lat`/`lon`, connects them with a line in
  date order, re-renders whenever itinerary data changes. Leaflet is loaded
  as a classic (non-module) script tag alongside the `type="module"` app
  script — that's intentional, Leaflet doesn't ship as an ES module on the
  CDN build used here.
- **Offline resilience.** Every successful Firebase sync writes the full
  trip state to `localStorage` (`trip-cache-{tripId}`). On page load, the
  cached copy renders immediately (before Firebase even connects), then
  gets overwritten the moment live data arrives. If Firebase hasn't
  connected within 6 seconds, an orange banner says so. This is genuinely
  new capability vs. the very first version of this project (which was a
  Cowork Artifact — Artifacts can't use `localStorage` or call external
  hosts at all). Once we moved to real GitHub Pages hosting, both
  restrictions went away; this is why weather/map/offline-cache weren't
  built until this round.
- **PWA / "Add to Home Screen".** `manifest.json` + `sw.js`. The service
  worker only caches static shell assets (currently just the icon) and
  passes through everything else (Firebase, fonts, Leaflet, weather API) to
  the network — it deliberately does NOT cache Firebase responses, so it
  can never serve stale trip data as if it were live. `sw.js` is registered
  from an **absolute** path (`/trip-dashboard/sw.js`) so its scope covers
  every trip subfolder from one shared file.
  `manifest.json` is duplicated per-trip-folder rather than shared, because
  a shared manifest's `start_url` resolves relative to the manifest's own
  location, not the page that links it — a shared root manifest would make
  every trip's "installed" icon reopen the repo root instead of that
  specific trip. Per-trip manifests with `"start_url": "."` avoid that.
- **Today highlight.** Compares each itinerary day's `date` (ISO) against
  the browser's local today (computed manually via `getFullYear`/
  `getMonth`/`getDate`, NOT `toISOString()`, to avoid UTC-vs-local date
  shifting) — matching card gets a brass border + "Today" tag.
- **Print / export.** A "Print / Save PDF" button calling `window.print()`,
  plus a `@media print` block that disables tab-switching (forces every
  panel to `display: block` at once) and hides buttons/toolbar/map so it
  reads as a clean paper itinerary. No separate PDF library — relies on the
  browser's own print-to-PDF.
- **"Last edited by."** A small text input in the toolbar, stored in
  `localStorage` only (`trip-editor-name`) — not per-user auth, just a
  courtesy label. Every field write goes through a central `writeValue()`
  helper that, alongside the actual write, also stamps
  `meta/lastEditedBy` + `meta/lastEditedAt`, so the sync-status line can
  read "Synced · edited by X · just now." This is trip-wide, not
  per-field — a genuinely per-field audit trail (who changed *this exact
  field*) was considered and deliberately skipped as more complexity than
  a two-person dashboard needs.

## Known limitations (already communicated to the user — don't "fix" silently)

- No auth; anyone with a trip's URL can read/write it.
- If two people edit the *exact same field* at the *exact same moment*,
  last write wins — no conflict resolution. Fine for two people, not built
  for more.
- Each render function bails out early if the user currently has focus
  inside that section (`focusedInside()` guard), so a remote edit elsewhere
  won't yank your cursor mid-type. It also means you won't *see* a remote
  update to a section you're actively editing until you click away.
- Weather only works within ~16 days of the date, and only for days with
  lat/lon filled in.
- No offline *write* queueing — the offline cache is read-only fallback
  for viewing; edits made while offline are not currently queued and
  replayed once reconnected (worth adding if it becomes a real pain point).

## History (why things are the way they are)

1. Started as a Cowork Artifact — a single published HTML page, fully
   client-side, no backend. Realized the moment we needed two people to
   both *edit* it live, an Artifact can't do that (sandboxed, no outbound
   network, no localStorage).
2. Rebuilt on GitHub Pages (user already had an account) + Firebase
   Realtime Database (free tier) for the shared live state. First version
   used one shared `index.html` at repo root with `?trip=xxxxxx` random
   codes in the URL.
3. User asked for "one index.html per subfolder" instead of the random-code
   query param — switched to the per-trip-folder convention documented
   above.
4. First real trip drafted: `australia-dec-2026/` (Sydney → Blue Mountains →
   Melbourne → Great Ocean Road → Phillip Island, Dec 8–21 2026) — explicitly
   flagged by the user as "random things" / a draft to build on, not a real
   itinerary yet. Nothing in it is booked or verified.
5. First deploy went through GitHub's web upload UI (no git). User then
   asked to do it "properly" with real git — set up a local clone,
   `.gitignore`, commit/push, initially outside Google Drive
   (`C:\Users\longf\projects\trip-dashboard`) specifically to avoid
   Drive-sync-vs-git conflicts. User then explicitly asked to move the
   clone *into* the Drive-synced folder anyway, accepting the risk ("minor
   project") — see Stack section above.
6. This round: added weather, map, offline caching, PWA support, today
   highlight, print/export, and last-edited-by tracking to a shared
   "engine" template, then propagated it to the (draft, still-unverified)
   Australia trip. Also had to re-seed the Australia trip's Firebase data
   from scratch, since the data model changed (itinerary `date` went from
   free text to ISO, added `lat`/`lon`) and the old seed had already been
   written on first load — safe to do because it was explicitly disclosed
   as throwaway draft content, not a real trip yet.

## Still open / natural next steps

- Real verification pass before the Australia trip is actually real:
  confirm opening hours/closures for each stop via web search close to the
  trip date (per the standing project instruction), fill in actual
  hotel/car-rental bookings and confirmation numbers, replace all `[TBD]`
  placeholders.
- Consider extracting the shared JS into one `/trip-dashboard/app.js` if
  the number of trips grows enough that per-file duplication becomes
  painful to maintain (see "Why duplicated" above).
- Offline write queueing, if spotty signal on an actual drive turns out to
  be a real problem in practice rather than a theoretical one.

## Round 3: itinerary card UX (geocoding, Waze, layout)

- **Day above Date.** `.card-row` changed from a horizontal flex row to a
  stacked column — the "Stop N" label (+ Today tag) now sits above the
  date input rather than beside it. Pure CSS change, no data model impact.
- **Coordinates are hidden by default now, and mostly auto-filled.**
  Raw lat/lon inputs used to always show on every itinerary card — the
  user asked whether that was necessary, and it wasn't: humans don't need
  to see decimal coordinates day-to-day, they're just plumbing for
  weather/map/navigation. Two changes:
  1. The coords row is now hidden behind a small "± coordinates" toggle
     button per card (manual override still fully available, just not
     shown by default).
  2. When the `location` text field is edited and lat/lon are still empty,
     `geocodeLocation()` (Open-Meteo's free geocoding API, no key) resolves
     the typed place name to coordinates automatically in the background
     and writes them silently. If the auto-match is wrong (ambiguous place
     names — "Sydney" could resolve outside Australia, etc.), open the
     toggle and correct the lat/lon by hand; it won't be overwritten again
     once non-empty. Geocoding only fires when lat/lon are both blank, so
     it never fights a manual correction.
- **Waze handoff.** Each card has a "Navigate in Waze →" link
  (`https://waze.com/ul?ll={lat},{lon}&navigate=yes`, Waze's universal
  link format — opens the Waze app if installed, falls back to
  web/store otherwise) that only appears once lat/lon are present
  (auto-geocoded or manual). This was the actual justification for keeping
  coordinates in the data model at all rather than dropping them — they
  now power three features (weather, map, one-tap Waze navigation), not
  just one.
