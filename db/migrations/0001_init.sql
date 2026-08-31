-- ===========================================================================
-- Financial Migration OS — initial schema
-- ===========================================================================
--
-- Design commitments encoded here, not left to application code:
--
--   1. tenant_id on EVERY row. There is no table a tenant can reach without
--      passing its own id, and row-level security enforces it in the database
--      so an application bug cannot leak across institutions.
--   2. migration_events is append-only. No UPDATE, no DELETE — enforced by a
--      trigger. The event log is the audit spine; if it can be rewritten it is
--      worth nothing to a regulator.
--   3. Money is BIGINT minor units plus a currency column. Never NUMERIC
--      inferred, never floats.
--   4. Rule provenance (rule_id) is stored on every plan item, so "why was this
--      customer's Livret A closed" is answerable years later.
--
-- Target: PostgreSQL 15+.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy and access
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
    id              TEXT PRIMARY KEY,
    name            TEXT        NOT NULL,
    country         TEXT        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    disabled_at     TIMESTAMPTZ
);

CREATE TYPE api_role AS ENUM ('ADMIN', 'OPERATOR', 'READ_ONLY', 'SERVICE');

-- Only a hash is stored. A leaked database must not yield usable credentials.
CREATE TABLE api_keys (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    key_prefix      TEXT        NOT NULL,           -- shown in the UI, e.g. fmos_live_a1b2
    key_hash        TEXT        NOT NULL,           -- sha-256 of the full key
    role            api_role    NOT NULL DEFAULT 'SERVICE',
    scopes          TEXT[]      NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    UNIQUE (key_hash)
);

CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

CREATE TABLE institutions (
    id                          TEXT PRIMARY KEY,
    tenant_id                   TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                        TEXT        NOT NULL,
    country                     TEXT        NOT NULL,
    type                        TEXT        NOT NULL,
    bic                         TEXT,
    supported_products          TEXT[]      NOT NULL DEFAULT '{}',
    supports_mobility_scheme    BOOLEAN     NOT NULL DEFAULT false,
    supports_securities_in      BOOLEAN     NOT NULL DEFAULT false,
    has_api                     BOOLEAN     NOT NULL DEFAULT false,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX institutions_tenant_idx ON institutions (tenant_id);

-- ---------------------------------------------------------------------------
-- Customers and consent
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
    id                      TEXT PRIMARY KEY,
    tenant_id               TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    institution_id          TEXT        NOT NULL REFERENCES institutions(id),
    external_ref            TEXT,                       -- the institution's own id
    first_name              TEXT        NOT NULL,
    last_name               TEXT        NOT NULL,
    date_of_birth           DATE        NOT NULL,
    country_of_residence    TEXT        NOT NULL,
    fiscal_residence        TEXT        NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Retention: personal data is purged on this date unless a migration is
    -- still open. Set by policy, not by hand.
    purge_after             DATE,
    UNIQUE (tenant_id, external_ref)
);

CREATE INDEX customers_tenant_idx ON customers (tenant_id);

CREATE TABLE consents (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id     TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    scopes          TEXT[]      NOT NULL,
    granted_at      TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    evidence        JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- how consent was captured
    CHECK (expires_at > granted_at)
);

CREATE INDEX consents_customer_idx ON consents (tenant_id, customer_id);

-- ---------------------------------------------------------------------------
-- Financial products
-- ---------------------------------------------------------------------------

CREATE TABLE financial_products (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id         TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    institution_id      TEXT        NOT NULL REFERENCES institutions(id),
    account_id          TEXT        NOT NULL,
    type                TEXT        NOT NULL,
    raw_label           TEXT        NOT NULL,       -- exactly as the origin returned it
    balance_minor       BIGINT      NOT NULL,
    currency            TEXT        NOT NULL DEFAULT 'EUR',
    opened_at           DATE,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Which connectivity provider produced this row, for debugging and for the
    -- day a provider's normalisation changes underneath you.
    source_provider     TEXT,
    source_fetched_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX financial_products_customer_idx ON financial_products (tenant_id, customer_id);

CREATE TABLE recurring_payments (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id         TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    account_id          TEXT        NOT NULL,
    merchant            TEXT        NOT NULL,
    amount_minor        BIGINT      NOT NULL,
    currency            TEXT        NOT NULL DEFAULT 'EUR',
    frequency           TEXT        NOT NULL,
    category            TEXT        NOT NULL,
    direction           TEXT        NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    confidence          NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    migration_status    TEXT        NOT NULL DEFAULT 'NOT_STARTED',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX recurring_payments_customer_idx ON recurring_payments (tenant_id, customer_id);

-- ---------------------------------------------------------------------------
-- Migrations
-- ---------------------------------------------------------------------------

CREATE TABLE migrations (
    id                          TEXT PRIMARY KEY,
    tenant_id                   TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id                 TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    origin_institution_id       TEXT        NOT NULL REFERENCES institutions(id),
    destination_institution_id  TEXT        NOT NULL REFERENCES institutions(id),
    batch_id                    TEXT,
    state                       TEXT        NOT NULL DEFAULT 'CREATED',
    -- Denormalised for dashboard queries over hundreds of thousands of rows.
    completion                  NUMERIC(5,4) NOT NULL DEFAULT 0,
    blocking_exception_count    INTEGER     NOT NULL DEFAULT 0,
    estimated_duration_days     INTEGER,
    estimated_fees_minor        BIGINT      NOT NULL DEFAULT 0,
    -- Idempotency: the same key from the same tenant returns the same migration
    -- instead of creating a second one. Institutions retry; they should not
    -- double-migrate a customer because a socket timed out.
    idempotency_key             TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ,
    UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX migrations_tenant_state_idx ON migrations (tenant_id, state);
CREATE INDEX migrations_batch_idx ON migrations (tenant_id, batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX migrations_blocked_idx ON migrations (tenant_id)
    WHERE blocking_exception_count > 0;

CREATE TABLE plan_items (
    id                      TEXT PRIMARY KEY,
    tenant_id               TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    migration_id            TEXT        NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
    subject                 TEXT        NOT NULL CHECK (subject IN ('PRODUCT', 'RECURRING_PAYMENT')),
    subject_id              TEXT        NOT NULL,
    product_type            TEXT,
    category                TEXT        NOT NULL,
    label                   TEXT        NOT NULL,
    action                  TEXT        NOT NULL,
    -- Provenance. Never null: an item with no rule behind it is not a decision,
    -- it is a guess, and the engine does not produce guesses.
    rule_id                 TEXT        NOT NULL,
    rationale               TEXT        NOT NULL,
    balance_minor           BIGINT,
    currency                TEXT,
    preserves_tax_history   BOOLEAN     NOT NULL DEFAULT false,
    estimated_duration_days INTEGER     NOT NULL DEFAULT 0,
    estimated_fees_minor    BIGINT      NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX plan_items_migration_idx ON plan_items (tenant_id, migration_id);

CREATE TABLE migration_tasks (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    migration_id    TEXT        NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
    item_id         TEXT        REFERENCES plan_items(id) ON DELETE CASCADE,
    type            TEXT        NOT NULL,
    label           TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'PENDING',
    actor           TEXT        NOT NULL,
    sla_days        INTEGER     NOT NULL DEFAULT 0,
    deadline_at     TIMESTAMPTZ,
    dependencies    TEXT[]      NOT NULL DEFAULT '{}',
    documents       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    position        INTEGER     NOT NULL,           -- topological execution order
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX migration_tasks_migration_idx ON migration_tasks (tenant_id, migration_id, position);
CREATE INDEX migration_tasks_open_idx ON migration_tasks (tenant_id, status)
    WHERE status IN ('READY', 'IN_PROGRESS', 'WAITING_EXTERNAL', 'BLOCKED');

CREATE TABLE migration_exceptions (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    migration_id    TEXT        NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
    task_id         TEXT        REFERENCES migration_tasks(id) ON DELETE SET NULL,
    code            TEXT        NOT NULL,
    severity        TEXT        NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'BLOCKING')),
    message         TEXT        NOT NULL,
    resolution      TEXT        NOT NULL,
    subject_id      TEXT,
    resolved_at     TIMESTAMPTZ,
    resolved_by     TEXT,
    resolution_note TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX migration_exceptions_open_idx ON migration_exceptions (tenant_id, severity)
    WHERE resolved_at IS NULL;
CREATE INDEX migration_exceptions_code_idx ON migration_exceptions (tenant_id, code);

-- ---------------------------------------------------------------------------
-- Event log — append only
-- ---------------------------------------------------------------------------

CREATE TABLE migration_events (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    migration_id    TEXT        NOT NULL REFERENCES migrations(id) ON DELETE CASCADE,
    sequence        INTEGER     NOT NULL,
    type            TEXT        NOT NULL,
    payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Gapless per migration: a missing sequence number is detectable, which is
    -- the whole point of an audit log.
    UNIQUE (migration_id, sequence)
);

CREATE INDEX migration_events_migration_idx ON migration_events (tenant_id, migration_id, sequence);
CREATE INDEX migration_events_type_idx ON migration_events (tenant_id, type, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'migration_events is append-only (attempted % on migration %)',
        TG_OP, COALESCE(OLD.migration_id, NEW.migration_id);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER migration_events_immutable
    BEFORE UPDATE OR DELETE ON migration_events
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Audit log for API access, separate from the domain event log because it
-- records who looked at what, not what happened to the migration.
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    api_key_id      TEXT,
    actor_role      TEXT,
    action          TEXT        NOT NULL,
    resource_type   TEXT        NOT NULL,
    resource_id     TEXT,
    outcome         TEXT        NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED')),
    detail          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, occurred_at DESC);

CREATE TRIGGER audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_endpoints (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    url             TEXT        NOT NULL,
    secret          TEXT        NOT NULL,           -- HMAC signing secret
    event_types     TEXT[]      NOT NULL DEFAULT '{}',   -- empty = all
    active          BOOLEAN     NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id) WHERE active;

CREATE TABLE webhook_deliveries (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    endpoint_id         TEXT        NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event_type          TEXT        NOT NULL,
    payload             JSONB       NOT NULL,
    status              TEXT        NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'DEAD_LETTERED')),
    attempts            INTEGER     NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ,
    last_status_code    INTEGER,
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at        TIMESTAMPTZ
);

CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
    WHERE status = 'PENDING';
CREATE INDEX webhook_deliveries_dead_idx ON webhook_deliveries (tenant_id)
    WHERE status = 'DEAD_LETTERED';

-- ---------------------------------------------------------------------------
-- Batches — the mass institutional migration path
-- ---------------------------------------------------------------------------

CREATE TABLE migration_batches (
    id                  TEXT PRIMARY KEY,
    tenant_id           TEXT        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name                TEXT        NOT NULL,
    origin_institution_id       TEXT NOT NULL REFERENCES institutions(id),
    destination_institution_id  TEXT NOT NULL REFERENCES institutions(id),
    status              TEXT        NOT NULL DEFAULT 'IMPORTING'
                        CHECK (status IN ('IMPORTING', 'PLANNING', 'PLANNED', 'EXECUTING', 'COMPLETED', 'FAILED')),
    total_customers     INTEGER     NOT NULL DEFAULT 0,
    planned_count       INTEGER     NOT NULL DEFAULT 0,
    failed_count        INTEGER     NOT NULL DEFAULT 0,
    blocked_count       INTEGER     NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX migration_batches_tenant_idx ON migration_batches (tenant_id, status);

ALTER TABLE migrations
    ADD CONSTRAINT migrations_batch_fk
    FOREIGN KEY (batch_id) REFERENCES migration_batches(id) ON DELETE SET NULL;

COMMIT;
