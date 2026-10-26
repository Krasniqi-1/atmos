const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const HOUR = 3_600_000;
const state = {
  mode: 'live', explicitMode: false, page: 'overview', metric: 'temperature', range: 60,
  readings: [], demo: [], connected: false, loaded: false, setup: null, sketch: '', chart: null,
  logFilter: { preset: '24h', from: '', to: '' }, history: { rows: [], count: 0, loading: false, error: '', loaded: false }, exporting: false,
  exportMetrics: ['temperature', 'humidity']
};
try {
  const preferred = sessionStorage.getItem('atmos-source');
  if (['live', 'demo'].includes(preferred)) { state.mode = preferred; state.explicitMode = true; }
} catch { /* Storage-disabled browsers still work. */ }
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const fullTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
$('#today').textContent = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
let toastTimeout;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function currentReadings() { return state.mode === 'demo' ? state.demo : state.readings; }
function latest() { return currentReadings().at(-1); }
function sampleDemo(t) {
  const x = t / HOUR;
  return {
    deviceId: 'demo-room', readingId: `demo-${t}`,
    temperature: +(23.1 + .64 * Math.sin(x * 2.3) + .19 * Math.sin(x * 15.2) + .05 * Math.sin(x * 180)).toFixed(1),
    humidity: +(47.4 + 3.6 * Math.sin(x * 1.1) + .8 * Math.sin(x * 17) + .2 * Math.cos(x * 140)).toFixed(1),
    rssi: -56 - Math.round(4 * (1 + Math.sin(x * 4))),
    measuredAt: new Date(t).toISOString(), receivedAt: new Date(t).toISOString(), uptimeMs: 3_675_000
  };
}
function updateDemo() {
  const end = Math.floor(Date.now() / 6000) * 6000;
  if (!state.demo.length) {
    for (let t = end - 24 * HOUR; t <= end; t += 6000) state.demo.push(sampleDemo(t));
    return true;
  }
  let changed = false;
  for (let t = Date.parse(state.demo.at(-1).measuredAt) + 6000; t <= end; t += 6000) {
    state.demo.push(sampleDemo(t)); changed = true;
  }
  state.demo = state.demo.filter(r => Date.parse(r.measuredAt) >= end - 24 * HOUR);
  return changed;
}
function setMode(mode, explicit = true) {
  state.mode = mode;
  if (explicit) {
    state.explicitMode = true;
    try { sessionStorage.setItem('atmos-source', mode); } catch { /* Optional preference. */ }
  }
  if (mode === 'demo') updateDemo();
  render();
  if (state.page === 'readings') refreshLogHistory();
}
function changePage() {
  const name = location.hash.slice(1) || 'overview';
  state.page = ['overview', 'readings', 'setup'].includes(name) ? name : 'overview';
  const labels = {
    overview: ['Overview', 'Your room, in real time', 'Small changes. A clearer picture of the space around you.'],
    readings: ['Reading log', 'Every reading tells a story', 'A closer look at the changes in your environment.'],
    setup: ['Device setup', 'Meet your little observatory', 'Three simple steps from a sensor to a clearer picture.']
  };
  const [breadcrumb, title, description] = labels[state.page];
  $('#breadcrumb').textContent = breadcrumb;
  $('#page-title').replaceChildren(document.createTextNode(title), Object.assign(document.createElement('span'), { textContent: '.' }));
  $('#page-description').textContent = description;
  $('#export').hidden = state.page === 'setup';
  for (const name of ['overview', 'readings', 'setup']) $(`#${name}-page`).hidden = state.page !== name;
  $$('.nav-item').forEach(link => {
    const active = link.dataset.page === state.page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  if (state.page === 'setup') loadSetup();
  $('#log-date-filter').hidden = state.page !== 'readings';
  closeDateFilter(false);
  render();
  if (state.page === 'readings') refreshLogHistory();
}
window.addEventListener('hashchange', changePage);
$('#connect-device').addEventListener('click', () => { location.hash = 'setup'; });
$('#open-setup').addEventListener('click', () => { location.hash = 'setup'; });
$('#empty-demo').addEventListener('click', () => setMode('demo'));
$$('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$$('[data-metric]').forEach(button => button.addEventListener('click', () => {
  state.metric = button.dataset.metric;
  renderChart();
}));
$$('[data-range]').forEach(button => button.addEventListener('click', () => {
  state.range = Number(button.dataset.range);
  renderChart();
}));
const display = (value, suffix = '') => Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : '—';
function updateConnection() {
  const row = latest();
  const demo = state.mode === 'demo';
  const age = row ? Math.max(0, Date.now() - Date.parse(row.measuredAt)) : Infinity;
  const stale = age > 20000;
  let label = 'Awaiting device', css = '';
  if (demo) { label = 'Simulated feed'; css = 'is-demo'; }
  else if (!state.connected) { label = state.loaded ? 'Server disconnected' : 'Connecting…'; css = 'is-stale'; }
  else if (row && !stale) { label = 'Live · every 6s'; css = 'is-live'; }
  else if (row) { label = 'Readings stale'; css = 'is-stale'; }
  const feed = $('#feed-state');
  feed.textContent = label;
  feed.className = `feed-state ${css}`;
  $('#connection-notice').hidden = state.connected || !state.loaded;
  const topPill = $('.local-pill');
  topPill.lastChild.textContent = state.connected ? ' Local server' : ' Server offline';
  $('#device-badge').textContent = demo ? 'Demo feed' : !state.connected ? 'Disconnected' : !row ? 'No device' : stale ? 'Stale' : 'Connected';
  $('#last-seen').textContent = !row ? 'Not yet' : age < 1000 ? 'Just now' : age < 60000 ? `${Math.floor(age / 1000)} sec ago` : age < HOUR ? `${Math.floor(age / 60000)} min ago` : `${Math.floor(age / HOUR)} hr ago`;
  $('#last-seen').title = row ? dateTime.format(new Date(row.measuredAt)) : 'No measurements';
  if (row && stale && !demo) {
    $('#temperature-tag').textContent = 'Last known reading';
    $('#humidity-tag').textContent = 'Last known reading';
    $('#comfort-title').textContent = 'A pause in the picture.';
    $('#comfort-description').textContent = 'No fresh measurement for over 20 seconds. Check your sensor and Wi-Fi.';
  }
  $('#footer-status').textContent = demo ? 'DEMO DATA · SIMULATED' : 'LOCAL FIRST. ALWAYS.';
  // The wiring represents real device contact, independent of the demo selector.
  const deviceRow = state.readings.at(-1);
  const deviceAge = deviceRow ? Math.max(0, Date.now() - Date.parse(deviceRow.measuredAt)) : Infinity;
  const deviceOnline = state.connected && deviceAge <= 20000;
  const wiring = $('#wiring-diagram');
  const connection = deviceOnline ? 'online' : 'offline';
  if (wiring.dataset.connection !== connection) {
    wiring.dataset.connection = connection;
    wiring.setAttribute('aria-label', `ESP32 to DHT22 wiring. Device ${connection}; wires ${deviceOnline ? 'connected and energized' : 'disconnected'}. 3V3 to VCC, GPIO 27 to DATA, GND to GND.`);
  }
  const wiringLabel = deviceOnline ? 'Device online' : !state.connected && state.loaded ? 'Connection interrupted' : 'Device offline';
  if ($('#wiring-status').textContent !== wiringLabel) $('#wiring-status').textContent = wiringLabel;
  $('#wiring-status').classList.toggle('is-online', deviceOnline);
  $('#wiring-status-detail').textContent = deviceOnline ? 'Live signal · every 6s' : !state.connected && state.loaded ? 'Reconnecting to the local server' : deviceRow ? 'No fresh reading for over 20s' : 'Waiting for a live reading';
}
function renderMetrics() {
  const rows = currentReadings();
  const row = rows.at(-1), previous = rows.at(-2);
  $('#temperature').textContent = display(row?.temperature);
  $('#humidity').textContent = display(row?.humidity);
  const t = row?.temperature, h = row?.humidity;
  $('#temperature-tag').textContent = row ? t < 20 ? 'On the cool side' : t > 26 ? 'On the warm side' : 'In balance' : 'Awaiting reading';
  $('#humidity-tag').textContent = row ? h < 40 ? 'On the dry side' : h > 60 ? 'On the humid side' : 'In balance' : 'Awaiting reading';
  for (const metric of ['temperature', 'humidity']) {
    const delta = previous && row ? row[metric] - previous[metric] : null;
    $(`#${metric}-change`).textContent = delta == null ? 'Every 6 seconds' : Math.abs(delta) < .05 ? 'Steady since last reading' : `${delta > 0 ? '↗' : '↘'} ${Math.abs(delta).toFixed(1)}${metric === 'temperature' ? '°' : '%'} since last reading`;
  }
  $('#signal').textContent = row?.rssi != null && row.rssi > -127 ? `${row.rssi} dBm` : 'Unavailable';
  $('#signal').title = row?.rssi == null ? '' : row.rssi > -60 ? 'Strong signal' : row.rssi > -75 ? 'Fair signal' : 'Weak or unavailable signal';
  // Magnus approximation for water vapour; undefined at zero relative humidity.
  const alpha = row && h > 0 ? Math.log(h / 100) + (17.62 * t) / (243.12 + t) : NaN;
  const dewPoint = 243.12 * alpha / (17.62 - alpha);
  $('#dew-point').textContent = display(dewPoint, ' °C');
  $('#comfort-title').textContent = !row ? 'Ready to observe.' : t < 20 ? 'A little on the cool side.' : t > 26 ? 'A little on the warm side.' : 'A nicely balanced space.';
  $('#comfort-description').textContent = !row ? 'Connect your sensor to get a feel for your environment.' : t >= 20 && t <= 26 ? 'Temperature sits within the 20–26°C reference band.' : 'Temperature is outside the 20–26°C reference band.';
  $('#comfort-marker').style.left = `${row ? Math.max(1, Math.min(98, (t - 10) / 25 * 100)) : 50}%`;
  $('#comfort-marker').hidden = !row;
}
function chartRows() {
  const cutoff = Date.now() - state.range * 60000;
  return currentReadings().filter(r => Date.parse(r.measuredAt) >= cutoff);
}
function niceStep(n) {
  const exponent = Math.pow(10, Math.floor(Math.log10(n)));
  const base = n / exponent;
  return (base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10) * exponent;
}
function renderChart() {
  if (state.page !== 'overview') return;
  const svg = $('#climate-chart');
  const rows = chartRows();
  const metric = state.metric;
  const isTemp = metric === 'temperature';
  const unit = isTemp ? '°C' : '%';
  const color = isTemp ? '#859e61' : '#7197aa';
  $$('[data-metric]').forEach(button => {
    const active = button.dataset.metric === metric;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
  });
  $$('[data-range]').forEach(button => {
    const active = +button.dataset.range === state.range;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
  });
  $('#legend-label').textContent = isTemp ? 'Temperature' : 'Relative humidity';
  $('#legend-dot').style.background = color;
  $('#chart-current').textContent = display(rows.at(-1)?.[metric], ` ${unit}`);
  $('#chart-current').style.color = color;
  $('#chart-count').textContent = `${rows.length.toLocaleString()} reading${rows.length === 1 ? '' : 's'} in this window`;
  const values = rows.map(r => r[metric]);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  $('#chart-min').textContent = display(min, ` ${unit}`);
  $('#chart-average').textContent = display(average, ` ${unit}`);
  $('#chart-max').textContent = display(max, ` ${unit}`);
  $('#chart-empty').hidden = rows.length > 0;

  const width = Math.max(250, $('#chart-container').clientWidth);
  const height = $('#chart-container').clientHeight;
  const left = 38, right = width - 13, top = 14, bottom = height - 31;
  const end = Date.now(), start = end - state.range * 60000;
  const span = min == null ? 2 : Math.max(isTemp ? 1 : 4, max - min);
  const step = niceStep(span / 3);
  const lo = min == null ? (isTemp ? 20 : 40) : Math.floor((min - span * .15) / step) * step;
  const hi = min == null ? (isTemp ? 26 : 60) : Math.ceil((max + span * .15) / step) * step;
  const x = t => left + (t - start) / (end - start) * (right - left);
  const y = v => bottom - (v - lo) / (hi - lo) * (bottom - top);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('tabindex', rows.length ? '0' : '-1');
  svg.setAttribute('aria-label', `${isTemp ? 'Temperature' : 'Humidity'} over the last ${state.range < 60 ? `${state.range} minutes` : `${state.range / 60} hours`}. ${rows.length} readings. Use left and right arrows to inspect readings.`);
  let html = `<title>${isTemp ? 'Temperature' : 'Humidity'} history</title><desc>Minimum ${display(min, unit)}, average ${display(average, unit)}, maximum ${display(max, unit)}. Missing measurements appear as gaps. Demo readings are simulated.</desc><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".16"/><stop offset="100%" stop-color="${color}" stop-opacity=".015"/></linearGradient></defs>`;
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * i / 4, yy = y(v);
    html += `<line class="grid-line" x1="${left}" y1="${yy}" x2="${right}" y2="${yy}"/><text x="0" y="${yy + 3}">${v.toFixed(isTemp ? 1 : 0)}${isTemp ? '°' : '%'}</text>`;
  }
  const ticks = width < 450 ? 3 : 6;
  for (let i = 0; i <= ticks; i++) {
    const t = start + (end - start) * i / ticks;
    html += `<text x="${x(t)}" y="${height - 7}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${timeFormat.format(new Date(t))}</text>`;
  }
  // Min/max buckets preserve short-lived spikes while bounding SVG complexity.
  const rawSegments = [];
  let segment = [];
  // Identify outages before downsampling so wide windows preserve every real gap.
  for (const row of rows) {
    const previous = segment.at(-1);
    if (previous && Date.parse(row.measuredAt) - Date.parse(previous.measuredAt) > 18000) { rawSegments.push(segment); segment = []; }
    segment.push(row);
  }
  if (segment.length) rawSegments.push(segment);
  const bucketSize = Math.max(1, Math.ceil(rows.length / 300));
  const segments = rawSegments.map(raw => {
    const plotted = [];
    for (let i = 0; i < raw.length; i += bucketSize) {
      const bucket = raw.slice(i, i + bucketSize);
      const indexes = new Set([0, bucket.length - 1]);
      let low = 0, high = 0;
      bucket.forEach((r, j) => { if (r[metric] < bucket[low][metric]) low = j; if (r[metric] > bucket[high][metric]) high = j; });
      indexes.add(low); indexes.add(high);
      for (const j of [...indexes].sort((a, b) => a - b)) plotted.push(bucket[j]);
    }
    return plotted;
  });
  for (const points of segments) {
    const coordinates = points.map(r => [x(Date.parse(r.measuredAt)).toFixed(2), y(r[metric]).toFixed(2)]);
    const line = coordinates.map(([xx, yy], i) => `${i ? 'L' : 'M'}${xx},${yy}`).join(' ');
    if (coordinates.length > 1) html += `<path d="${line} L${coordinates.at(-1)[0]},${bottom} L${coordinates[0][0]},${bottom} Z" fill="url(#chart-fill)"/><path class="data-line" d="${line}" stroke="${color}"/>`;
    else html += `<circle cx="${coordinates[0][0]}" cy="${coordinates[0][1]}" r="3" fill="${color}"/>`;
  }
  if (rows.length) {
    const last = rows.at(-1);
    html += `<circle class="data-dot" cx="${x(Date.parse(last.measuredAt))}" cy="${y(last[metric])}" r="4" fill="${color}"/>`;
  }
  html += `<g id="chart-cursor" visibility="hidden"><line class="chart-cursor" x1="0" x2="0" y1="${top}" y2="${bottom}"/><circle class="data-dot" r="4" fill="${color}"/></g>`;
  svg.innerHTML = html;
  state.chart = { rows, start, end, left, right, x, y, unit, index: rows.length - 1 };
  $('#chart-tooltip').hidden = true;
}
function showChartPoint(index) {
  const chart = state.chart;
  if (!chart?.rows.length) return;
  chart.index = Math.max(0, Math.min(index, chart.rows.length - 1));
  const row = chart.rows[chart.index];
  const xx = chart.x(Date.parse(row.measuredAt)), yy = chart.y(row[state.metric]);
  const cursor = $('#chart-cursor');
  cursor.setAttribute('visibility', 'visible');
  cursor.querySelector('line').setAttribute('x1', xx);
  cursor.querySelector('line').setAttribute('x2', xx);
  cursor.querySelector('circle').setAttribute('cx', xx);
  cursor.querySelector('circle').setAttribute('cy', yy);
  const tooltip = $('#chart-tooltip');
  tooltip.replaceChildren(Object.assign(document.createElement('span'), { textContent: fullTime.format(new Date(row.measuredAt)) }), document.createTextNode(display(row[state.metric], ` ${chart.unit}`)));
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(0, Math.min(xx - 52, $('#chart-container').clientWidth - 120))}px`;
  tooltip.style.top = `${Math.max(0, yy - 68)}px`;
}
$('#climate-chart').addEventListener('pointermove', event => {
  const chart = state.chart;
  if (!chart?.rows.length) return;
  const xx = event.clientX - $('#climate-chart').getBoundingClientRect().left;
  const time = chart.start + (xx - chart.left) / (chart.right - chart.left) * (chart.end - chart.start);
  let low = 0, high = chart.rows.length - 1;
  while (low < high) { const mid = Math.floor((low + high) / 2); if (Date.parse(chart.rows[mid].measuredAt) < time) low = mid + 1; else high = mid; }
  if (low > 0 && Math.abs(Date.parse(chart.rows[low - 1].measuredAt) - time) < Math.abs(Date.parse(chart.rows[low].measuredAt) - time)) low--;
  showChartPoint(low);
});
function hideTooltip() { $('#chart-cursor')?.setAttribute('visibility', 'hidden'); $('#chart-tooltip').hidden = true; }
$('#climate-chart').addEventListener('pointerleave', hideTooltip);
$('#climate-chart').addEventListener('blur', hideTooltip);
$('#climate-chart').addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && state.chart) {
    event.preventDefault(); showChartPoint(state.chart.index + (event.key === 'ArrowLeft' ? -1 : 1));
  }
});
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 80); }).observe($('#chart-container'));

const filterNames = { '15m': 'Last 15 minutes', '1h': 'Last hour', '24h': 'Last 24 hours', today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', all: 'All saved data', custom: 'Custom range' };
const exportMetricHeaders = { temperature: 'temperature_c', humidity: 'humidity_percent' };
function exportMetricLabel(metrics = state.exportMetrics, short = false) {
  return metrics.length === 2 ? (short ? 'Temp + humidity' : 'Temperature + humidity') : metrics[0] === 'temperature' ? 'Temperature' : 'Humidity';
}
function filterBounds(filter = state.logFilter, now = new Date()) {
  const end = now.getTime();
  if (filter.preset === 'all') return null;
  if (filter.preset === 'custom') return { from: new Date(filter.from).getTime(), to: new Date(filter.to).getTime() + 60000 };
  if (filter.preset === 'today' || filter.preset === 'yesterday') {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const previous = filter.preset === 'yesterday';
    return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (previous ? 1 : 0)).getTime(), to: previous ? midnight.getTime() : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() };
  }
  const duration = { '15m': HOUR / 4, '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR }[filter.preset];
  return { from: end - duration, to: end + 1 };
}
function rangeParams(bounds) {
  return bounds ? new URLSearchParams({ from: new Date(bounds.from).toISOString(), to: new Date(bounds.to).toISOString() }) : new URLSearchParams({ all: '1' });
}
function filterDemoRows(bounds = filterBounds()) {
  return state.demo.filter(row => !bounds || (Date.parse(row.measuredAt) >= bounds.from && Date.parse(row.measuredAt) < bounds.to));
}
function localInput(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
const rangeDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function rangeDescription(bounds) {
  return bounds ? `${rangeDateFormat.format(new Date(bounds.from))} – ${rangeDateFormat.format(new Date(bounds.to - 1))}` : 'Every available reading in your saved logs.';
}
function updateFilterDraft() {
  const custom = $('#log-range').value === 'custom';
  $('#custom-date-fields').hidden = !custom;
  $('#log-from').required = custom; $('#log-to').required = custom;
  $('#filter-error').hidden = true;
  $('#filter-range-preview').textContent = custom ? 'The entire selected end minute is included.' : rangeDescription(filterBounds({ preset: $('#log-range').value }));
}
function closeDateFilter(returnFocus = true) {
  const wasOpen = !$('#date-filter-panel').hidden;
  $('#date-filter-panel').hidden = true;
  $('#date-filter-toggle').setAttribute('aria-expanded', 'false');
  if (wasOpen && returnFocus) $('#date-filter-toggle').focus();
}
$('#date-filter-toggle').addEventListener('click', () => {
  if (!$('#date-filter-panel').hidden) return closeDateFilter();
  const initial = filterBounds() ?? { from: Date.now() - 24 * HOUR, to: Date.now() };
  $('#log-range').value = state.logFilter.preset;
  $('#log-from').value = state.logFilter.from || localInput(new Date(initial.from));
  $('#log-to').value = state.logFilter.to || localInput(new Date(initial.to - 1));
  $('#export-temperature').checked = state.exportMetrics.includes('temperature');
  $('#export-humidity').checked = state.exportMetrics.includes('humidity');
  updateFilterDraft();
  $('#filter-timezone-label').textContent = `Local time · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  $('#date-filter-panel').hidden = false;
  $('#date-filter-toggle').setAttribute('aria-expanded', 'true');
  $('#log-range').focus();
});
$('#log-range').addEventListener('change', updateFilterDraft);
document.addEventListener('click', event => { if (!$('#log-date-filter').contains(event.target)) closeDateFilter(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDateFilter(); });
function applyLogFilter(filter, metrics = state.exportMetrics) {
  state.logFilter = filter.preset === 'custom' ? filter : { preset: filter.preset, from: '', to: '' };
  state.exportMetrics = [...metrics];
  state.history = { rows: [], count: 0, loading: false, loaded: false, error: '' };
  const bounds = filterBounds();
  $('#date-filter-label').textContent = filterNames[filter.preset];
  $('#date-filter-toggle').title = rangeDescription(bounds);
  $('#export-metrics-label').textContent = exportMetricLabel(metrics, true);
  closeDateFilter();
  refreshLogHistory();
}
$('#date-filter-form').addEventListener('submit', event => {
  event.preventDefault();
  const filter = { preset: $('#log-range').value, from: $('#log-from').value, to: $('#log-to').value };
  const metrics = $$('#export-metrics input:checked').map(input => input.value);
  if (!metrics.length) {
    $('#filter-error').textContent = 'Select Temperature, Humidity, or both to export.';
    $('#filter-error').hidden = false;
    $('#export-temperature').focus();
    return;
  }
  if (filter.preset === 'custom') {
    const from = new Date(filter.from).getTime(), to = new Date(filter.to).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      $('#filter-error').textContent = 'Choose valid dates, with the start at or before the end.';
      $('#filter-error').hidden = false;
      return;
    }
  }
  applyLogFilter(filter, metrics);
});
$$('#export-metrics input').forEach(input => input.addEventListener('change', () => { $('#filter-error').hidden = true; }));
$('#reset-date-filter').addEventListener('click', () => applyLogFilter({ preset: '24h', from: '', to: '' }, ['temperature', 'humidity']));
let historyController, historyRefreshTimer, historyRequest = 0;
async function refreshLogHistory() {
  clearTimeout(historyRefreshTimer);
  historyController?.abort();
  const request = ++historyRequest;
  if (state.page !== 'readings' || state.mode === 'demo') { renderLog(); return; }
  historyController = new AbortController();
  state.history.loading = true; state.history.error = '';
  renderLog();
  try {
    const response = await fetch(`/api/history?${rangeParams(filterBounds())}`, { signal: historyController.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load saved readings. Check that the latest server is running, then retry.');
    const data = await response.json();
    if (request !== historyRequest) return;
    state.history = { rows: data.readings, count: data.count, loading: false, loaded: true, error: '' };
  } catch (error) {
    if (request !== historyRequest || error.name === 'AbortError') return;
    state.history = { rows: [], count: 0, loading: false, loaded: false, error: error.message };
  }
  renderLog();
}
function scheduleLogRefresh() {
  if (state.page === 'readings' && state.mode === 'live' && !state.history.loading) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(refreshLogHistory, 200);
  }
}
$('#retry-history').addEventListener('click', refreshLogHistory);
function renderLog() {
  if (state.page !== 'readings') return;
  const demo = state.mode === 'demo';
  const all = demo ? filterDemoRows().reverse().slice(0, 100) : state.history.rows;
  const count = demo ? filterDemoRows().length : state.history.count;
  $('#log-summary').textContent = !demo && state.history.loading ? 'Loading saved readings…' : `${count.toLocaleString()} matching · ${demo ? 'Simulated' : 'Device data'}`;
  const selectedRange = state.logFilter.preset === 'custom' ? rangeDescription(filterBounds()) : filterNames[state.logFilter.preset];
  $('#log-table-note').textContent = `${selectedRange} · Showing the latest ${Math.min(100, count).toLocaleString()} matches. Export CSV includes every match · ${exportMetricLabel()}.${demo ? ' Demo has only 24 hours of simulated history.' : ''}`;
  $('#history-error').hidden = demo || !state.history.error;
  $('#history-error span').textContent = state.history.error;
  $('#readings-page').setAttribute('aria-busy', !demo && state.history.loading);
  const tbody = $('#readings-body');
  tbody.replaceChildren();
  if (!all.length) {
    const row = tbody.insertRow();
    const cell = row.insertCell(); cell.colSpan = 5; cell.className = 'empty-table';
    cell.textContent = !demo && state.history.loading ? 'Loading readings for your selected time range…' : !demo && state.history.error ? 'Saved readings are unavailable. Retry when the server is connected.' : 'No readings in this time range. Choose another date or time span.';
    return;
  }
  for (const reading of all) {
    const row = tbody.insertRow();
    [dateTime.format(new Date(reading.measuredAt)), display(reading.temperature, ' °C'), display(reading.humidity, ' %'), reading.rssi != null ? `${reading.rssi} dBm` : '—'].forEach(value => { row.insertCell().textContent = value; });
    const cell = row.insertCell();
    const badge = document.createElement('span'); badge.className = 'table-source'; badge.textContent = state.mode === 'demo' ? 'Simulated' : 'ESP32'; cell.append(badge);
  }
}
function render() {
  $$('[data-mode]').forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', active);
  });
  $('#demo-notice').hidden = state.mode !== 'demo';
  renderMetrics(); updateConnection(); renderChart(); renderLog();
}
function mergeReadings(rows) {
  const byId = new Map(state.readings.map(r => [r.readingId, r]));
  const cutoff = Date.now() - 24 * HOUR;
  for (const row of rows) byId.set(row.readingId, row);
  state.readings = [...byId.values()].filter(r => Date.parse(r.measuredAt) >= cutoff).sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt)).slice(-20000);
}
async function syncHistory() {
  const response = await fetch('/api/readings', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not fetch measurements');
  const data = await response.json();
  mergeReadings(data.readings);
  if (!state.loaded && !state.explicitMode && !state.readings.length) {
    state.mode = 'demo'; updateDemo();
  }
  state.loaded = true;
  render();
  scheduleLogRefresh();
}
const events = new EventSource('/api/events');
events.addEventListener('ready', () => {
  state.connected = true;
  syncHistory().catch(() => { state.loaded = true; state.connected = false; render(); });
  updateConnection();
});
events.addEventListener('reading', event => {
  try {
    mergeReadings([JSON.parse(event.data)]);
    if (!state.explicitMode && state.mode === 'demo') { state.mode = 'live'; toast('Your ESP32 is connected. Showing real measurements.'); }
    render();
    scheduleLogRefresh();
  } catch { toast('Could not display an incoming measurement. Reconnect to refresh.'); }
});
events.onerror = () => { state.connected = false; state.loaded = true; updateConnection(); };
// Refresh after tab sleep so reconnection cannot leave a gap in chart history.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.connected) syncHistory().catch(() => {});
});
let lastChartTick = 0;
setInterval(() => {
  const cutoff = Date.now() - 24 * HOUR;
  state.readings = state.readings.filter(r => Date.parse(r.measuredAt) >= cutoff);
  if (state.mode === 'demo' && updateDemo()) render();
  else {
    updateConnection();
    const tick = Math.floor(Date.now() / 6000);
    if (lastChartTick !== tick) { renderChart(); renderLog(); lastChartTick = tick; }
  }
}, 1000);

async function copyText(text) {
  if (!text) return toast('Nothing to copy yet.');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = document.createElement('textarea'); area.value = text; area.className = 'clipboard-fallback';
      document.body.append(area); area.select(); const copied = document.execCommand('copy'); area.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    toast('Copied to clipboard.');
  } catch { toast('Clipboard unavailable. Select and copy the text manually.'); }
}
let setupPromise;
async function loadSetup() {
  if (state.setup) return;
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      const response = await fetch('/api/setup', { cache: 'no-store' });
      if (!response.ok) throw new Error('Setup unavailable');
      state.setup = await response.json();
      $('#server-url').value = state.setup.lanUrls[0] ? `${state.setup.lanUrls[0]}/api/readings` : 'No LAN IP detected. Connect your PC to the network.';
      $('#device-token').value = state.setup.deviceToken ?? '';
      if (!state.setup.localAccess) {
        $('#device-token').type = 'text';
        $('#device-token').value = 'Open localhost on the server PC to get your token';
        $('#copy-token').disabled = true;
        $('#download-sketch').hidden = true;
        $('.code-details').hidden = true;
        $('#setup-network-note').textContent = 'Open http://localhost:' + location.port + ' on the PC running Atmos to download the configured sketch. Setup secrets are available only on that PC.';
      } else if (state.setup.lanUrls.length > 1) {
        $('#setup-network-note').textContent = `Multiple network adapters found. Verify the address belongs to the ESP32's network. Available addresses: ${state.setup.lanUrls.join(', ')}. Allow Node.js on your private network if Windows Firewall asks.`;
      }
    } catch { toast('Could not load setup. Check that your local server is running.'); }
    finally { setupPromise = null; }
  })();
  return setupPromise;
}
$('#copy-url').addEventListener('click', () => copyText(state.setup?.lanUrls[0] ? `${state.setup.lanUrls[0]}/api/readings` : ''));
$('#copy-token').addEventListener('click', () => copyText(state.setup?.deviceToken));
async function loadSketch() {
  if (state.sketch) return state.sketch;
  const response = await fetch('/api/sketch', { cache: 'no-store' });
  if (!response.ok) throw new Error('Open localhost on your server PC to view the configured sketch.');
  state.sketch = await response.text();
  $('#sketch-code').textContent = state.sketch;
  return state.sketch;
}
$('.code-details').addEventListener('toggle', event => {
  if (event.target.open) loadSketch().catch(error => { $('#sketch-code').textContent = error.message; });
});
$('#copy-sketch').addEventListener('click', async () => {
  try { await copyText(await loadSketch()); } catch (error) { toast(error.message); }
});
$('#export').addEventListener('click', async () => {
  if (state.exporting) return;
  const mode = state.mode;
  const metrics = [...state.exportMetrics];
  if (!metrics.length) return toast('Select Temperature, Humidity, or both in the export filter.');
  const bounds = state.page === 'readings' ? filterBounds() : { from: Date.now() - 24 * HOUR, to: Date.now() + 1 };
  const demoRows = mode === 'demo' ? filterDemoRows(bounds) : null;
  if (demoRows && !demoRows.length) return toast('No simulated readings in this time range. Choose a more recent range.');
  if (mode === 'live' && state.page === 'readings' && state.history.loaded && !state.history.loading && !state.history.count) return toast('No readings in this time range. Choose another date or time span.');
  state.exporting = true;
  $('#export').disabled = true;
  $('#export').setAttribute('aria-busy', 'true');
  try {
    let blob;
    if (demoRows) {
      const header = ['measured_at', 'received_at', 'device_id', ...metrics.map(metric => exportMetricHeaders[metric]), 'rssi_dbm', 'uptime_ms', 'source'].join(',');
      const csv = [header, ...demoRows.map(r => [r.measuredAt, r.receivedAt, r.deviceId, ...metrics.map(metric => r[metric]), r.rssi ?? '', r.uptimeMs ?? '', 'simulated'].join(','))].join('\r\n');
      blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    } else {
      const params = rangeParams(bounds);
      params.set('metrics', metrics.join(','));
      const response = await fetch(`/api/export?${params}`, { cache: 'no-store' });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/csv')) throw new Error('Export failed. Check that the server is connected and try again.');
      blob = await response.blob();
    }
    const label = bounds ? `${localInput(new Date(bounds.from)).replace('T', '_').replace(':', '-')}-to-${localInput(new Date(bounds.to - 1)).replace('T', '_').replace(':', '-')}` : 'all-saved';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `atmos-${mode === 'demo' ? 'DEMO-' : ''}${label}-${metrics.join('-')}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(mode === 'demo' ? `Exported ${demoRows.length.toLocaleString()} simulated readings.` : 'Exported sensor readings for your selected time range.');
  } catch (error) { toast(error.message || 'Could not export readings. Try again.'); }
  finally {
    state.exporting = false;
    $('#export').disabled = false;
    $('#export').removeAttribute('aria-busy');
  }
});
changePage();
