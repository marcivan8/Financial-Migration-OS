# Financial Migration OS — engine + enterprise API

Milestones 1 through 5 of the build brief: a deterministic migration engine, the
multi-tenant API, webhooks, batch pipeline and operations dashboard around it, a
Postgres adapter behind the same storage port the in-memory store uses, a
connectivity abstraction with its first provider mapping (Powens), and a
recurring-payment detector that turns raw transaction history into the
`RecurringPayment[]` the planner has consumed since Milestone 1.

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
npm test                      # 127 tests, in-memory store by default
```

Set `DATABASE_URL` to run any of `test`/`serve` against real Postgres instead —
see Milestone 3, below.

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
  store/postgres.ts      Postgres adapter — real RLS, real constraints
  auth/keys.ts           hashed API keys, roles, scopes
  api/service.ts         plan → persist → emit → publish (the only side effects)
  api/server.ts          Fastify routes, problem+json, audit
  api/dashboard.ts       server-rendered operations view
  api/serializers.ts     wire format (snake_case, minor-unit money)
  webhooks/dispatcher.ts signing, backoff, dead-letter, replay
  batch/pipeline.ts      bulk import, batched planning, exception queue
  connectivity/types.ts  ConnectivityProvider — the §5 abstraction
  connectivity/powens.ts first provider: raw Powens accounts/transactions → canonical shapes
  detection/recurring.ts recurring-payment detector — Transaction[] → RecurringPayment[]
  serve.ts               boot with a seeded tenant

db/migrate.ts             tracked, idempotent migration runner
db/migrations/
  0001_init.sql          multi-tenant schema, append-only event log
  0002_rls.sql           row-level security policies
  0003_postgres_adapter.sql  plan snapshot column, fmos_worker role
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
API and its tests run with no infrastructure by default — and `src/store/postgres.ts`
is the drop-in for when they shouldn't (Milestone 3, below). Three things the
schema enforces rather than trusting the application:

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

## Milestone 3 — Postgres adapter

```bash
DATABASE_URL=postgres://fmos:<password>@localhost/fmos npm run db:migrate  # once
DATABASE_URL=postgres://fmos:<password>@localhost/fmos npm test            # same 127 tests, real Postgres
DATABASE_URL=postgres://fmos:<password>@localhost/fmos npm run serve       # data survives a restart
```

`src/store/postgres.ts` implements the same `MigrationStore` port as
`src/store/memory.ts`. `wire()` takes either; `test/api.test.ts` and
`test/batch.test.ts` run unmodified against whichever `DATABASE_URL` selects
(`test/testStore.ts`), which is the actual point of writing the port first —
nothing above it changes to prove the adapter works.

**A generated plan is stored twice, on purpose.** `migrations.plan_snapshot`
holds the `MigrationPlan` exactly as the planner produced it — JSONB, written
once, never touched again — while `plan_items` / `migration_tasks` /
`migration_exceptions` hold the same data normalised, and are what changes as
execution proceeds. `getPlan()` reads the snapshot. This mirrors what the
in-memory store already did (its `plans` map is separate from its live `tasks`
and `exceptions` maps) rather than introducing new behaviour — reconstructing
a plan from tables that execution has since mutated cannot promise the same
byte-for-byte answer a frozen snapshot can.

**RLS needed one deliberate hole, not a bypass.** `MigrationStore.listDueDeliveries`
and `.updateDelivery` are cross-tenant by the port's own contract — a webhook
retry loop has to see every tenant's due deliveries in one query, and "no
tenant context set" is RLS's fail-safe-to-zero-rows direction, not
fail-open. Granting `BYPASSRLS` on the application's main role would defeat
RLS everywhere for that one worker's convenience; instead `db/migrations/0003`
adds `fmos_worker`, a role with `BYPASSRLS` granted `SELECT, UPDATE` on
`webhook_deliveries` alone, and the adapter switches to it (`SET LOCAL ROLE`)
for exactly those two methods. Every other call runs as `fmos_app`, which RLS
still fully constrains.

**One FK had to give, for a reason worth keeping.** `audit_log.tenant_id`
references `tenants(id)` like every other table — reasonable until an
unauthenticated or forged-key request gets audited under `'unknown'` or a
tenant id nobody issued (`server.ts`'s denial path does exactly this). Real
Postgres rejected that insert with a foreign-key violation, turning a clean
401 into a 500 — the in-memory store, which has no FK to violate, had been
masking it the whole time the suite ran against it. A security log has to
accept an attacker's claimed identity without vouching for it, so
`PostgresStore.audit` creates a placeholder `tenants` row on demand rather
than requiring the id to be real first — the same permissiveness the
in-memory adapter had by construction, made explicit for the one table where
referential integrity would otherwise get in the way of its purpose. Found
running the suite against Postgres for the first time, not by review.

**Throughput moved, and most of the gap has since closed.** The in-memory
store plans 500 customers in ~600ms. The first Postgres adapter took ~12s for
the same batch — every plan item, task and exception was its own network
round trip inside the migration's transaction. Batching each table into one
multi-row `INSERT` per migration (`valuesPlaceholders` in `postgres.ts`) cut
that to ~7s. What's left is mostly per-migration transaction overhead (`BEGIN`
/ role switch / `set_config` / `COMMIT`, 500 times over 25-way concurrency) —
batching *across* customers, not just within one, would be the next cut, and
isn't free: it means a failure in customer 214 can no longer be isolated from
customer 213 by a transaction boundary the way `importRows` promises today.

Local setup used for the above (`fmos_worker` is created by the migration
itself):

```sql
CREATE ROLE fmos LOGIN PASSWORD '...';
GRANT fmos_app TO fmos;
GRANT fmos_worker TO fmos;
GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO fmos;  -- test-only, for PostgresStore.resetForTests()
```

## Six bugs the build surfaced

Worth recording, because three of them were invisible until the system ran at
more than one migration — and one only showed up against a real database:

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
4. **A task blocked at execution never reached the operations queue.**
   `blockTask` emitted an `ExceptionRaised` *event* but created no exception
   *record*, so `GET /v1/exceptions` and the dashboard showed only planning-time
   causes. The migration sat in `ACTION_REQUIRED` with nothing saying why — the
   exact failure the exception engine exists to prevent. In the seeded demo that
   hid every one of the 28 migrations awaiting action. Fixed by making
   `blockTask` produce a first-class exception that the service persists, and by
   giving execution-time causes their own vocabulary (`MISSING_DOCUMENT`,
   `ORIGIN_UNRESPONSIVE`, `INVALID_IBAN`, …) that the API validates rather than
   flattening to a generic code.
5. **Resolving an exception left the portfolio reporting it blocked.**
   `blockingExceptionCount` is a denormalised aggregate on `migrations`, set at
   creation and never refreshed, so it drifted in both directions. Every path
   that changes the exception set now recomputes it.
6. **`audit_log`'s foreign key turned a 401 into a 500, only against real
   Postgres.** Covered above (Milestone 3) — the in-memory store has no
   referential integrity to violate, so 92 of the suite's 99 tests passed
   against it while this was live; the other seven, all denial paths, only
   failed once the same suite ran against Postgres for the first time.

## Milestone 4 — connectivity

```bash
npm test   # includes test/connectivity.test.ts — 12 tests, no network, no live Powens account
```

`src/connectivity/types.ts` is the abstraction from §5 of the brief:
`ConnectivityProvider.normalizeAccounts(raw, ctx)` turns a provider's own raw
shape into canonical `FinancialProduct[]`, and that is the entire interface —
no HTTP client, no auth flow. Fetching varies by provider and by deployment;
the part worth capturing in code once is the mapping, so that's the only part
this interface owns.

`src/connectivity/powens.ts` is the first provider, chosen because Powens'
account-type taxonomy already distinguishes `livret_a`, `ldds`, `pel`, `cel`
and `pea` rather than lumping French regulated savings under one generic
"savings" type — which is exactly the classification work the rules engine
needs done *before* a product reaches it. (Field names and the type enum are
modeled from Powens' public API reference, checked while writing this file,
not integration-tested against a live account — the same caveat the rule
catalog already carries.)

**A provider is allowed to not know something, and has to say so rather than
guess.** Three real gaps came out of mapping Powens specifically, and all
three are reported through `NormalizationResult.skipped` rather than solved
by assumption:

- Powens' generic `savings` type doesn't distinguish a LEP from a plain
  unregulated livret — the difference changes which rule applies, so a
  `savings` account is skipped, not defaulted to `LIVRET_A` because that's
  the common case.
- Powens' `loan` type doesn't distinguish a mortgage from any other loan —
  every Powens loan lands as `LOAN`, never `MORTGAGE`. A real limitation of
  classifying from `type` alone, left visible rather than papered over.
- Powens' account object has no opening-date field. `openedAt` still needs a
  value (the domain type requires one), so it falls back to `last_update` — a
  sync timestamp, not the account's real age. It is deliberately *never* used
  for `metadata.fiscalSeniorityDate`: that stays unset for every
  Powens-sourced PEA/PEL/CEL, which routes straight into the rules engine's
  existing `MISSING_PRODUCT_METADATA` check (`rules/engine.ts`) — the
  connectivity boundary and the rules engine's exception handling compose
  without new glue code, which `test/connectivity.test.ts`'s last case checks
  for real rather than asserting in a comment.

**`financial_products.source_provider` and `source_fetched_at` were reserved
in the schema since `db/migrations/0001_init.sql`, unpopulated until now.**
`FinancialProduct` had no field to carry them, so `PostgresStore.putProducts`
had nothing to write. Both are now on the domain type (optional — hand-built
fixtures and the batch pipeline's plain CSV-shaped import still don't set
them) and wired through the adapter.

**Not built alongside this:** recurring-payment detection from raw
transactions. Powens' API doesn't expose it either (checked directly — its
"Subscriptions" product retrieves bills/proof documents, not spending
patterns), and it's a different kind of component from account normalization
— a detector, closer to the AI layer in §15 than to connectivity, but still
deterministic rather than model-based. Built in Milestone 5, below.

### Wired to a caller

```http
POST /v1/batches/:id/import/powens
{"rows": [{"externalRef": "...", "firstName": "...", ..., "rawAccounts": [ /* raw Powens accounts */ ]}]}
```

`BatchPipeline.importFromProvider(ctx, batchId, provider, rows)` takes a
`ConnectivityProvider` and rows of raw accounts, normalizes each customer's
accounts before `putProducts`, and reports the result the same way
`importRows` already does: a customer with *some* accounts skipped still
imports (`skipped_accounts` in the response), a customer with *every* account
unusable is an import failure, and one failing customer never stops the rest
of the batch. `server.ts` dispatches `:provider` against a small registry
(`{ powens: PowensProvider }` today) and 422s an unknown one rather than
guessing which provider was meant. Verified against a live server, not just
the test suite: `POST .../import/powens` end to end, including the 422 for an
unregistered provider name.

## Milestone 5 — recurring-payment detection

```bash
npm test   # includes test/detection.test.ts — 10 tests, deterministic fixtures, no live data
```

`src/detection/recurring.ts` turns a customer's transaction history into
`RecurringPayment[]` — the same shape `planner/planner.ts` has consumed since
Milestone 1, previously only ever supplied by hand (`test/batch.test.ts`'s
`row()` fixture, or a customer created with `recurring_payments` in the
request body). Pure and deterministic, same discipline as the rules engine
and the connectivity layer: a merchant + amount + interval heuristic, no
model, no external service, thresholds exported rather than hidden so a
caller can recalibrate them against real data without forking the file.

**How it groups.** Transactions are keyed by (account, direction, normalised
counterparty), then sub-clustered by amount within a group (±25%, greedy
1D clustering) — a merchant with both a fixed subscription and unrelated
one-off purchases only has the subscription flagged. A cluster needs at
least 3 occurrences (two dates are a coincidence, not a cadence) and a
regular interval — coefficient of variation of the gaps between occurrences
capped at 0.4 — to be considered recurring at all. That interval check is a
hard gate, not a confidence penalty: `test/detection.test.ts` includes six
same-store, similar-amount grocery-shopping transactions with no fixed
cadence specifically to prove the detector does not flag them. Amount
consistency, by contrast, is *not* a hard gate — a genuinely variable
utility bill still detects, just at lower confidence, because real recurring
bills legitimately vary in amount while staying the same relationship.

**Confidence** blends three signals already in [0,1] — interval regularity
(45%), amount consistency (35%), sample size (20%) — into the same
`0..1` score `RecurringPayment.confidence` has always carried. Nothing
downstream had to change: the planner's existing `RECURRING_CONFIDENCE_THRESHOLD`
(0.7) and `LOW_CONFIDENCE_RECURRING_PAYMENT` exception already handled a
below-threshold detection by planning a `MANUAL_REVIEW` task before an
operator notifies the counterparty — this is the same composition claim
Milestone 4 made for `MISSING_PRODUCT_METADATA`, checked the same way: a
real fixture (a variable-amount utility bill, deliberately calibrated to
land at ~0.68) run through the actual planner in `test/batch.test.ts`, not
asserted in a comment.

**Category is mostly left alone, on purpose.** Every detection defaults to
`OTHER`. The one exception is `SALARY`: the largest inbound monthly cluster
on an account is tagged `SALARY`, a narrow, well-established heuristic in
account aggregation ("the biggest regular monthly deposit is almost always
the paycheck"), not a general classifier. `RENT`, `UTILITIES`, `TELECOM`,
`SUBSCRIPTION`, `INSURANCE`, `TAX` and `LOAN_REPAYMENT` are not attempted —
that needs either a merchant-name taxonomy (not built) or a provider's own
category feed mapped against a confirmed schema. Powens' `categories` field
looked like it might cover this during research, but its exact taxonomy
isn't documented anywhere this file could verify against the public
reference, so guessing at a mapping stayed off the table — the same choice
this repo already made for Powens' ambiguous account types in Milestone 4.

**`src/connectivity/powens.ts` gained `normalizePowensTransactions`**, the
transaction-side counterpart to the account mapping, wired onto
`PowensProvider.normalizeTransactions` (now an optional method on
`ConnectivityProvider` — not every provider this engine will ever talk to
exposes transaction history the same way, or at all). Two open questions
came out of it, called out rather than assumed away:

- **Sign convention.** Powens' docs describe `value` as signed but do not
  explicitly confirm "negative = debit" anywhere in the public reference.
  This mapping assumes the near-universal convention; it needs verifying
  against a live sandbox before this ships, same as the rest of this file.
- **`id_cluster`.** Powens' transaction object has a field described only as
  "if the transaction is part of a cluster" — which reads like it could be
  Powens' own recurring-transaction grouping, but the docs don't say so
  explicitly. Rather than build on an unconfirmed feature, the detector does
  its own grouping and ignores `id_cluster` entirely. Worth a cross-check
  against real data later, not a foundation to build on now.

### Wired to a caller

```http
POST /v1/customers/:id/recurring-payments/detect/powens
{"transactions_by_account": {"<accountId>": [ /* raw Powens transactions */ ]}}
```

`BatchPipeline.detectRecurringPayments(ctx, customerId, provider, rawTransactionsByAccount)`
normalizes each account's raw transactions, runs the detector across all of
them, and persists the result with `store.putRecurringPayments` — deliberately
per-customer rather than per-batch, since transaction volume dwarfs account
volume and a caller should choose which customers are worth the fetch rather
than this pipeline fetching every customer's full history unconditionally.
Once persisted, nothing else needs wiring: `MigrationService` already reads
`store.listRecurringPayments` when it builds a plan, so a customer planned
after this call sees the detected payments exactly as if they had been
imported by hand. Verified against a live server: `POST .../detect/powens`
against the seeded demo customer, whose plan then included the detected
Netflix subscription alongside its hand-authored recurring payments with no
special-casing, plus the 422s for an unknown provider and an unknown
customer.

## Not built (deliberately)

**No durable queue.** `WebhookDispatcher.drain()` is called on a timer in
`serve.ts`; in production it is a BullMQ worker or a Temporal activity. The
retry, backoff and dead-letter logic lives in the dispatcher precisely so that
swap does not change behaviour.

**No customer-facing surface**, no document AI, no ops copilot. The AI layer
from §15 consumes this output; none of it belongs in the decision path.

### Next

1. Verify the two open Powens questions flagged in Milestone 5 (the
   transaction sign convention, and whether `id_cluster` is a usable
   recurrence signal) against a live sandbox, and recalibrate the
   detector's thresholds against real transaction data rather than
   hand-built fixtures once that's possible.
2. If the remaining ~7s on a 500-customer Postgres plan matters at real
   volume: batch *across* customers, not just within one — deliberately not
   done yet, because it trades away the per-customer transaction isolation
   `importRows` currently gives failure handling.
3. Get the rule catalog in front of counsel before anything above is built on
   top of it — it is the moat, and right now it is an educated reading.
