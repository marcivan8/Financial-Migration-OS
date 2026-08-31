# Financial Migration OS — engine + enterprise API

Milestones 1 and 2 of the build brief: a deterministic migration engine, and the
multi-tenant API, webhooks, batch pipeline and operations dashboard around it.

## Milestone 1 — Migration Engine

The first technical milestone from the build brief: feed it a fictional customer
with several French financial products and two institutions, and it produces a
rules-based **migration plan**, a **task dependency graph**, an **exception list**
and a **completion score** — with no open-banking provider anywhere in the design.

```bash
npm install
npm run demo                  # print the plan for the fixture customer
npm run demo -- --simulate    # also walk the workflow and score completion
npm run demo -- --blocked     # same customer, destination with no securities desk
npm run demo -- --json        # machine-readable plan
npm run serve -- --populate   # boot the API with a 120-customer batch + dashboard
npm test                      # 94 tests
```

## What it does

```
Customer + origin + destination + products + recurring payments
        │
        ▼
   Rules engine  ── deterministic, one rule per (country, product type)
        │
        ▼
   Migration plan ── an item per product and per recurring relationship,
        │            each carrying the rule id that decided it
        ▼
   Task graph    ── dependencies, topologically ordered, cycles rejected
        │
        ▼
   State machine ── append-only events, illegal transitions throw
        │
        ▼
   Completion    ── Financial Relationship Migration Completion Rate
```

Sample output for the fixture customer (8 products, 8 recurring payments):

```
  → CURRENT_ACCOUNT    AUTOMATED_MOBILITY     22 days
  ⇄ LIVRET_A           CLOSE_AND_REOPEN       20 days
  ⇄ LDDS               CLOSE_AND_REOPEN       20 days
  ⇒ PEA                INSTITUTION_TRANSFER   45 days, fees 135,00 €, tax history preserved
  ⇒ CTO                INSTITUTION_TRANSFER   30 days
  ⏸ ASSURANCE_VIE      KEEP_AT_ORIGIN
  ✖ LEP                NOT_MIGRATABLE         destination does not offer it
  ⏸ MORTGAGE           KEEP_AT_ORIGIN

  Critical path   59 days (longest dependency chain, not the sum of all tasks)
  Dispatchable    NO — blocking exceptions must clear first
```

## Design decisions worth arguing with

**No model in the decision path.** `src/rules/` is pure data and pure functions.
A product type plus a jurisdiction plus institution capabilities resolves to
exactly one rule, and that rule is the only authority on whether something moves.
The AI layer from §15 of the brief consumes this output; it never produces it.

**Every outcome carries its provenance.** Each plan item records `ruleId`,
`rationale` and `legalBasis`. When an institution asks why a customer's Livret A
was closed rather than transferred, the answer is a rule id, not a reconstruction.

**Ordering is a safety property, not a display concern.** A Livret A is one per
holder nationwide, so the plan closes the origin account *before* opening the
destination one; a PEA is the reverse, because the destination account must exist
before the transfer can be requested. `test/planner.test.ts` asserts both. Getting
this backwards puts the customer in breach or strands a balance.

**Exceptions are first-class.** `NOT_MIGRATABLE`, `MISSING_PRODUCT_METADATA`,
`DUPLICATE_REGULATED_PRODUCT`, `FISCAL_RESIDENCE_INELIGIBLE` and the rest each
carry a severity and a written resolution. A plan with a blocking exception is
not dispatchable — `isPlanDispatchable()` gates it.

**Completion excludes the impossible.** An LEP the destination does not sell is a
product-shelf fact, not an execution failure. It leaves the denominator and is
reported separately. Folding it into "incomplete" would park every institution at
a permanent 85% and destroy the metric's usefulness.

**Duration is the critical path**, not the sum of task SLAs — independent branches
run in parallel, and summing them would triple the estimate an institution quotes
its customer.

**Money is integer cents.** No floats anywhere near a balance.

## Layout

```
src/
  domain/types.ts        canonical model — customer, institution, account,
                         product, recurring payment; provider-agnostic
  domain/migration.ts    states, transitions, events, tasks, exceptions, plan
  rules/catalog.ts       the FR rule catalog ← the moat lives here
  rules/engine.ts        deterministic resolution + cross-product compliance
  planner/taskGraph.ts   topological sort, critical path, readiness
  planner/planner.ts     the migration planner (pure, no I/O)
  workflow/stateMachine.ts  event-sourced execution
  workflow/completion.ts    the north-star metric
  fixtures/              fictional customer and institutions
  cli.ts                 demo runner

  store/types.ts         the storage port — tenant context on every call
  store/memory.ts        in-memory adapter obeying the same rules as the schema
  auth/keys.ts           hashed API keys, roles, scopes
  api/service.ts         plan → persist → emit → publish (the only side effects)
  api/server.ts          Fastify routes, problem+json, audit
  api/dashboard.ts       server-rendered operations view
  api/serializers.ts     wire format (snake_case, minor-unit money)
  webhooks/dispatcher.ts signing, backoff, dead-letter, replay
  batch/pipeline.ts      bulk import, batched planning, exception queue
  serve.ts               boot with a seeded tenant

db/migrations/
  0001_init.sql          multi-tenant schema, append-only event log
  0002_rls.sql           row-level security policies
```

## ⚠️ The rules are not legal advice

`src/rules/catalog.ts` encodes a working reading of French retail-finance
practice — good enough to build and test an engine against, not good enough to
execute a real customer's migration. Two figures were checked while writing
(2026-08):

- **PEA transfer fees** — 15 € per listed line, 50 € per unlisted line, capped at
  150 € per plan. Décret n° 2020-95 du 5 février 2020 (loi PACTE), art. D. 221-109
  CMF. These are indexed to INSEE CPI and revised every three years, so they need
  a maintenance owner.
- **Mobilité bancaire** — 22 business days for the destination bank to complete
  the switch, 13 months of inbound redirection by the origin bank, free of charge.
  Regulated savings, assurance-vie and PEA are explicitly outside the mandate,
  which is why they each get their own rule here.

Everything else needs counsel before production, per §26 of the brief.

## Milestone 2 — Enterprise API

```bash
npm run serve -- --populate
# → API on :8080, a seeded tenant, and a 120-customer batch already mid-flight
```

The engine stays pure. Everything with a side effect lives above it.

```
  HTTP (Fastify)  ── API keys · RBAC scopes · tenant binding · audit
        │
        ▼
  MigrationService ── plan → persist → emit events → publish webhooks
        │
        ├── BatchPipeline    bulk import, bounded-concurrency planning,
        │                    per-cause exception queue
        └── WebhookDispatcher HMAC-signed, backoff, dead-letter, replay
        │
        ▼
  MigrationStore   ── port; in-memory adapter here, Postgres schema in db/
```

### Endpoints

```http
POST /v1/institutions            GET  /v1/institutions
POST /v1/customers               POST /v1/customers/:id/consents

POST /v1/migrations              GET  /v1/migrations
GET  /v1/migrations/:id          GET  /v1/migrations/:id/status
GET  /v1/migrations/:id/products GET  /v1/migrations/:id/tasks
GET  /v1/migrations/:id/documents GET /v1/migrations/:id/events
POST /v1/migrations/:id/authorize POST /v1/migrations/:id/actions

GET  /v1/exceptions              POST /v1/exceptions/:id/resolve
POST /v1/webhooks/endpoints      GET  /v1/webhooks/deliveries
POST /v1/webhooks/deliveries/:id/replay

POST /v1/batches                 POST /v1/batches/:id/import
POST /v1/batches/:id/plan        GET  /v1/batches/:id/exceptions

GET  /v1/portfolio/stats         GET  /v1/audit         GET /dashboard
```

Errors are RFC 9457 `application/problem+json`. Money is always
`{amount_minor, currency}` — never a decimal that a JSON parser can round.

### Persistence

`db/migrations/0001_init.sql` is the real schema; `0002_rls.sql` adds row-level
security. `src/store/memory.ts` is an adapter that obeys the same rules, so the
API and its tests run with no infrastructure and a Postgres adapter is a
drop-in. Three things the schema enforces rather than trusting the application:

- **`tenant_id` on every row, plus RLS.** The application sets
  `app.tenant_id` per transaction and connects as a role without `BYPASSRLS`.
  One forgotten `WHERE` clause is a cross-institution breach; that class of bug
  is invisible in code review, so the database refuses the row instead.
- **`migration_events` is append-only**, enforced by a trigger, with a gapless
  `UNIQUE (migration_id, sequence)`. An audit log that can be rewritten is worth
  nothing to a regulator, and a missing sequence number should be detectable.
- **`plan_items.rule_id` is `NOT NULL`.** An item with no rule behind it is not
  a decision, it is a guess.

### Security posture

API keys are stored as SHA-256 hashes and compared in constant time; the
plaintext is returned once at issue and never again. Roles carry scopes, and the
split is deliberate: `SERVICE` can plan and execute but cannot resolve an
exception, because clearing a compliance block is a human judgement with a name
attached. `READ_ONLY` powers dashboards without holding a credential that can
authorize a customer's migration. Another tenant's resource returns **404, not
403** — a 403 confirms it exists.

### Webhooks

Only institution-facing events cross the boundary; internal churn
(`TaskStarted`, `StateChanged`) stays internal, because a feed that mirrors the
event log is a feed nobody reads. Payloads are signed `t=<unix>,v1=<hmac>` over
`<t>.<body>`, so a captured request cannot be replayed outside the tolerance
window. Failures retry on 1m/5m/25m/2h/6h backoff and then **dead-letter rather
than vanish** — an institution whose endpoint was down for a day needs to see
and replay what it missed.

### Mass migration

`POST /v1/batches/:id/import` then `/plan`. 500 customers plan in ~600ms in the
test suite. The design constraint is not throughput, it is failure isolation:
one malformed row in a 500,000-row file must not abort the other 499,999, so
every failure is captured with the customer it belongs to and the run continues.
Re-planning a batch is idempotent per `(batch, customer)`, so a partially failed
run resumes instead of migrating anyone twice.

### Operations dashboard

`GET /dashboard` renders live from the store — every number on it is what
`GET /v1/portfolio/stats` returns. Two decisions worth noting:

- **The exception queue groups by root cause, not by customer.** One destination
  that does not sell the LEP produced 23 identical rows in the first build, and
  would produce 4,000 in production. Grouped, it is one decision to make once,
  with the affected population as the measure of what it is worth. 70 exceptions
  become 2 cases.
- **A migration that finished with products left behind reads
  `COMPLETED · partial`.** It moved everything it was allowed to move, but part
  of the customer's money is still at the old bank. A plain green "completed"
  there would let an institution believe a customer moved when they half did.

Charts follow the data-viz method: headline numbers are stat tiles, not plots;
both bar charts are single-series so every bar is one hue; status colour appears
only with an icon and a word, because green-vs-red fails colourblind separation
(ΔE 4.1 deutan) and hue must never carry the meaning alone. Dark mode is a
selected set of steps for the dark surface, under both the OS media query and an
explicit theme stamp.

## Three bugs the build surfaced

Worth recording, because two of them were invisible until the system ran at more
than one migration:

1. **Nothing ever entered `IN_PROGRESS`.** A blocked task could not escalate, so
   a stalled PEA read as "authorized, all fine" on the dashboard. Fixed by
   deriving state from the task set, with blocked outranking waiting outranking
   progressing.
2. **Task, plan-item and exception ids collided across migrations.** The planner
   minted `tsk_0001` for every customer, so in a shared store one migration
   served its neighbour's task statuses — and rehydration skipped work that was
   never done. In Postgres it would have been a primary-key violation on the
   second insert. Ids are now namespaced by migration id. **The suite passed
   while this was live**, because every test used a single migration; the
   regression tests in `test/planner.test.ts` and `test/api.test.ts` now cover it.
3. **Authorization was reported as execution.** A migration flipped to
   `IN_PROGRESS` the moment consent was captured, hiding the gap — often days —
   between a customer agreeing and the first institution actually moving.

## Not built (deliberately)

**No connectivity layer.** No Powens, no Tink, no TrueLayer. Products arrive as
canonical `FinancialProduct` values, which is the whole point — an open-banking
provider gets plugged into a working engine rather than the engine being
designed around a provider.

**No Postgres adapter.** The schema is written and the port is defined; wiring
`pg` to it is mechanical and deliberately not done, because the in-memory
adapter keeps the test suite infrastructure-free.

**No durable queue.** `WebhookDispatcher.drain()` is called on a timer in
`serve.ts`; in production it is a BullMQ worker or a Temporal activity. The
retry, backoff and dead-letter logic lives in the dispatcher precisely so that
swap does not change behaviour.

**No customer-facing surface**, no document AI, no ops copilot. The AI layer
from §15 consumes this output; none of it belongs in the decision path.

### Next

1. Postgres adapter behind the existing `MigrationStore` port, and run the same
   test suite against it.
2. One open-banking provider mapped onto `FinancialProduct`, behind the
   connectivity abstraction from §5.
3. Get the rule catalog in front of counsel before anything above is built on
   top of it — it is the moat, and right now it is an educated reading.
