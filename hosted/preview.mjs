import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const receiptColumns = `device_id AS "deviceId", reading_id AS "readingId",
  measured_at AS "measuredAt", received_at AS "receivedAt", temperature, humidity,
  'simulator' AS provenance`;

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function sessionSignature(expiry, secret) {
  return createHmac('sha256', secret).update(`atmos-viewer:${expiry}`).digest('base64url');
}

function hasViewerSession(req, secret) {
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)__Host-atmos-preview=([^;]+)/)?.[1];
  if (!cookie) return false;
  const [expiry, signature, extra] = cookie.split('.');
  return !extra && /^\d{13}$/.test(expiry) && Number(expiry) > Date.now()
    && equal(signature, sessionSignature(expiry, secret));
}

export function createPreviewHandler(env, connect = neon) {
  return async function preview(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const { VERCEL_ENV, ATMOS_PREVIEW_DATABASE_URL, ATMOS_PREVIEW_ADMIN_KEY,
      ATMOS_PREVIEW_VIEWER_PASSWORD, ATMOS_PREVIEW_SESSION_SECRET } = env;
    if (VERCEL_ENV !== 'preview') return reply(404, { error: 'not_found' });
    if (![ATMOS_PREVIEW_DATABASE_URL, ATMOS_PREVIEW_ADMIN_KEY,
      ATMOS_PREVIEW_VIEWER_PASSWORD, ATMOS_PREVIEW_SESSION_SECRET].every(Boolean)) {
      return reply(503, { error: 'preview_unconfigured' });
    }

    const path = req.url.split('?')[0];
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    try {
      if (req.method === 'POST' && path === '/api/v1/session') {
        const credentials = await readJson(req);
        if (!equal(credentials?.password, ATMOS_PREVIEW_VIEWER_PASSWORD)) {
          return reply(401, { error: 'unauthorized' });
        }
        const expiry = Date.now() + 3600000;
        res.setHeader('Set-Cookie', `__Host-atmos-preview=${expiry}.${sessionSignature(expiry, ATMOS_PREVIEW_SESSION_SECRET)}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict`);
        return reply(200, { role: 'viewer' });
      }

      const sql = connect(ATMOS_PREVIEW_DATABASE_URL);
      if (req.method === 'POST' && path === '/api/v1/devices') {
        if (!equal(bearer, ATMOS_PREVIEW_ADMIN_KEY)) return reply(401, { error: 'unauthorized' });
        const body = await readJson(req);
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 100) return reply(400, { error: 'invalid_name' });
        const deviceId = randomUUID();
        const deviceKey = randomBytes(32).toString('base64url');
        await sql`INSERT INTO atmos_devices (id, name, key_hash) VALUES (${deviceId}, ${name}, ${hash(deviceKey)})`;
        return reply(201, { deviceId, name, deviceKey });
      }

      if (req.method === 'POST' && path === '/api/v1/readings') {
        if (!bearer) return reply(401, { error: 'unauthorized' });
        const [device] = await sql`SELECT id FROM atmos_devices WHERE key_hash = ${hash(bearer)}`;
        if (!device) return reply(401, { error: 'unauthorized' });
        const body = await readJson(req);
        if (typeof body?.readingId !== 'string' || !/^[\w-]{1,80}$/.test(body.readingId)
          || !Number.isFinite(body.temperature) || body.temperature < -40 || body.temperature > 80
          || !Number.isFinite(body.humidity) || body.humidity < 0 || body.humidity > 100
          || !Number.isInteger(body.ageMs) || body.ageMs < 0 || body.ageMs > 86400000
          || (body.deviceId !== undefined && body.deviceId !== device.id)) {
          return reply(400, { error: 'invalid_reading' });
        }
        const receivedAt = Date.now();
        const measuredAt = new Date(receivedAt - body.ageMs).toISOString();
        const [inserted] = await sql.query(
          `INSERT INTO atmos_readings (device_id, reading_id, measured_at, received_at, temperature, humidity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (device_id, reading_id) DO NOTHING RETURNING ${receiptColumns}`,
          [device.id, body.readingId, measuredAt, new Date(receivedAt).toISOString(), body.temperature, body.humidity],
        );
        if (inserted) return reply(201, inserted);
        const [existing] = await sql.query(
          `SELECT ${receiptColumns} FROM atmos_readings WHERE device_id = $1 AND reading_id = $2`,
          [device.id, body.readingId],
        );
        if (existing.temperature !== body.temperature || existing.humidity !== body.humidity) {
          return reply(409, { error: 'reading_id_conflict' });
        }
        return reply(200, existing);
      }

      const deviceId = path.match(/^\/api\/v1\/devices\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/readings$/i)?.[1];
      if (req.method === 'GET' && deviceId) {
        if (!hasViewerSession(req, ATMOS_PREVIEW_SESSION_SECRET)) return reply(401, { error: 'unauthorized' });
        const [device] = await sql`SELECT name FROM atmos_devices WHERE id = ${deviceId}`;
        if (!device) return reply(404, { error: 'not_found' });
        const readings = await sql.query(
          `SELECT ${receiptColumns} FROM atmos_readings WHERE device_id = $1
           ORDER BY measured_at DESC, reading_id DESC LIMIT 100`,
          [deviceId],
        );
        return reply(200, { device, readings });
      }
      return reply(404, { error: 'not_found' });
    } catch (error) {
      console.error('Atmos preview request failed', error.code ?? error.name);
      return reply(503, { error: 'temporarily_unavailable' });
    }
  };
}

export default createPreviewHandler(process.env);