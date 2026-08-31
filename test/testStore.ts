import { InMemoryStore } from '../src/store/memory.js';
import { PostgresStore } from '../src/store/postgres.js';
import type { MigrationStore } from '../src/store/types.js';

/**
 * Picks the store the suite runs against.
 *
 * By default: the in-memory adapter, no infrastructure required. Set
 * DATABASE_URL to run the exact same tests against a real Postgres instead —
 * the point of the adapter is that nothing above the port should be able to
 * tell the difference:
 *
 *   npm run db:migrate                          # once, against a fresh database
 *   DATABASE_URL=postgres://fmos:...@localhost/fmos_test npm test
 *
 * `resetForTests()` truncates every tenant-scoped table between tests, since
 * fixtures reuse fixed ids (`ten_nova`, `cus_82931`, ...) and Postgres — unlike
 * the in-memory Map — actually enforces the uniqueness that implies.
 */

let pgStore: PostgresStore | undefined;

export async function freshStore(): Promise<MigrationStore> {
  const url = process.env.DATABASE_URL;
  if (!url) return new InMemoryStore();
  pgStore ??= PostgresStore.connect(url);
  await pgStore.resetForTests();
  return pgStore;
}

export const usingPostgres = Boolean(process.env.DATABASE_URL);

export async function closeTestStore(): Promise<void> {
  await pgStore?.close();
  pgStore = undefined;
}
