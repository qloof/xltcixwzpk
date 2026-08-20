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
                Auto-filled by geocoding the `location` text (see Feature
                notes) unless coordsManual is true.
    order       number, default 0. Manual tiebreaker within a date group
                (see "Manual reordering" in Feature notes) — only meaningful
                among itinerary days sharing the same date (or all having
                no date yet). Never overrides date-based ordering.
    coordsManual  boolean, default false. True once a human has manually
                typed into the lat/lon fields (via the "± coordinates"
                toggle). While false, every edit to `location` re-geocodes
                and silently overwrites lat/lon. Once true, location edits
                stop touching lat/lon — the human's manual pin is trusted.
                There's currently no UI to flip this back to false short of
                manually re-editing lat/lon back to blank; see Known
                limitations.
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
- **PWA / "Add to Home Screen".** `manifest.json` + `sw.js`. It deliberately
  does NOT cache Firebase responses, so it can never serve stale trip data
  as if it were live. `sw.js` is registered from an **absolute** path
  (`/trip-dashboard/sw.js`) so its scope covers every trip subfolder from
  one shared file.
  **v2 correction (this round):** the original description here said the
  service worker "only caches static shell assets (currently just the
  icon)" — that was wrong, and it caused a real bug, not just a docs typo.
  The `fetch` handler intercepted *every* same-origin GET, including
  `index.html` itself, and served the cached copy first (refreshing the
  cache in the background for *next* time) — a stale-while-revalidate
  pattern. That's fine for an asset that never changes, but the dashboard's
  own HTML/JS changes on every code deploy, so this meant every fix pushed
  to this repo needed an *extra silent reload* on a phone that had visited
  before, before it actually showed up — indistinguishable from "the fix
  didn't work." This is exactly what happened after the Waze/geocode fix
  earlier this session: the fix was correctly deployed, but the user's
  phone kept serving the stale pre-fix JS. Fixed by making the app's own
  HTML/manifest **network-first** (always try the network, only fall back
  to cache if the network request fails outright) while leaving genuinely
  static assets (the icon) cache-first. Cache name bumped to
  `trip-dashboard-shell-v2` so the old stale-cached entries get purged on
  activate. **If this ever recurs** (a deployed fix "isn't showing up"),
  suspect the service worker cache before suspecting the code — have the
  user do a hard refresh, or clear site data for the page, or uninstall/
  reinstall if it's been added to the home screen.
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
- **Itinerary date display.** Each card shows the day's date stacked two
  ways: a bold full weekday name ("Tuesday") on top, a numeric `d/m/yyyy`
  date ("8/12/2026") underneath — both derived live from the same ISO
  `date` field via `formatWeekday()`/`formatNumericDate()`. The actual
  `<input type="date">` used to edit the date stays present underneath
  (small, muted) — the stacked display is read-only, driven off the same
  input's `change` event.
- **Location → coordinates (auto-geocode + Waze).** Raw lat/lon inputs are
  hidden by default behind a "± coordinates" toggle so the itinerary card
  stays readable. Typing a location and clicking away (blur) calls the
  Open-Meteo geocoding API (`geocodeLocation()`) and fills lat/lon
  automatically, which also fills a "Navigate in Waze →" link
  (`https://waze.com/ul?ll={lat},{lon}&navigate=yes`). If the lookup finds
  nothing, a small amber line under the location field says so and points
  at the manual toggle instead of failing silently. **This re-geocodes on
  every location edit**, not just the first — earlier code only geocoded
  when lat/lon were both still empty, which meant editing an already-seeded
  card's location (e.g. changing "Sydney" to a Singapore address) silently
  kept Sydney's coordinates and both the "coords not updating" and "Waze
  opens but doesn't navigate anywhere sensible" symptoms the user hit were
  this bug. Fixed by tracking a `coordsManual` flag instead of "are lat/lon
  currently non-empty": location edits always re-geocode *unless* the human
  has manually typed into lat/lon themselves, in which case their manual
  pin is trusted and left alone.
- **Manual reordering (▲/▼).** Full drag-and-drop was considered and
  rejected: this is a phone-first app and native HTML5 drag doesn't work
  reliably on touch without an extra library, and — more fundamentally —
  itinerary order is driven by `date`, not by list position (see the sort
  comment at the top of `renderItinerary()`). Dragging a card to a
  different date's position wouldn't stick; the next render would snap it
  back to date order, which would look broken. What people actually need
  manual control over is the *sub-order within a date* (or among days that
  don't have a date yet) — e.g. two draft stops with no date, or two stops
  planned for the same day. The ▲/▼ buttons only swap within that group;
  they're disabled (greyed out, unclickable) when there's no same-group
  neighbor to swap with, so you never click one and see nothing happen.
  Backed by a per-day `order` number (see Data model) that's lazily
  "repaired" to clean sequential values the first time you reorder a given
  group, so pre-existing cards with no `order` field don't need migrating.
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
- Once `coordsManual` is set true on a day (by editing lat/lon by hand),
  there's no button to un-pin it back to auto-geocoding — the only way is
  to manually clear/re-edit the lat/lon fields (which sets coordsManual
  true again, not back to false). Worth adding an explicit "reset to
  auto" control if manual pins turn out to need frequent correcting.

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
7. This round: reworked the itinerary card's date to show a stacked
   weekday-name/numeric-date display, and fixed a real bug in the
   location→coordinates auto-geocode flow (was gated on "lat/lon currently
   empty," which silently kept stale coordinates — and a stale/wrong-country
   Waze link — when editing an already-seeded card's location; now gated on
   an explicit `coordsManual` flag instead). Both changes were made in the
   engine template first, then propagated to `australia-dec-2026/index.html`
   the same way as always.
8. This round: added manual ▲/▼ reordering within a date group (see Feature
   notes — full drag was rejected, not just deferred, for reasons explained
   there). Also found and fixed a real bug in `sw.js`: it was serving stale
   cached HTML/JS on every load instead of the freshly-deployed code, which
   is why the user saw the round-7 Waze fix appear not to work even though
   it had deployed correctly — see the "v2 correction" note under PWA in
   Feature notes for the full story.
9. Second trip added: `singapore-aug-2026/` — a deliberate **live test**,
   not a real planned trip. 4 days starting the day it was created, real
   Singapore landmarks with real lat/lon seeded in (Gardens by the Bay,
   Sentosa, Chinatown/Little India, East Coast Park), specifically so the
   user could open it on their phone the same day and exercise weather
   (finally within the ~16-day forecast window, unlike the Australia draft
   which is months out), geocoding, the Waze fix, and the new reorder
   buttons against real dates and a real location instead of a hypothetical.
   Flagged in its own subtitle as test/draft content, same convention as
   the Australia trip.

## Trips so far

- `australia-dec-2026/` — draft, not booked/verified (see History #4).
- `singapore-aug-2026/` — live test trip, not a real planned trip (History
  #9). Fine to delete/repurpose once it's served its testing purpose.

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
