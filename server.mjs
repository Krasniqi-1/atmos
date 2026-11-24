import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const DEVICE_ID = 'esp32-room-01';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ino': 'text/plain' };

function readDateRange(params, defaultRecent = false) {
  const badRange = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (params.has('all')) {
    if (params.get('all') !== '1' || params.has('from') || params.has('to')) badRange('Use all=1 by itself, or provide from and to.');
    return { from: -Infinity, to: Infinity };
  }
  if (!params.has('from') && !params.has('to')) {
    if (defaultRecent) return { from: Date.now() - DAY, to: Date.now() + 60001 };
    badRange('Provide from and to, or all=1.');
  }
  const parse = name => {
    const value = params.get(name) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) badRange('Dates must be ISO timestamps with a timezone.');
    return Date.parse(value);
  };
  const from = parse('from'), to = parse('to');
  if (from >= to) badRange('Start time must be before end time.');
  return { from, to };
}

const EXPORT_METRIC_HEADERS = { temperature: 'temperature_c', humidity: 'humidity_percent' };
function readExportMetrics(params) {
  const selected = (params.get('metrics') ?? 'temperature,humidity').split(',');
  if (params.getAll('metrics').length > 1 || !selected.length || selected.some(metric => !Object.hasOwn(EXPORT_METRIC_HEADERS, metric)) || new Set(selected).size !== selected.length) {
    throw Object.assign(new Error('Select temperature, humidity, or both for export.'), { status: 400 });
  }
  return Object.keys(EXPORT_METRIC_HEADERS).filter(metric => selected.includes(metric));
}

export async function createAtmosServer(options = {}) {
  const dataDir = options.dataDir ?? process.env.ATMOS_DATA_DIR ?? path.join(ROOT, '..', 'data', 'measurements');
  const configPath = options.configPath ?? process.env.ATMOS_CONFIG_PATH ?? path.join(ROOT, '..', 'data', 'local.config.json');
  await mkdir(dataDir, { recursive: true });
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
    if (typeof config.deviceToken !== 'string' || config.deviceToken.length < 24) throw new Error('deviceToken must be at least 24 characters');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { deviceToken: randomBytes(24).toString('hex') };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  }
  const token = Buffer.from(config.deviceToken);
  const clients = new Set();
  const rate = new Map();
  const seen = new Set();
  let readings = [];
  let lastReceivedAt = null;
  let persistence = Promise.resolve();
  let activeWrites = 0;

  // Load only the current 24-hour window. All daily files remain on disk.
  for (const day of [new Date(Date.now() - DAY), new Date()]) {
    try {
      const logPath = path.join(dataDir, `${day.toISOString().slice(0, 10)}.jsonl`);
      const text = await readFile(logPath, 'utf8');
      // Isolate any interrupted final append before accepting fresh records.
      if (text && !text.endsWith('\n')) await appendFile(logPath, '\n');
      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const row = JSON.parse(line);
          if (row.deviceId === DEVICE_ID && Number.isFinite(row.temperature) && Number.isFinite(row.humidity) &&
              Number.isFinite(Date.parse(row.measuredAt)) && Date.parse(row.measuredAt) > Date.now() - DAY && !seen.has(row.readingId)) {
            readings.push(row);
            seen.add(row.readingId);
          }
        } catch { /* A partial final line after a power loss does not block startup. */ }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  readings.sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
  for (const row of readings) if (!lastReceivedAt || row.receivedAt > lastReceivedAt) lastReceivedAt = row.receivedAt;

  const lanAddresses = () => [...new Set(Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address))];
  const port = () => server.address()?.port ?? Number(options.port ?? process.env.PORT ?? 3000);
  const localRequest = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const status = () => ({
    service: 'atmos-local',
    deviceId: DEVICE_ID, intervalMs: 6000, lastReceivedAt,
    latest: readings.at(-1) ?? null, count: readings.length,
    retentionHours: 24, lanUrls: lanAddresses().map(ip => `http://${ip}:${port()}`)
  });
  const prune = () => {
    const cutoff = Date.now() - DAY;
    while (readings.length && (Date.parse(readings[0].measuredAt) < cutoff || readings.length > 20000)) {
      seen.delete(readings.shift().readingId);
    }
  };
  const broadcast = row => {
    for (const res of clients) {
      if (!res.write(`event: reading\ndata: ${JSON.stringify(row)}\n\n`)) {
        // A stalled viewer must not grow an unbounded write buffer.
        res.end();
        clients.delete(res);
      }
    }
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const authenticated = req => {
    const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return supplied.length === token.length && timingSafeEqual(supplied, token);
  };
  const bodyJSON = req => new Promise((resolve, reject) => {
    let body = '', bytes = 0, oversized = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096) oversized = true;
      else body += chunk.toString('utf8');
    });
    req.on('error', reject);
    req.on('end', () => {
      if (oversized) return reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
  });
  const validNumber = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  function normalize(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object');
    if (body.deviceId !== DEVICE_ID) throw new Error(`deviceId must be ${DEVICE_ID}`);
    if (typeof body.readingId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.readingId)) throw new Error('Invalid readingId');
    if (!validNumber(body.temperature, -40, 80)) throw new Error('temperature must be a number from -40 to 80');
    if (!validNumber(body.humidity, 0, 100)) throw new Error('humidity must be a number from 0 to 100');
    if (body.rssi != null && !validNumber(body.rssi, -127, 0)) throw new Error('Invalid rssi');
    if (body.uptimeMs != null && !validNumber(body.uptimeMs, 0, 4294967295)) throw new Error('Invalid uptimeMs');
    if (body.ageMs != null && !validNumber(body.ageMs, 0, DAY - 1000)) throw new Error('Invalid ageMs');
    const now = Date.now();
    const measured = body.measuredAt == null ? now - (body.ageMs ?? 0) : Date.parse(body.measuredAt);
    if (!Number.isFinite(measured) || measured > now + 60000 || measured < now - DAY) throw new Error('measuredAt must be within the last 24 hours, with at most 60 seconds clock skew');
    return {
      deviceId: DEVICE_ID, readingId: body.readingId,
      temperature: Math.round(body.temperature * 100) / 100,
      humidity: Math.round(body.humidity * 100) / 100,
      rssi: body.rssi ?? null, uptimeMs: body.uptimeMs ?? null,
      measuredAt: new Date(measured).toISOString(), receivedAt: new Date(now).toISOString()
    };
  }

  // Archives are stored by receipt date. A delayed sample can be measured up to
  // 24 hours earlier, so include the following day's file when locating records.
  async function* archivedReadings(range) {
    await persistence;
    const earliestFile = Number.isFinite(range.from) ? new Date(range.from - 60000).toISOString().slice(0, 10) : '';
    const latestFile = Number.isFinite(range.to) ? new Date(Math.min(range.to + DAY, 8.64e15)).toISOString().slice(0, 10) : '9999-12-31';
    const files = (await readdir(dataDir)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) >= earliestFile && name.slice(0, 10) <= latestFile).sort();
    const emitted = new Set();
    for (const name of files) {
      const stream = createReadStream(path.join(dataDir, name), { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (!row || row.deviceId !== DEVICE_ID || typeof row.readingId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.readingId) ||
              !validNumber(row.temperature, -40, 80) || !validNumber(row.humidity, 0, 100) ||
              !Number.isFinite(Date.parse(row.receivedAt))) continue;
          const measured = Date.parse(row.measuredAt);
          if (!Number.isFinite(measured) || measured < range.from || measured >= range.to || emitted.has(row.readingId)) continue;
          emitted.add(row.readingId);
          yield { ...row, measuredAt: new Date(measured).toISOString(), receivedAt: new Date(row.receivedAt).toISOString(),
            rssi: validNumber(row.rssi, -127, 0) ? row.rssi : null,
            uptimeMs: validNumber(row.uptimeMs, 0, 4294967295) ? row.uptimeMs : null };
        }
      } finally { lines.close(); stream.destroy(); }
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase(), ...lanAddresses()]);
      const url = new URL(req.url, `http://${host}`);
      if (!allowedHosts.has(url.hostname.toLowerCase())) return json(res, 403, { error: 'Unrecognized host' });
      // Local-only service: no cross-origin reads or writes, including configuration access.
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(res, 403, { error: 'Cross-origin requests are disabled' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are disabled' });
      prune();

      const cloudResource = url.pathname.match(/^\/api\/cloud\/(readings|export\.csv)$/)?.[1];
      if (req.method === 'GET' && cloudResource) {
        const key = req.headers.authorization;
        if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(key ?? '')) return json(res, 401, { error: 'Device key required' });
        const upstreamUrl = new URL('/api/v1/device/' + cloudResource, 'https://atmos-roan.vercel.app');
        upstreamUrl.search = url.search;
        let upstream;
        try {
          upstream = await fetch(upstreamUrl, {
            headers: { Authorization: key }, redirect: 'error', signal: AbortSignal.timeout(12000),
          });
        } catch {
          return json(res, 502, { error: 'Cloud feed unavailable' });
        }
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        return res.end(Buffer.from(await upstream.arrayBuffer()));
      }

      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
      if (req.method === 'GET' && url.pathname === '/api/readings') return json(res, 200, { readings, ...status() });
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const range = readDateRange(url.searchParams);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) return json(res, 400, { error: 'limit must be between 1 and 500.' });
        const matches = [];
        let count = 0;
        for await (const row of archivedReadings(range)) {
          if (res.destroyed) return;
          count++;
          if (matches.length === limit && row.measuredAt < matches.at(-1).measuredAt) continue;
          let low = 0, high = matches.length;
          while (low < high) { const mid = (low + high) >>> 1; if (matches[mid].measuredAt > row.measuredAt) low = mid + 1; else high = mid; }
          matches.splice(low, 0, row);
          if (matches.length > limit) matches.pop();
        }
        return json(res, 200, { readings: matches, count, limit });
      }
      if (req.method === 'GET' && url.pathname === '/api/setup') {
        return json(res, 200, { ...status(), localAccess: localRequest(req), deviceToken: localRequest(req) ? config.deviceToken : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/sketch') {
        if (!localRequest(req)) return json(res, 403, { error: 'Download the configured sketch from localhost on the server PC.' });
        let sketch = await readFile(path.join(ROOT, 'firmware', 'atmos_sensor', 'atmos_sensor.ino'), 'utf8');
        sketch = sketch.replace('YOUR_DEVICE_TOKEN', config.deviceToken).replace('YOUR_PC_IP', lanAddresses()[0] ?? 'YOUR_PC_IP').replace(':3000/api/readings', `:${port()}/api/readings`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="atmos_sensor.ino"', 'Cache-Control': 'no-store' });
        return res.end(sketch);
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (clients.size >= 20) return json(res, 503, { error: 'Too many live viewers' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive' });
        res.write(`event: ready\ndata: ${JSON.stringify(status())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/readings') {
        if (!authenticated(req)) return json(res, 401, { error: 'Invalid device token' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'Use application/json' });
        const ip = req.socket.remoteAddress;
        const now = Date.now();
        const bucket = rate.get(ip);
        if (!bucket || now - bucket.start >= 60000) rate.set(ip, { start: now, count: 1 });
        else if (++bucket.count > 120) return json(res, 429, { error: 'Upload rate exceeded; retry later' });
        const body = await bodyJSON(req);
        let row;
        try { row = normalize(body); } catch (error) { return json(res, 400, { error: error.message }); }
        if (activeWrites >= 100) return json(res, 503, { error: 'Storage busy; retry later' });
        activeWrites++;
        // Serialize deduplication and disk writes. Acknowledgement means the append succeeded.
        const operation = persistence.then(async () => {
          if (seen.has(row.readingId)) return { duplicate: true };
          await appendFile(path.join(dataDir, `${row.receivedAt.slice(0, 10)}.jsonl`), JSON.stringify(row) + '\n');
          seen.add(row.readingId);
          readings.push(row);
          readings.sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt));
          lastReceivedAt = row.receivedAt;
          prune();
          broadcast(row);
          return { duplicate: false };
        });
        persistence = operation.catch(() => {});
        try {
          const result = await operation;
          return json(res, result.duplicate ? 200 : 201, { ok: true, ...result });
        } finally { activeWrites--; }
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const range = readDateRange(url.searchParams, true);
        const metrics = readExportMetrics(url.searchParams);
        const label = Number.isFinite(range.from) ? `${new Date(range.from).toISOString().slice(0, 10)}-to-${new Date(range.to - 1).toISOString().slice(0, 10)}` : 'all-saved';
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="atmos-${label}-${metrics.join('-')}.csv"`, 'Cache-Control': 'no-store' });
        res.write(['measured_at', 'received_at', 'device_id', ...metrics.map(metric => EXPORT_METRIC_HEADERS[metric]), 'rssi_dbm', 'uptime_ms', 'source'].join(',') + '\r\n');
        for await (const row of archivedReadings(range)) {
          if (res.destroyed) return;
          const line = [row.measuredAt, row.receivedAt, row.deviceId, ...metrics.map(metric => row[metric]), row.rssi ?? '', row.uptimeMs ?? '', 'device'].join(',') + '\r\n';
          if (!res.write(line)) await once(res, 'drain', { signal: AbortSignal.timeout(30000) });
        }
        return res.end();
      }
      const assets = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg' };
      if (req.method === 'GET' && assets[url.pathname]) {
        const file = assets[url.pathname];
        const data = await readFile(path.join(ROOT, 'dist', file));
        res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(data);
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'Server error. Check the server terminal and available disk space.' });
      else res.end();
      if (!error.status) console.error(error.message);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      if (!res.write(': heartbeat\n\n')) { clients.delete(res); res.end(); }
    }
    for (const [ip, bucket] of rate) if (Date.now() - bucket.start > 60000) rate.delete(ip);
  }, 15000);
  heartbeat.unref();
  return {
    server, config,
    async listen(portNumber = Number(options.port ?? process.env.PORT ?? 3000), host = '::') {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(portNumber, host, resolve); });
      return port();
    },
    async close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      await persistence;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedPort = Number(process.env.PORT ?? 3000);
  const dashboardUrl = `http://127.0.0.1:${requestedPort}`;
  const openDashboard = async () => {
    if (!process.argv.includes('--open') || process.platform !== 'win32') return;
    // Wait for the Windows URL handler instead of detaching Explorer and exiting.
    const opened = await new Promise(resolve => {
      const browser = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${dashboardUrl}"`], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
      const timer = setTimeout(() => {
        browser.kill();
        resolve(false);
      }, 6000);
      browser.once('error', () => { clearTimeout(timer); resolve(false); });
      browser.once('close', code => { clearTimeout(timer); resolve(code === 0); });
    });
    console.log(opened
      ? `  Browser open requested. If no browser appears, open ${dashboardUrl} manually.\n`
      : `  Windows could not open the browser automatically. Open ${dashboardUrl} manually.\n`);
  };
  try {
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) throw new Error('PORT must be a whole number between 1 and 65535.');
    const app = await createAtmosServer();
    try {
      await app.listen(requestedPort);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      let existingAtmos = false;
      try {
        const response = await fetch(`${dashboardUrl}/api/status`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        const info = response.ok ? await response.json() : null;
        if (info?.service === 'atmos-local') existingAtmos = true;
        // Recognize the first release, which did not include a service identifier.
        else if (info?.deviceId === DEVICE_ID && info?.intervalMs === 6000) {
          const page = await fetch(dashboardUrl, { signal: AbortSignal.timeout(2000), redirect: 'error' });
          existingAtmos = page.ok && (await page.text()).includes('<title>Atmos — Local climate observatory</title>');
        }
      } catch { /* Another program or an unresponsive process owns the port. */ }
      if (!existingAtmos) throw new Error(`Port ${requestedPort} is already in use by another program. Close that program or choose a different PORT, then update the ESP32's SERVER_URL to match.`);
      console.log(`\n  Atmos is already running.\n  Dashboard: ${dashboardUrl}\n  Your existing server will keep collecting readings.\n`);
      await openDashboard();
      // Do not stop the existing server or change its configured port.
    }
    if (app.server.listening) {
      console.log(`\n  ATMOS / Local climate observatory\n\n  Dashboard:  ${dashboardUrl}\n`);
      const addresses = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal);
      for (const { address } of addresses) console.log(`  ESP32 API:  http://${address}:${requestedPort}/api/readings`);
      if (!addresses.length) console.log('  No LAN IPv4 address detected. Connect your PC to the same network as the ESP32.');
      console.log('\n  Open Device setup in the dashboard for your configured Arduino sketch.\n  Local measurements are saved in the configured data directory. Keep this window open. Press Ctrl+C to stop.\n');
      await openDashboard();
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
    }
  } catch (error) {
    console.error(`\n  Could not start Atmos: ${error.message}\n`);
    process.exitCode = 1;
  }
}
