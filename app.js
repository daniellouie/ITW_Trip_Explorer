/* ════════════════════════════════════════
   ITW Trip Database — app.js
   ════════════════════════════════════════ */

/* ── CONFIG ── */
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRqhaP4vPUwoFzvmx6-vxPbgOxWqXpwKodb4TQsN52q4Ih2Ca_G9Pp9Cetua_OOyvBf_azibL_IlfE0/pub?gid=64204779&single=true&output=csv';
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
const GEO_CACHE_KEY    = 'itw_geocache_v4';
const GEO_DELAY_MS     = 1100; // Nominatim: max 1 req/sec

/* Column name mappings — update here if the sheet changes */
const COL = {
  timestamp:    'Timestamp',
  trip:         'Trip',
  location:     'Location',
  zipcode:      'Zipcode',
  leaders:      'Leaders',
  depart:       'Depart',
  returnDate:   'Return',
  travelLoc:    'Travel location',
  mileage:      'Mileage',
  gasCost:      'Total Gas Cost',
  itinerary:    'Basic Trip Itinerary',
  skillLevel:   'Trip Skill Level',
  sunrise:      'Sunrise/Sunset',
  weather:      'Weather Update',
  participants: 'Number of Participants Total',
  gearList:     'Individual Gear List for Participants',
  blurb:        'School-wide Email Blurb',
  rangerStation:'Address and phone number of closest ranger station',
  hospital:     'Address and phone number of closest hospital',
};

/* ── TABLE COLUMN DEFINITIONS ── */
const TABLE_COLUMNS = [
  { key: 'trip',         label: 'Trip',            isDate: false, default: true  },
  { key: 'location',     label: 'Location',        isDate: false, default: true  },
  { key: 'skillLevel',   label: 'Skill Level',     isDate: false, default: true  },
  { key: 'depart',       label: 'Depart',          isDate: true,  default: true  },
  { key: 'returnDate',   label: 'Return',          isDate: true,  default: false },
  { key: 'leaders',      label: 'Leaders',         isDate: false, default: true  },
  { key: 'participants', label: 'Participants',     isDate: false, default: false },
  { key: 'mileage',      label: 'Mileage',         isDate: false, default: false },
  { key: 'gasCost',      label: 'Gas Cost',        isDate: false, default: false },
  { key: 'timestamp',    label: 'Submitted',       isDate: true,  default: false },
  { key: 'zipcode',      label: 'Zipcode',         isDate: false, default: false },
  { key: 'travelLoc',    label: 'Travel Location', isDate: false, default: false },
  { key: 'itinerary',    label: 'Itinerary',       isDate: false, default: false },
  { key: 'sunrise',      label: 'Sunrise/Sunset',  isDate: false, default: false },
  { key: 'weather',      label: 'Weather',         isDate: false, default: false },
  { key: 'gearList',     label: 'Gear List',       isDate: false, default: false },
  { key: 'blurb',        label: 'Email Blurb',     isDate: false, default: false },
  { key: 'rangerStation',label: 'Ranger Station',  isDate: false, default: false },
  { key: 'hospital',     label: 'Hospital',        isDate: false, default: false },
];

/* ── STATE ── */
let allTrips        = [];
let filteredTrips   = [];
let map             = null;
let markers         = {};      // tripId → Leaflet marker
let selectedTripId  = null;
let currentView     = 'map';   // 'map' | 'table'
let searchQuery     = '';
let filterLevel     = 'all';
let columnFilters   = []; // [{key, label, value}] — AND logic
let sortColumnKey   = 'depart';
let sortDir         = 'desc';
let activeColumnKeys = TABLE_COLUMNS.filter(c => c.default).map(c => c.key);
let searchTimeout   = null;
let lastUpdated     = null;
let refreshTimer    = null;

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  bindUI();
  await loadData();
  startRefresh();
});

/* ════════════════════════════════════════
   MAP
   ════════════════════════════════════════ */

function initMap() {
  map = L.map('map', {
    center: [37.3, -121.9], // Santa Clara area
    zoom: 8,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);

  // Close panel when clicking the map background
  map.on('click', () => closeTripPanel());
}

function makeIcon(trip, selected = false) {
  const color = selected ? '#ef4444' : '#4361ee';
  const size  = selected ? 22 : 18;
  return L.divIcon({
    className: '',
    html: `<div class="pin-icon${selected ? ' selected' : ''}" style="width:${size}px;height:${size}px;background:${color};"></div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor:[0, -size],
  });
}

function renderMarkers(trips) {
  // Remove old markers
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  trips.forEach(trip => {
    if (!trip._lat || !trip._lng) return;

    const marker = L.marker([trip._lat, trip._lng], { icon: makeIcon(trip) });
    marker.bindPopup(miniPopupHTML(trip), { maxWidth: 240 });

    marker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectTrip(trip);
    });

    marker.addTo(map);
    markers[trip._id] = marker;
  });
}

function selectTrip(trip) {
  // Deselect old
  if (selectedTripId && markers[selectedTripId]) {
    const prev = allTrips.find(t => t._id === selectedTripId);
    if (prev) markers[selectedTripId].setIcon(makeIcon(prev, false));
  }

  selectedTripId = trip._id;

  // Highlight new
  if (markers[trip._id]) {
    markers[trip._id].setIcon(makeIcon(trip, true));
    map.setView([trip._lat, trip._lng], Math.max(map.getZoom(), 11), { animate: true });
  }

  openTripPanel(trip);

  // Highlight table row
  document.querySelectorAll('#trips-tbody tr').forEach(row => {
    row.classList.toggle('selected', row.dataset.id === trip._id);
  });
}

/* ════════════════════════════════════════
   TRIP PANEL
   ════════════════════════════════════════ */

function openTripPanel(trip) {
  const panel = document.getElementById('trip-panel');
  panel.classList.remove('hidden');
  // Force reflow so transition fires
  panel.offsetHeight;
  panel.classList.add('open');
  document.getElementById('trip-panel-content').innerHTML = tripPanelHTML(trip);
}

function closeTripPanel() {
  const panel = document.getElementById('trip-panel');
  panel.classList.remove('open');
  panel.addEventListener('transitionend', () => {
    if (!panel.classList.contains('open')) panel.classList.add('hidden');
  }, { once: true });

  if (selectedTripId && markers[selectedTripId]) {
    const prev = allTrips.find(t => t._id === selectedTripId);
    if (prev) markers[selectedTripId].setIcon(makeIcon(prev, false));
  }
  selectedTripId = null;
}

function miniPopupHTML(trip) {
  return `<div class="popup-mini">
    <div>${escHtml(trip[COL.trip] || 'Unnamed Trip')}</div>
    <div class="popup-level">${escHtml(trip[COL.skillLevel] || '')}</div>
  </div>`;
}

function tripPanelHTML(trip) {
  const depart  = trip[COL.depart]     || '—';
  const ret     = trip[COL.returnDate] || '—';
  const dateStr = depart === ret ? depart : `${depart} – ${ret}`;

  const travelUrl = trip[COL.travelLoc]
    ? `https://www.google.com/maps/search/${encodeURIComponent(trip[COL.travelLoc])}`
    : null;

  return `
    <div class="panel-hero">
      <div class="panel-title">${escHtml(trip[COL.trip] || 'Unnamed Trip')}</div>
      <div class="panel-location">📍 ${escHtml(trip[COL.location] || '')}</div>
    </div>
    <div class="panel-body">
      <div class="panel-stats">
        ${statCard('Dates',        dateStr)}
        ${statCard('Skill Level',  escHtml(trip[COL.skillLevel] || '—'))}
        ${statCard('Leaders',      escHtml(trip[COL.leaders] || '—'))}
        ${statCard('Participants', trip[COL.participants] || '—')}
        ${trip[COL.mileage]  ? statCard('Mileage',      trip[COL.mileage]) : ''}
        ${trip[COL.gasCost]  ? statCard('Gas Cost',     trip[COL.gasCost]) : ''}
      </div>

      ${sectionHTML('Itinerary', trip[COL.itinerary] || trip[COL.blurb] || '')}
      ${sectionHTML('Gear List', trip[COL.gearList]  || '')}
      ${sectionHTML('Weather',   trip[COL.weather]   || '')}
      ${sectionHTML('Sunrise/Sunset', trip[COL.sunrise] || '')}

      ${travelUrl ? `<a class="panel-map-btn" href="${travelUrl}" target="_blank" rel="noopener">
        🗺️ Open in Google Maps
      </a>` : ''}
    </div>
  `;
}

function statCard(label, value) {
  if (!value) return '';
  return `<div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
  </div>`;
}

function sectionHTML(title, text) {
  if (!text || !text.trim()) return '';
  return `<div class="panel-section">
    <div class="panel-section-title">${title}</div>
    <div class="panel-section-body">${escHtml(text).replace(/\n/g, '<br>')}</div>
  </div>`;
}

/* ════════════════════════════════════════
   TABLE
   ════════════════════════════════════════ */

function renderTableHeader() {
  const tr = document.getElementById('trips-thead-row');
  tr.innerHTML = activeColumnKeys.map(key => {
    const col = TABLE_COLUMNS.find(c => c.key === key);
    const isActive = sortColumnKey === key;
    const arrow = isActive
      ? `<span class="sort-arrow">${sortDir === 'asc' ? '↑' : '↓'}</span>`
      : '';
    return `<th data-key="${key}" class="${isActive ? 'sort-active' : ''}">${col.label}${arrow}</th>`;
  }).join('');

  tr.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (sortColumnKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumnKey = key;
        sortDir = 'asc';
      }
      applyFilters();
    });
  });
}

function getCellHTML(trip, key) {
  const val = trip[COL[key]] || '';
  if (key === 'trip') return `<span title="${escAttr(val)}">${escHtml(val || '—')}</span>`;
  return `<span class="td-muted" title="${escAttr(val)}">${escHtml(val || '—')}</span>`;
}

function renderTable(trips) {
  const tbody = document.getElementById('trips-tbody');
  const noResults = document.getElementById('no-results');

  renderTableHeader();

  if (trips.length === 0) {
    tbody.innerHTML = '';
    noResults.classList.remove('hidden');
    return;
  }
  noResults.classList.add('hidden');

  tbody.innerHTML = trips.map(trip => {
    const isSelected = trip._id === selectedTripId ? ' selected' : '';
    const cells = activeColumnKeys.map(key => `<td>${getCellHTML(trip, key)}</td>`).join('');
    return `<tr data-id="${trip._id}"${isSelected ? ' class="selected"' : ''}>${cells}</tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => {
      const trip = allTrips.find(t => t._id === row.dataset.id);
      if (!trip) return;
      openTableDetailPanel(trip);
    });
  });
}

/* ── Table detail panel ── */
function openTableDetailPanel(trip) {
  // Highlight row
  document.querySelectorAll('#trips-tbody tr').forEach(r =>
    r.classList.toggle('selected', r.dataset.id === trip._id)
  );
  selectedTripId = trip._id;

  const panel = document.getElementById('table-detail-panel');
  document.getElementById('table-panel-content').innerHTML = tripPanelHTML(trip);
  panel.classList.remove('hidden');

  // Also add a "View on Map" button behaviour via event delegation
  panel.querySelector('.panel-map-btn')?.addEventListener('click', () => {
    switchView('map');
    if (trip._lat && trip._lng) selectTrip(trip);
  });
}

function closeTableDetailPanel() {
  document.getElementById('table-detail-panel').classList.add('hidden');
  document.querySelectorAll('#trips-tbody tr').forEach(r => r.classList.remove('selected'));
  selectedTripId = null;
}

/* ── Column filter pills ── */
function renderColumnFilterPills() {
  const container = document.getElementById('column-filter-pills');
  if (columnFilters.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = columnFilters.map((f, i) => `
    <span class="filter-pill">
      <span class="filter-pill-col">${escHtml(f.label)}</span>
      <span class="filter-pill-sep">:</span>
      <span class="filter-pill-val" title="${escAttr(f.value)}">${escHtml(f.value)}</span>
      <button class="filter-pill-remove" data-index="${i}" aria-label="Remove ${escAttr(f.label)} filter">×</button>
    </span>
  `).join('') + (columnFilters.length > 1
    ? `<button class="filter-clear-all" id="filter-clear-all">Clear all</button>`
    : '');

  container.querySelectorAll('.filter-pill-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      columnFilters.splice(parseInt(btn.dataset.index), 1);
      renderColumnFilterPills();
      applyFilters();
    });
  });
  document.getElementById('filter-clear-all')?.addEventListener('click', () => {
    columnFilters = [];
    renderColumnFilterPills();
    applyFilters();
  });
}

/* ── Column chooser ── */
function renderColChooser() {
  const dropdown = document.getElementById('col-chooser-dropdown');
  dropdown.innerHTML = TABLE_COLUMNS.map(col => `
    <label>
      <input type="checkbox" data-key="${col.key}" ${activeColumnKeys.includes(col.key) ? 'checked' : ''}>
      ${col.label}
    </label>
  `).join('');

  dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      if (cb.checked) {
        if (!activeColumnKeys.includes(key)) {
          // Insert at original TABLE_COLUMNS order
          const order = TABLE_COLUMNS.map(c => c.key);
          activeColumnKeys = order.filter(k => activeColumnKeys.includes(k) || k === key);
        }
      } else {
        if (activeColumnKeys.length > 1) { // always keep at least one column
          activeColumnKeys = activeColumnKeys.filter(k => k !== key);
        } else {
          cb.checked = true; // revert
        }
      }
      renderTable(filteredTrips);
    });
  });
}

/* ════════════════════════════════════════
   FILTERING & SORTING
   ════════════════════════════════════════ */

function applyFilters() {
  let trips = [...allTrips];

  // Search
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    trips = trips.filter(t =>
      (t[COL.trip]      || '').toLowerCase().includes(q) ||
      (t[COL.location]  || '').toLowerCase().includes(q) ||
      (t[COL.leaders]   || '').toLowerCase().includes(q) ||
      (t[COL.itinerary] || '').toLowerCase().includes(q) ||
      (t[COL.blurb]     || '').toLowerCase().includes(q)
    );
  }

  // Skill level filter
  if (filterLevel !== 'all') {
    trips = trips.filter(t =>
      (t[COL.skillLevel] || '').toLowerCase().includes(filterLevel)
    );
  }

  // Column-specific filters (AND logic — every active filter must match)
  columnFilters.forEach(f => {
    const q = f.value.toLowerCase();
    trips = trips.filter(t => (t[COL[f.key]] || '').toLowerCase().includes(q));
  });

  // Sort by active column
  trips.sort((a, b) => {
    const col = TABLE_COLUMNS.find(c => c.key === sortColumnKey);
    if (!col) return 0;
    const aRaw = (a[COL[sortColumnKey]] || '').trim();
    const bRaw = (b[COL[sortColumnKey]] || '').trim();

    // Participants: strict integers only; invalid data always sinks to bottom
    if (sortColumnKey === 'participants') {
      const aIsInt = /^\d+$/.test(aRaw);
      const bIsInt = /^\d+$/.test(bRaw);
      if (!aIsInt && !bIsInt) return 0;
      if (!aIsInt) return 1;  // invalid always at bottom regardless of direction
      if (!bIsInt) return -1;
      const cmp = parseInt(aRaw, 10) - parseInt(bRaw, 10);
      return sortDir === 'asc' ? cmp : -cmp;
    }

    let cmp;
    if (sortColumnKey === 'skillLevel') {
      cmp = levelOrder(aRaw) - levelOrder(bRaw);
    } else if (col.isDate) {
      cmp = dateVal(aRaw) - dateVal(bRaw);
    } else {
      cmp = aRaw.localeCompare(bRaw);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  filteredTrips = trips;
  renderTable(filteredTrips);

  // In map view: update visible markers
  if (currentView === 'map') {
    renderMarkers(filteredTrips);
  }

  // Update count
  document.getElementById('trip-count').textContent =
    `${filteredTrips.length} trip${filteredTrips.length !== 1 ? 's' : ''}`;
}

function levelOrder(level) {
  const l = (level || '').toLowerCase();
  let order = 4; // unknown/invalid → bottom
  if (l.includes('beginner'))     order = 1;
  if (l.includes('intermediate')) order = 2;
  if (l.includes('advanced'))     order = 3;
  return order; // last match wins — consistent with skill level display
}

/* ════════════════════════════════════════
   DATA LOADING & GEOCODING
   ════════════════════════════════════════ */

async function loadData(isRefresh = false) {
  if (!isRefresh) showLoading(true);

  try {
    const csv = await fetchCSV();
    const parsed = parseCSV(csv);

    // Show data immediately (no coordinates yet)
    allTrips = parsed;
    applyFilters();
    lastUpdated = new Date();
    updateLastUpdated();
    hideError();

    // Hide loading screen as soon as the table/map shell is ready
    if (!isRefresh) showLoading(false);

    // Geocode in the background — markers appear as coordinates come in
    geocodeProgressively(parsed, isRefresh);

  } catch (err) {
    console.error('Failed to load trip data:', err);
    showError('Could not load trip data. Retrying in 5 minutes.');
    if (!isRefresh) showLoading(false);
  }
}

async function geocodeProgressively(trips, isRefresh) {
  const cache = getGeoCache();
  const toGeocode = [];

  trips.forEach(trip => {
    if (!rangerStationAddress(trip)) return; // skip trips with no address
    if (cache[trip._id]) {
      trip._lat = cache[trip._id].lat;
      trip._lng = cache[trip._id].lng;
    } else {
      toGeocode.push(trip);
    }
  });

  // Render whatever we already have from cache immediately
  if (currentView === 'map') renderMarkers(filteredTrips);

  for (let i = 0; i < toGeocode.length; i++) {
    if (i > 0) await sleep(GEO_DELAY_MS);
    const trip = toGeocode[i];
    const result = await geocodeTrip(trip);
    if (result) {
      trip._lat = result.lat;
      trip._lng = result.lng;
      cache[trip._id] = result;
      if (filteredTrips.includes(trip) && currentView === 'map') {
        addSingleMarker(trip);
      }
    }
  }

  if (toGeocode.length > 0) saveGeoCache(cache);
}

async function fetchCSV() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseCSV(csvText) {
  // The sheet has a "Table 1" title row before the real header row — drop it
  const lines = csvText.split('\n');
  const firstCell = lines[0].split(',')[0].trim().replace(/^"|"$/g, '');
  const cleaned = (firstCell.toLowerCase() === 'table 1' || firstCell === '')
    ? lines.slice(1).join('\n')
    : csvText;

  const result = Papa.parse(cleaned, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });
  return result.data.map((row) => {
    const raw = (row[COL.timestamp] || '') + '|' + (row[COL.trip] || '');
    row._id  = hashStr(raw);
    row._lat = null;
    row._lng = null;
    return row;
  });
}

/* ── Geocoding ── */

function getGeoCache() {
  try {
    return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || '{}');
  } catch { return {}; }
}

function saveGeoCache(cache) {
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

function addSingleMarker(trip) {
  if (!trip._lat || !trip._lng) return;
  if (markers[trip._id]) return; // already exists
  const marker = L.marker([trip._lat, trip._lng], { icon: makeIcon(trip) });
  marker.bindPopup(miniPopupHTML(trip), { maxWidth: 240 });
  marker.on('click', (e) => {
    L.DomEvent.stopPropagation(e);
    selectTrip(trip);
  });
  marker.addTo(map);
  markers[trip._id] = marker;
}

function rangerStationAddress(trip) {
  const raw = (trip[COL.rangerStation] || '').trim();
  if (!raw) return null;

  let s = raw;
  // Remove phone numbers anywhere in the string: (xxx) xxx-xxxx or xxx-xxx-xxxx or xxx.xxx.xxxx
  s = s.replace(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g, '');
  // Remove labels like "Phone number:", "Phone:", "Ph:"
  s = s.replace(/phone\s*(number)?\s*:?/gi, '');
  // Remove standalone punctuation debris left over
  s = s.replace(/^[\s,.\-–]+|[\s,.\-–]+$/g, '').trim();
  // Collapse multiple spaces/commas
  s = s.replace(/\s{2,}/g, ' ').replace(/,\s*,/g, ',').trim();

  return s || null;
}

async function geocodeTrip(trip) {
  const addr = rangerStationAddress(trip);
  if (!addr) return null;
  try {
    return await nominatimLookup(addr);
  } catch {
    return null;
  }
}

async function nominatimLookup(query) {
  // Constrain to western US (CA, NV, OR, AZ, UT, WA) to prevent mis-geocoding
  // viewbox format: west,south,east,north
  const viewbox = '-124.5,32.5,-109.0,49.0';
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=${viewbox}&bounded=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'ITW-Trip-Tool/1.0' }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

/* ════════════════════════════════════════
   VIEW SWITCHING
   ════════════════════════════════════════ */

function switchView(view) {
  currentView = view;

  document.getElementById('map-view').classList.toggle('hidden',   view !== 'map');
  document.getElementById('table-view').classList.toggle('hidden', view !== 'table');
  document.getElementById('btn-map-view').classList.toggle('active',   view === 'map');
  document.getElementById('btn-table-view').classList.toggle('active', view === 'table');
  document.getElementById('btn-map-view').setAttribute('aria-selected',   String(view === 'map'));
  document.getElementById('btn-table-view').setAttribute('aria-selected', String(view === 'table'));

  if (view === 'map') {
    // Leaflet needs a size invalidation after being hidden
    setTimeout(() => map && map.invalidateSize(), 50);
    renderMarkers(filteredTrips);
  }
}

/* ════════════════════════════════════════
   UI BINDINGS
   ════════════════════════════════════════ */

function bindUI() {
  // View toggle
  document.getElementById('btn-map-view').addEventListener('click', () => switchView('map'));
  document.getElementById('btn-table-view').addEventListener('click', () => switchView('table'));

  // Search
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    searchClear.classList.toggle('hidden', !searchQuery);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(applyFilters, 300);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClear.classList.add('hidden');
    applyFilters();
    searchInput.focus();
  });

  // Filter chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      filterLevel = chip.dataset.level;
      applyFilters();
    });
  });

  // Column chooser toggle
  const colBtn = document.getElementById('col-chooser-btn');
  const colDropdown = document.getElementById('col-chooser-dropdown');
  renderColChooser();

  colBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !colDropdown.classList.contains('hidden');
    colDropdown.classList.toggle('hidden', isOpen);
    colBtn.classList.toggle('open', !isOpen);
    colBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  // Add Filter dropdown
  const colFilterBtn      = document.getElementById('col-filter-btn');
  const colFilterDropdown = document.getElementById('col-filter-dropdown');
  const colFilterSelect   = document.getElementById('col-filter-select');
  const colFilterInput    = document.getElementById('col-filter-input');
  const colFilterAddBtn   = document.getElementById('col-filter-add-btn');

  // Populate column select
  TABLE_COLUMNS.forEach(col => {
    const opt = document.createElement('option');
    opt.value = col.key;
    opt.textContent = col.label;
    colFilterSelect.appendChild(opt);
  });

  colFilterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !colFilterDropdown.classList.contains('hidden');
    colFilterDropdown.classList.toggle('hidden', isOpen);
    colFilterBtn.classList.toggle('open', !isOpen);
    colFilterBtn.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) setTimeout(() => colFilterInput.focus(), 50);
  });

  function commitColFilter() {
    const key   = colFilterSelect.value;
    const value = colFilterInput.value.trim();
    if (!key || !value) return;
    const col = TABLE_COLUMNS.find(c => c.key === key);
    columnFilters.push({ key, label: col.label, value });
    colFilterInput.value = '';
    colFilterDropdown.classList.add('hidden');
    colFilterBtn.classList.remove('open');
    colFilterBtn.setAttribute('aria-expanded', 'false');
    renderColumnFilterPills();
    applyFilters();
  }

  colFilterAddBtn.addEventListener('click', commitColFilter);
  colFilterInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  commitColFilter();
    if (e.key === 'Escape') {
      colFilterDropdown.classList.add('hidden');
      colFilterBtn.classList.remove('open');
      colFilterBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // Close both dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!document.getElementById('col-chooser').contains(e.target)) {
      colDropdown.classList.add('hidden');
      colBtn.classList.remove('open');
      colBtn.setAttribute('aria-expanded', 'false');
    }
    if (!document.getElementById('col-filter').contains(e.target)) {
      colFilterDropdown.classList.add('hidden');
      colFilterBtn.classList.remove('open');
      colFilterBtn.setAttribute('aria-expanded', 'false');
    }
  });

  // Close map trip panel
  document.getElementById('trip-panel-close').addEventListener('click', closeTripPanel);

  // Close table detail panel
  document.getElementById('table-panel-close').addEventListener('click', closeTableDetailPanel);

  // Error banner close
  document.getElementById('error-close').addEventListener('click', hideError);
}

/* ── Auto-refresh ── */
function startRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => loadData(true), REFRESH_INTERVAL);
}

function updateLastUpdated() {
  if (!lastUpdated) return;
  const el = document.getElementById('last-updated');
  el.textContent = `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/* ════════════════════════════════════════
   LOADING / ERROR UI
   ════════════════════════════════════════ */

function showLoading(show) {
  const overlay = document.getElementById('loading-overlay');
  if (show) {
    overlay.classList.remove('fade-out');
    overlay.style.display = '';
  } else {
    overlay.classList.add('fade-out');
    setTimeout(() => { overlay.style.display = 'none'; }, 450);
  }
}

function showError(msg) {
  document.getElementById('error-text').textContent = msg;
  document.getElementById('error-banner').classList.remove('hidden');
  document.getElementById('footer-status').textContent = '⚠ Data unavailable';
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
  document.getElementById('footer-status').textContent = '';
}

/* ════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════ */

function dateVal(raw) {
  if (!raw) return 0;
  const d = new Date(raw);
  return isNaN(d) ? 0 : d.getTime();
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function escAttr(str) {
  return (str || '').replace(/"/g, '&quot;');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* Simple non-cryptographic string hash for stable IDs */
function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}
