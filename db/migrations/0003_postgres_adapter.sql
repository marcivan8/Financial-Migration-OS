-- ===========================================================================
-- Postgres adapter support
-- ===========================================================================
--
-- Three additions the in-memory store didn't need to make explicit, because
-- an in-process Map doesn't have to declare its shape:
--
--   1. `plan_snapshot` on `migrations`. A generated MigrationPlan is an
--      immutable artifact of the planner — `getPlan()` must return exactly
--      what was produced at planning time, byte for byte, even after tasks
--      complete and exceptions resolve around it (the in-memory store's
--      `plans` map is already separate from its live `tasks`/`exceptions`
--      maps for the same reason). Reconstructing that structure from the
--      normalised tables on every read would risk silently drifting from
--      what the planner actually produced; storing the snapshot verbatim
--      does not.
--
--   2. `migration_ids` on `customers`. Round-trips a field of `Customer`
--      that nothing in the application ever mutates after creation — kept
--      for interface fidelity, not because anything reads it back.
--
--   3. The `fmos_worker` role. `MigrationStore.listDueDeliveries` and
--      `updateDelivery` are deliberately cross-tenant (§ store/types.ts:
--      "the delivery worker is infrastructure, not a caller") — a webhook
--      retry loop has to see every tenant's due deliveries in one query.
--      RLS's fail-safe direction means a role with no tenant context set
--      sees zero rows, not all of them, so that query needs a role that
--      bypasses RLS outright. Scoping BYPASSRLS to a role that can only
--      touch `webhook_deliveries` — rather than granting it on `fmos_app`,
--      which would silently defeat RLS everywhere — keeps the blast radius
--      of that exception to the one table it exists for.

BEGIN;

ALTER TABLE migrations
    ADD COLUMN plan_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE customers
    ADD COLUMN migration_ids TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fmos_worker') THEN
        CREATE ROLE fmos_worker NOLOGIN BYPASSRLS;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fmos_worker;
GRANT SELECT, UPDATE ON webhook_deliveries TO fmos_worker;

COMMIT;
