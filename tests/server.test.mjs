import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readdir, readFile, appendFile } from 'node:fs/promises';
import { createAtmosServer } from '../server.mjs';

test('local sensor pipeline', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'run-'));
  const options = { dataDir: path.join(dir, 'data'), configPath: path.join(dir, 'config.json') };
  const app = await createAtmosServer(options);
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(() => app.close());
  const makeSample = (id, changes = {}) => ({ deviceId: 'esp32-room-01', readingId: id, temperature: 23.4, humidity: 48.2, rssi: -57, uptimeMs: 6000, ageMs: 2000, ...changes });
  const post = (sample, token = app.config.deviceToken, extra = {}) => fetch(`${base}/api/readings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(sample) });

  await t.test('serves application and rejects cross-origin or unknown files', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Your room, in real time/);
    assert.equal((await fetch(`${base}/local.config.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/setup`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/setup`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  });
  await t.test('requires the device token and correct sensor identity', async () => {
    assert.equal((await post(makeSample('unauthorized'), 'wrong-token')).status, 401);
    assert.equal((await post(makeSample('wrong-device', { deviceId: 'another-device' }))).status, 400);
  });
  await t.test('rejects invalid readings, times, oversized payloads, and wrong content types', async () => {
    for (const change of [{ temperature: '23' }, { temperature: 81 }, { humidity: -1 }, { humidity: null }, { rssi: 10 }, { measuredAt: 'not-a-date' }, { measuredAt: new Date(Date.now() + 120000).toISOString() }, { readingId: '=formula()' }, { ageMs: -1 }]) {
      assert.equal((await post(makeSample('invalid', change))).status, 400);
    }
    assert.equal((await post(makeSample('oversize', { extra: 'x'.repeat(5000) }))).status, 413);
    assert.equal((await post(makeSample('wrong-content'), app.config.deviceToken, { 'Content-Type': 'text/plain' })).status, 415);
  });
  await t.test('persists a reading once, including concurrent retries', async () => {
    const sample = makeSample('dedupe');
    const responses = await Promise.all([post(sample), post(sample), post(sample)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 200, 201]);
    const history = await (await fetch(`${base}/api/readings`)).json();
    assert.equal(history.readings.length, 1);
    assert.equal(history.latest.temperature, 23.4);
    const elapsed = Date.parse(history.latest.receivedAt) - Date.parse(history.latest.measuredAt);
    assert.equal(elapsed, 2000);
    const files = await readdir(options.dataDir);
    const text = await readFile(path.join(options.dataDir, files[0]), 'utf8');
    assert.equal(text.trim().split('\n').length, 1);
  });
  await t.test('broadcasts accepted readings over SSE', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${base}/api/events`, { signal: controller.signal });
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      assert.match(text, /event: ready/);
      assert.equal((await post(makeSample('sse-reading', { ageMs: 0 }))).status, 201);
      while (!text.includes('event: reading')) text += decoder.decode((await reader.read()).value);
      assert.match(text, /sse-reading/);
      await reader.cancel();
    } finally { clearTimeout(timeout); controller.abort(); }
  });
  await t.test('backfilled readings do not replace the newest measurement', async () => {
    assert.equal((await post(makeSample('backfill', { temperature: 21, ageMs: 600000 }))).status, 201);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.latest.readingId, 'sse-reading');
  });
  await t.test('exports CSV and generates an Arduino sketch with configured values', async () => {
    const csv = await (await fetch(`${base}/api/export`)).text();
    assert.match(csv, /temperature_c,humidity_percent/);
    assert.equal(csv.trim().split('\r\n').length, 4);
    const sketch = await (await fetch(`${base}/api/sketch`)).text();
    assert.ok(sketch.includes(app.config.deviceToken));
    assert.ok(!sketch.includes('YOUR_DEVICE_TOKEN'));
    assert.ok(sketch.includes(`:${port}/api/readings`));
    assert.match(sketch, /SAMPLE_INTERVAL_MS = 6000/);
  });
  await t.test('recovers accepted readings and token after a server restart', async () => {
    const restored = await createAtmosServer(options);
    const restoredPort = await restored.listen(0, '127.0.0.1');
    try {
      assert.equal(restored.config.deviceToken, app.config.deviceToken);
      const history = await (await fetch(`http://127.0.0.1:${restoredPort}/api/readings`)).json();
      assert.equal(history.readings.length, 3);
      assert.equal(history.latest.readingId, 'sse-reading');
    } finally { await restored.close(); }
  });
  await t.test('isolates an interrupted log line so future samples remain recoverable', async () => {
    const fixtureDir = await mkdtemp(path.join(root, 'partial-'));
    const fixture = { dataDir: path.join(fixtureDir, 'data'), configPath: path.join(fixtureDir, 'config.json') };
    await mkdir(fixture.dataDir);
    await appendFile(path.join(fixture.dataDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), '{"partial":');
    const recovery = await createAtmosServer(fixture);
    const recoveryPort = await recovery.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`http://127.0.0.1:${recoveryPort}/api/readings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${recovery.config.deviceToken}` },
        body: JSON.stringify(makeSample('after-partial'))
      });
      assert.equal(response.status, 201);
    } finally { await recovery.close(); }
    const again = await createAtmosServer(fixture);
    const againPort = await again.listen(0, '127.0.0.1');
    try {
      const history = await (await fetch(`http://127.0.0.1:${againPort}/api/readings`)).json();
      assert.equal(history.readings.length, 1);
      assert.equal(history.latest.readingId, 'after-partial');
    } finally { await again.close(); }
  });
});

test('date-filtered saved history and exports', async t => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'archive-'));
  const dataDir = path.join(dir, 'data');
  await mkdir(dataDir);
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - 4);
  fromDate.setUTCHours(10, 0, 0, 0);
  const from = fromDate.getTime(), to = from + 3600000;
  const stored = (id, measured, received = measured) => ({ deviceId: 'esp32-room-01', readingId: id, temperature: 22.4, humidity: 48, rssi: -55, uptimeMs: 12000, measuredAt: new Date(measured).toISOString(), receivedAt: new Date(received).toISOString() });
  const fixtures = [stored('before-start', from - 1), stored('at-start-delayed', from, from + 86400000 - 1), stored('before-end', to - 1), stored('at-end', to), stored('before-end', to - 1)];
  for (const row of fixtures) await appendFile(path.join(dataDir, `${row.receivedAt.slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n');
  await appendFile(path.join(dataDir, `${fromDate.toISOString().slice(0, 10)}.jsonl`), '{bad-json}\n');
  const app = await createAtmosServer({ dataDir, configPath: path.join(dir, 'config.json') });
  const port = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });

  await t.test('reads dates older than the live buffer, with inclusive start and exclusive end', async () => {
    const live = await (await fetch(`${base}/api/readings`)).json();
    assert.equal(live.readings.length, 0);
    const history = await (await fetch(`${base}/api/history?${query}`)).json();
    assert.equal(history.count, 2);
    assert.deepEqual(history.readings.map(row => row.readingId), ['before-end', 'at-start-delayed']);
  });
  await t.test('exports exactly the matching archived rows, including delayed uploads from another file', async () => {
    const response = await fetch(`${base}/api/export?${query}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    const lines = (await response.text()).trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.slice(1).map(line => line.split(',')[0]).sort(), [new Date(from).toISOString(), new Date(to - 1).toISOString()]);
    assert.ok(lines.slice(1).every(line => line.endsWith(',device')));
  });
  await t.test('exports temperature only, humidity only, or both with the selected date range', async () => {
    for (const metrics of ['temperature', 'humidity', 'temperature,humidity', 'humidity,temperature']) {
      const params = new URLSearchParams(query);
      params.set('metrics', metrics);
      const response = await fetch(`${base}/api/export?${params}`);
      assert.equal(response.status, 200);
      const lines = (await response.text()).trim().split('\r\n').map(line => line.split(','));
      const headers = lines[0];
      assert.equal(lines.length, 3);
      assert.equal(headers.includes('temperature_c'), metrics.includes('temperature'));
      assert.equal(headers.includes('humidity_percent'), metrics.includes('humidity'));
      assert.deepEqual(headers.slice(0, 3), ['measured_at', 'received_at', 'device_id']);
      assert.deepEqual(headers.slice(-3), ['rssi_dbm', 'uptime_ms', 'source']);
      for (const row of lines.slice(1)) {
        assert.equal(row.length, headers.length);
        if (metrics.includes('temperature')) assert.equal(row[headers.indexOf('temperature_c')], '22.4');
        if (metrics.includes('humidity')) assert.equal(row[headers.indexOf('humidity_percent')], '48');
      }
      if (metrics.includes(',')) assert.ok(headers.indexOf('temperature_c') < headers.indexOf('humidity_percent'));
    }
  });
  await t.test('measurement selection works for all saved data and empty ranges', async () => {
    const response = await fetch(`${base}/api/export?all=1&metrics=humidity`);
    assert.match(response.headers.get('content-disposition'), /all-saved-humidity\.csv/);
    const csv = await response.text();
    assert.equal(csv.trim().split('\r\n').length, 5);
    assert.ok(!csv.split('\r\n')[0].includes('temperature_c'));
    const params = new URLSearchParams({ from: new Date(to + 1).toISOString(), to: new Date(to + 3600000).toISOString(), metrics: 'temperature' });
    const emptyCsv = await (await fetch(`${base}/api/export?${params}`)).text();
    assert.equal(emptyCsv.trim().split('\r\n').length, 1);
    assert.ok(emptyCsv.includes('temperature_c'));
    assert.ok(!emptyCsv.includes('humidity_percent'));
  });
  await t.test('rejects empty, unsupported, or duplicated measurement selections before returning CSV', async () => {
    for (const metricQuery of ['metrics=', 'metrics=temp', 'metrics=temperature,pressure', 'metrics=temperature,temperature', 'metrics=temperature&metrics=humidity']) {
      const response = await fetch(`${base}/api/export?${query}&${metricQuery}`);
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('content-disposition'), null);
    }
  });
  await t.test('honours explicit timezone offsets', async () => {
    const offset = millis => new Date(millis + 7200000).toISOString().replace('Z', '+02:00');
    const params = new URLSearchParams({ from: offset(from), to: offset(to) });
    const history = await (await fetch(`${base}/api/history?${params}`)).json();
    assert.equal(history.count, 2);
  });
  await t.test('all saved data is deduplicated, counted fully, and the log limit preserves newest rows', async () => {
    const history = await (await fetch(`${base}/api/history?all=1&limit=1`)).json();
    assert.equal(history.count, 4);
    assert.equal(history.readings.length, 1);
    assert.equal(history.readings[0].readingId, 'at-end');
    const csv = await (await fetch(`${base}/api/export?all=1`)).text();
    assert.equal(csv.trim().split('\r\n').length, 5);
  });
  await t.test('empty ranges return an empty log and a valid header-only CSV', async () => {
    const params = new URLSearchParams({ from: new Date(to + 1).toISOString(), to: new Date(to + 3600000).toISOString() });
    const history = await (await fetch(`${base}/api/history?${params}`)).json();
    assert.equal(history.count, 0);
    assert.deepEqual(history.readings, []);
    const csv = await (await fetch(`${base}/api/export?${params}`)).text();
    assert.equal(csv.trim().split('\r\n').length, 1);
  });
  await t.test('rejects missing, ambiguous, reversed, and invalid ranges before downloading', async () => {
    for (const params of ['', 'from=invalid&to=invalid', `from=${encodeURIComponent(new Date(from).toISOString())}`, `from=${encodeURIComponent(new Date(to).toISOString())}&to=${encodeURIComponent(new Date(from).toISOString())}`, 'from=2026-10-01T10:00&to=2026-10-02T10:00', `all=1&${query}`, 'all=0']) {
      assert.equal((await fetch(`${base}/api/history?${params}`)).status, 400);
      if (params) {
        const response = await fetch(`${base}/api/export?${params}`);
        assert.equal(response.status, 400);
        assert.match(response.headers.get('content-type'), /application\/json/);
      }
    }
    assert.equal((await fetch(`${base}/api/history?all=1&limit=501`)).status, 400);
    assert.equal((await fetch(`${base}/api/history?all=1&limit=-1`)).status, 400);
  });
});
