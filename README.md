# Atmos

Atmos measures indoor temperature and humidity with an ESP32 and DHT22. The hosted dashboard reads data from a PostgreSQL-backed API.

- **Live dashboard:** https://atmos-roan.vercel.app/live — select **Connect device** and enter the assigned device token.
- **Demo without a token:** https://atmos-roan.vercel.app/

## Run locally

With Node.js 20 or newer, run `npm start` and open http://127.0.0.1:3000. On Windows, you can also run `start.cmd`. Select **Demo** to explore without hardware. Local sensor readings use JSONL. The hosted API uses PostgreSQL.

## Guides

- [ESP32 and DHT22 setup](HARDWARE.md)
- [PostgreSQL setup and queries](DATABASE.md)
- [API contract](CONTRACT.md) and [OpenAPI specification](openapi.json)

For local verification, run `npm ci`, `npm run check`, and `npm test`. The tests use temporary storage and PGlite.
