import { timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { refreshRollups } from './rollups.mjs';
import { acceptUpload, hash } from './upload.mjs';

export default async function deviceIngress(req, res) {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const path = req.url.split('?')[0];
  const upload = path === '/api/v1/readings' && req.method === 'POST';
  const cron = path === '/api/v1/maintenance/rollups' && req.method === 'GET';
  if (!upload && !cron) return reply(404, { error: 'not_found' });

  const connection = process.env.ATMOS_INGRESS_DATABASE_URL;
  if (!connection) return reply(503, { error: 'ingress_unconfigured' });
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  try {
    if (upload) return reply(...await acceptUpload(req, neon(connection), bearer));
    const secret = process.env.CRON_SECRET;
    if (!secret || !bearer || !timingSafeEqual(Buffer.from(hash(bearer)), Buffer.from(hash(secret)))) {
      return reply(401, { error: 'unauthorized' });
    }
    const day = 86400000;
    const end = Math.floor(Date.now() / day) * day;
    const rows = await refreshRollups(neon(connection), new Date(end - 2 * day).toISOString(), new Date(end).toISOString());
    return reply(200, { summariesRefreshed: rows.length });
  } catch (error) {
    console.error('Atmos production request failed', error.code ?? error.name);
    return reply(503, { error: 'temporarily_unavailable' });
  }
}
