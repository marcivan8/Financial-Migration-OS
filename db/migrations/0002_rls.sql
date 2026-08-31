-- ===========================================================================
-- Row-level security
-- ===========================================================================
--
-- Application-side tenant scoping is necessary but not sufficient: one missing
-- WHERE clause in one query is a cross-institution data breach, and that class
-- of bug is invisible in code review. RLS makes the database refuse the row
-- regardless of what the application asked for.
--
-- The application connects as a role WITHOUT BYPASSRLS and sets
--   SET LOCAL app.tenant_id = '<tenant>'
-- at the start of every transaction. No tenant context means no rows — the
-- fail-safe direction.

BEGIN;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS TEXT AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '');
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'institutions', 'customers', 'consents', 'financial_products',
        'recurring_payments', 'migrations', 'plan_items', 'migration_tasks',
        'migration_exceptions', 'migration_events', 'audit_log',
        'webhook_endpoints', 'webhook_deliveries', 'migration_batches',
        'api_keys'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        -- FORCE applies the policy to the table owner too, so a migration run
        -- as the owner cannot quietly read across tenants either.
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I
                USING (tenant_id = current_tenant_id())
                WITH CHECK (tenant_id = current_tenant_id())
        $f$, t);
    END LOOP;
END $$;

-- The application role. Note the absence of BYPASSRLS and of DELETE on the
-- append-only tables.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fmos_app') THEN
        CREATE ROLE fmos_app NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO fmos_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO fmos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fmos_app;

REVOKE UPDATE, DELETE ON migration_events FROM fmos_app;
REVOKE UPDATE, DELETE ON audit_log FROM fmos_app;

-- Deleting a customer is a data-subject-erasure operation with its own
-- procedure and its own audit trail. It is not a routine API capability.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM fmos_app;

COMMIT;
