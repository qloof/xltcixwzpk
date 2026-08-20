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
- **All shared rendering/sync logic lives in one file: `app.js`** (repo
  root), imported as an ES module by every trip's `index.html`. This used
  to be a full byte-for-byte copy of the JS pasted into every trip file —
  see "Why the engine used to be duplicated per trip" below for why that
  was extracted and what changed.
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
                A "↺ reset to auto" button appears once this is true, to
                flip it back and re-geocode immediately (see Feature notes).
    plan, lodging, alt   free text
  checklists/{w4|w2|packingLongfen|packingGwen|dayBefore|onRoad}/{pushKey}/
    text, checked
  budget/{lodging|transport|food|activities|misc}/
    label (fixed), budgeted, actual   — total row is computed client-side,
    never stored.
  budgetCurrency  string, e.g. 'SGD', 'AUD'. What currency the budget
                figures above are entered in. Defaults to 'SGD' (the
                app's HOME_CURRENCY) if absent — this matters for
                existing trips seeded before this field existed, since
                they're never re-seeded from an updated TRIP_SEED (see
                "To start a new real trip" below); a trip whose actual
                spending currency isn't SGD needs this field set once,
                by hand, via a Firebase REST write or by picking it from
                the dropdown in the Budget panel (which writes it back
                immediately).
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
├── index.html                     the landing page — lists every trip,
│                                   reads trips.json, no Firebase/app.js
│                                   (see Feature notes "Landing page")
├── trips.json                     [{slug, title, subtitle}, ...] — kept up
│                                   to date automatically by
│                                   scripts/new-trip.mjs
├── template/
│   └── index.html                  generic "engine" copy — NOT a real trip,
│                                    the copy-source scripts/new-trip.mjs
│                                    (and manual copying) starts from
├── app.js                          the shared engine — see below
├── manifest.json, icon.svg, sw.js  shared PWA assets (icon + service worker
│                                   are genuinely shared across all trips;
│                                   manifest.json is duplicated per-folder
│                                   on purpose — see PWA notes below)
├── .nojekyll                       tells GitHub Pages not to run Jekyll
│                                   processing — this repo has no build
│                                   step or Jekyll dependency (see Stack),
│                                   this just makes that explicit/predictable
├── scripts/
│   ├── new-trip.mjs                 scaffolds a new trip folder — see
│   │                                 "To start a new real trip" below
│   └── new-trip.example.json        starter seed you copy/fill in for a
│                                     new trip and pass to new-trip.mjs
├── .gitignore                      repo-root level, not per-subfolder
└── <trip-slug>/
    ├── index.html                  that trip's dashboard — a thin shell
    │                                (HTML/CSS + an initTripDashboard()
    │                                call) that imports app.js
    └── manifest.json                per-trip copy (see below)
```

Live URL for a trip: `https://qloof.github.io/trip-dashboard/<trip-slug>/`.
Site root (`https://qloof.github.io/trip-dashboard/`) is now the landing
page listing all trips — see History #17.

### To start a new real trip

1. Write a seed file describing the trip — copy
   `scripts/new-trip.example.json` and fill it in: itinerary days (ISO
   `yyyy-mm-dd` dates, `lat`/`lon` in plain decimal degrees for any stop
   you want weather/map/drive-time support on, e.g. Sydney Opera House is
   `-33.8568, 151.2153`), checklists, contacts, budget line items.
2. Run `node scripts/new-trip.mjs <slug> <label> <path-to-seed.json>` from
   the repo root (`X:\My Drive\Claude\Trip Dashboard\trip-dashboard\`) —
   `<slug>` becomes both the folder name and the Firebase tripId (they must
   match), `<label>` is the short ticket-stub label. This creates
   `<slug>/index.html` and `<slug>/manifest.json` for you, reading the
   *live* engine file (`template/index.html`) as its template so the
   scaffolded trip always matches whatever the dashboard actually looks
   like — see the script's own header comment. It also appends the new
   trip to `trips.json`, so it shows up on the landing page automatically
   — nothing else to do for that.
3. `git add`, commit, push from the local clone. GitHub Pages redeploys
   automatically in ~1-2 min.
4. Open the new URL once to trigger the seed-on-first-load (see below),
   confirm "Synced" status, confirm the seeded content looks right.

(Steps 1-2 replace what used to be five manual steps — copy the engine
file, hand-edit TRIP_ID/TRIP_LABEL/TRIP_SEED, update `<title>`, write a
manifest.json by hand, keep the folder name and TRIP_ID in sync yourself.
See "Why the engine used to be duplicated per trip" below.)

### Why the engine used to be duplicated per trip (fixed — see `app.js`)

Considered and rejected, early on: a single shared `index.html` reading
`tripId` from a URL query param (`?trip=xxxxxx`) so one file serves every
trip. That's what the very first version did (see History). The user
explicitly asked to switch to "one index.html per subfolder" with a real,
readable per-trip URL instead of a random code — it reads better and each
trip is a self-contained file you can hand off/archive independently.

The tradeoff, for a long time, was that every trip's `index.html` carried a
full byte-for-byte copy of the render/sync JS (~800 lines), so a bug fix or
new feature had to be hand-applied to every trip file. History entries #10,
#11, #12, #13, #14, #15 below all ended with "propagated to all three
files" as a separate, error-prone step. That's now fixed **without giving
up per-trip URLs**: all shared logic moved into one file, `app.js` (repo
root), which every trip's `index.html` imports as an ES module —
`import { initTripDashboard } from '../app.js'` from a trip subfolder (or
from `template/index.html`, the engine copy-source — see History #17 for
why that moved out of the repo root). Each trip's `index.html` is now just
its HTML/CSS shell plus one `initTripDashboard({ tripId, tripLabel,
tripSeed })` call — see `template/index.html` for the canonical shell.

A few small pieces of markup/CSS added *after* this extraction (the update
toast, the budget "Other…" currency input) are injected by `app.js` itself
at init time (`injectStyles()`/`ensureUpdateToast()`/
`ensureCurrencyOtherInput()`) rather than hand-edited into all three HTML
files — so genuinely everything about how the dashboard behaves and mostly
how it looks lives in one file now. The itinerary card's own markup (the
"reset to auto" coords button, see Feature notes) needed no such injection
since that card was already built as an HTML template string inside
`renderItinerary()` in `app.js`, not static HTML.

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
  stays readable. Typing a location and clicking away (blur) calls
  `geocodeLocation()` and fills lat/lon automatically, which also fills a
  "Navigate in Waze →" link (`https://waze.com/ul?ll={lat},{lon}&navigate=yes`).
  If the lookup finds nothing, a small amber line under the location field
  says so and points at the manual toggle instead of failing silently.
  **This re-geocodes on every location edit**, not just the first — earlier
  code only geocoded when lat/lon were both still empty, which meant
  editing an already-seeded card's location silently kept the old
  coordinates. Fixed by tracking a `coordsManual` flag instead of "are
  lat/lon currently non-empty": location edits always re-geocode *unless*
  the human has manually typed into lat/lon themselves, in which case
  their manual pin is trusted and left alone.
  **Geocoder swapped this round (was Open-Meteo, now Nominatim/OSM):**
  the original geocoder used Open-Meteo's geocoding endpoint since it's
  the same keyless API already used for weather. That was the wrong tool —
  it's a city/town gazetteer (GeoNames-based), not a landmark/address
  geocoder, and it was the actual cause of "sometimes it works, sometimes
  it doesn't." Confirmed by direct testing: querying it for "Gardens by
  the Bay" (a real Singapore landmark, and in this repo's own seed data)
  returned zero results; querying "Sentosa" matched an unrelated village
  in Central Java, Indonesia instead of Sentosa Island — a wrong-country
  false positive with no error surfaced. Switched to Nominatim
  (`nominatim.openstreetmap.org/search`), OSM's own search, which
  indexes landmarks/POIs/addresses — what this field is actually used
  for. Public instance, no API key, but has a real usage policy
  (max ~1 req/sec, wants the app identified — satisfied by the browser's
  automatic Referer header, no extra code needed); this app's usage
  (occasional interactive lookups) is well within that. **Not verified
  from this dev environment** — the sandbox's outbound network is
  allowlisted and blocks Nominatim directly, and the web-fetch tool
  respects Nominatim's robots.txt (which only applies to crawlers, not to
  a real browser's `fetch()`, but it meant this round's fix could only be
  verified by code review + confirming the API behavior via a differently
  routed lookup, not by hitting the exact deployed code path end-to-end).
  If a location still doesn't resolve after this, that's real signal —
  check the actual API response for that query before assuming the code
  regressed.
  Also added: a per-card `geocodeSeq` sequence guard on the location blur
  handler. The location-text write reaches Firebase (and re-renders the
  card) well before a geocoding lookup over the network returns, so two
  edits made in quick succession could have their lookups resolve
  out of order — the guard makes sure only the most recently *fired*
  lookup is allowed to write its result, so a slower/older response can't
  clobber a newer one.
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
- **Two packing lists.** Longfen and Gwen each get their own checklist tier
  (`packingLongfen`, `packingGwen`) under the Checklists tab, between "2
  weeks out" and "Day before" — same UI/interaction as every other tier
  (checkbox + editable text + remove), nothing new to build. Considered and
  rejected: a single shared packing list, and a brand-new top-level tab.
  A shared list doesn't work because packing needs are genuinely different
  per person; a new tab was rejected because this is structurally identical
  to what Checklists already does, and the tab bar is already six items
  wide on a phone screen — a packing list doesn't need its own top-level
  nav destination. Names are hardcoded into the engine template (not a
  generic placeholder like "[Person 1]") because this app is built for
  exactly these two people, not for resale/generalization — see the
  project's own description.
- **"Last edited by."** A small text input in the toolbar, stored in
  `localStorage` only (`trip-editor-name`) — not per-user auth, just a
  courtesy label. Every field write goes through a central `writeValue()`
  helper that, alongside the actual write, also stamps
  `meta/lastEditedBy` + `meta/lastEditedAt`, so the sync-status line can
  read "Synced · edited by X · just now." This is trip-wide, not
  per-field — a genuinely per-field audit trail (who changed *this exact
  field*) was considered and deliberately skipped as more complexity than
  a two-person dashboard needs.
- **Enter commits a field; a brief flash confirms it.** Every editable
  field is a bare `contenteditable` span/div — its native browser behavior
  for Enter is to insert a line break, not submit, so pressing Enter after
  typing did something invisible (the value only committed later, on
  blur, whenever that happened) — reported as "I can't tell if my edit
  registered." `commitOnEnter()` makes Enter blur the field immediately
  (preventing the line-break insert), and `flashSaved()` adds a brief teal
  background flash on any field right after its value is written — reusing
  `--teal`, the same color the sync dot uses for "connected," rather than
  a new accent color. Wired into `commitOnBlur()` (covers checklist items,
  budget, contacts, extras) and individually into the itinerary location
  field and the header title/subtitle/days fields, since those don't go
  through `commitOnBlur()`. One thing to watch: the header fields
  (title/subtitle/days) are NOT recreated each render like card fields
  are, so their Enter-handling uses `.onkeydown =` (property assignment,
  replaces on every render) rather than `commitOnEnter()`'s
  `addEventListener` (which would silently stack a duplicate listener on
  every Firebase sync if used there) — keep that distinction if this
  pattern gets extended to more fixed, non-recreated elements.
- **Drive time between stops** (OSRM, `router.project-osrm.org`, no API
  key). Each itinerary card shows walking-you-through-it drive time/
  distance to the *next* card in date order (🚗 "1h 12m · 58 km to
  Sentosa Island"), computed from both cards' lat/lon. Blank if either
  stop is missing coordinates, or if it's the last stop. Results are
  cached in-memory per lat/lon pair (`routeCache`) since the same
  consecutive-stop pair recomputes on every render otherwise. **Explicitly
  a non-production instance**: OSRM's own docs describe
  `router.project-osrm.org` as a demo/evaluation server, not something to
  build a real product on — no uptime guarantee, no key, shared rate
  limits. Accepted here because usage is low (a handful of cached lookups
  per page view) and occasional — revisit (self-hosted OSRM, or a
  commercial routing API) if this ever needs to be reliable for more than
  a two-person trip dashboard.
- **Trip countdown / status badge.** The toolbar's "Status:" badge
  (`#stubStatus`) used to be static text ("Status: Planning"). Now
  computed live from the itinerary's actual date range vs. today:
  "T-minus N days" before the trip starts, "Day N of M · In progress"
  during it, "Trip complete" after the last day, and back to the original
  "Status: Planning" text if the itinerary has no dated days yet. Pure
  client-side date math (`updateTripStatus()`), no API involved.
- **QR code + share link.** A "Share" button in the toolbar toggles a
  panel showing a QR code and the page's own URL (stripped of query
  string/hash) plus a "Copy link" button using
  `navigator.clipboard.writeText`. QR rendering uses the
  `qrcode-generator` library (Kazuhiko Arase, MIT license), loaded as a
  classic script tag from `unpkg.com/qrcode-generator@1.4.4/qrcode.js` —
  same pattern as Leaflet (not an ES module on the CDN build, so it can't
  be `import`ed from the module script). The QR image is generated once
  and cached (`qrGenerated` flag) rather than regenerated every time the
  panel is toggled open. Deliberately excluded from `@media print`'s
  hide-list is *not* the case here — `.share-panel` IS hidden when
  printing (a QR code and "copy link" button aren't useful on paper),
  unlike `.drive-line` which is deliberately left visible when printed.
- **Currency conversion in Budget.** A dropdown at the top of the Budget
  panel lets you declare what currency the budgeted/actual figures are
  entered in (defaults to reading `budgetCurrency`, see Data model). If
  that's not the app's home currency (SGD, hardcoded as
  `HOME_CURRENCY`), a line under the budget table shows a live reference
  conversion of the totals to SGD, fetched from the Frankfurter API
  (`api.frankfurter.dev`, ECB reference rates, no key) and cached per
  currency for the session (`fxRateCache`) since it doesn't change
  minute to minute. This is explicitly a *reference* conversion for
  planning, not a live/authoritative exchange rate — ECB reference rates
  update once a day on banking days. Changing the dropdown writes
  `budgetCurrency` back to Firebase immediately so it's remembered for
  next time and syncs to the other person.
- **Temporal Dead Zone (TDZ) bug — found and fixed this round, not just
  new-feature risk.** `renderAll()` can run *synchronously* during the
  very first paint, straight off the `localStorage` offline cache, before
  the module script has finished executing top-to-bottom (see "Offline
  resilience" above). Any `const`/`let` declared *after* the line that
  first calls it will throw `ReferenceError: Cannot access 'X' before
  initialization` the first time that code path runs — this is the JS
  Temporal Dead Zone, and it's silent here because the offline-cache
  render is wrapped in try/catch, so the error was swallowed and the
  live Firebase render (which happens later, after the whole script has
  loaded) painted correctly a moment after — nothing looked broken unless
  you were specifically watching the console on first load. `function`
  declarations are NOT affected (fully hoisted) — only `const`/`let`.
  While building this round's drive-time and currency features, this bug
  would have hit the new `routeCache` and `HOME_CURRENCY`/`fxRateCache`
  declarations. Fixing it surfaced that it was **already present and
  already firing**, undetected, for two pre-existing declarations:
  `weatherCache`/`WMO` (weather) and `leafletMap`/`markerLayer` (map) —
  both declared later in the file than the offline-cache render that can
  reach them. It only actually threw for the Singapore trip, never the
  Australia one, because the weather-fetch code path is only reached for
  itinerary days within ~16 days of today — true for Singapore (a live
  test trip happening now) but never for Australia (months out), so
  Singapore was the first trip that ever actually exercised the buggy
  path. Fixed by moving all four declarations (`routeCache`,
  `HOME_CURRENCY`/`fxRateCache`, `weatherCache`/`WMO`,
  `leafletMap`/`markerLayer`) to before the offline-cache render call,
  right after `writeValue()`'s definition — with inline comments
  explaining *why* they're up there instead of near their point of use,
  specifically so a future session doesn't "clean this up" by moving one
  back down next to the function that uses it. **Lesson for future
  sessions:** any new top-level `const`/`let` needs to be checked against
  what the offline-cache render (which runs synchronously, early, on
  every page load) can reach — if in doubt, declare it early, right after
  `writeValue()`, rather than next to its point of use.
- **Coordinates "reset to auto" button.** Once `coordsManual` is set true
  on an itinerary day (see Data model), a small "↺ reset to auto" button
  appears next to "± coordinates" (reuses the `.coords-toggle` CSS class,
  no new styling needed). Clicking it writes `coordsManual: false` and
  immediately re-runs `geocodeLocation()` against the card's current
  location text, updating lat/lon (and the Waze link) right away rather
  than just flipping the flag and leaving stale coordinates sitting there
  until the next location edit. Fixes the gap noted in Known limitations —
  previously the only way back to auto-geocoding was manually clearing/
  re-typing lat/lon, which itself re-set `coordsManual` back to true.
- **Offline write queue.** Previously "no offline write queueing" was a
  known limitation — the Firebase RTDB client does hold writes in memory
  and send them once reconnected, but only for the life of the current
  page load; closing the tab/app while offline (a real scenario on an
  actual drive with spotty signal) lost anything still pending. Every
  write now goes through `dbSet()`/`writeValue()` in `app.js`, which checks
  `isOnline` (tracked via Firebase's own `.info/connected` ref, not
  `navigator.onLine` — the latter can read `true` on a dead/captive-portal
  connection) and either sends immediately or appends to a
  localStorage-persisted queue (`trip-queue-{tripId}`) keyed by Firebase
  path, replacing any earlier queued write to the same path so re-editing
  a field repeatedly offline doesn't grow the queue unboundedly. The queue
  flushes automatically the moment `.info/connected` flips true. If the
  page reloads while still offline, `applyQueuedPatches()` overlays the
  pending writes onto the cached snapshot before the offline-first render,
  so you see your own unsent edits instead of stale pre-edit data. The
  offline banner text now reports how many edits are waiting, and the old
  6-second-timeout heuristic for showing/hiding that banner was replaced
  by the same `.info/connected` listener — a strictly more accurate signal
  than a fixed timer.
- **"Someone else just edited this" toast.** A small pill (`#updateToast`,
  injected by `app.js`, top-center, fades after ~3.5s) appears when a
  remote sync brings in a change made by someone other than you (compared
  by the "editing as" name — see "Last edited by" above), skipping your
  own writes syncing back to you and skipping the very first sync on page
  load. This is trip-wide, not truly per-field — a genuine per-field audit
  trail would need a data-model change (each field would need its own
  `lastEditedBy`/`lastEditedAt`, not just one pair on `meta`), which felt
  like more complexity than this warranted. It reuses the same
  `meta/lastEditedBy`/`meta/lastEditedAt` stamps every write already makes.
- **Help tab.** A new "Help" tab (last in the tab bar) with plain-language,
  non-technical write-ups of every feature on the page — aimed at someone
  who isn't comfortable with apps generally (e.g. Gwen), not at a
  developer. Deliberately avoids implementation language (no API/library
  names) and is written as short "what you'll see / what to tap" blurbs,
  grouped by tab. It's static content — no Firebase data, nothing to
  sync, identical across every trip file — so it needed zero JS changes:
  the tab-switching code (`document.querySelectorAll('.tab')...`) is
  already generic, keyed off `data-panel` matching a panel's `id`, so
  adding one more `<button data-panel="help">`/`<div id="help">` pair was
  purely HTML/CSS. Excluded from the printed view (`#help` added to the
  `@media print` hide-list) since "tap here" instructions make no sense
  on paper — unlike every other panel, which prints deliberately (the
  print CSS forces all panels to `display: block` at once so a paper
  copy shows everything at once).
- **Budget currency dropdown — closed list, plus a free-text fallback
  (fixed).** The "Figures entered in" dropdown (see Currency conversion
  above) is still a fixed `<select>` of 14 hardcoded currencies (SGD, AUD,
  USD, EUR, GBP, JPY, MYR, THB, IDR, PHP, NZD, CNY, KRW, HKD, INR), but now
  has an "Other…" option at the bottom. Picking it reveals a small 3-letter
  text input (`ensureCurrencyOtherInput()` in `app.js`, injected next to
  the `<select>` rather than hand-added to all three HTML files — see
  "Why the engine used to be duplicated" above) that writes whatever code
  you type straight to `budgetCurrency`. `renderBudget()` now checks
  `FIXED_CURRENCIES.includes(budgetCurrency)` to decide whether to show the
  dropdown's matching option or flip to "Other…" with the input populated —
  this also fixes the old "shows blank/unselected" case for any
  out-of-list value already sitting in Firebase. The FX conversion line
  degrades the same way as before: `fetchFxRate()` treats "no rate
  returned" as `null`, so a code Frankfurter doesn't recognize (plausible
  for something like VND/LAK/KHR) just means no conversion line, not an
  error — budget totals themselves are unaffected either way since they're
  plain numbers with no currency validation.
- **Landing page (repo-root `index.html`).** The site root used to serve
  the blank engine template — nothing pointed you at either real trip, you
  had to already know or dig up each trip's URL. Now it's a small static
  page (no Firebase, doesn't import `app.js`) that fetches `trips.json`
  and renders one card per trip, linking to `./<slug>/`. `trips.json` is a
  maintained manifest (`[{slug, title, subtitle}, ...]`), not a live
  folder listing, because GitHub Pages is plain static hosting with no
  directory-listing API — there's no way to ask "what folders exist" at
  runtime. `scripts/new-trip.mjs` appends to it automatically when
  scaffolding a new trip (see "To start a new real trip"), so this stays
  current without a separate manual step. Reuses the established palette/
  type tokens (navy/brass/teal, IBM Plex + Fraunces) but not the ~800-line
  component CSS from the engine template — that's all itinerary/checklist/
  budget UI this page doesn't have. Duplicates the 3-line service-worker
  registration `app.js` does (rather than importing `app.js` itself, which
  would pull in Firebase this page has no use for) so a visitor whose
  first-ever visit is the landing page still gets offline/PWA coverage.
  This meant the engine template could no longer live at the site root
  (GitHub Pages always serves a directory's own `index.html`) — it moved
  to `template/index.html`; see History #17 and the folder diagram above.

## Known limitations (already communicated to the user — don't "fix" silently)

- No auth; anyone with a trip's URL can read/write it.
- If two people edit the *exact same field* at the *exact same moment*,
  last write wins — no conflict resolution. Fine for two people, not built
  for more.
- Each render function bails out early if the user currently has focus
  inside that section (`focusedInside()` guard), so a remote edit elsewhere
  won't yank your cursor mid-type. It also means you won't *see* a remote
  update to a section you're actively editing until you click away.
  **Fixed this round:** `focusedInside()` originally treated ANY focused
  element inside the section as "editing," including buttons — so tapping
  "Remove" or a ▲/▼ reorder button left focus sitting on that button, and
  the re-render triggered by the button's own write was silently skipped.
  The write itself succeeded (Firebase had the new data), but nothing
  visibly moved until a full page reload — indistinguishable from "the
  button doesn't work." Now `focusedInside()` only counts text inputs,
  textareas, and contenteditable elements as "editing"; a focused button
  no longer blocks the render it just caused.
- Weather only works within ~16 days of the date, and only for days with
  lat/lon filled in.
- The offline write queue (see Feature notes) is localStorage-based, not a
  server-side queue — it survives a closed tab/app on the *same device*,
  but two people editing conflicting fields while both offline still
  resolves as last-write-wins once both reconnect, same as the online case.

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

10. This round: fixed the `focusedInside()` guard treating a focused button
    (right after tapping Remove or ▲/▼) as "actively editing" — see the
    correction under Known limitations. Found via live testing on the new
    Singapore trip: reordering wrote the correct data but didn't visibly
    move anything without a full reload. Applied to all three deployed
    files (engine, Australia, Singapore) — this one couldn't wait for the
    next "propagate to trip files" pass since it broke a feature on a trip
    already in someone's hands.
11. Added per-person packing lists (`packingLongfen`/`packingGwen` tiers
    under Checklists — see Feature notes). Propagated to all three files
    (engine, Australia, Singapore) with real starter items for the two
    live trips, not placeholders.
12. This round: the user kept hitting "sometimes the coords update,
    sometimes they don't" after round 7's geocode fix. Root cause turned
    out to be one level deeper than round 7 fixed — round 7 fixed *when*
    geocoding fires, but never verified the geocoding API itself actually
    worked for real-world queries. It didn't: Open-Meteo's geocoder is a
    city gazetteer, not a landmark/address geocoder, confirmed by testing
    it directly against this repo's own seed data (see "Geocoder swapped"
    under Feature notes). Swapped to Nominatim (OSM) and added a sequence
    guard against out-of-order lookup responses. **Lesson for future
    sessions:** when picking a free/keyless API for something specific
    (landmark lookup, not weather), test it against real example queries
    before building on it — don't assume a "geocoding" endpoint does
    general-purpose geocoding just because of its name.
13. Added `commitOnEnter()`/`flashSaved()` (see Feature notes) — Enter now
    commits a contenteditable field instead of inserting a line break, and
    a brief teal flash confirms any field's value was actually written.
    Applied everywhere fields are committed: `commitOnBlur()`, the
    itinerary location field, and the header title/subtitle/days fields.
14. User confirmed the dashboard "working perfectly" and asked for more
    features; agreed to drive time between stops, a trip countdown, a QR
    code/share link, and currency conversion in the budget — explicitly
    *not* expense splitting. All four built (see Feature notes). While
    building them, found and fixed a real, previously-undiscovered
    Temporal Dead Zone bug affecting `weatherCache`/`WMO` and
    `leafletMap`/`markerLayer` (pre-existing, not introduced this round)
    as well as risk in the two new features' own module-level state — see
    the TDZ writeup under Feature notes for the full mechanism and the
    lesson for future sessions. Propagated to all three files (engine,
    Australia, Singapore) by regenerating each trip file from the
    updated engine template (splicing back in just that trip's `<title>`
    and `TRIP_ID`/`TRIP_LABEL`/`TRIP_SEED` block) rather than manually
    repeating ~15 discrete edits twice more — verified byte-for-byte
    parity between engine and both trip files outside that spliced block,
    and `node --check` syntax validity on all three.
15. User asked what happens if their actual currency isn't in the Budget
    tab's dropdown, and asked for a Help tab explaining every feature in
    plain language for someone not tech-savvy (Gwen). Answered the
    currency question and documented it as a known limitation (see Known
    limitations / Feature notes) rather than silently patching it, since
    fixing it means a product decision (expand the fixed list vs. add
    free-text entry) not yet made. Built the Help tab (see Feature
    notes) — static, non-technical, no JS logic beyond the tab-switching
    code already in place. Propagated to all three files the same
    splice-from-engine way as round 14.
16. User asked for suggestions/QoL improvements, then asked to implement
    all of them (except expense splitting and auth, both previously
    rejected by design). Extracted the shared engine into `app.js` (see
    "Why the engine used to be duplicated per trip" above) — the biggest
    structural change to this project since round 5's per-trip-folder
    switch — and built the offline write queue, the coords "reset to
    auto" button, the budget currency free-text fallback, and the
    "someone else just edited this" toast on top of it (see Feature
    notes for each). Also wrote `scripts/new-trip.mjs` to scaffold a new
    trip from a seed JSON file instead of five manual steps. Verification
    this round was unusually thorough given the size of the change:
    `node --check` on `app.js` and on the extracted module script in all
    three HTML files; a diff-based cross-check confirming every itinerary
    coordinate and budget figure survived the rewrite byte-for-byte; a
    dry run of `new-trip.mjs` against a throwaway trip folder (checked
    then deleted); and a full DOM-id cross-reference between every
    `getElementById()` call in `app.js` and what's actually in the static
    HTML. **Not verified in an actual browser** — Claude in Chrome wasn't
    connected this session, so nothing here has been exercised against
    real Firebase sync, the offline queue's actual online/offline
    transition, or the new toast/reset-coords/currency-other UI by hand.
    Do that before trusting this fully; see "Still open" below.
17. User picked "all-trips landing page" off a list of further ideas,
    flagging that not having one URL that lists both trips had been
    bugging them. Repurposed the site root into a landing page (see
    Feature notes "Landing page"), which meant relocating the engine
    template out of the root `index.html` slot (GitHub Pages always
    serves a directory's own `index.html`) to `template/index.html`, and
    updating `scripts/new-trip.mjs` to read from there. Also added
    `trips.json` (a maintained manifest the landing page fetches, since
    static hosting can't list folders) and had `new-trip.mjs` append to it
    automatically, and added `.nojekyll` to make GitHub Pages' (previously
    silent, inert) Jekyll processing explicitly off rather than relying on
    undocumented Jekyll folder-naming conventions to hide `template/` from
    publish. Verified the same way as round 16 — `node --check` on the new/
    changed scripts, a dry run of `new-trip.mjs` confirming it reads
    `template/index.html` and correctly appends to `trips.json` (throwaway
    trip folder + `trips.json` entry both reverted after), a local static
    server + `curl` confirming the landing page/`trips.json`/`template/`
    all serve correctly, and a DOM-id cross-reference for the landing
    page's own script. **Not verified in an actual browser**, same caveat
    as round 16 — Claude in Chrome still wasn't connected this session.

## Trips so far

- `australia-dec-2026/` — draft, not booked/verified (see History #4).
- `singapore-aug-2026/` — live test trip, not a real planned trip (History
  #9). Fine to delete/repurpose once it's served its testing purpose.

## Still open / natural next steps

- **Live-browser verification of rounds 16 and 17's changes** (see History
  #16, #17) — open the site root and confirm the landing page renders both
  trip cards and links work, then open `singapore-aug-2026/` (the live
  test trip) and confirm: the page loads with no console errors, Firebase
  sync still works, weather/map/drive-time still render, the new "reset to
  auto" coords button and "Other…" currency input behave, and — hardest to
  fake headlessly — the offline write queue actually queues a write while
  devtools is set to offline, then sends it once back online. Both rounds'
  verification was thorough on the static/syntactic side but nothing was
  exercised in a real browser against real Firebase.
- Real verification pass before the Australia trip is actually real:
  confirm opening hours/closures for each stop via web search close to the
  trip date (per the standing project instruction), fill in actual
  hotel/car-rental bookings and confirmation numbers, replace all `[TBD]`
  placeholders.
- No UI yet to un-share / revoke a share link — the QR/share panel just
  surfaces the existing (unauthed) URL, it doesn't add any new access
  control. Consistent with the existing "anyone with the link" trust
  model (see Known limitations), just making the link easier to hand
  someone.
- Australia itinerary has a real content gap: dated stops exist for
  Dec 8–13, then nothing at all until a single Dec 21 departure entry —
  Dec 14–20 (7 days) has no itinerary data. Needs either real stops added
  or the trip's actual plan for that stretch confirmed with the user.
- The Australia week-4 checklist includes "Apply for Australia ETA /
  eVisitor visa" — written as a plausible starter item, not verified
  against current Australian visa requirements for a Singapore passport.
  Confirm the correct visa product via a real search before the user
  relies on it (visa rules/names do change).
