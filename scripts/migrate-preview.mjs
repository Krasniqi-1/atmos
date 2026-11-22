import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const connection = process.env.ATMOS_MIGRATION_DATABASE_URL ?? process.env.ATMOS_PREVIEW_MIGRATION_URL;
if (!connection) throw new Error('Set ATMOS_MIGRATION_DATABASE_URL to the intended Atmos database.');
const migrations = ['001-preview.sql', '002-identity-storage.sql', '003-rollups.sql'];

const sql = neon(connection);
try {
  for (const file of migrations) {
    const migration = await readFile(new URL('../hosted/' + file, import.meta.url), 'utf8');
    const statements = migration.split(';').map((statement) => statement.trim()).filter(Boolean);
    await sql.transaction(statements.map((statement) => sql.query(statement)));
    console.log('Applied Atmos preview migration ' + file);
  }

} catch (error) {
  console.error('Preview migration failed:', error.code ?? error.name);
  process.exitCode = 1;
}
