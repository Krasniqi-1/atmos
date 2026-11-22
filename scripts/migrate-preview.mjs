import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const connection = process.env.ATMOS_PREVIEW_MIGRATION_URL;
if (!connection) throw new Error('Set ATMOS_PREVIEW_MIGRATION_URL to the isolated preview database.');
const migration = await readFile(new URL('../hosted/001-preview.sql', import.meta.url), 'utf8');
const statements = migration.split(';').map((statement) => statement.trim()).filter(Boolean);
const sql = neon(connection);
try {
  await sql.transaction(statements.map((statement) => sql.query(statement)));
  console.log('Applied Atmos preview migration 001.');
} catch (error) {
  console.error('Preview migration failed:', error.code ?? error.name);
  process.exitCode = 1;
}
