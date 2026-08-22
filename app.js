// Shared "engine" for every trip page — see DEV_NOTES.md, "Why the engine
// is duplicated per trip" / "Extract shared engine into app.js". Every
// trip's index.html used to carry a full byte-for-byte copy of this logic,
// so every fix had to be hand-applied to every trip file (see DEV_NOTES
// History for how often that bit us). Now each trip's index.html is a thin
// shell — HTML/CSS plus its own TRIP_ID/TRIP_LABEL/TRIP_SEED — that imports
// initTripDashboard() from here. Per-trip folders and URLs are unchanged;
// only the JS (and, via injectStyles()/ensure*() below, a couple of small
// bits of markup/CSS added after this file was created) is de-duplicated.
//
// A new trip's index.html imports this as:
//   import { initTripDashboard } from '../app.js';   (or './app.js' at repo root)
//   initTripDashboard({ tripId: '...', tripLabel: '...', tripSeed: {...} });

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getDatabase, ref, onValue, set, push, child, get } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

// Not a secret — see DEV_NOTES.md "Database rules" for why GitHub's secret
// scanner flagging this is a false positive. Access control is the DB
// rules, not this key.
const firebaseConfig = {
  apiKey: "AIzaSyCwmKdxRXjhGZXWdXlKx4trc9c6_OkPD7U",
  authDomain: "trip-dashboard-c6f8a.firebaseapp.com",
  databaseURL: "https://trip-dashboard-c6f8a-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "trip-dashboard-c6f8a",
};
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Closed list backing the Budget tab's currency dropdown, plus an "Other…"
// escape hatch (see ensureCurrencyOtherInput()) for a currency that isn't
// on it (e.g. VND/LAK/KHR) — this list used to be a hard dead end.
const FIXED_CURRENCIES = ['SGD', 'AUD', 'USD', 'EUR', 'GBP', 'JPY', 'MYR', 'THB', 'IDR', 'PHP', 'NZD', 'CNY', 'KRW', 'HKD', 'INR'];

const GENERIC_SEED = {
  meta: { title: '[Trip Name]', subtitle: '[Destination(s)] · [Start date] – [End date]', days: '—' },
  itineraryDays: [
    { date: '', location: '[town / stop name]', lat: '', lon: '', plan: '[main activity, booking ref if any]', lodging: '[hotel / campsite, confirmation #]', alt: '' },
  ],
  checklists: {
    w4: ['[e.g. confirm time off work]', '[e.g. book primary lodging]'],
    w2: ['[e.g. arrange pet/house sitter]', '[e.g. verify opening hours for planned stops]'],
    packingLongfen: ['[e.g. passport / ID]', '[e.g. chargers + adapter]', '[e.g. weather-appropriate clothing]'],
    packingGwen: ['[e.g. passport / ID]', '[e.g. chargers + adapter]', '[e.g. weather-appropriate clothing]'],
    dayBefore: ['[e.g. charge devices]', '[e.g. re-check weather + closures]'],
    onRoad: ['[e.g. daily check-in with home]'],
  },
  contacts: [{ name: '[e.g. Roadside assistance]', ref: '[number]' }],
  budget: {
    lodging:    { label: 'Lodging',          budgeted: '', actual: '' },
    transport:  { label: 'Transport / fuel', budgeted: '', actual: '' },
    food:       { label: 'Food',             budgeted: '', actual: '' },
    activities: { label: 'Activities',       budgeted: '', actual: '' },
    misc:       { label: 'Misc / buffer',    budgeted: '', actual: '' },
  },
  extras: [{ item: '[what needs tracking]', notes: '[details]' }],
  flights: [{ date: '', flightNo: '[e.g. TG410]', route: '[e.g. SIN → BKK]', depart: '', arrive: '', confirmation: '[PNR / booking ref]', pdfUrl: '', notes: '' }],
  accommodations: [{ name: '[hotel / ryokan name]', checkIn: '', checkOut: '', confirmation: '[booking ref]', pdfUrl: '', lat: '', lon: '', notes: '' }],
  carRental: [{ company: '[rental company]', pickupDate: '', pickupLocation: '', dropoffDate: '', dropoffLocation: '', confirmation: '', pdfUrl: '', notes: '' }],
};

// Small bits of CSS/markup added after the three trip HTML files already
// existed (update toast, budget "Other…" currency input). Injected here at
// init time instead of hand-edited into every trip's <style>/<body> so this
// really is a one-file change — see the extraction note at the top of this
// file. The itinerary card's own new markup (the "reset to auto" coords
// button) needed no injection since that card is already built as an HTML
// string inside renderItinerary() below.
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .update-toast { position: fixed; top: 14px; left: 50%; transform: translateX(-50%) translateY(-8px);
      background: var(--ink); color: var(--paper); font-family: var(--font-mono); font-size: 12px;
      padding: 8px 16px; border-radius: 999px; opacity: 0; pointer-events: none;
      transition: opacity 0.3s ease, transform 0.3s ease; z-index: 999; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .update-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    @media print { .update-toast { display: none !important; } }
  `;
  document.head.appendChild(style);
}
function ensureUpdateToast() {
  let el = document.getElementById('updateToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'updateToast';
    el.className = 'update-toast';
    document.body.appendChild(el);
  }
  return el;
}
// Adds the "Other…" option + a small text input (hidden unless selected) to
// the Budget tab's currency dropdown, so a currency outside the fixed list
// (e.g. a Vietnam/Laos/Cambodia trip) can still be entered, instead of the
// dropdown just showing blank/unselected with no way to fix it (see
// DEV_NOTES "Budget currency dropdown — closed list, not free text").
function ensureCurrencyOtherInput() {
  const sel = document.getElementById('budgetCurrency');
  if (!sel.querySelector('option[value="OTHER"]')) {
    const opt = document.createElement('option');
    opt.value = 'OTHER';
    opt.textContent = 'Other…';
    sel.appendChild(opt);
  }
  let other = document.getElementById('budgetCurrencyOther');
  if (!other) {
    other = document.createElement('input');
    other.type = 'text';
    other.id = 'budgetCurrencyOther';
    other.className = 'currency-select';
    other.placeholder = 'e.g. VND';
    other.maxLength = 3;
    other.spellcheck = false;
    other.style.display = 'none';
    sel.insertAdjacentElement('afterend', other);
  }
  return other;
}

export function initTripDashboard({ tripId, tripLabel, tripSeed }) {
  injectStyles();
  ensureUpdateToast();
  const otherCurrencyInput = ensureCurrencyOtherInput();

  document.getElementById('tripCode').textContent = `TRIP · ${tripLabel}`;
  document.getElementById('footerNote').textContent = `Trip: ${tripId} — this link is dedicated to this trip; share it as-is.`;

  const tripRef = ref(db, `trips/${tripId}`);
  const CACHE_KEY = `trip-cache-${tripId}`;
  const SEED = tripSeed || GENERIC_SEED;

  // ---- editor name (local only, for the "last edited by" tag) ----
  const nameInput = document.getElementById('editorName');
  nameInput.value = localStorage.getItem('trip-editor-name') || '';
  nameInput.addEventListener('blur', () => localStorage.setItem('trip-editor-name', nameInput.value.trim()));
  function editorName() { return localStorage.getItem('trip-editor-name')?.trim() || 'Someone'; }

  // ---- offline write queue ----
  // The Firebase RTDB client already holds writes in memory and sends them
  // once reconnected *within the same page load* — but that queue is lost
  // if the tab/app gets closed or reloaded while still offline, which is
  // exactly the scenario this app is built for (spotty signal on an actual
  // drive). This persists pending writes to localStorage so they survive a
  // reload and still go out once back online. See DEV_NOTES "Known
  // limitations" — this replaces the old "no offline write queueing" gap.
  //
  // isOnline is tracked via Firebase's own `.info/connected` ref (set up
  // near the bottom of this function) rather than navigator.onLine, since
  // navigator.onLine can be true on a captive portal / dead connection —
  // `.info/connected` reflects whether the RTDB socket itself is actually
  // up. Declared here (not near its point of use) for the same
  // temporal-dead-zone reason as HOME_CURRENCY/routeCache/etc. below: the
  // offline-cache render further down can run synchronously, before the
  // rest of this function has executed, and needs writeQueue to exist.
  const QUEUE_KEY = `trip-queue-${tripId}`;
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  let writeQueue = loadQueue();
  let isOnline = false; // flips true on the first `.info/connected` event — see bottom of this function

  function updateQueueBadge() {
    const banner = document.getElementById('offlineBanner');
    if (isOnline) return;
    banner.textContent = writeQueue.length
      ? `Showing last synced copy — no connection right now. ${writeQueue.length} edit${writeQueue.length === 1 ? '' : 's'} saved locally, will send once you're back online.`
      : `Showing last synced copy — no connection right now. Edits will be saved locally and sent once you're back online.`;
  }
  // Replaces any earlier queued write to the same path so re-editing a
  // field repeatedly while offline doesn't grow the queue unboundedly —
  // only the latest value per path needs to survive to replay, matching
  // Firebase's own last-write-wins semantics.
  function queueWrite(path, value) {
    writeQueue = writeQueue.filter(w => w.path !== path);
    writeQueue.push({ path, value });
    saveQueue(writeQueue);
    updateQueueBadge();
  }
  function flushQueue() {
    if (!writeQueue.length) return;
    const toSend = writeQueue;
    writeQueue = [];
    saveQueue(writeQueue);
    updateQueueBadge();
    toSend.forEach(w => set(ref(db, w.path), w.value));
  }
  // Overlays queued-but-unsent writes onto the cached trip snapshot so a
  // page reload while still offline shows your own pending edits instead
  // of the last data that actually made it to Firebase.
  function applyQueuedPatches(data) {
    const prefix = `trips/${tripId}/`;
    writeQueue.forEach(w => {
      if (!w.path.startsWith(prefix)) return;
      const segments = w.path.slice(prefix.length).split('/');
      let obj = data;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (typeof obj[seg] !== 'object' || obj[seg] === null) obj[seg] = {};
        obj = obj[seg];
      }
      const lastSeg = segments[segments.length - 1];
      if (w.value === null) delete obj[lastSeg];
      else obj[lastSeg] = w.value;
    });
    return data;
  }
  // Every raw Firebase write (edits, removals, reorders, the checkbox
  // toggle, etc.) goes through this instead of calling set()/ref() directly,
  // so offline handling is in exactly one place.
  function dbSet(path, value) {
    if (isOnline) set(ref(db, path), value);
    else queueWrite(path, value);
  }
  // ---- central write helper: every field commit goes through here so we can
  // stamp who/when without threading it through every handler individually ----
  function writeValue(path, value) {
    dbSet(path, value);
    dbSet(`trips/${tripId}/meta/lastEditedBy`, editorName());
    dbSet(`trips/${tripId}/meta/lastEditedAt`, new Date().toISOString());
  }

  // ---- currency conversion (Frankfurter API — ECB reference rates, no key) ----
  // See the long comment that used to live here in the pre-extraction engine
  // file (DEV_NOTES.md still has the full history) — short version: this
  // lets a human say what currency the budget numbers ARE in and shows a
  // reference conversion back to home currency (SGD). Declared here (not
  // near renderBudget, where it's used) because the offline-cache render
  // further down can call renderAll() → renderBudget() synchronously before
  // this function has finished executing top to bottom; a `const`
  // referenced from code that runs before its own declaration line throws
  // (temporal dead zone) — this was a real, previously-undiscovered bug,
  // see DEV_NOTES "Temporal Dead Zone (TDZ) bug".
  const HOME_CURRENCY = 'SGD';
  const fxRateCache = {};
  async function fetchFxRate(fromCurrency) {
    if (fromCurrency === HOME_CURRENCY) return 1;
    if (fromCurrency in fxRateCache) return fxRateCache[fromCurrency];
    try {
      const url = `https://api.frankfurter.dev/v1/latest?base=${fromCurrency}&symbols=${HOME_CURRENCY}`;
      const res = await fetch(url);
      const json = await res.json();
      const rate = json?.rates?.[HOME_CURRENCY] ?? null;
      fxRateCache[fromCurrency] = rate;
      return rate;
    } catch (e) {
      return null;
    }
  }

  // ---- drive time to the next stop (OSRM public routing server, no key) ----
  // Same temporal-dead-zone reason as HOME_CURRENCY above for why this is
  // declared up here rather than near attachDriveTime()'s point of use.
  const routeCache = new Map();
  async function fetchDriveTime(lat1, lon1, lat2, lon2) {
    const key = `${lat1},${lon1},${lat2},${lon2}`;
    if (routeCache.has(key)) return routeCache.get(key);
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
      const res = await fetch(url);
      const json = await res.json();
      const route = json?.routes?.[0];
      const result = route ? { seconds: route.duration, meters: route.distance } : null;
      routeCache.set(key, result);
      return result;
    } catch (e) {
      return null;
    }
  }
  function attachDriveTime(el, lat1, lon1, lat2, lon2, nextLabel) {
    if (!lat1 || !lon1 || !lat2 || !lon2) { el.textContent = ''; return; }
    el.textContent = 'Checking drive time…';
    el.classList.add('muted');
    fetchDriveTime(lat1, lon1, lat2, lon2).then(r => {
      if (!r) { el.textContent = ''; return; }
      el.classList.remove('muted');
      const mins = Math.round(r.seconds / 60);
      const km = Math.round(r.meters / 1000);
      const hrs = Math.floor(mins / 60);
      const remMins = mins % 60;
      const timeLabel = hrs > 0 ? `${hrs}h ${remMins}m` : `${mins} min`;
      el.textContent = `🚗 ${timeLabel} · ${km} km to ${nextLabel || 'next stop'}`;
    });
  }

  // ---- weather (Open-Meteo, no API key; only returns data within ~16 days of
  // today) / map — both declared here for the same temporal-dead-zone reason
  // as the blocks above: renderItinerary() (called from the offline-first
  // render below) reaches both unconditionally.
  let leafletMap = null;
  let markerLayer = null;

  const weatherCache = new Map();
  const WMO = {
    0: '☀️ Clear', 1: '🌤️ Mostly clear', 2: '⛅ Partly cloudy', 3: '☁️ Cloudy',
    45: '🌫️ Fog', 48: '🌫️ Fog', 51: '🌦️ Light drizzle', 53: '🌦️ Drizzle', 55: '🌧️ Heavy drizzle',
    61: '🌦️ Light rain', 63: '🌧️ Rain', 65: '🌧️ Heavy rain', 71: '🌨️ Light snow', 73: '🌨️ Snow', 75: '❄️ Heavy snow',
    80: '🌦️ Showers', 81: '🌧️ Showers', 82: '⛈️ Violent showers', 95: '⛈️ Thunderstorm', 96: '⛈️ Thunderstorm (hail)', 99: '⛈️ Thunderstorm (hail)',
  };
  async function fetchWeather(lat, lon, date) {
    const key = `${lat},${lon},${date}`;
    if (weatherCache.has(key)) return weatherCache.get(key);
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${date}&end_date=${date}`;
      const res = await fetch(url);
      const json = await res.json();
      const code = json?.daily?.weathercode?.[0];
      const max = json?.daily?.temperature_2m_max?.[0];
      const min = json?.daily?.temperature_2m_min?.[0];
      const result = (code === undefined) ? null : { label: WMO[code] || '—', max, min };
      weatherCache.set(key, result);
      return result;
    } catch (e) {
      return null;
    }
  }
  function attachWeather(el, lat, lon, date) {
    if (!lat || !lon || !date) { el.textContent = ''; return; }
    const daysOut = Math.round((new Date(date) - new Date(todayISO())) / 86400000);
    if (daysOut < 0) { el.textContent = ''; return; }
    if (daysOut > 15) {
      el.textContent = 'Forecast available once within ~2 weeks of this date';
      el.classList.add('muted');
      return;
    }
    el.textContent = 'Checking forecast…';
    el.classList.add('muted');
    fetchWeather(lat, lon, date).then(w => {
      if (!w) { el.textContent = 'Forecast unavailable'; return; }
      el.classList.remove('muted');
      el.textContent = `${w.label} · ${Math.round(w.min)}–${Math.round(w.max)}°C`;
    });
  }

  // ---- transient "someone else just changed something" toast ----
  // Trip-wide, not truly per-field (a genuine per-field audit trail would
  // need a data-model change — see DEV_NOTES "Last edited by") — reuses the
  // meta/lastEditedBy + lastEditedAt already stamped on every write. Skips
  // toasting your own writes (they sync back to you too) and skips the
  // very first sync on page load.
  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById('updateToast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // ---- seed a brand-new trip id once ----
  get(tripRef).then(snap => {
    if (snap.exists()) return;
    const seeded = {
      meta: SEED.meta,
      itinerary: {},
      checklists: { w4: {}, w2: {}, packingLongfen: {}, packingGwen: {}, dayBefore: {}, onRoad: {} },
      budget: SEED.budget,
      contacts: {},
      extras: {},
      flights: {},
      accommodations: {},
      carRental: {},
    };
    SEED.itineraryDays.forEach(day => {
      const key = push(child(tripRef, 'itinerary')).key;
      seeded.itinerary[key] = day;
    });
    Object.entries(SEED.checklists).forEach(([tier, items]) => {
      items.forEach(text => {
        const key = push(child(tripRef, `checklists/${tier}`)).key;
        seeded.checklists[tier][key] = { text, checked: false };
      });
    });
    SEED.contacts.forEach(c => {
      const key = push(child(tripRef, 'contacts')).key;
      seeded.contacts[key] = c;
    });
    SEED.extras.forEach(x => {
      const key = push(child(tripRef, 'extras')).key;
      seeded.extras[key] = x;
    });
    (SEED.flights || []).forEach(f => {
      const key = push(child(tripRef, 'flights')).key;
      seeded.flights[key] = f;
    });
    (SEED.accommodations || []).forEach(a => {
      const key = push(child(tripRef, 'accommodations')).key;
      seeded.accommodations[key] = a;
    });
    (SEED.carRental || []).forEach(c => {
      const key = push(child(tripRef, 'carRental')).key;
      seeded.carRental[key] = c;
    });
    set(tripRef, seeded);
  });

  // ---- offline-first render: paint from localStorage cache immediately if present,
  // then let the live Firebase listener take over once it connects ----
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try { renderAll(applyQueuedPatches(JSON.parse(cached))); } catch (e) { /* ignore bad cache */ }
  }

  let firstSync = true;
  let lastSeenEditAt = null;
  onValue(tripRef, snap => {
    const data = snap.val() || {};
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    document.getElementById('syncDot').classList.remove('offline');
    document.getElementById('syncDot').classList.add('ok');
    const who = data.meta?.lastEditedBy;
    const editedAt = data.meta?.lastEditedAt;
    document.getElementById('syncText').textContent = firstSync
      ? 'Synced'
      : `Synced${who ? ' · edited by ' + who : ''} · just now`;
    if (!firstSync && who && who !== editorName() && editedAt && editedAt !== lastSeenEditAt) {
      showToast(`Updated by ${who}`);
    }
    lastSeenEditAt = editedAt;
    firstSync = false;
    renderAll(data);
  }, err => {
    document.getElementById('syncDot').classList.add('offline');
    document.getElementById('syncText').textContent = 'Sync error — check console';
    console.error(err);
  });

  // Canonical connectivity signal for the offline write queue and banner —
  // see the "offline write queue" comment above for why this is used
  // instead of navigator.onLine.
  onValue(ref(db, '.info/connected'), snap => {
    const nowOnline = snap.val() === true;
    const cameOnline = nowOnline && !isOnline;
    isOnline = nowOnline;
    document.getElementById('offlineBanner').classList.toggle('show', !isOnline);
    updateQueueBadge();
    if (cameOnline) flushQueue();
  });

  function renderAll(data) {
    renderMeta(data.meta || {});
    updateTripStatus(data.itinerary || {});
    renderItinerary(data.itinerary || {});
    renderChecklists(data.checklists || {});
    renderBudget(data.budget || {}, data.budgetCurrency || HOME_CURRENCY);
    renderContacts(data.contacts || {});
    renderExtras(data.extras || {});
    renderFlights(data.flights || {});
    renderAccommodations(data.accommodations || {});
    renderCarRental(data.carRental || {});
  }

  // Turns the static "Status: Planning" badge into a live countdown/progress
  // indicator computed from the itinerary's own dates.
  function updateTripStatus(itinerary) {
    const statusEl = document.getElementById('stubStatus');
    const dates = Object.values(itinerary).map(d => d.date).filter(Boolean).sort();
    if (!dates.length) { statusEl.textContent = 'Status: Planning'; return; }
    const first = dates[0], last = dates[dates.length - 1];
    const today = todayISO();
    if (today < first) {
      const days = Math.round((new Date(first) - new Date(today)) / 86400000);
      statusEl.textContent = `T-minus ${days} day${days === 1 ? '' : 's'}`;
    } else if (today > last) {
      statusEl.textContent = 'Trip complete';
    } else {
      const dayNum = Math.round((new Date(today) - new Date(first)) / 86400000) + 1;
      const totalDays = Math.round((new Date(last) - new Date(first)) / 86400000) + 1;
      statusEl.textContent = `Day ${dayNum} of ${totalDays} · In progress`;
    }
  }

  // Only counts as "actively editing" if the focused element is something
  // you type into — see DEV_NOTES for the button-focus bug this guards
  // against (tapping Remove/▲/▼ used to be treated as "editing" and silently
  // skipped the re-render its own write caused).
  function focusedInside(container) {
    const el = document.activeElement;
    if (!container || !el || !container.contains(el)) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }
  function commitOnEnter(el) {
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      el.blur();
    });
  }
  function flashSaved(el) {
    el.classList.add('field-saved');
    setTimeout(() => el.classList.remove('field-saved'), 500);
  }
  function commitOnBlur(el, writePath, isCheckbox) {
    commitOnEnter(el);
    el.addEventListener('blur', () => {
      writeValue(writePath, el.textContent);
      flashSaved(el);
    });
  }

  function renderMeta(meta) {
    const titleEl = document.getElementById('title');
    const subEl = document.getElementById('subtitle');
    const daysEl = document.getElementById('days');
    if (document.activeElement !== titleEl) titleEl.textContent = meta.title ?? '';
    if (document.activeElement !== subEl) subEl.textContent = meta.subtitle ?? '';
    if (document.activeElement !== daysEl) daysEl.textContent = meta.days ?? '—';
    titleEl.onblur = () => { writeValue(`trips/${tripId}/meta/title`, titleEl.textContent); flashSaved(titleEl); };
    subEl.onblur = () => { writeValue(`trips/${tripId}/meta/subtitle`, subEl.textContent); flashSaved(subEl); };
    daysEl.onblur = () => { writeValue(`trips/${tripId}/meta/days`, daysEl.textContent); flashSaved(daysEl); };
    // renderMeta() re-runs on every Firebase sync, and these three elements
    // are fixed (not recreated each render) — .onkeydown assignment replaces
    // on every render instead of stacking a duplicate addEventListener.
    const commitEnterKeydown = e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
    titleEl.onkeydown = subEl.onkeydown = daysEl.onkeydown = commitEnterKeydown;
  }

  // ---- date / today helpers ----
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function formatDate(iso) {
    if (!iso) return 'Add date';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function formatWeekday(iso) {
    if (!iso) return 'No date set';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-SG', { weekday: 'long' });
  }
  function formatNumericDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  }

  // ---- geocoding (Nominatim/OSM, no key) — see DEV_NOTES "Geocoder swapped"
  // for why this isn't Open-Meteo's geocoder (city gazetteer, not a
  // landmark/address geocoder — confirmed broken for this app's own seed data).
  async function geocodeLocation(query) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`;
      const res = await fetch(url);
      const json = await res.json();
      const r = json?.[0];
      if (!r) return null;
      return { lat: parseFloat(r.lat), lon: parseFloat(r.lon) };
    } catch (e) {
      return null;
    }
  }

  function renderItinerary(itinerary) {
    const list = document.getElementById('itineraryList');
    if (focusedInside(list)) return;
    list.innerHTML = '';
    const today = todayISO();
    const entries = Object.entries(itinerary).sort(([ka, a], [kb, b]) => {
      const da = a.date || '9999-99-99', db = b.date || '9999-99-99';
      if (da !== db) return da < db ? -1 : 1;
      const oa = a.order ?? 0, ob = b.order ?? 0;
      if (oa !== ob) return oa < ob ? -1 : 1;
      return ka < kb ? -1 : 1;
    });
    function reorderWithinDateGroup(key, direction) {
      const idx = entries.findIndex(([k]) => k === key);
      if (idx === -1) return;
      const groupDate = entries[idx][1].date || '';
      let start = idx, end = idx;
      while (start > 0 && (entries[start - 1][1].date || '') === groupDate) start--;
      while (end < entries.length - 1 && (entries[end + 1][1].date || '') === groupDate) end++;
      const group = entries.slice(start, end + 1);
      const posInGroup = idx - start;
      const targetPos = posInGroup + direction;
      if (targetPos < 0 || targetPos >= group.length) return;
      const orders = group.map((_, i) => i * 10);
      [orders[posInGroup], orders[targetPos]] = [orders[targetPos], orders[posInGroup]];
      group.forEach(([k], i) => writeValue(`trips/${tripId}/itinerary/${k}/order`, orders[i]));
    }
    entries.forEach(([key, day], i) => {
      const isToday = day.date && day.date === today;
      const card = document.createElement('div');
      card.className = 'card' + (isToday ? ' is-today' : '');
      card.innerHTML = `
        <div class="card-row">
          <div class="day-label-group">
            <span class="day-label">Stop ${i + 1}</span>
            ${isToday ? '<span class="today-tag">Today</span>' : ''}
            <span class="move-btns">
              <button class="move-btn" type="button" data-move-up title="Move up (same date)">▲</button>
              <button class="move-btn" type="button" data-move-down title="Move down (same date)">▼</button>
            </span>
          </div>
          <div class="date-display">
            <div class="date-weekday" data-weekday></div>
            <div class="date-numeric" data-numeric></div>
          </div>
          <input class="day-date-input" type="date" data-f="date">
        </div>
        <div class="field"><span class="field-label">Location</span><span contenteditable="true" data-f="location"></span></div>
        <div class="geocode-feedback" data-geocode-feedback></div>
        <div class="card-links">
          <button class="coords-toggle" type="button" data-toggle-coords>± coordinates</button>
          <button class="coords-toggle" type="button" data-reset-coords style="display:none;">↺ reset to auto</button>
          <a class="nav-link" data-waze target="_blank" rel="noopener" style="display:none;">Navigate in Waze →</a>
        </div>
        <div class="coords-row hidden">
          <span class="field-label" style="align-self:center;margin:0;">Coords</span>
          <input type="number" step="any" placeholder="lat" data-f="lat">
          <input type="number" step="any" placeholder="lon" data-f="lon">
        </div>
        <div class="field"><span class="field-label">Plan</span><span contenteditable="true" data-f="plan"></span></div>
        <div class="field"><span class="field-label">Lodging</span><span contenteditable="true" data-f="lodging"></span></div>
        <div class="field"><span class="field-label">Alternate (weather / closure)</span><span contenteditable="true" data-f="alt"></span></div>
        <div class="weather-line" data-weather></div>
        <div class="drive-line" data-drive></div>
        <button class="remove-row" data-remove>− Remove this day</button>`;

      const latInput = card.querySelector('[data-f="lat"]');
      const lonInput = card.querySelector('[data-f="lon"]');
      const wazeLink = card.querySelector('[data-waze]');
      const weekdayEl = card.querySelector('[data-weekday]');
      const numericEl = card.querySelector('[data-numeric]');
      const geoFeedback = card.querySelector('[data-geocode-feedback]');
      const resetBtn = card.querySelector('[data-reset-coords]');
      resetBtn.style.display = day.coordsManual ? '' : 'none';
      function updateWazeLink() {
        const lat = latInput.value, lon = lonInput.value;
        if (lat && lon) {
          wazeLink.href = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
          wazeLink.style.display = '';
        } else {
          wazeLink.style.display = 'none';
        }
      }
      function updateDateDisplay(iso) {
        weekdayEl.textContent = formatWeekday(iso);
        numericEl.textContent = formatNumericDate(iso);
      }
      function showGeoFeedback(msg) {
        geoFeedback.textContent = msg;
        geoFeedback.classList.toggle('show', !!msg);
      }

      const dateInput = card.querySelector('[data-f="date"]');
      dateInput.value = day.date ?? '';
      updateDateDisplay(day.date);
      dateInput.addEventListener('change', e => {
        writeValue(`trips/${tripId}/itinerary/${key}/date`, e.target.value);
        updateDateDisplay(e.target.value);
      });

      const locEl = card.querySelector('[data-f="location"]');
      locEl.textContent = day.location ?? '';
      commitOnEnter(locEl);
      let geocodeSeq = 0;
      locEl.addEventListener('blur', () => {
        const text = locEl.textContent.trim();
        writeValue(`trips/${tripId}/itinerary/${key}/location`, text);
        flashSaved(locEl);
        if (!text || day.coordsManual) { showGeoFeedback(''); return; }
        const mySeq = ++geocodeSeq;
        showGeoFeedback('Locating…');
        geocodeLocation(text).then(geo => {
          if (mySeq !== geocodeSeq) return;
          if (!geo) {
            showGeoFeedback('Couldn’t find that place — set coordinates manually via “± coordinates” below');
            return;
          }
          showGeoFeedback('');
          latInput.value = geo.lat;
          lonInput.value = geo.lon;
          updateWazeLink();
          writeValue(`trips/${tripId}/itinerary/${key}/lat`, geo.lat);
          writeValue(`trips/${tripId}/itinerary/${key}/lon`, geo.lon);
          attachWeather(card.querySelector('[data-weather]'), geo.lat, geo.lon, day.date);
        });
      });

      card.querySelectorAll('span[data-f]:not([data-f="location"])').forEach(el => {
        el.textContent = day[el.dataset.f] ?? '';
        commitOnBlur(el, `trips/${tripId}/itinerary/${key}/${el.dataset.f}`);
      });
      card.querySelectorAll('input[type="number"][data-f]').forEach(el => {
        el.value = day[el.dataset.f] ?? '';
        el.addEventListener('blur', () => {
          writeValue(`trips/${tripId}/itinerary/${key}/${el.dataset.f}`, el.value);
          // A manual coordinate edit pins the location, so future location-text
          // edits stop auto-overwriting it — see the geocode note above.
          writeValue(`trips/${tripId}/itinerary/${key}/coordsManual`, true);
          resetBtn.style.display = '';
          updateWazeLink();
        });
      });
      card.querySelector('[data-toggle-coords]').onclick = () => card.querySelector('.coords-row').classList.toggle('hidden');
      // Un-pins coordsManual and immediately re-runs the geocode against the
      // current location text, so "reset to auto" actually moves the pin
      // back rather than just flipping a flag with stale coordinates left
      // sitting there — see DEV_NOTES "Known limitations" for the gap this
      // closes (previously the only way back was manually re-editing lat/lon).
      resetBtn.onclick = () => {
        writeValue(`trips/${tripId}/itinerary/${key}/coordsManual`, false);
        resetBtn.style.display = 'none';
        const text = locEl.textContent.trim();
        if (!text) return;
        showGeoFeedback('Locating…');
        geocodeLocation(text).then(geo => {
          if (!geo) {
            showGeoFeedback('Couldn’t find that place — set coordinates manually via “± coordinates” below');
            return;
          }
          showGeoFeedback('');
          latInput.value = geo.lat;
          lonInput.value = geo.lon;
          updateWazeLink();
          writeValue(`trips/${tripId}/itinerary/${key}/lat`, geo.lat);
          writeValue(`trips/${tripId}/itinerary/${key}/lon`, geo.lon);
          attachWeather(card.querySelector('[data-weather]'), geo.lat, geo.lon, day.date);
        });
      };
      card.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/itinerary/${key}`, null);

      const groupDate = day.date || '';
      const isFirstInGroup = i === 0 || (entries[i - 1][1].date || '') !== groupDate;
      const isLastInGroup = i === entries.length - 1 || (entries[i + 1][1].date || '') !== groupDate;
      const upBtn = card.querySelector('[data-move-up]');
      const downBtn = card.querySelector('[data-move-down]');
      upBtn.disabled = isFirstInGroup;
      downBtn.disabled = isLastInGroup;
      upBtn.onclick = () => reorderWithinDateGroup(key, -1);
      downBtn.onclick = () => reorderWithinDateGroup(key, +1);

      list.appendChild(card);

      updateWazeLink();
      attachWeather(card.querySelector('[data-weather]'), day.lat, day.lon, day.date);
      const nextDay = entries[i + 1]?.[1];
      attachDriveTime(card.querySelector('[data-drive]'), day.lat, day.lon, nextDay?.lat, nextDay?.lon, nextDay?.location);
    });

    renderMap(entries);
  }
  document.getElementById('addDay').onclick = () => {
    const key = push(child(tripRef, 'itinerary')).key;
    writeValue(`trips/${tripId}/itinerary/${key}`, { date: '', location: '', lat: '', lon: '', plan: '', lodging: '', alt: '', coordsManual: false, order: 0 });
  };

  // ---- map ----
  function renderMap(sortedEntries) {
    if (typeof L === 'undefined') return;
    if (!leafletMap) {
      leafletMap = L.map('mapView').setView([0, 0], 2);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18,
      }).addTo(leafletMap);
      markerLayer = L.layerGroup().addTo(leafletMap);
    }
    markerLayer.clearLayers();
    const points = [];
    sortedEntries.forEach(([key, day], i) => {
      const lat = parseFloat(day.lat), lon = parseFloat(day.lon);
      if (isNaN(lat) || isNaN(lon)) return;
      points.push([lat, lon]);
      L.marker([lat, lon]).addTo(markerLayer)
        .bindPopup(`<strong>Stop ${i + 1}${day.date ? ' · ' + formatDate(day.date) : ''}</strong><br>${day.location || ''}`);
    });
    if (points.length >= 2) {
      L.polyline(points, { color: '#B8862F', weight: 3, opacity: 0.7 }).addTo(markerLayer);
    }
    if (points.length) {
      leafletMap.fitBounds(points, { padding: [30, 30] });
    }
    setTimeout(() => leafletMap.invalidateSize(), 50);
  }
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.dataset.panel === 'map' && leafletMap) setTimeout(() => leafletMap.invalidateSize(), 50);
    });
  });

  function renderChecklists(checklists) {
    ['w4', 'w2', 'packingLongfen', 'packingGwen', 'dayBefore', 'onRoad'].forEach(tier => {
      const container = document.getElementById('tier-' + tier);
      if (focusedInside(container)) return;
      container.innerHTML = '';
      const items = checklists[tier] || {};
      Object.entries(items).sort(([a], [b]) => (a < b ? -1 : 1)).forEach(([key, item]) => {
        const row = document.createElement('div');
        row.className = 'check-item';
        row.innerHTML = `<input type="checkbox"><span contenteditable="true"></span><button class="remove-row" data-remove>✕</button>`;
        row.querySelector('input').checked = !!item.checked;
        row.querySelector('span').textContent = item.text ?? '';
        row.querySelector('input').onchange = e => writeValue(`trips/${tripId}/checklists/${tier}/${key}/checked`, e.target.checked);
        commitOnBlur(row.querySelector('span'), `trips/${tripId}/checklists/${tier}/${key}/text`);
        row.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/checklists/${tier}/${key}`, null);
        container.appendChild(row);
      });
    });
  }
  document.querySelectorAll('.tier-add').forEach(btn => {
    btn.onclick = () => {
      const tier = btn.closest('.tier').dataset.tier;
      const key = push(child(tripRef, `checklists/${tier}`)).key;
      writeValue(`trips/${tripId}/checklists/${tier}/${key}`, { text: '[new item]', checked: false });
    };
  });

  function renderBudget(budget, budgetCurrency) {
    const body = document.getElementById('budgetBody');
    if (focusedInside(body)) return;
    body.innerHTML = '';
    let totalB = 0, totalA = 0;
    Object.entries(budget).forEach(([key, row]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.label}</td><td contenteditable="true" data-f="budgeted"></td><td contenteditable="true" data-f="actual"></td>`;
      tr.querySelectorAll('[data-f]').forEach(td => {
        td.textContent = row[td.dataset.f] ?? '';
        commitOnBlur(td, `trips/${tripId}/budget/${key}/${td.dataset.f}`);
      });
      totalB += Number(row.budgeted) || 0;
      totalA += Number(row.actual) || 0;
      body.appendChild(tr);
    });
    const totalRow = document.createElement('tr');
    totalRow.className = 'total';
    totalRow.innerHTML = `<td>Total</td><td>${totalB || '—'}</td><td>${totalA || '—'}</td>`;
    body.appendChild(totalRow);

    const currencySel = document.getElementById('budgetCurrency');
    if (FIXED_CURRENCIES.includes(budgetCurrency)) {
      if (document.activeElement !== currencySel) currencySel.value = budgetCurrency;
      otherCurrencyInput.style.display = 'none';
    } else {
      if (document.activeElement !== currencySel) currencySel.value = 'OTHER';
      otherCurrencyInput.style.display = '';
      if (document.activeElement !== otherCurrencyInput) otherCurrencyInput.value = budgetCurrency;
    }

    const fxLine = document.getElementById('budgetFxLine');
    if (budgetCurrency === HOME_CURRENCY || (!totalB && !totalA)) {
      fxLine.textContent = '';
    } else {
      fxLine.textContent = 'Converting…';
      fetchFxRate(budgetCurrency).then(rate => {
        if (!rate) { fxLine.textContent = ''; return; }
        const bHome = Math.round(totalB * rate);
        const aHome = Math.round(totalA * rate);
        fxLine.textContent = `≈ ${HOME_CURRENCY} ${bHome} budgeted / ${aHome} actual, at today's rate (1 ${budgetCurrency} = ${rate.toFixed(4)} ${HOME_CURRENCY})`;
      });
    }
  }
  document.getElementById('budgetCurrency').addEventListener('change', e => {
    if (e.target.value === 'OTHER') {
      otherCurrencyInput.style.display = '';
      otherCurrencyInput.focus();
    } else {
      otherCurrencyInput.style.display = 'none';
      writeValue(`trips/${tripId}/budgetCurrency`, e.target.value);
    }
  });
  commitOnEnter(otherCurrencyInput);
  otherCurrencyInput.addEventListener('blur', () => {
    const code = otherCurrencyInput.value.trim().toUpperCase();
    if (code) writeValue(`trips/${tripId}/budgetCurrency`, code);
  });

  function renderContacts(contacts) {
    const grid = document.getElementById('contactGrid');
    if (focusedInside(grid)) return;
    grid.innerHTML = '';
    Object.entries(contacts).sort(([a], [b]) => (a < b ? -1 : 1)).forEach(([key, c]) => {
      const card = document.createElement('div');
      card.className = 'card contact-card';
      card.innerHTML = `
        <span class="field-label">Name</span>
        <div contenteditable="true" data-f="name"></div>
        <span class="field-label">Phone / ref</span>
        <div contenteditable="true" data-f="ref"></div>
        <button class="remove-row" data-remove>− Remove</button>`;
      card.querySelectorAll('[data-f]').forEach(el => {
        el.textContent = c[el.dataset.f] ?? '';
        commitOnBlur(el, `trips/${tripId}/contacts/${key}/${el.dataset.f}`);
      });
      card.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/contacts/${key}`, null);
      grid.appendChild(card);
    });
  }
  document.getElementById('addContact').onclick = () => {
    const key = push(child(tripRef, 'contacts')).key;
    writeValue(`trips/${tripId}/contacts/${key}`, { name: '[name]', ref: '[number / ref]' });
  };

  function renderExtras(extras) {
    const list = document.getElementById('extrasList');
    if (focusedInside(list)) return;
    list.innerHTML = '';
    Object.entries(extras).sort(([a], [b]) => (a < b ? -1 : 1)).forEach(([key, x]) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="field"><span class="field-label">Item</span><span contenteditable="true" data-f="item"></span></div>
        <div class="field"><span class="field-label">Notes</span><span contenteditable="true" data-f="notes"></span></div>
        <button class="remove-row" data-remove>− Remove</button>`;
      card.querySelectorAll('[data-f]').forEach(el => {
        el.textContent = x[el.dataset.f] ?? '';
        commitOnBlur(el, `trips/${tripId}/extras/${key}/${el.dataset.f}`);
      });
      card.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/extras/${key}`, null);
      list.appendChild(card);
    });
  }
  document.getElementById('addExtra').onclick = () => {
    const key = push(child(tripRef, 'extras')).key;
    writeValue(`trips/${tripId}/extras/${key}`, { item: '', notes: '' });
  };

  // ---- Bookings tab: Flights / Accommodations / Car Rental ----
  // Kept as one tab with three subsections (see the CSS comment on
  // `.panel section + section`) rather than three top-level tabs — the tab
  // bar is already 7 wide on a phone screen, same reasoning DEV_NOTES
  // documents for why per-person packing lists became Checklists tiers
  // instead of their own tab. Each record type sorts by its own primary
  // date field (not creation order, unlike Contacts/Extras) so the cards
  // read chronologically — useful for "what's next" while actually
  // traveling. Date fields are real `<input type="date">` elements
  // (reusing `.day-date-input`, the same class/pattern renderItinerary()
  // uses for its date input) rather than contenteditable text, for the same
  // reason itinerary's own date field had to move off free text: sorting
  // needs a real ISO value, not whatever a human happens to type.
  function sortByDate(entries, field) {
    return entries.sort(([, a], [, b]) => {
      const da = a[field] || '9999-99-99', db = b[field] || '9999-99-99';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }
  // Shows/hides the "View PDF" link a record card carries next to its
  // pdfUrl field (see renderFlights/renderAccommodations/renderCarRental) —
  // the field itself holds a plain URL (typically a link into this trip's
  // docs/ folder in this repo, or any other URL a human pastes in), this
  // just wires the clickable link up to whatever that value currently is.
  function wirePdfLink(card, value) {
    const link = card.querySelector('[data-pdf-link]');
    if (value) { link.href = value; link.style.display = ''; }
    else { link.style.display = 'none'; }
  }

  function renderFlights(flights) {
    const list = document.getElementById('flightsList');
    if (focusedInside(list)) return;
    list.innerHTML = '';
    sortByDate(Object.entries(flights), 'date').forEach(([key, f]) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="field">
          <span class="field-label">Date</span>
          <div class="date-weekday" data-weekday></div>
          <input class="day-date-input" type="date" data-f="date">
        </div>
        <div class="field"><span class="field-label">Flight</span><span contenteditable="true" data-f="flightNo"></span></div>
        <div class="field"><span class="field-label">Route</span><span contenteditable="true" data-f="route"></span></div>
        <div class="field"><span class="field-label">Depart</span><span contenteditable="true" data-f="depart"></span></div>
        <div class="field"><span class="field-label">Arrive</span><span contenteditable="true" data-f="arrive"></span></div>
        <div class="field"><span class="field-label">Confirmation / PNR</span><span contenteditable="true" data-f="confirmation"></span></div>
        <div class="field"><span class="field-label">Document link (e-ticket PDF)</span><span contenteditable="true" data-f="pdfUrl"></span></div>
        <div class="card-links"><a class="nav-link" data-pdf-link target="_blank" rel="noopener" style="display:none;">📄 View PDF →</a></div>
        <div class="field"><span class="field-label">Notes</span><span contenteditable="true" data-f="notes"></span></div>
        <button class="remove-row" data-remove>− Remove</button>`;
      const dateInput = card.querySelector('[data-f="date"]');
      const weekdayEl = card.querySelector('[data-weekday]');
      dateInput.value = f.date ?? '';
      weekdayEl.textContent = formatWeekday(f.date);
      dateInput.addEventListener('change', e => {
        writeValue(`trips/${tripId}/flights/${key}/date`, e.target.value);
        weekdayEl.textContent = formatWeekday(e.target.value);
      });
      card.querySelectorAll('span[data-f]').forEach(el => {
        el.textContent = f[el.dataset.f] ?? '';
        commitOnBlur(el, `trips/${tripId}/flights/${key}/${el.dataset.f}`);
      });
      wirePdfLink(card, f.pdfUrl);
      card.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/flights/${key}`, null);
      list.appendChild(card);
    });
  }
  document.getElementById('addFlight').onclick = () => {
    const key = push(child(tripRef, 'flights')).key;
    writeValue(`trips/${tripId}/flights/${key}`, { date: '', flightNo: '', route: '', depart: '', arrive: '', confirmation: '', pdfUrl: '', notes: '' });
  };

  function renderAccommodations(accommodations) {
    const list = document.getElementById('accommodationsList');
    if (focusedInside(list)) return;
    list.innerHTML = '';
    sortByDate(Object.entries(accommodations), 'checkIn').forEach(([key, a]) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="field"><span class="field-label">Name</span><span contenteditable="true" data-f="name"></span></div>
        <div class="geocode-feedback" data-geocode-feedback></div>
        <div class="card-links">
          <button class="coords-toggle" type="button" data-toggle-coords>± coordinates</button>
          <button class="coords-toggle" type="button" data-reset-coords style="display:none;">↺ reset to auto</button>
          <a class="nav-link" data-waze target="_blank" rel="noopener" style="display:none;">Navigate in Waze →</a>
        </div>
        <div class="coords-row hidden">
          <span class="field-label" style="align-self:center;margin:0;">Coords</span>
          <input type="number" step="any" placeholder="lat" data-f="lat">
          <input type="number" step="any" placeholder="lon" data-f="lon">
        </div>
        <div class="field">
          <span class="field-label">Check-in</span>
          <div class="date-weekday" data-weekday-for="checkIn"></div>
          <input class="day-date-input" type="date" data-f="checkIn">
        </div>
        <div class="field">
          <span class="field-label">Check-out</span>
          <div class="date-weekday" data-weekday-for="checkOut"></div>
          <input class="day-date-input" type="date" data-f="checkOut">
        </div>
        <div class="field"><span class="field-label">Confirmation</span><span contenteditable="true" data-f="confirmation"></span></div>
        <div class="field"><span class="field-label">Document link (booking confirmation PDF)</span><span contenteditable="true" data-f="pdfUrl"></span></div>
        <div class="card-links"><a class="nav-link" data-pdf-link target="_blank" rel="noopener" style="display:none;">📄 View PDF →</a></div>
        <div class="field"><span class="field-label">Notes</span><span contenteditable="true" data-f="notes"></span></div>
        <button class="remove-row" data-remove>− Remove</button>`;
      card.querySelector('[data-weekday-for="checkIn"]').textContent = formatWeekday(a.checkIn);
      card.querySelector('[data-weekday-for="checkOut"]').textContent = formatWeekday(a.checkOut);
      card.querySelectorAll('input[type="date"][data-f]').forEach(el => {
        el.value = a[el.dataset.f] ?? '';
        el.addEventListener('change', e => {
          writeValue(`trips/${tripId}/accommodations/${key}/${el.dataset.f}`, e.target.value);
          card.querySelector(`[data-weekday-for="${el.dataset.f}"]`).textContent = formatWeekday(e.target.value);
        });
      });
      card.querySelectorAll('span[data-f]:not([data-f="name"])').forEach(el => {
        el.textContent = a[el.dataset.f] ?? '';
        commitOnBlur(el, `trips/${tripId}/accommodations/${key}/${el.dataset.f}`);
      });

      // Waze navigation link — same auto-geocode-on-blur pattern as the
      // itinerary card's own Location field (see renderItinerary() and
      // DEV_NOTES "Location → coordinates"), applied to the accommodation's
      // Name field instead, since that's this record's equivalent of "the
      // place." Same coordsManual/geocodeSeq safeguards for the same
      // reasons: a manually-pinned location must stop auto-overwriting, and
      // a slower/older lookup response must not clobber a newer one.
      const nameEl = card.querySelector('[data-f="name"]');
      nameEl.textContent = a.name ?? '';
      const latInput = card.querySelector('[data-f="lat"]');
      const lonInput = card.querySelector('[data-f="lon"]');
      const wazeLink = card.querySelector('[data-waze]');
      const geoFeedback = card.querySelector('[data-geocode-feedback]');
      const resetBtn = card.querySelector('[data-reset-coords]');
      resetBtn.style.display = a.coordsManual ? '' : 'none';
      latInput.value = a.lat ?? '';
      lonInput.value = a.lon ?? '';
      function updateWazeLink() {
        const lat = latInput.value, lon = lonInput.value;
        if (lat && lon) {
          wazeLink.href = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
          wazeLink.style.display = '';
        } else {
          wazeLink.style.display = 'none';
        }
      }
      function showGeoFeedback(msg) {
        geoFeedback.textContent = msg;
        geoFeedback.classList.toggle('show', !!msg);
      }
      updateWazeLink();
      commitOnEnter(nameEl);
      let geocodeSeq = 0;
      nameEl.addEventListener('blur', () => {
        const text = nameEl.textContent.trim();
        writeValue(`trips/${tripId}/accommodations/${key}/name`, text);
        flashSaved(nameEl);
        if (!text || a.coordsManual) { showGeoFeedback(''); return; }
        const mySeq = ++geocodeSeq;
        showGeoFeedback('Locating…');
        geocodeLocation(text).then(geo => {
          if (mySeq !== geocodeSeq) return;
          if (!geo) {
            showGeoFeedback('Couldn’t find that place — set coordinates manually via “± coordinates” below');
            return;
          }
          showGeoFeedback('');
          latInput.value = geo.lat;
          lonInput.value = geo.lon;
          updateWazeLink();
          writeValue(`trips/${tripId}/accommodations/${key}/lat`, geo.lat);
          writeValue(`trips/${tripId}/accommodations/${key}/lon`, geo.lon);
        });
      });
      card.querySelector('[data-toggle-coords]').onclick = () => card.querySelector('.coords-row').classList.toggle('hidden');
      resetBtn.onclick = () => {
        writeValue(`trips/${tripId}/accommodations/${key}/coordsManual`, false);
        resetBtn.style.display = 'none';
        const text = nameEl.textContent.trim();
        if (!text) return;
        showGeoFeedback('Locating…');
        geocodeLocation(text).then(geo => {
          if (!geo) {
            showGeoFeedback('Couldn’t find that place — set coordinates manually via “± coordinates” below');
            return;
          }
          showGeoFeedback('');
          latInput.value = geo.lat;
          lonInput.value = geo.lon;
          updateWazeLink();
          writeValue(`trips/${tripId}/accommodations/${key}/lat`, geo.lat);
          writeValue(`trips/${tripId}/accommodations/${key}/lon`, geo.lon);
        });
      };
      card.querySelectorAll('input[type="number"][data-f]').forEach(el => {
        el.addEventListener('blur', () => {
          writeValue(`trips/${tripId}/accommodations/${key}/${el.dataset.f}`, el.value);
          writeValue(`trips/${tripId}/accommodations/${key}/coordsManual`, true);
          resetBtn.style.display = '';
          updateWazeLink();
        });
      });

      wirePdfLink(card, a.pdfUrl);
      card.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/accommodations/${key}`, null);
      list.appendChild(card);
    });
  }
  document.getElementById('addAccommodation').onclick = () => {
    const key = push(child(tripRef, 'accommodations')).key;
    writeValue(`trips/${tripId}/accommodations/${key}`, { name: '', checkIn: '', checkOut: '', confirmation: '', pdfUrl: '', lat: '', lon: '', coordsManual: false, notes: '' });
  };

  function renderCarRental(carRental) {
    const list = document.getElementById('carRentalList');
    if (focusedInside(list)) return;
    list.innerHTML = '';
    sortByDate(Object.entries(carRental), 'pickupDate').forEach(([key, c]) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="field"><span class="field-label">Company</span><span contenteditable="true" data-f="company"></span></div>
        <div class="field">
          <span class="field-label">Pickup</span>
          <div class="date-weekday" data-weekday-for="pickupDate"></div>
          <input class="day-date-input" type="date" data-f="pickupDate">
        </div>
        <div class="field"><span class="field-label">Pickup location</span><span contenteditable="true" data-f="pickupLocation"></span></div>
        <div class="field">
          <span class="field-label">Drop-off</span>
          <div class="date-weekday" data-weekday-for="dropoffDate"></div>
          <input class="day-date-input" type="date" data-f="dropoffDate">
        </div>
        <div class="field"><span class="field-label">Drop-off location</span><span contenteditable="true" data-f="dropoffLocation"></span></div>
        <div class="field"><span class="field-label">Confirmation</span><span contenteditable="true" data-f="confirmation"></span></div>
        <div class="field"><span class="field-label">Document link (booking / insurance PDF)</span><span contenteditable="true" data-f="pdfUrl"></span></div>
        <div class="card-links"><a class="nav-link" data-pdf-link target="_blank" rel="noopener" style="display:none;">📄 View PDF →</a></div>
        <div class="field"><span class="field-label">Notes</span><span contenteditable="true" data-f="notes"></span></div>
        <button class="remove-row" data-remove>− Remove</button>`;
      card.querySelector('[data-weekday-for="pickupDate"]').textContent = formatWeekday(c.pickupDate);
      card.querySelector('[data-weekday-for="dropoffDate"]').textContent = formatWeekday(c.dropoffDate);
      card.querySelectorAll('input[type="date"][data-f]').forEach(el => {
        el.value = c[el.dataset.f] ?? '';
        el.addEventListener('change', e => {
          writeValue(`trips/${tripId}/carRental/${key}/${el.dataset.f}`, e.target.value);
          card.querySelector(`[data-weekday-for="${el.dataset.f}"]`).textContent = formatWeekday(e.target.value);
        });
      });
      card.querySelectorAll('span[data-f]').forEach(el => {
        el.textContent = c[el.dataset.f] ?? '';
        commitOnBlur(el, `trips/${tripId}/carRental/${key}/${el.dataset.f}`);
      });
      wirePdfLink(card, c.pdfUrl);
      card.querySelector('[data-remove]').onclick = () => dbSet(`trips/${tripId}/carRental/${key}`, null);
      list.appendChild(card);
    });
  }
  document.getElementById('addCarRental').onclick = () => {
    const key = push(child(tripRef, 'carRental')).key;
    writeValue(`trips/${tripId}/carRental/${key}`, { company: '', pickupDate: '', pickupLocation: '', dropoffDate: '', dropoffLocation: '', confirmation: '', pdfUrl: '', notes: '' });
  };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.panel).classList.add('active');
    });
  });

  document.getElementById('printBtn').onclick = () => window.print();

  // ---- share panel: QR code + copyable link ----
  let qrGenerated = false;
  document.getElementById('shareBtn').onclick = () => {
    const panel = document.getElementById('sharePanel');
    panel.classList.toggle('show');
    if (panel.classList.contains('show') && !qrGenerated) {
      const url = window.location.href.split('?')[0].split('#')[0];
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      document.getElementById('qrCode').innerHTML = qr.createImgTag(5, 8);
      document.getElementById('shareUrl').textContent = url;
      qrGenerated = true;
    }
  };
  document.getElementById('copyLinkBtn').onclick = () => {
    const url = window.location.href.split('?')[0].split('#')[0];
    const btn = document.getElementById('copyLinkBtn');
    const original = btn.textContent;
    navigator.clipboard.writeText(url).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }).catch(() => {
      btn.textContent = 'Copy failed — select the text above';
      setTimeout(() => { btn.textContent = original; }, 2000);
    });
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/trip-dashboard/sw.js').catch(() => {});
    });
  }
}
