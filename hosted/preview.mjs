import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { createIdentityVerifier } from './identity.mjs';
import deviceIngress from './ingress.mjs';
import { acceptUpload, hash, readJson } from './upload.mjs';
import {
  defaultWorkspace, issueKey, receiptColumns, registerDevice, revokeKey, uuidPattern,
} from './storage.mjs';

const equal = (a, b) => typeof a === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
function parseBound(value) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : false;
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

export function createPreviewHandler(env, connect = neon, verifyIdentity = createIdentityVerifier(env)) {
  return async function preview(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const production = env.VERCEL_ENV === 'production';
    const connection = production ? env.ATMOS_PRODUCTION_VIEWER_DATABASE_URL : env.ATMOS_PREVIEW_DATABASE_URL;
    const viewerPassword = production ? env.ATMOS_PRODUCTION_VIEWER_PASSWORD : env.ATMOS_PREVIEW_VIEWER_PASSWORD;
    const sessionSecret = production ? env.ATMOS_PRODUCTION_SESSION_SECRET : env.ATMOS_PREVIEW_SESSION_SECRET;
    if (!production && env.VERCEL_ENV !== 'preview') return reply(404, { error: 'not_found' });
    if (!connection || (!production && !verifyIdentity && (!viewerPassword || !sessionSecret))) {
      return reply(503, { error: 'viewer_unconfigured' });
    }

    let path = req.url.split('?')[0];
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    try {
      if (req.method === 'POST' && path === '/api/v1/session' && !verifyIdentity && !production) {
        const credentials = await readJson(req);
        if (!equal(credentials?.password, viewerPassword)) {
          return reply(401, { error: 'unauthorized' });
        }
        const expiry = Date.now() + 3600000;
        res.setHeader('Set-Cookie', `__Host-atmos-preview=${expiry}.${sessionSignature(expiry, sessionSecret)}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict`);
        return reply(200, { role: 'viewer' });
      }

      const url = new URL(req.url, 'https://atmos.invalid');
      let workspace = req.headers['x-atmos-workspace'] ?? defaultWorkspace;
      if (!uuidPattern.test(workspace)) return reply(400, { error: 'invalid_workspace' });
      const sql = connect(connection);
      if (!production && req.method === 'POST' && path === '/api/v1/readings') {
        return reply(...await acceptUpload(req, sql, bearer));
      }

      if (production && req.method !== 'GET') return reply(404, { error: 'not_found' });
      let role;
      let actor;
      const deviceRoute = path.match(/^\/api\/v1\/device\/(readings|export\.csv|rollups)$/);
      if (req.method === 'GET' && deviceRoute) {
        if (!bearer) return reply(401, { error: 'unauthorized' });
        const keySql = production ? connect(env.ATMOS_INGRESS_DATABASE_URL) : sql;
        const [device] = await keySql`SELECT d.id, d.workspace_id FROM atmos_device_keys k
          JOIN atmos_devices d ON d.id = k.device_id
          WHERE k.key_hash = ${hash(bearer)} AND k.revoked_at IS NULL AND d.disabled_at IS NULL`;
        if (!device) return reply(401, { error: 'unauthorized' });
        workspace = device.workspace_id;
        path = '/api/v1/devices/' + device.id + '/' + deviceRoute[1];
        role = 'viewer';
      } else if (production) {
        return reply(404, { error: 'not_found' });
      } else if (verifyIdentity) {
        const identity = bearer ? await verifyIdentity(bearer) : null;
        if (!identity) return reply(401, { error: 'unauthorized' });
        const [member] = await sql`SELECT role FROM atmos_memberships
          WHERE workspace_id = ${workspace} AND issuer = ${identity.issuer} AND subject = ${identity.subject}`;
        role = member?.role;
        actor = JSON.stringify([identity.issuer, identity.subject]);
      } else if (workspace === defaultWorkspace) {
        if (!production && env.ATMOS_PREVIEW_ADMIN_KEY && equal(bearer, env.ATMOS_PREVIEW_ADMIN_KEY)) {
          role = 'admin';
          actor = 'preview-admin';
        } else if (hasViewerSession(req, sessionSecret)) {
          role = 'viewer';
        }
      }
      if (!role) return reply(401, { error: 'unauthorized' });

      if (req.method === 'GET' && path === '/api/v1/devices') {
        const devices = await sql`SELECT d.id, d.name, d.room, d.source, d.last_contact_at AS "lastContactAt",
          d.disabled_at AS "disabledAt", row_to_json(latest) AS latest
          FROM atmos_devices d LEFT JOIN LATERAL (
            SELECT reading_id AS "readingId", measured_at AS "measuredAt", temperature, humidity, provenance
            FROM atmos_readings WHERE device_id = d.id
            ORDER BY measured_at DESC, reading_id DESC LIMIT 1
          ) latest ON TRUE WHERE d.workspace_id = ${workspace} ORDER BY d.name, d.id`;
        return reply(200, { devices });
      }

      if (req.method === 'POST' && path === '/api/v1/devices') {
        if (role !== 'admin') return reply(403, { error: 'forbidden' });
        const body = await readJson(req);
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        const room = typeof body?.room === 'string' ? body.room.trim() : null;
        const source = body?.source ?? 'simulator';
        if (!name || name.length > 100 || room?.length > 100 || !['physical', 'simulator'].includes(source)) {
          return reply(400, { error: 'invalid_device' });
        }
        return reply(201, await registerDevice(sql, workspace, actor, { name, room, source }, hash));
      }

      const [collection, deviceId, resource, keyId, extra] = path.split('/').slice(3);
      if (collection !== 'devices' || extra !== undefined || !uuidPattern.test(deviceId ?? '')) return reply(404, { error: 'not_found' });
      if (resource === 'keys') {
        if (role !== 'admin') return reply(403, { error: 'forbidden' });
        if (req.method === 'POST' && !keyId) {
          const issued = await issueKey(sql, workspace, deviceId, actor, hash);
          return issued ? reply(201, issued) : reply(404, { error: 'not_found' });
        }
        if (req.method === 'DELETE' && uuidPattern.test(keyId ?? '')) {
          const revoked = await revokeKey(sql, workspace, deviceId, keyId, actor);
          return revoked ? reply(200, revoked) : reply(404, { error: 'not_found' });
        }
      }

      if (req.method === 'GET' && resource === 'rollups' && !keyId) {
        const start = parseBound(url.searchParams.get('start'));
        const end = parseBound(url.searchParams.get('end'));
        if (!start || !end || end <= start || Date.parse(end) - Date.parse(start) > 31 * 86400000) {
          return reply(400, { error: 'invalid_range' });
        }
        const [device] = await sql`SELECT name, source FROM atmos_devices WHERE id = ${deviceId} AND workspace_id = ${workspace}`;
        if (!device) return reply(404, { error: 'not_found' });
        const summaries = await sql`SELECT bucket_start AS "bucketStart", sample_count AS "sampleCount",
          temperature_min AS "temperatureMin", temperature_avg AS "temperatureAvg", temperature_max AS "temperatureMax",
          humidity_min AS "humidityMin", humidity_avg AS "humidityAvg", humidity_max AS "humidityMax"
        FROM atmos_reading_rollups WHERE device_id = ${deviceId}
          AND bucket_start >= ${start} AND bucket_start < ${end}
        ORDER BY bucket_start DESC`;
        return reply(200, { device, intervalSeconds: 300, summaries });
      }

      if (req.method === 'GET' && ['readings', 'export.csv'].includes(resource) && !keyId) {
        const [device] = await sql`SELECT name, source FROM atmos_devices WHERE id = ${deviceId} AND workspace_id = ${workspace}`;
        if (!device) return reply(404, { error: 'not_found' });
        const csv = resource === 'export.csv';
        const start = parseBound(url.searchParams.get('start'));
        const end = parseBound(url.searchParams.get('end'));
        const limit = Number(url.searchParams.get('limit') ?? (csv ? 15000 : 100));
        const metrics = (url.searchParams.get('metrics') ?? 'temperature,humidity').split(',');
        const metricHeaders = { temperature: 'temperature_c', humidity: 'humidity_percent' };
        if (csv && (metrics.some((metric) => !Object.hasOwn(metricHeaders, metric))
          || new Set(metrics).size !== metrics.length)) return reply(400, { error: 'invalid_metrics' });
        if (start === false || end === false || (start && end && start >= end)
          || !Number.isInteger(limit) || limit < 1 || limit > (csv ? 15000 : 500)) {
          return reply(400, { error: 'invalid_range' });
        }
        const readings = await sql.query(
          `SELECT ${receiptColumns}${csv ? '' : ', count(*) OVER ()::int AS total'} FROM atmos_readings WHERE device_id = $1
           AND ($2::timestamptz IS NULL OR measured_at >= $2)
           AND ($3::timestamptz IS NULL OR measured_at < $3)
           ORDER BY measured_at DESC, reading_id DESC LIMIT $4`,
          [deviceId, start, end, csv ? limit + 1 : limit],
        );
        if (!csv) return reply(200, {
          device, count: readings[0]?.total ?? 0,
          readings: readings.map(({ total, ...reading }) => reading),
        });
        if (readings.length > limit) return reply(422, { error: 'export_range_too_large' });
        const header = ['device_id', 'reading_id', 'measured_at_utc', 'received_at_utc', ...metrics.map((metric) => metricHeaders[metric]), 'provenance'].join(',');
        const lines = readings.map((row) => [
          row.deviceId, row.readingId, new Date(row.measuredAt).toISOString(),
          new Date(row.receivedAt).toISOString(), ...metrics.map((metric) => row[metric]), row.provenance,
        ].join(','));
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="atmos-readings.csv"',
          'Cache-Control': 'no-store',
        });
        return res.end([header, ...lines, ''].join('\r\n'));
      }
      return reply(404, { error: 'not_found' });
    } catch (error) {
      console.error('Atmos preview request failed', error.code ?? error.name);
      return reply(503, { error: 'temporarily_unavailable' });
    }
  };
}

const hosted = createPreviewHandler(process.env);
export default function handler(req, res) {
  const path = req.url.split('?')[0];
  if (process.env.VERCEL_ENV === 'production'
    && ((req.method === 'POST' && path === '/api/v1/readings') || path === '/api/v1/maintenance/rollups')) {
    return deviceIngress(req, res);
  }
  return hosted(req, res);
}
