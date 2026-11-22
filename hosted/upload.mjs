import { createHash } from 'node:crypto';
import { storeReading, uuidPattern } from './storage.mjs';

export const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function readJson(req) {
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

export async function acceptUpload(req, sql, bearer) {
  if (!bearer) return [401, { error: 'unauthorized' }];
  const body = await readJson(req);
  if (typeof body?.readingId !== 'string' || !/^[\w-]{1,80}$/.test(body.readingId)
    || !Number.isFinite(body.temperature) || body.temperature < -40 || body.temperature > 80
    || !Number.isFinite(body.humidity) || body.humidity < 0 || body.humidity > 100
    || !Number.isInteger(body.ageMs) || body.ageMs < 0 || body.ageMs > 86400000
    || (body.deviceId !== undefined && (typeof body.deviceId !== 'string' || !uuidPattern.test(body.deviceId)))) {
    return [400, { error: 'invalid_reading' }];
  }
  return storeReading(sql, hash(bearer), body);
}
