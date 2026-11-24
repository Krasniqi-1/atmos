# Atmos communication contract v1

Implementation baseline: `c2fe46b769ec2de36722c407d6129df34495dc54` · 23 November 2026

## 1. Integration boundaries

| Boundary | Contract | Conditions for replacement |
|---|---|---|
| Sensor or other producer → backend | HTTPS `POST /api/v1/readings`, JSON, device bearer key | A replacement sender needs the endpoint, valid TLS trust, a registered device key and the same fields and retry rules. A replacement receiver needs the same HTTP behavior. |
| Backend → Neon PostgreSQL | Parameterized SQL via the Neon serverless driver | This is a database interface. An alternative PostgreSQL host needs the migrations, permissions and a suitable adapter. Keep the same HTTP contract outside the backend. |
| Backend → web or other client | The client issues authenticated HTTP GET requests and receives JSON or CSV. | A server-side client can use the production API directly. The existing browser client expects same-origin routes. Use an appropriate proxy or CORS configuration when moving it to a different origin. |

```text
ESP32 or simulator -- HTTPS POST --> Vercel API -- parameterized SQL --> PostgreSQL (Neon)
Web app or client -- HTTPS GET --> Vercel API -- parameterized SQL --> PostgreSQL (Neon)
Local web app -- local GET --> Node.js proxy -- HTTPS GET --> Vercel API
```

The first two items in the requested workflow describe one upload from the device's perspective. The Vercel API terminates HTTP and writes to Neon. The ESP32 and browser need an application device key. Database credentials stay on the server.

## 2. Producer to any compatible endpoint

Configure the HTTPS URL and a trusted root certificate on the board. Send `Content-Type: application/json` and `Authorization: Bearer <DEVICE_KEY>`. A JSON body may contain up to 4,096 bytes.

```json
{"readingId":"boot7-42","temperature":21.8,"humidity":66.3,"ageMs":120}
```

| Field | Wire contract |
|---|---|
| `readingId` | Required string of 1–80 ASCII letters, digits, underscores or hyphens. Retain this value on retry. The ESP32 uses a random boot identifier and sequence number. |
| `temperature` | Required finite number from −40 to 80, in °C. |
| `humidity` | Required finite number from 0 to 100, in % RH. |
| `ageMs` | Required integer from 0 to 86,400,000, computed from elapsed milliseconds since sampling. The backend derives `measuredAt` from server receipt minus age. This is an estimate, with transit latency included. |
| `deviceId` | Optional UUID. When supplied, it must match the device resolved from the key. Omitting it lets the key determine the device. |

An integration fixture can POST to an **isolated test instance** with a test key and write the JSON above to `sample.json`. These examples use PowerShell with `curl.exe`. Populate the variables locally.

```powershell
curl.exe -sS -i -X POST "$env:ATMOS_TEST_BASE/api/v1/readings" `
  -H "Authorization: Bearer $env:ATMOS_TEST_KEY" `
  -H "Content-Type: application/json" --data-binary '@sample.json'

curl.exe -sS -i "$env:ATMOS_TEST_BASE/api/v1/device/readings?limit=1" `
  -H "Authorization: Bearer $env:ATMOS_TEST_KEY"
```

| Status | Behavior expected by a compatible integration |
|---|---|
| 201 | A new row committed. Return its receipt and allow the sender to remove the sample from its queue. |
| 200 | The same device and reading ID already have the same temperature and humidity. Return the original receipt and allow the sender to remove the sample. The current age is excluded from duplicate comparison. |
| 400 | The body, fields or size fail validation. Check the producer and discard or quarantine the invalid sample. |
| 401 | Missing, wrong or revoked key, disabled device, or supplied device UUID incompatible with the key. Correct configuration. |
| 409 | The same device and reading ID already have different measurement values. Investigate the identifier or sample. |
| 503 or connection failure | Commit state may be unknown to the sender. Keep the sample and retry with its original ID and measurement values. |

The response fields are `deviceId`, `readingId`, `measuredAt`, `receivedAt`, `temperature`, `humidity` and `provenance`. The backend derives provenance from the device registration. Time strings use UTC with `Z`. An alternate device, gateway or simulator needs to preserve this contract. The legacy local POST route `/api/readings` uses its own LAN key and local device identity. Switching to that route requires the local firmware configuration.

## 3. Backend to PostgreSQL

The handler hashes the bearer key, looks up an active device, and uses the device's stored source. A parameterized SQL statement locks the active key for the operation, updates last contact and inserts the measurement. A primary key on `(device_id, reading_id)` enforces uniqueness, including concurrent delivery. On a duplicate, the handler reads the stored row and compares measurement values. The backend returns a new-row receipt only after the SQL request succeeds. Preview and production use distinct Neon databases and credentials.

Storage includes workspaces, memberships, devices, device keys, raw readings, audit events and five-minute rollups. PostgreSQL stores timestamps in `timestamptz` and the API serializes them as UTC. Raw readings and summaries have different contracts. Maintenance refreshes completed buckets from retained raw rows. Older-row deletion remains disabled.

To replace Neon with another PostgreSQL provider, apply the versioned migrations, configure separate runtime and migration credentials, and choose a driver compatible with the execution environment. The Neon HTTP driver may require replacement with a PostgreSQL connection pool or another adapter. Non-PostgreSQL engines need their own storage implementation for transactions, credential lookup, uniqueness, date aggregation and export. Retry and outage behavior must remain consistent from the caller's perspective.

## 4. Backend to front end

| Method and route | Parameters and result |
|---|---|
| `GET /api/v1/device/readings` | Optional UTC `start` (inclusive) and `end` (exclusive), and `limit` (1–500, default 100). Returns `{device, count, readings}`. `count` is the total for the filter. `readings` has newest measured time first, then descending reading ID. Empty ranges return an empty array and count zero. |
| `GET /api/v1/device/export.csv` | Same bounds. Optional `metrics` is `temperature`, `humidity`, or both comma-separated. Optional limit is 1–15,000, default 15,000. Exceeding the limit returns 422 rather than silently truncating. |
| `GET /api/v1/device/rollups` | Requires both bounds, at most 31 days. Returns `{device, intervalSeconds: 300, summaries}`. Each bucket includes its start, sample count and minimum, mean and maximum for both metrics. |
| Local cloud mode | `GET /api/cloud/readings` and `GET /api/cloud/export.csv` proxy the two corresponding production routes. The local server forwards the key only to the fixed Atmos origin. |

Use the same bearer header as for POST. History exposes no database credentials, and the key selects the device. The current key grants both upload and read access. The public demo generates its own browser samples. The live view at `/live` uses the key in memory and polls about every six seconds while visible. No cross-origin browser authentication is assumed by the contract.

## 5. Substitution evidence and remaining checks

- An independent Python `urllib` producer and reader used the Atmos handler with an isolated PGlite database. It proved POST 201, replay 200 with the same receipt, conflict 409, anonymous GET 401, authorized GET 200 and CSV 200. A separate read-only run against production returned 200 with the device key and 401 without it. Evidence: `dp/data/ATMOS_INTERFACE_CONFORMANCE.json`.
- An independent Python HTTP receiver accepted a firmware-shaped payload. The Atmos dashboard rendered the returned values in a DOM test covering POST and recent history for one in-memory device. The baseline dashboard showed an ESP32 badge for simulated readings. The review branch uses the returned provenance for that badge. Evidence: `dp/data/ATMOS_REPLACEMENT_BACKEND_PROBE.json`.
- The real ESP32 obtained HTTP 201 from Vercel. A production SQL row and the protected API agreed on the reading ID, values and timestamps. Both dashboard origins rendered the live physical feed and refreshed without a page reload. Evidence: `dp/data/ATMOS_DIRECT_HTTPS_SERIAL.json`, `ATMOS_PRODUCTION_UPLOAD_EVIDENCE.json`, `ATMOS_SHARED_DASHBOARD_VERCEL.json` and `ATMOS_SHARED_DASHBOARD_LOCAL.json`.
- The same versioned SQL migrations and handler behavior were exercised with Neon and isolated PGlite. A full cutover to another managed PostgreSQL provider and a physical ESP32 sending directly to a different HTTPS receiver remain acceptance tests. Run TLS, retry, concurrency, restore and historical export checks before declaring an alternate deployment equivalent.

The machine-readable companion covers the four production data routes. Administration and the maintenance trigger are excluded from the client contract.

Standards and implementation references. [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110), [JSON](https://www.rfc-editor.org/rfc/rfc8259), [UTC timestamps](https://www.rfc-editor.org/rfc/rfc3339), [Bearer header convention](https://www.rfc-editor.org/rfc/rfc6750), [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html), [Neon serverless driver](https://neon.com/docs/serverless/serverless-driver).
