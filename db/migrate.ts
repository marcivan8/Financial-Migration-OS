import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Applies db/migrations/*.sql in filename order, tracking what has already
 * run in a `schema_migrations` table. Idempotent: re-running it only applies
 * files it hasn't seen.
 *
 * Deliberately not a build-time step — a schema change should be a reviewed,
 * explicit action against a specific database, not something that happens as
 * a side effect of `npm install`.
 *
 * Usage:
 *   DATABASE_URL=postgres://fmos_admin:...@localhost/fmos npm run db:migrate
 */

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT id FROM schema_migrations')).rows.map(
        (r: { id: string }) => r.id,
      ),
    );

    const files = readdirSync(join(here, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(here, 'migrations', file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    return newlyApplied;
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  migrate(url)
    .then((applied) => {
      if (applied.length === 0) {
        console.log('Already up to date.');
      } else {
        console.log(`Applied: ${applied.join(', ')}`);
      }
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
