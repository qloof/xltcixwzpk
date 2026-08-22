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
  flights/{pushKey}/
    date, flightNo, route, depart, arrive, confirmation, notes
    date is the sort key (ISO, same reasoning as itinerary's date — see
    "Bookings tab" in Feature notes).
  accommodations/{pushKey}/
    name, checkIn, checkOut, confirmation, notes
    checkIn is the sort key.
  carRental/{pushKey}/
    company, pickupDate, pickupLocation, dropoffDate, dropoffLocation,
    confirmation, notes
    pickupDate is the sort key.
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
├── trips.json                     [{slug, title, subtitle, startDate,
│                                   endDate}, ...] — kept up to date
│                                   automatically by scripts/new-trip.mjs
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
  maintained manifest (`[{slug, title, subtitle, startDate, endDate}, ...]`),
  not a live folder listing, because GitHub Pages is plain static hosting
  with no directory-listing API — there's no way to ask "what folders
  exist" at runtime. `scripts/new-trip.mjs` appends to it automatically
  when scaffolding a new trip (see "To start a new real trip"), computing
  `startDate`/`endDate` from the seed's own `itineraryDays` (min/max date,
  same approach `updateTripStatus()` in `app.js` uses for the "T-minus N
  days" badge) — so this stays current without a separate manual step.
  Reuses the established palette/type tokens (navy/brass/teal, IBM Plex +
  Fraunces) but not the ~800-line component CSS from the engine template —
  that's all itinerary/checklist/budget UI this page doesn't have.
  Duplicates the 3-line service-worker registration `app.js` does (rather
  than importing `app.js` itself, which would pull in Firebase this page
  has no use for) so a visitor whose first-ever visit is the landing page
  still gets offline/PWA coverage. This meant the engine template could no
  longer live at the site root (GitHub Pages always serves a directory's
  own `index.html`) — it moved to `template/index.html`; see History #17
  and the folder diagram above.
  **Current/Past grouping (added right after):** trips are split into
  "Current Trips" (anything not yet ended — covers both upcoming and
  in-progress under one heading, since there's usually at most one
  in-progress trip and a separate "Upcoming" section felt like overkill
  for two trips a year) and "Past Trips" (only rendered once there's at
  least one), sorted soonest-first and most-recent-first respectively.
  Grouping is computed from each trip's `startDate`/`endDate` — originally
  read straight from `trips.json`, which went stale the moment a trip's
  actual dates were edited inside the app without anyone remembering to
  update `trips.json` to match (fixed, see History #21: the page now
  fetches each trip's live itinerary via Firebase's plain REST API —
  `fetch` only, no SDK/import of `app.js` — and computes the range the
  same way `updateTripStatus()` does in `app.js`; `trips.json`'s copy
  survives only as a fallback for when that fetch fails or a trip has no
  dated itinerary rows yet). A trip with no date range either way (e.g. a
  freshly-scaffolded blank trip whose seed has no dated itinerary days
  yet — confirmed via a real dry run of `new-trip.mjs` against its own
  example seed) falls into Current Trips rather than being silently
  dropped from the list.
  **Expand/collapse (added right after):** each section is a native
  `<details>`/`<summary>` rather than a plain `<div>` — free expand/
  collapse with no JS click-handler/state to maintain, and it works even
  if JS partially fails. `.section-label`'s default `::marker` triangle is
  hidden and replaced with a `::before` chevron that rotates on `[open]`,
  styled to match the mono/uppercase/brass look already used for section
  dividers elsewhere (e.g. the Help tab's `.help-group-title`). Current
  Trips defaults open (`sectionEl(..., true)`), Past Trips defaults closed
  (`sectionEl(..., false)`) — the point of Past Trips is to get out of the
  way once there are several.

- **Bookings tab (Flights / Accommodations / Car Rental).** One tab, three
  subsections in it (`.panel section + section` gives each its own spacing) —
  not three separate top-level tabs. Considered and rejected: three new tabs,
  same reasoning already used to reject a new top-level tab for packing
  lists (see "Two packing lists" above) — the tab bar is already 7 items wide
  on a phone screen, and going to 10 fights that constraint directly. Instead
  this follows the Checklists precedent: multiple sub-groups inside one tab.
  Each record type (`renderFlights()`/`renderAccommodations()`/
  `renderCarRental()` in `app.js`) is built from the same card/field-label
  building blocks as Contacts/Extras, but **sorts by its own primary date
  field** (flight `date`, accommodation `checkIn`, car rental `pickupDate`)
  rather than creation order — the point of this tab is quick lookup while
  actually traveling ("what's my next confirmation number"), so chronological
  order matters here in a way it doesn't for Contacts/Extras. Date fields are
  real `<input type="date">` elements reusing `.day-date-input` (the same
  class/pattern `renderItinerary()`'s own date input uses), not
  contenteditable text — same reason itinerary's `date` field had to move off
  free text (see Data model): sorting needs a real ISO value. Icons in each
  subsection heading (✈/🏨/🚗) reuse the existing convention of a plain emoji
  prefix already established by drive-time's 🚗 line, not a new icon system.
  Kept deliberately separate from the itinerary's existing free-text
  `lodging` field — itinerary stays the at-a-glance day-by-day plan, Bookings
  is the reference/confirmation-number layer, same separation Contacts
  already has from itinerary. A Help tab entry was added alongside the other
  tabs' entries, same non-technical style as the rest of Help.
  **Weekday + document link (added right after).** Each record's primary
  date field also shows the weekday name above the date input (`.date-weekday`,
  the same class/pattern `renderItinerary()`'s stacked weekday/numeric date
  display uses), and every record has a `pdfUrl` text field plus a "📄 View
  PDF →" link (`wirePdfLink()`, reusing `.nav-link` — the same class the
  Waze link uses) that only shows once that field has a value. `pdfUrl` is
  just a plain URL a human pastes in — for `kyushu-dec-2026` these point at
  real files checked into `kyushu-dec-2026/docs/` in this repo (e-tickets,
  Agoda confirmations), copied over from the planning folder outside the
  dashboard repo, so GitHub Pages serves them as ordinary static files with
  no extra hosting setup. Nothing stops a future trip's pdfUrl from
  pointing at an external link (Google Drive, etc.) instead.
  **Waze link on Accommodations (added right after).** Reuses itinerary's
  exact auto-geocode-on-blur pattern (`geocodeLocation()`, the
  `coordsManual` flag, the `± coordinates` toggle, the `↺ reset to auto`
  button, the `geocodeSeq` out-of-order-response guard — see "Location →
  coordinates" above) against the accommodation's `name` field instead of a
  separate location field, since the name (e.g. "Ryokan Sanga (Kurokawa
  Onsen, Minamioguni, Kumamoto)") already serves as this record's "the
  place." Not added to Flights or Car Rental — a flight has no single point
  to navigate to, and no one's asked for one on a car rental. New fields:
  `accommodations/{pushKey}/lat`, `lon`, `coordsManual` (same meaning as the
  itinerary fields of the same name). For `kyushu-dec-2026`, Ryokan Sanga
  geocodes cleanly via Nominatim; Ryokojin Sanso doesn't (no OSM entry for
  the property), so its pin is manually set to the nearest resolvable
  landmark (Kirishima Jingū Station) with `coordsManual: true` and a note
  on the card flagging it as approximate.
  **Google Maps link (added History #25).** A second nav-app link next to
  Waze on both Itinerary and Accommodations cards, `"Navigate in Google
  Maps →"`, using Google's documented stable URL scheme
  (`https://www.google.com/maps/dir/?api=1&destination={lat},{lon}`) —
  opens the native app on mobile if installed, falls back to the web app
  otherwise. No new data fields: it's derived from the same `lat`/`lon`
  already tracked for Waze, so the per-card `updateWazeLink()` closure in
  both `renderItinerary()` and `renderAccommodations()` was renamed to
  `updateNavLinks()` and extended to set both links' `href`/visibility
  together, rather than adding a second, separately-triggered function.
  Same scope decision as Waze: not added to Car Rental, since pickup/
  dropoff are plain text with no geocoding infrastructure at all — adding
  a Maps link there would mean building that from scratch first, not
  reusing anything that exists.

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
18. Immediately after round 17, user asked whether the user could start a
    new trip right from the landing page. Explained the tradeoffs (would
    need a GitHub Pages 404-catch-all routing trick and moving the trip
    list from git-committed `trips.json` to a Firebase-backed index, plus
    it'd cost per-trip file portability and per-trip PWA identity) and
    recommended against it given trips get added only a couple times a
    year — user agreed, will keep asking for `new-trip.mjs` to be run
    manually. No code changed for this part.
    Then asked for "Past Trips"/"Current Trips" categories on the landing
    page (see Feature notes "Landing page" — "Current/Past grouping").
    Added `startDate`/`endDate` to `trips.json` for both existing trips and
    to what `scripts/new-trip.mjs` computes/appends going forward, and
    grouped the landing page's cards accordingly, client-side, from those
    fields — deliberately not by fetching live Firebase data per trip,
    which would reintroduce the Firebase dependency the landing page was
    built without. Verified with a Node-side simulation of the exact
    grouping/sort logic against real data plus synthetic past/no-date
    cases (see the logic in `index.html`'s inline script), plus the same
    `node --check`/dry-run/local-server/DOM-id checks as round 17.
    Then asked for the two sections to be individually expandable/
    collapsible — switched each section from a plain `<div>` to a native
    `<details>`/`<summary>` (see Feature notes "Expand/collapse"), Current
    Trips open by default, Past Trips closed. Same verification technique
    as the rest of this round. **Not verified in an actual browser**, same
    caveat as rounds 16-17.
19. User asked how to remove `singapore-aug-2026/` (the live test trip,
    now that it had served its testing purpose across several rounds).
    Explained it's three separate pieces — the repo files, the `trips.json`
    entry, and the live Firebase data at `/trips/singapore-aug-2026`
    (deleting the repo files alone leaves the Firebase record orphaned,
    since it's not stored in git) — and confirmed before touching
    anything. Deleted all three: confirmed real (edited-since-seed) data
    existed at that Firebase path via a REST GET, deleted it via REST
    DELETE (DB rules already allow this — see "Database rules"), verified
    the path now returns `null`; `git rm -r singapore-aug-2026`; removed
    its entry from `trips.json`. Updated "Trips so far" and the
    live-browser-verification item under "Still open" (which used to
    specifically reference this trip for weather/countdown checks, since
    it was the only trip with near-term dates).
20. A different Claude session reviewed rounds 16-19 (the `app.js`
    extraction, landing page, and Singapore cleanup) after the fact and
    found that `sw.js` had never been updated for the `app.js`
    extraction — its network-first check only matched `.html`, `/`, and
    `manifest.json`, so same-origin `.js` requests (i.e. `app.js` itself,
    now where 100% of the dashboard's logic lives) fell through to the
    cache-first branch below. That's the same bug History #8 already
    fixed once for `index.html`, recurring one layer down: a deployed fix
    to `app.js` could silently fail to show up on a returning visitor's
    phone until a second load. Fixed by adding `.js` to the network-first
    match and bumping the cache name to `trip-dashboard-shell-v3` so any
    already-stale cached `app.js` gets purged on activate rather than
    waiting to be incidentally refetched. **Lesson:** when a shared
    module gets extracted out of what used to be inline/duplicated code
    (see History #16), re-check every piece of infrastructure that
    reasons about file types or paths — not just the code that imports
    it — since `sw.js`'s cache rules had no reason to be touched by the
    extraction itself and so silently went stale.
21. Same session, immediately after: flagged that the landing page's
    Current/Past grouping read only `trips.json`'s static `startDate`/
    `endDate`, which meant a trip whose actual dates were edited inside
    the app (adding/changing itinerary rows) wouldn't re-bucket on the
    landing page until someone remembered to hand-update `trips.json` to
    match — a real, if minor, staleness gap. Discussed three options
    (fetch live Firebase data per trip via plain REST; have `app.js` write
    a computed date-range field back to Firebase for a lighter per-trip
    fetch; leave it as a documented manual step) and went with the first —
    smallest change, no new write-side logic, reuses the exact min/max-of-
    dated-days logic `updateTripStatus()` already uses in `app.js`. The
    landing page now fetches each trip's `itinerary.json` via Firebase's
    plain REST API (no SDK import — deliberately doesn't pull in
    `app.js`/Firebase the way it always has, see Feature notes "Landing
    page") and computes the range client-side; `trips.json`'s copy is now
    only a fallback for when that fetch fails or a trip has no dated rows
    yet. Verified the computed value against real Firebase data for the
    Australia trip via REST (matched `trips.json` exactly, since nothing's
    actually changed yet — this confirms no regression today, not that
    the live-tracking behavior has been exercised against an actual edit)
    and `node --check` on the extracted script. **Not verified in an
    actual browser** — Claude in Chrome wasn't connected this session
    either, so real-browser CORS behavior against the Firebase REST
    endpoint (publicly documented as CORS-enabled for reads, but not
    exercised here) is unconfirmed — folded into the existing
    live-browser-verification item under "Still open."
22. Same session: got Claude in Chrome actually connected (it needed a
    toggle enabled under the Claude desktop app's own "Claude in Chrome"
    settings page — distinct from both the Chrome extension's own
    permissions/options pages and Chrome's native per-extension "Site
    access" setting, all three of which were already fine; the desktop
    app's Connectors list also showed it as connected, which turned out
    to be a red herring — that entry apparently just reflects whether the
    connector exists, not whether it's enabled). With it connected, ran
    the first actual real-browser verification this project has had since
    the `app.js` extraction:
    - Landing page loads, shows `australia-dec-2026` under "Current
      Trips" with the correct title/subtitle/link.
    - The new live-itinerary REST fetch (History #21) genuinely works:
      confirmed via the browser's own network log, `GET
      .../trips/australia-dec-2026/itinerary.json` → `200`, no CORS
      error, console clean.
    - Opened the trip page itself: "Synced" status showing, the trip
      countdown badge correctly computing "T-minus 109 days," drive time
      rendering real OSRM data between Sydney and the Bondi stop, weather
      correctly showing its "not within 2 weeks yet" message (expected,
      not a bug, given the trip is months out), and the Help tab present
      in the tab bar. Console showed one benign Firebase SDK internal log
      ("heartbeats") and nothing else.
    - Budget tab: currency dropdown correctly shows the AUD value set via
      REST earlier this project, and the FX conversion line renders a
      real live Frankfurter rate ("≈ SGD 5243 budgeted / 0 actual, at
      today's rate (1 AUD = 0.9040 SGD)"), with the total itself computed
      correctly (5800).
    This is the first time since the `app.js` extraction (History #16)
    that any of this has been confirmed outside static checks. Narrowed
    "Still open"'s live-browser-verification item down to what's
    genuinely still unexercised (see that entry) rather than leaving the
    broad "nothing verified in a browser" framing standing now that most
    of it has been.

23. User asked for a "Bookings" tab (Flights / Accommodations / Car Rental)
    to surface real booking confirmations that had, until now, only lived in
    planning `.md` files (`kyushu-dec-2026/*.md`, outside the dashboard
    repo), and asked for a real IA pass rather than a bolted-on add.
    Confirmed with the user up front: one tab not three (tab-bar-width
    constraint, see Feature notes), built into the shared engine (not
    Kyushu-only), and to scaffold `kyushu-dec-2026/` as a real trip in the
    same round, seeded with the actual flight/ryokan/rental-car data from
    `booking-confirmations.md`. Built the tab (see Feature notes "Bookings
    tab" for the full design rationale), propagated it to `app.js`,
    `template/index.html`, and `australia-dec-2026/index.html` (engine
    plumbing only — Australia's own trip content untouched; per the Kyushu
    itinerary doc, Australia is now stale/dropped and left alone). Also
    added `flights`/`accommodations`/`carRental` to `GENERIC_SEED` and the
    first-load seeding block, so a brand-new trip picks the feature up too.
    Scaffolded `kyushu-dec-2026/` via `scripts/new-trip.mjs` from a seed
    JSON built from the two Kyushu planning docs — real flight legs (Thai
    Airways PNR FWTURC), both ryokan bookings, the pending Hi-Hi Car Rental
    lead (marked `[TBD]`, not yet confirmed), and real itinerary/checklist/
    budget/contacts data, including the "cancel duplicate Hankasou Seseragi
    booking before 11 Dec 2026" action item as an Extras card. Itinerary
    lat/lon are city-level approximations (Fukuoka, Nagasaki, Kumamoto,
    Takachiho, Kurokawa Onsen, Kirishima, Kagoshima), not geocoded against
    specific addresses — flagged as a known gap, same treatment as
    Australia's unverified draft content.
    Verification: `node --check` on `app.js` and the extracted module script
    in `template/`, `australia-dec-2026/`, and `kyushu-dec-2026/`; a DOM-id
    cross-reference confirming every new `getElementById()` call in `app.js`
    has a matching element in all three HTML files; a byte-for-byte JSON
    diff confirming the `tripSeed` baked into `kyushu-dec-2026/index.html`
    matches the source seed file exactly; a local static-server smoke check
    of the landing page, both trip pages, `app.js`, and `trips.json`.
    **Not verified in an actual browser** — same caveat as prior rounds;
    real Firebase sync (first-load seeding, the Bookings tab's add/sort/
    remove behavior) is unexercised until someone opens the live URL.

24. User worked through choosing a Fukuoka Dec 18–19 hotel in conversation
    (long shortlist, several ruled out — including catching that Richmond
    Hotel Fukuoka Tenjin is fully closed for renovation through the whole
    stay), landed on **Hotel Monte Hermana Fukuoka** (Agoda booking ID
    2043617518), then asked to add it plus Day 1's places of interest to
    the live dashboard. Wrote directly to the live Firebase data via REST
    PATCH (not just re-seeding, since `kyushu-dec-2026` had already been
    opened once — re-seeding only fires on first load, see Data model) —
    added the hotel as a new Accommodations card with real geocoded
    coordinates (Nominatim), added it to Contacts, and split the single
    Dec 18 itinerary day into **4 same-date stops** (arrival/hotel
    logistics, lunch at Taiho Ramen, Ohori Park/Fukuoka Castle,
    Watanabe-dori Yatai dinner) using the existing `order` field — the
    first real exercise of the "multiple stops sharing one date" feature
    (History/Feature notes, "Manual reordering") for actual trip content
    rather than a hypothetical. Each stop has real coordinates geocoded
    via direct Nominatim queries (not through the app's own UI-driven
    geocode-on-blur, since this was a REST write). Copied the hotel's
    Agoda confirmation PDF into `kyushu-dec-2026/docs/`, committed, and
    pushed (the user had to add a permission rule before `git push` was
    allowed to run non-interactively — see "Environment note" below).
    Also marked the already-cancelled Hankasou Seseragi duplicate booking
    done in both the `w4` checklist and the Extras card (it had been sitting
    checked=false / undated despite being resolved), and bumped the Budget
    tab's lodging "actual" figure to include an estimated SGD conversion of
    the hotel's JPY 16,468 charge (not a verified FX rate — flagged as such
    to the user).
    **Then**, user reported the Bookings tab's Flights cards only ever
    linked one e-ticket PDF (Longfen's) — real gap, since Gwen's e-ticket
    existed in `docs/` but nothing on the page could reach it. Root cause:
    the Flights card template only ever had one `pdfUrl` field/link. Fixed
    by generalizing `wirePdfLink(card, value)` to `wirePdfLink(card, value,
    selector)` and adding a second field/link (`pdfUrl2`, "📄 View PDF
    (co-traveler) →") to the Flights card only — not Accommodations or Car
    Rental, since those don't have the same two-named-traveler-per-record
    shape flights do. Backfilled `pdfUrl2` on all 4 Kyushu flight legs via
    REST PATCH. `node --check` passed; committed and pushed separately from
    the hotel/itinerary data change (that one was a pure Firebase data
    write, no code, so had nothing to push).
    **Then**, user asked for both e-ticket PDFs to be read for "gotchas."
    Found two genuinely new, actionable items not previously in the
    dashboard: (1) baggage allowance is asymmetric — 1 checked bag/pax
    outbound (fare class K) vs. 2 PCS/pax on the return (fare class Q);
    (2) THAI's smart-luggage rule — any battery-integrated checked bag
    needs its batteries pulled and carried in the cabin. Added the baggage
    note to the TG648/TG649 flight records' `notes` fields and a new
    `dayBefore` checklist item for the battery rule, all via REST PATCH.
    Cross-checked names/ticket numbers/PNR/fare total against what was
    already recorded — no discrepancies found.
    **Environment note**: `git push` was blocked by this session's
    auto-mode permission classifier on the first attempt (a hard block,
    not something asking again could clear) until the user added a
    permission rule; documented here in case a future session hits the
    same wall doing routine repo pushes for this project.
    Verification this round: `node --check` on `app.js`; every REST PATCH
    response body checked against the intended payload (Firebase REST
    echoes back exactly what was written); DOM markup for the new
    `pdfUrl2` field/link manually reviewed against the existing
    `pdfUrl`/`wirePdfLink` pattern for consistency. **Not verified in an
    actual browser this round** — same standing caveat as most of Kyushu's
    history (see "Still open").
25. User asked for a "Navigate in Google Maps" button next to the existing
    Waze one, on every place that already has a Waze link — confirmed via
    a quick scope check that this meant Itinerary + Accommodations only,
    matching Waze's existing footprint, not Car Rental (which has no
    geocoding infrastructure at all — see "Waze link on Accommodations" in
    Feature notes for why that was excluded originally). Pure additive UI:
    added a second `<a data-gmaps>` link next to `<a data-waze>` in both
    card templates, and renamed the per-card `updateWazeLink()` closure to
    `updateNavLinks()` in both `renderItinerary()` and
    `renderAccommodations()`, extending it to set both links' `href` from
    the same `lat`/`lon` inputs rather than adding a second function with
    its own call sites (see Feature notes "Google Maps link" for the URL
    scheme used). No data model change — nothing new stored, both links
    are pure UI derived from coordinates already tracked for Waze.
    Verification: `node --check` passed; manually reviewed the rendered
    template strings for both new elements. **Not verified in an actual
    browser this round** — same standing caveat as History #24.

## Trips so far

- `australia-dec-2026/` — draft, not booked/verified (see History #4).
  Per the Kyushu itinerary doc (2026-08-22), this trip is now dropped —
  leave it alone unless the user asks to clean it up.
- `kyushu-dec-2026/` — real, booked trip (flights + both ryokans + the
  Dec 18–19 Fukuoka hotel confirmed; rental car and the Dec 28 hotel
  pending — see Still open). Scaffolded History #23; Dec 18 fully
  worked out History #24.
- `singapore-aug-2026/` — deleted (see History #19). Was a deliberate live
  test trip (History #9), not a real planned trip; served its purpose
  across rounds 10-18 and was removed once no longer needed — repo files,
  `trips.json` entry, and the live Firebase data under
  `/trips/singapore-aug-2026` were all deleted. If this slug is ever
  reused, note the Firebase data starts fresh (nothing to migrate).

## Still open / natural next steps

- **Remaining live-browser verification** (see History #22 — most of this
  item is now done, this is what's left): the offline write queue
  actually queuing a write while devtools is set to offline and sending
  it once back online (hardest to fake headlessly, still untested); the
  coords "reset to auto" button (no itinerary day currently has
  `coordsManual: true` to exercise it against); the Budget currency
  dropdown's "Other…" free-text option specifically (AUD, a fixed-list
  value, was confirmed working, but the free-text fallback path wasn't
  opened); and actually editing the Australia trip's itinerary dates to
  confirm the landing page's Current/Past grouping re-buckets without a
  `trips.json` edit (History #21's fix was verified via a real network
  request succeeding, not by triggering an actual re-bucket).
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
- **Kyushu rental car — not yet booked.** Hi-Hi Car Rental's reply is still
  pending as of scaffolding (History #23); the Bookings tab's Car Rental
  card is seeded with `[TBD]` in the company field. Update it once
  confirmed — either by hand in the app (Bookings tab) or by re-running
  the relevant Firebase write.
- Kyushu itinerary lat/lon are approximate city-center coordinates for
  every day **except Dec 18**, which now has 4 real geocoded stops (see
  History #24) — not geocoded against actual hotel/ryokan addresses for
  the rest. Opening hours/closures and the IDP application are also still
  open (see the seeded Checklists tab).
- **Kyushu — Ryokojin Sanso's Waze pin is a stand-in, not the real address.**
  Nominatim has no OSM entry for the property itself, so its Accommodations
  card is pinned to the nearest resolvable landmark (Kirishima Jingū
  Station) with `coordsManual: true` and a note flagging it as approximate
  (see "Waze link on Accommodations" in Feature notes). Replace with the
  real address via the card's "± coordinates" toggle once available.
- **Kyushu — most `[TBD]` hotel nights still have no lat/lon.** Nagasaki
  (×2), Kumamoto, Takachiho, and Kagoshima itinerary days all have a real
  location name but no coordinates yet, since no specific hotel is booked
  — weather/map/drive-time for those days stay blank until a real stop
  (with coordinates) replaces the city-level placeholder. **Dec 18
  (Fukuoka) is now resolved** — see History #24. **Dec 28 is also still
  open**: the plan moved from a Fukuoka-city last night to Dazaifu/
  Chikushino (Futsukaichi Onsen) per the planning doc
  (`kyushu-dec-2026-itinerary.md`), but no specific accommodation has been
  chosen there yet, and the live dashboard's Dec 28 itinerary day still
  says the old "Fukuoka hotel [TBD], last yatai dinner" plan — that day's
  card needs updating to match the planning doc once a Futsukaichi
  property is picked.
- **Kyushu — not yet verified in an actual browser at all.** History #22's
  real-browser pass covered `australia-dec-2026/` and the landing page
  only; `kyushu-dec-2026/` (including the Bookings tab, the PDF links —
  now two per flight card, see History #24 — and the Ryokojin Sanso Waze
  pin) has only been checked via `node --check`, DOM-id cross-reference,
  and direct Firebase REST reads — never opened in a real browser/phone.
  Do that before trusting the sync/UI behavior fully, especially the new
  `pdfUrl2` co-traveler link and the 4-stops-on-one-date Dec 18 card
  (first real use of same-date multi-stop ordering with actual content).
- Passenger names on both Thai Airways e-tickets (QUEK LONG FEN MR / LEE WEI
  YI GWENDOLYN MISS) still need checking against passports exactly — flagged
  in the flight records' notes and the w2 checklist, not yet confirmed. Both
  e-tickets were read in full this session (History #24) and the names
  match what's already recorded in the dashboard, but that's not the same
  as checking them against the actual passports.
