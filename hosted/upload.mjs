import { createHash } from 'node:crypto';
import { storeReading, uuidPattern } from './storage.mjs';

const MAX_JSON_BYTES = 4096;
const MAX_READING_AGE_MS = 24 * 60 * 60 * 1000;
const READING_ID_PATTERN = /^[\w-]{1,80}$/;

export const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return null;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) return null;
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
  const { readingId, temperature, humidity, ageMs, deviceId } = body ?? {};
  const validReadingId = typeof readingId === 'string' && READING_ID_PATTERN.test(readingId);
  const validTemperature = Number.isFinite(temperature) && temperature >= -40 && temperature <= 80;
  const validHumidity = Number.isFinite(humidity) && humidity >= 0 && humidity <= 100;
  const validAge = Number.isInteger(ageMs) && ageMs >= 0 && ageMs <= MAX_READING_AGE_MS;
  const validDeviceId = deviceId === undefined || (typeof deviceId === 'string' && uuidPattern.test(deviceId));
  if (!(validReadingId && validTemperature && validHumidity && validAge && validDeviceId)) {
    return [400, { error: 'invalid_reading' }];
  }
  return storeReading(sql, hash(bearer), body);
}
