#!/usr/bin/env node
// Generates a read-only, sanitized, static "public" snapshot of a trip —
// no Firebase connection, no editing, safe to hand to friends/family.
// Written to a top-level <repo>/<random12char>/index.html — deliberately
// NOT nested under the trip's own folder (e.g. NOT <tripId>/public/):
// a nested path is one URL-edit away from the live, fully-editable
// dashboard (no auth on that DB — see DEV_NOTES.md "Known limitations"),
// so the public URL must share no derivable relationship with the private
// one. Run manually, on request (never automatic — see DEV_NOTES.md
// "Public share snapshot").
//
// Each generation retires the trip's previous slug folder (deletes it) and
// mints a fresh one — old shared links stop working, tracked in
// share-slugs.json so the script knows what to clean up next time.
//
// Usage:
//   node scripts/build-public.mjs <tripId>   — one trip
//   node scripts/build-public.mjs            — every trip in trips.json
//
// Why this can't just be the live app in a read-only mode: the Firebase DB
// rules are open read/write per trip (see DEV_NOTES.md "Known limitations")
// — a page that still talks to that live DB, even with editing hidden in
// the UI, would let anyone curious enough to open devtools find the DB URL
// and edit the real trip. This script instead bakes a redacted JSON
// snapshot straight into a fully static page with no Firebase SDK at all.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
// trips.json and share-slugs.json live one level up, OUTSIDE the published
// git repo (moved 2026-09-02) — neither is read by any live page (the
// root landing page that used to read trips.json was deleted, see
// DEV_NOTES.md "Root index.html deleted"), so publishing them only handed
// out a plaintext directory of every private trip slug for free. Same
// "keep build-only bookkeeping outside the public tree" pattern as
// Student Portal's portal_passwords.json.
const PROJECT_ROOT = join(REPO_ROOT, '..');
const DB_URL = 'https://trip-dashboard-c6f8a-default-rtdb.asia-southeast1.firebasedatabase.app';

// Traveler name tokens to scrub from free text wherever they appear.
// Kept as a short explicit list (not a generic PII detector) — matches the
// same targeted approach as the existing sanitized itinerary markdown.
const NAME_TOKENS = ['Longfen', 'Gwen', 'Gwendolyn', 'Quek Long Fen', 'Lee Wei Yi Gwendolyn'];

// Patterns for booking IDs / PINs / PNRs embedded in free text (contacts.ref,
// extras.item, notes fields) — dedicated `confirmation`/`pdfUrl` fields are
// dropped outright below, this catches the ones mixed into prose.
const ID_PATTERNS = [
  /\bPIN\b[:\s]+[A-Za-z0-9]{3,}/gi,
  /\bPNR\b[:\s]*[A-Za-z0-9]{3,}/gi,
  /\bBooking\s+(?:ID|No\.?|Number|Ref\.?|Reference)\b[:\s]*[A-Za-z0-9]{3,}/gi,
  /\bAgoda\s+(?:booking\s+)?(?:ID|ref\.?)\b[:\s]*[A-Za-z0-9]{3,}/gi,
];

function scrubText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const re of ID_PATTERNS) out = out.replace(re, '');
  for (const name of NAME_TOKENS) {
    out = out.replace(new RegExp(`\\b${name}\\b`, 'gi'), '');
  }
  // Cleanup artifacts left behind by the removals above: empty parens,
  // dangling separators at the edges, doubled-up separators/spaces.
  out = out
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s·,\-–—]+/, '')
    .replace(/[\s·,\-–—]+$/, '')
    .replace(/([·,\-–—])\s*\1/g, '$1')
    .trim();
  return out;
}

function scrubDeep(value) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

function sanitizeTrip(raw) {
  const trip = structuredClone(raw);

  // Whole sections dropped outright, not just scrubbed.
  delete trip.budget;
  delete trip.budgetCurrency;
  delete trip.checklists; // also sidesteps hardcoded "Packing · Longfen/Gwen" tier labels in the live template

  if (trip.meta) {
    delete trip.meta.lastEditedBy;
    delete trip.meta.lastEditedAt;
  }

  for (const section of ['flights', 'accommodations', 'carRental']) {
    for (const rec of Object.values(trip[section] || {})) {
      delete rec.confirmation;
      delete rec.pdfUrl;
      delete rec.pdfUrl2;
    }
  }

  return scrubDeep(trip);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Same approach as app.js's linkifyText: escape first, then wrap bare
// http(s) URLs as clickable links — kept in sync with that function.
function linkify(s) {
  return esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function navLinks(name, lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return '';
  const q = encodeURIComponent(name || '');
  const gmaps = `https://www.google.com/maps/search/${q}/@${lat},${lon},17z`;
  const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=no`;
  return `<div class="card-links">
    <a class="nav-link" href="${esc(waze)}" target="_blank" rel="noopener">View in Waze →</a>
    <a class="nav-link" href="${esc(gmaps)}" target="_blank" rel="noopener">View in Google Maps →</a>
  </div>`;
}

function renderItinerary(trip) {
  const days = Object.values(trip.itinerary || {});
  days.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.order ?? 0) - (b.order ?? 0));
  return days.map((day) => {
    const planItems = Object.values(day.planItems || {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const planHtml = planItems.length
      ? planItems.map((p) => `<div class="field">${linkify(p.text)}</div>`).join('')
      : (day.plan ? `<div class="field">${linkify(day.plan)}</div>` : '');
    return `<div class="card">
      <div class="date-display"><div class="date-weekday">${esc(fmtDate(day.date))}</div></div>
      <div class="field"><span class="field-label">Location</span>${esc(day.location)}</div>
      ${navLinks(day.location, day.lat, day.lon)}
      ${planHtml}
      ${day.lodging ? `<div class="field"><span class="field-label">Lodging</span>${esc(day.lodging)}</div>` : ''}
      ${day.alt ? `<div class="field"><span class="field-label">Alternate</span>${esc(day.alt)}</div>` : ''}
    </div>`;
  }).join('\n');
}

function renderContacts(trip) {
  const items = Object.values(trip.contacts || {});
  if (!items.length) return '<p class="section-hint">None listed.</p>';
  return `<div class="contact-grid">${items.map((c) => `<div class="card contact-card">
    <div class="field-label">${esc(c.name)}</div>
    <div class="field">${esc(c.ref)}</div>
  </div>`).join('')}</div>`;
}

function renderExtras(trip) {
  const items = Object.values(trip.extras || {});
  if (!items.length) return '<p class="section-hint">None listed.</p>';
  return items.map((x) => `<div class="card">
    <div class="field">${esc(x.item)}</div>
    ${x.notes ? `<div class="field"><span class="field-label">Notes</span>${esc(x.notes)}</div>` : ''}
  </div>`).join('');
}

function renderBookings(trip) {
  const flights = Object.values(trip.flights || {}).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const accom = Object.values(trip.accommodations || {}).sort((a, b) => (a.checkIn || '').localeCompare(b.checkIn || ''));
  const cars = Object.values(trip.carRental || {}).sort((a, b) => (a.pickupDate || '').localeCompare(b.pickupDate || ''));

  const flightsHtml = flights.map((f) => `<div class="card">
    <div class="field"><span class="field-label">${esc(fmtDate(f.date))} · ${esc(f.flightNo)}</span>${esc(f.route)}</div>
    <div class="field">${esc(f.depart)} → ${esc(f.arrive)}</div>
    ${f.notes ? `<div class="field"><span class="field-label">Notes</span>${esc(f.notes)}</div>` : ''}
  </div>`).join('');

  const accomHtml = accom.map((a) => `<div class="card">
    <div class="field"><span class="field-label">${esc(fmtDate(a.checkIn))} → ${esc(fmtDate(a.checkOut))}</span>${esc(a.name)}</div>
    ${navLinks(a.name, a.lat, a.lon)}
    ${a.notes ? `<div class="field"><span class="field-label">Notes</span>${esc(a.notes)}</div>` : ''}
  </div>`).join('');

  const carHtml = cars.map((c) => `<div class="card">
    <div class="field"><span class="field-label">${esc(c.company)}</span>${esc(fmtDate(c.pickupDate))} → ${esc(fmtDate(c.dropoffDate))}</div>
    <div class="field">${esc(c.pickupLocation)} → ${esc(c.dropoffLocation)}</div>
    ${c.notes ? `<div class="field"><span class="field-label">Notes</span>${esc(c.notes)}</div>` : ''}
  </div>`).join('');

  return `<section><h2>✈ Flights</h2>${flightsHtml || '<p class="section-hint">None listed.</p>'}</section>
  <section><h2>🏨 Accommodations</h2>${accomHtml || '<p class="section-hint">None listed.</p>'}</section>
  <section><h2>🚗 Car Rental</h2>${carHtml || '<p class="section-hint">None listed.</p>'}</section>`;
}

function extractStyleBlock() {
  const templateHtml = readFileSync(join(REPO_ROOT, 'template', 'index.html'), 'utf8');
  const match = templateHtml.match(/<style>[\s\S]*?<\/style>/);
  if (!match) throw new Error('Could not find <style> block in template/index.html');
  return match[0];
}

function buildPage(trip, tripId) {
  const style = extractStyleBlock();
  const generatedAt = new Date().toISOString().slice(0, 10);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#16233F">
<meta name="robots" content="noindex, nofollow">
<title>${esc(trip.meta?.title || tripId)} — Trip Preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" rel="stylesheet">
${style}
<style>
  .readonly-banner { font-family: var(--font-mono); font-size: 12px; color: var(--ink-soft); background: var(--brass-soft); border-radius: var(--radius); padding: 10px 14px; margin: 14px 0; }
  .tabs a.tab { text-decoration: none; display: inline-block; }
</style>
</head>
<body>
<div class="wrap">
  <div class="stub">
    <div class="stub-main">
      <p class="stub-eyebrow">Road Trip Dashboard — Preview</p>
      <h1 class="stub-title">${esc(trip.meta?.title || tripId)}</h1>
      <p class="stub-sub">${esc(trip.meta?.subtitle || '')}</p>
    </div>
  </div>
  <p class="readonly-banner">📖 Read-only shareable preview, generated ${esc(generatedAt)} — not live, and some details (budget, packing lists, booking confirmation numbers) are left out on purpose. Ask for the latest if plans have changed.</p>

  <section><h2>Day by day</h2>${renderItinerary(trip)}</section>
  <section><h2>Contacts</h2>${renderContacts(trip)}</section>
  <section><h2>Extras</h2>${renderExtras(trip)}</section>
  <section><h2>Bookings</h2>${renderBookings(trip)}</section>

  <footer>Generated ${esc(generatedAt)} from the live trip dashboard — static, read-only snapshot.</footer>
</div>
</body>
</html>
`;
}

const SLUG_MAP_PATH = join(PROJECT_ROOT, 'share-slugs.json');
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function loadSlugMap() {
  if (!existsSync(SLUG_MAP_PATH)) return {};
  return JSON.parse(readFileSync(SLUG_MAP_PATH, 'utf8'));
}

function saveSlugMap(map) {
  writeFileSync(SLUG_MAP_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
}

function randomSlug(len = 12) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

async function buildOne(tripId) {
  const res = await fetch(`${DB_URL}/trips/${tripId}.json`);
  const raw = await res.json();
  if (!raw || raw.error) {
    console.error(`  ✗ ${tripId}: fetch failed (${raw?.error || 'empty response'})`);
    return;
  }
  const sanitized = sanitizeTrip(raw);

  const slugMap = loadSlugMap();
  const oldSlug = slugMap[tripId];
  if (oldSlug) {
    const oldDir = join(REPO_ROOT, oldSlug);
    if (existsSync(oldDir)) {
      rmSync(oldDir, { recursive: true, force: true });
      console.log(`  · retired old link: ${oldSlug}`);
    }
  }

  const slug = randomSlug();
  const html = buildPage(sanitized, tripId);
  const outDir = join(REPO_ROOT, slug);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');

  slugMap[tripId] = slug;
  saveSlugMap(slugMap);

  console.log(`  ✓ ${tripId} → https://qloof.github.io/xltcixwzpk/${slug}/`);
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    await buildOne(arg);
  } else {
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'trips.json'), 'utf8'));
    for (const t of manifest) await buildOne(t.slug);
  }
}

main();
