import { randomBytes, randomUUID } from 'node:crypto';

export const defaultWorkspace = '00000000-0000-4000-8000-000000000001';
export const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const receiptColumns = `device_id AS "deviceId", reading_id AS "readingId",
  measured_at AS "measuredAt", received_at AS "receivedAt", temperature, humidity, provenance`;

export async function registerDevice(sql, workspace, actor, { name, room, source }, hash) {
  const deviceId = randomUUID();
  const deviceKey = randomBytes(32).toString('base64url');
  const [key] = await sql`WITH device AS (
    INSERT INTO atmos_devices (id, workspace_id, name, room, source)
    VALUES (${deviceId}, ${workspace}, ${name}, ${room}, ${source}) RETURNING id
  ), credential AS (
    INSERT INTO atmos_device_keys (device_id, key_hash)
    SELECT id, ${hash(deviceKey)} FROM device RETURNING id, device_id
  )
  INSERT INTO atmos_audit_events (workspace_id, device_id, key_id, actor, action)
  SELECT ${workspace}, device_id, id, ${actor}, 'register' FROM credential
  RETURNING key_id AS "keyId"`;
  return { deviceId, name, deviceKey, ...key };
}

export async function issueKey(sql, workspace, deviceId, actor, hash) {
  const deviceKey = randomBytes(32).toString('base64url');
  const [issued] = await sql`WITH credential AS (
    INSERT INTO atmos_device_keys (device_id, key_hash)
    SELECT id, ${hash(deviceKey)} FROM atmos_devices
    WHERE id = ${deviceId} AND workspace_id = ${workspace} AND disabled_at IS NULL
    RETURNING id, device_id
  )
  INSERT INTO atmos_audit_events (workspace_id, device_id, key_id, actor, action)
  SELECT ${workspace}, device_id, id, ${actor}, 'issue_key' FROM credential
  RETURNING key_id AS "keyId"`;
  return issued ? { deviceId, deviceKey, ...issued } : null;
}

export async function revokeKey(sql, workspace, deviceId, keyId, actor) {
  const [revoked] = await sql`WITH credential AS (
    UPDATE atmos_device_keys AS k SET revoked_at = now()
    FROM atmos_devices AS d
    WHERE k.id = ${keyId} AND k.device_id = d.id AND d.id = ${deviceId}
      AND d.workspace_id = ${workspace} AND k.revoked_at IS NULL
    RETURNING k.id, k.device_id, k.key_hash
  ), clearLegacy AS (
    UPDATE atmos_devices AS d SET key_hash = NULL
    FROM credential AS c WHERE d.id = c.device_id AND d.key_hash = c.key_hash
  )
  INSERT INTO atmos_audit_events (workspace_id, device_id, key_id, actor, action)
  SELECT ${workspace}, device_id, id, ${actor}, 'revoke_key' FROM credential
  RETURNING key_id AS "keyId"`;
  return revoked ?? null;
}

export async function storeReading(sql, keyHash, body) {
  const receivedAt = Date.now();
  const measuredAt = new Date(receivedAt - body.ageMs).toISOString();
  const [result] = await sql.query(
    `WITH authorized AS (
       SELECT d.id FROM atmos_device_keys k JOIN atmos_devices d ON d.id = k.device_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND d.disabled_at IS NULL
         AND ($7::uuid IS NULL OR d.id = $7)
       FOR SHARE OF k
     ), contact AS (
       UPDATE atmos_devices d SET last_contact_at = GREATEST(d.last_contact_at, $4::timestamptz)
       FROM authorized a WHERE d.id = a.id AND d.disabled_at IS NULL
       RETURNING d.id, d.source
     ), inserted AS (
       INSERT INTO atmos_readings (device_id, reading_id, measured_at, received_at, temperature, humidity, provenance)
       SELECT id, $2, $3, $4, $5, $6, source FROM contact
       ON CONFLICT (device_id, reading_id) DO NOTHING RETURNING ${receiptColumns}
     )
     SELECT c.id, row_to_json(i) AS receipt FROM contact c LEFT JOIN inserted i ON TRUE`,
    [keyHash, body.readingId, measuredAt, new Date(receivedAt).toISOString(), body.temperature, body.humidity, body.deviceId ?? null],
  );
  if (!result) return [401, { error: 'unauthorized' }];
  if (result.receipt) {
    // PostgreSQL serializes timestamps differently inside JSON. Keep the v1 ISO UTC contract.
    const receipt = result.receipt;
    receipt.measuredAt = new Date(receipt.measuredAt).toISOString();
    receipt.receivedAt = new Date(receipt.receivedAt).toISOString();
    return [201, receipt];
  }
  const [existing] = await sql.query(
    `SELECT ${receiptColumns} FROM atmos_readings WHERE device_id = $1 AND reading_id = $2`,
    [result.id, body.readingId],
  );
  if (existing.temperature !== body.temperature || existing.humidity !== body.humidity) {
    return [409, { error: 'reading_id_conflict' }];
  }
  return [200, existing];
}
