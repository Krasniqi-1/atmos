import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createPreviewHandler } from '../hosted/preview.mjs';

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

  async function start() {
    database = new PGlite(directory);
    const sql = (parts, ...parameters) => {
      const statement = parts.reduce((query, part, index) => query + '$' + index + part);
      return sql.query(statement, parameters);
    };
    sql.query = async (statement, parameters) => (await database.query(statement, parameters)).rows;
    server = createServer(createPreviewHandler(env, () => sql));
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
    const registration = await request('/devices', post({ name: 'Preview simulator' }, env.ATMOS_PREVIEW_ADMIN_KEY));
    assert.equal(registration.status, 201);
    const { deviceId, deviceKey } = await registration.json();
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
    console.log('Local PostgreSQL receipt:', JSON.stringify(receipt));
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});
