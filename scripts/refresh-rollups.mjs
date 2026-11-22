import { neon } from '@neondatabase/serverless';
import { refreshRollups } from '../hosted/rollups.mjs';

const connection = process.env.ATMOS_MIGRATION_DATABASE_URL ?? process.env.ATMOS_PREVIEW_MIGRATION_URL;
if (!connection) throw new Error('Set ATMOS_MIGRATION_DATABASE_URL to the intended Atmos database.');
const args = process.argv.slice(2);
const day = 86400000;
const previousMidnight = Math.floor(Date.now() / day) * day;
const start = args.length ? Date.parse(args[0]) : previousMidnight - 2 * day;
const end = args.length ? Date.parse(args[1]) : previousMidnight;
if ((args.length && (args.length !== 2 || args.some((value) => !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00Z$/.test(value))))
  || !(start < end) || start % 300000 !== 0 || end % 300000 !== 0
  || end > Math.floor(Date.now() / 300000) * 300000 || end - start > 31 * day) {
  throw new Error('Use two UTC timestamps on five-minute boundaries for a completed range of up to 31 days.');
}
const rows = await refreshRollups(neon(connection), new Date(start).toISOString(), new Date(end).toISOString());
console.log(`Refreshed ${rows.length} five-minute summaries.`);
