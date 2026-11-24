import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createPreviewHandler } from '../hosted/preview.mjs';
import { refreshRollups } from '../hosted/rollups.mjs';

test('a committed simulator reading survives reopening the preview database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atmos-preview-'));
  const secret = () => randomBytes(32).toString('base64url');
  const env = {
    VERCEL_ENV: 'preview',
    ATMOS_PREVIEW_DATABASE_URL: 'local-postgresql',
    ATMOS_PREVIEW_ADMIN_KEY: secret(),
    ATMOS_PREVIEW_VIEWER_PASSWORD: secret(),
    ATMOS_PREVIEW_SESSION_SECRET: secret(),
  };
  let server;
  let database;
  const close = async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = undefined;
    }
    if (database) {
      await database.close();
      database = undefined;
    }
  };

  async function start(verifyIdentity, failQueries = false) {
    database = new PGlite(directory);
    const sql = (parts, ...parameters) => {
      const statement = parts.reduce((query, part, index) => query + '$' + index + part);
      return sql.query(statement, parameters);
    };
    sql.query = async (statement, parameters) => {
      if (failQueries) throw new Error('Test database unavailable');
      return (await database.query(statement, parameters)).rows;
    };
    server = createServer(createPreviewHandler(env, () => sql, verifyIdentity));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    return (path, options) => fetch(origin + '/api/v1' + path, options);
  }

  const post = (body, key) => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && { Authorization: 'Bearer ' + key }),
    },
    body: JSON.stringify(body),
  });

  async function signIn(request) {
    const response = await request('/session', post({ password: env.ATMOS_PREVIEW_VIEWER_PASSWORD }));
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
    return { headers: { Cookie: setCookie.split(';')[0] } };
  }

  try {
    let request = await start();
    await database.exec(await readFile(new URL('../hosted/001-preview.sql', import.meta.url), 'utf8'));
    const legacyId = randomUUID();
    const legacyKey = secret();
    const legacyHash = createHash('sha256').update(legacyKey).digest('hex');
    await database.query('INSERT INTO atmos_devices (id, name, key_hash) VALUES ($1, $2, $3)', [legacyId, 'Legacy', legacyHash]);
    await database.query(
      'INSERT INTO atmos_readings VALUES ($1, $2, now(), now(), $3, $4)',
      [legacyId, 'legacy-1', 20, 55],
    );
    await database.exec(await readFile(new URL('../hosted/002-identity-storage.sql', import.meta.url), 'utf8'));
    const [backfilled] = (await database.query(
      'SELECT d.workspace_id, k.key_hash, r.provenance FROM atmos_devices d JOIN atmos_device_keys k ON k.device_id=d.id JOIN atmos_readings r ON r.device_id=d.id WHERE d.id=$1',
      [legacyId],
    )).rows;
    assert.equal(backfilled.workspace_id, '00000000-0000-4000-8000-000000000001');
    assert.equal(backfilled.key_hash, legacyHash);
    assert.equal(backfilled.provenance, 'simulator');
    const registration = await request('/devices', post({ name: 'Preview simulator' }, env.ATMOS_PREVIEW_ADMIN_KEY));
    assert.equal(registration.status, 201);
    const { deviceId, deviceKey, keyId } = await registration.json();
    const reading = { readingId: 'preview-1', temperature: 22.4, humidity: 48.3, ageMs: 120 };
    const ingestion = await request('/readings', post(reading, deviceKey));
    assert.equal(ingestion.status, 201);
    const receipt = await ingestion.json();
    assert.equal(receipt.deviceId, deviceId);
    assert.equal(receipt.readingId, reading.readingId);
    assert.equal(receipt.temperature, reading.temperature);
    assert.equal(receipt.humidity, reading.humidity);
    assert.equal(Date.parse(receipt.receivedAt) - Date.parse(receipt.measuredAt), reading.ageMs);
    const history = '/devices/' + deviceId + '/readings';
    assert.equal((await request(history)).status, 401);
    const before = await request(history, await signIn(request));
    assert.equal(before.status, 200);
    assert.deepEqual((await before.json()).readings, [receipt]);

    await close();
    request = await start();
    const after = await request(history, await signIn(request));
    assert.equal(after.status, 200);
    assert.deepEqual((await after.json()).readings, [receipt]);
    const admin = env.ATMOS_PREVIEW_ADMIN_KEY;
    const second = await request('/devices', post({ name: 'Second simulator' }, admin));
    assert.equal(second.status, 201);
    const secondDevice = await second.json();
    const concurrent = await Promise.all([
      request('/readings', post(reading, secondDevice.deviceKey)),
      request('/readings', post({ ...reading, ageMs: 500 }, secondDevice.deviceKey)),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 201]);
    const receipts = await Promise.all(concurrent.map((response) => response.json()));
    assert.deepEqual(receipts[0], receipts[1]);
    assert.notEqual(receipts[0].deviceId, receipt.deviceId);
    assert.equal((await request('/readings', post({ ...reading, temperature: 1 }, secondDevice.deviceKey))).status, 409);
    const replacement = await request('/devices/' + deviceId + '/keys', post({}, admin));
    assert.equal(replacement.status, 201);
    const { deviceKey: replacementKey } = await replacement.json();
    assert.equal((await request('/readings', post(reading, replacementKey))).status, 200);
    const revoked = await request('/devices/' + deviceId + '/keys/' + keyId, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + admin },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await request('/readings', post(reading, deviceKey))).status, 401);
    const deviceHistory = '/device/readings';
    assert.equal((await request(deviceHistory)).status, 401);
    assert.equal((await request(deviceHistory, { headers: { Authorization: 'Bearer ' + deviceKey } })).status, 401);
    const keyedRead = await request(deviceHistory, { headers: { Authorization: 'Bearer ' + replacementKey } });
    assert.equal(keyedRead.status, 200);
    assert.deepEqual((await keyedRead.json()).readings, [receipt]);
    const deviceAuth = { headers: { Authorization: 'Bearer ' + replacementKey } };
    const included = await request(deviceHistory + '?start=' + receipt.measuredAt, deviceAuth);
    assert.equal(included.status, 200);
    assert.deepEqual((await included.json()).readings, [receipt]);
    const excluded = await request(deviceHistory + '?end=' + receipt.measuredAt, deviceAuth);
    assert.equal(excluded.status, 200);
    assert.deepEqual((await excluded.json()).readings, []);
    const includedCsv = await request('/device/export.csv?start=' + receipt.measuredAt, deviceAuth);
    assert.equal(includedCsv.status, 200);
    const [, exportedRow] = (await includedCsv.text()).trim().split('\r\n');
    assert.equal(exportedRow.split(',')[1], receipt.readingId);
    const excludedCsv = await request('/device/export.csv?end=' + receipt.measuredAt, deviceAuth);
    assert.equal(excludedCsv.status, 200);
    assert.equal((await excludedCsv.text()).trim().split('\r\n').length, 1);
    assert.equal((await request('/devices/' + secondDevice.deviceId + '/readings', {
      headers: { Authorization: 'Bearer ' + replacementKey },
    })).status, 401);
    const viewer = await signIn(request);
    const forbidden = await request('/devices/' + deviceId + '/keys', {
      ...post({}), headers: { ...post({}).headers, ...viewer.headers },
    });
    assert.equal(forbidden.status, 403);
    const exportResponse = await request('/devices/' + deviceId + '/export.csv', viewer);
    assert.equal(exportResponse.status, 200);
    assert.match(await exportResponse.text(), /preview-1.*22\.4,48\.3,simulator/);
    const filtered = await request(history + '?start=2099-01-01T00:00:00Z', viewer);
    assert.deepEqual((await filtered.json()).readings, []);
    await database.exec(await readFile(new URL('../hosted/003-rollups.sql', import.meta.url), 'utf8'));
    await database.query("UPDATE atmos_readings SET measured_at = '2025-01-01T00:01:00Z' WHERE device_id = $1", [deviceId]);
    const rollupSql = (parts, ...parameters) => database.query(
      parts.reduce((query, part, index) => query + '$' + index + part), parameters,
    );
    const bucketStart = '2025-01-01T00:00:00Z';
    const bucketEnd = '2025-01-01T00:05:00Z';
    await refreshRollups(rollupSql, bucketStart, bucketEnd);
    await refreshRollups(rollupSql, bucketStart, bucketEnd);
    const summaryPath = '/devices/' + deviceId + '/rollups?start=' + bucketStart + '&end=' + bucketEnd;
    const summary = async () => (await (await request(summaryPath, viewer)).json()).summaries;
    assert.equal((await summary()).length, 1);
    assert.equal((await summary())[0].sampleCount, 1);
    await database.query(
      "INSERT INTO atmos_readings (device_id, reading_id, measured_at, received_at, temperature, humidity) VALUES ($1, 'late', '2025-01-01T00:04:59Z', now(), 20.6, 50)",
      [deviceId],
    );
    await refreshRollups(rollupSql, bucketStart, bucketEnd);
    const [updated] = await summary();
    assert.equal(updated.sampleCount, 2);
    assert.equal(updated.temperatureMin, 20.6);
    assert.equal(updated.temperatureMax, 22.4);
    assert.equal(updated.temperatureAvg, 21.5);
    assert.equal(updated.humidityMax, 50);
    const otherWorkspace = randomUUID();
    await database.query('INSERT INTO atmos_workspaces (id, name) VALUES ($1, $2)', [otherWorkspace, 'Other']);
    await database.query(
      'INSERT INTO atmos_memberships (workspace_id, issuer, subject, role) VALUES ($1, $2, $3, $4)',
      [otherWorkspace, 'https://identity.test', 'other-viewer', 'viewer'],
    );
    await close();
    request = await start(async (token) => token === 'other-test-token'
      ? { issuer: 'https://identity.test', subject: 'other-viewer' } : null);
    const otherHeaders = { Authorization: 'Bearer other-test-token', 'X-Atmos-Workspace': otherWorkspace };
    assert.equal((await request(history, { headers: otherHeaders })).status, 404);
    assert.deepEqual(await (await request('/devices', { headers: otherHeaders })).json(), { devices: [] });
    assert.equal((await request(history, { headers: { Authorization: 'Bearer other-test-token' } })).status, 401);
    await close();
    request = await start(undefined, true);
    assert.equal((await request('/readings', post({ ...reading, readingId: 'outage' }, replacementKey))).status, 503);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM atmos_readings WHERE reading_id = 'outage'")).rows[0].count, 0);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed JWT verification checks signature, issuer, expiration and audience', async () => {
  const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import('jose');
  const { createIdentityVerifier } = await import('../hosted/identity.mjs');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const issuer = 'https://identity.test';
  const verifier = createIdentityVerifier({
    ATMOS_OIDC_ISSUER: issuer,
    ATMOS_OIDC_AUDIENCE: 'atmos',
    ATMOS_OIDC_JWKS_URL: issuer + '/jwks',
  }, () => createLocalJWKSet({ keys: [publicJwk] }));
  async function sign({ audience = 'atmos', tokenIssuer = issuer, expiration = '3m', key = privateKey } = {}) {
    return new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
      .setSubject('test-viewer').setIssuer(tokenIssuer).setAudience(audience)
      .setExpirationTime(expiration).sign(key);
  }
  assert.deepEqual(await verifier(await sign()), { issuer, subject: 'test-viewer' });
  assert.equal(await verifier(await sign({ audience: 'elsewhere' })), null);
  assert.equal(await verifier(await sign({ tokenIssuer: 'https://different.test' })), null);
  assert.equal(await verifier(await sign({ expiration: 1 })), null);
  const otherKey = (await generateKeyPair('RS256')).privateKey;
  assert.equal(await verifier(await sign({ key: otherKey })), null);
});
