# Atmos database setup

The local dashboard uses JSONL. Use the PostgreSQL setup below for the hosted API or to inspect the schema in a disposable local database. Use an empty development database when following these steps.

## Create the schema

For local PostgreSQL, set `PGHOST`, `PGPORT`, and `PGUSER` for your installation. Use PostgreSQL's normal authentication prompts or configuration.

```powershell
createdb atmos_dev
psql -X -v ON_ERROR_STOP=1 -d atmos_dev -1 -f hosted/001-preview.sql
psql -X -v ON_ERROR_STOP=1 -d atmos_dev -1 -f hosted/002-identity-storage.sql
psql -X -v ON_ERROR_STOP=1 -d atmos_dev -1 -f hosted/003-rollups.sql
```

For a fresh Neon database, set `ATMOS_MIGRATION_DATABASE_URL` in the current shell to its migration connection string, then run `npm ci` and `npm run db:migrate`. The script uses Neon's HTTP driver. Use the `psql` commands for a plain local PostgreSQL server.

1. `001-preview.sql` creates devices, readings, and the descending history index. The primary key `(device_id, reading_id)` protects the identity of a measurement during retries.
2. `002-identity-storage.sql` adds workspaces, memberships, hashed device keys, provenance, and audit events. It preserves existing readings and migrates legacy key hashes.
3. `003-rollups.sql` creates five-minute aggregates keyed by device and bucket start.

## Inspect results

```sql
SELECT device_id, reading_id, measured_at, received_at,
       temperature, humidity, provenance
FROM atmos_readings
ORDER BY measured_at DESC, reading_id DESC
LIMIT 10;

SELECT device_id, bucket_start, sample_count, temperature_avg, humidity_avg
FROM atmos_reading_rollups
ORDER BY bucket_start DESC
LIMIT 10;
```

Run `npm test` for a complete disposable API setup. The preview tests apply the three migrations, register a test device, and exercise authenticated writes and history queries. See [the API contract](CONTRACT.md) and [OpenAPI specification](openapi.json) for request examples.

For a Vercel deployment configure the ingress and viewer database roles with `ATMOS_INGRESS_DATABASE_URL` and `ATMOS_PRODUCTION_VIEWER_DATABASE_URL`. The production API expects an active device with a SHA-256 key hash in `atmos_device_keys`. Give the firmware and authorized dashboard users the original key through a private channel. Configure `CRON_SECRET` if using scheduled rollups.
