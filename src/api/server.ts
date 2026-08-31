import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Customer, Institution } from '../domain/types.js';
import type { MigrationStore, TenantContext, WebhookEndpoint } from '../store/types.js';
import { ConflictError } from '../store/types.js';
import {
  ApiKeyRegistry,
  AuthError,
  bearerToken,
  requireScope,
  type Scope,
} from '../auth/keys.js';
import { WebhookDispatcher } from '../webhooks/dispatcher.js';
import { MigrationService, NotFoundError, ValidationError, newId } from './service.js';
import { BatchPipeline } from '../batch/pipeline.js';
import {
  completionJson,
  documentsJson,
  exceptionJson,
  migrationSummary,
  planItemJson,
  planJson,
  problem,
  taskJson,
} from './serializers.js';
import { renderDashboard } from './dashboard.js';

/**
 * Fastify rather than NestJS.
 *
 * The brief leans NestJS for the enterprise API and that is the right call once
 * there are teams and dozens of modules. At this stage its DI and decorator
 * scaffolding would be more code than the product, and every route here maps to
 * a service method that is already framework-free — so the port to NestJS later
 * is mechanical, and nothing in `src/` outside this file knows about HTTP.
 */

export interface ServerDeps {
  store: MigrationStore;
  keys: ApiKeyRegistry;
  service: MigrationService;
  webhooks: WebhookDispatcher;
  batches: BatchPipeline;
}

type AuthedContext = TenantContext & { scopes: Scope[] };

declare module 'fastify' {
  interface FastifyRequest {
    ctx: AuthedContext;
  }
}

const PUBLIC_ROUTES = new Set(['/health', '/', '/favicon.ico']);

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, keys, service, webhooks, batches } = deps;

  // -------------------------------------------------------------------------
  // Authentication and tenant binding
  // -------------------------------------------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_ROUTES.has(req.url.split('?')[0] ?? '')) return;

    // The dashboard is a browser surface; it authenticates with a key in the
    // query string so it can be opened directly. In production this would be a
    // session cookie behind the institution's SSO, never a URL parameter.
    const fromQuery =
      req.url.startsWith('/dashboard')
        ? (req.query as { key?: string } | undefined)?.key
        : undefined;

    try {
      req.ctx = keys.authenticate(bearerToken(req.headers.authorization) ?? fromQuery);
    } catch (err) {
      if (err instanceof AuthError) {
        await store.audit({
          tenantId: 'unknown',
          action: `${req.method} ${req.url}`,
          resourceType: 'auth',
          outcome: 'DENIED',
          detail: { code: err.code },
          occurredAt: new Date().toISOString(),
        });
        return reply
          .code(err.status)
          .type('application/problem+json')
          .send(problem(err.status, 'Unauthorized', err.message, { code: err.code }));
      }
      throw err;
    }
  });

  /** Audit every mutating call, allowed or denied. */
  const guard = async (req: FastifyRequest, scope: Scope, resourceType: string, resourceId?: string) => {
    try {
      requireScope(req.ctx, scope);
      await store.audit({
        tenantId: req.ctx.tenantId,
        apiKeyId: req.ctx.apiKeyId,
        actorRole: req.ctx.role,
        action: `${req.method} ${req.routeOptions?.url ?? req.url}`,
        resourceType,
        resourceId,
        outcome: 'ALLOWED',
        occurredAt: new Date().toISOString(),
      });
    } catch (err) {
      await store.audit({
        tenantId: req.ctx.tenantId,
        apiKeyId: req.ctx.apiKeyId,
        actorRole: req.ctx.role,
        action: `${req.method} ${req.routeOptions?.url ?? req.url}`,
        resourceType,
        resourceId,
        outcome: 'DENIED',
        detail: { scope },
        occurredAt: new Date().toISOString(),
      });
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // Error handling — RFC 9457 problem+json everywhere
  // -------------------------------------------------------------------------

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) {
      return reply
        .code(err.status)
        .type('application/problem+json')
        .send(problem(err.status, 'Forbidden', err.message, { code: err.code }));
    }
    if (err instanceof NotFoundError) {
      return reply
        .code(404)
        .type('application/problem+json')
        .send(problem(404, 'Not Found', err.message));
    }
    if (err instanceof ValidationError) {
      return reply
        .code(422)
        .type('application/problem+json')
        .send(problem(422, 'Unprocessable Entity', err.message, { field: err.field }));
    }
    if (err instanceof ConflictError) {
      return reply
        .code(409)
        .type('application/problem+json')
        .send(problem(409, 'Conflict', err.message));
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply
      .code(500)
      .type('application/problem+json')
      .send(problem(500, 'Internal Server Error', message));
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  app.get('/health', async () => ({ status: 'ok', version: '0.2.0' }));

  // Browsers request this unprompted; answering it keeps a 401 out of the
  // console of anyone opening the dashboard.
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  // -------------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------------

  app.post('/v1/institutions', async (req, reply) => {
    await guard(req, 'customers:write', 'institution');
    const body = req.body as Partial<Institution> & { id?: string };
    if (!body?.name || !body?.country) {
      throw new ValidationError('name and country are required');
    }
    const institution: Institution = {
      id: body.id ?? newId('inst'),
      name: body.name,
      country: body.country,
      type: body.type ?? 'BANK',
      bic: body.bic,
      capabilities: body.capabilities ?? {
        supportedProducts: [],
        supportsBankMobilityScheme: false,
        supportsSecuritiesTransferIn: false,
        hasApi: false,
      },
    };
    await store.putInstitution(req.ctx, institution);
    return reply.code(201).send({ id: institution.id });
  });

  app.get('/v1/institutions', async (req) => {
    await guard(req, 'customers:read', 'institution');
    return { data: await store.listInstitutions(req.ctx) };
  });

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  app.post('/v1/customers', async (req, reply) => {
    await guard(req, 'customers:write', 'customer');
    const body = req.body as {
      institution_id?: string;
      identity?: Customer['identity'];
      consent?: Partial<Customer['consent']>;
      products?: unknown[];
      recurring_payments?: unknown[];
    };
    if (!body?.institution_id || !body?.identity) {
      throw new ValidationError('institution_id and identity are required');
    }
    const origin = await store.getInstitution(req.ctx, body.institution_id);
    if (!origin) throw new NotFoundError('institution', body.institution_id);

    const id = newId('cus');
    const customer: Customer = {
      id,
      tenantId: req.ctx.tenantId,
      institutionId: body.institution_id,
      identity: body.identity,
      consent: {
        id: newId('con'),
        scopes: body.consent?.scopes ?? ['ACCOUNT_INFORMATION'],
        grantedAt: body.consent?.grantedAt ?? new Date().toISOString(),
        expiresAt:
          body.consent?.expiresAt ?? new Date(Date.now() + 365 * 864e5).toISOString(),
      },
      migrationIds: [],
    };
    await store.putCustomer(req.ctx, customer);

    if (Array.isArray(body.products)) {
      await store.putProducts(
        req.ctx,
        body.products.map((p, i) => ({
          ...(p as Record<string, unknown>),
          id: `${id}_p${i}`,
          accountId: `${id}_a${i}`,
          customerId: id,
          institutionId: body.institution_id!,
        })) as never,
      );
    }
    if (Array.isArray(body.recurring_payments)) {
      await store.putRecurringPayments(
        req.ctx,
        body.recurring_payments.map((p, i) => ({
          ...(p as Record<string, unknown>),
          id: `${id}_r${i}`,
          accountId: `${id}_a0`,
          customerId: id,
        })) as never,
      );
    }
    return reply.code(201).send({ id, consent_id: customer.consent.id });
  });

  app.post('/v1/customers/:id/consents', async (req, reply) => {
    await guard(req, 'customers:write', 'consent', (req.params as { id: string }).id);
    const { id } = req.params as { id: string };
    const customer = await store.getCustomer(req.ctx, id);
    if (!customer) throw new NotFoundError('customer', id);
    const body = req.body as { scopes?: Customer['consent']['scopes']; expires_at?: string };

    customer.consent = {
      id: newId('con'),
      scopes: body?.scopes ?? customer.consent.scopes,
      grantedAt: new Date().toISOString(),
      expiresAt: body?.expires_at ?? new Date(Date.now() + 365 * 864e5).toISOString(),
    };
    await store.putCustomer(req.ctx, customer);
    return reply.code(201).send({ consent_id: customer.consent.id, scopes: customer.consent.scopes });
  });

  // -------------------------------------------------------------------------
  // Migrations
  // -------------------------------------------------------------------------

  app.post('/v1/migrations', async (req, reply) => {
    await guard(req, 'migrations:write', 'migration');
    const body = req.body as {
      customer_id?: string;
      destination_institution_id?: string;
    };
    if (!body?.customer_id || !body?.destination_institution_id) {
      throw new ValidationError('customer_id and destination_institution_id are required');
    }
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    const { record, plan, reused } = await service.createMigration(req.ctx, {
      customerId: body.customer_id,
      destinationInstitutionId: body.destination_institution_id,
      idempotencyKey,
    });

    return reply
      .code(reused ? 200 : 201)
      .header('idempotent-replayed', String(reused))
      .send({ ...migrationSummary(record), plan: planJson(plan) });
  });

  app.get('/v1/migrations', async (req) => {
    await guard(req, 'migrations:read', 'migration');
    const q = req.query as { state?: string; batch_id?: string; blocked?: string; limit?: string };
    const data = await store.listMigrations(req.ctx, {
      state: q.state as never,
      batchId: q.batch_id,
      blockedOnly: q.blocked === 'true',
      limit: q.limit ? Number(q.limit) : 50,
    });
    return { data: data.map(migrationSummary), count: data.length };
  });

  app.get('/v1/migrations/:id', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'migration', id);
    const record = await store.getMigration(req.ctx, id);
    if (!record) throw new NotFoundError('migration', id);
    const plan = await store.getPlan(req.ctx, id);
    return { ...migrationSummary(record), plan: plan ? planJson(plan) : null };
  });

  app.get('/v1/migrations/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'migration', id);
    const status = await service.status(req.ctx, id);
    return {
      migration_id: id,
      state: status.state,
      completion: completionJson(status.completion),
      ready_task_ids: status.readyTaskIds,
    };
  });

  app.get('/v1/migrations/:id/products', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'migration', id);
    const plan = await store.getPlan(req.ctx, id);
    if (!plan) throw new NotFoundError('migration', id);
    return { data: planItemJson(plan, 'PRODUCT') };
  });

  app.get('/v1/migrations/:id/tasks', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'migration', id);
    const tasks = await store.listTasks(req.ctx, id);
    if (tasks.length === 0 && !(await store.getMigration(req.ctx, id))) {
      throw new NotFoundError('migration', id);
    }
    return { data: tasks.map(taskJson) };
  });

  app.get('/v1/migrations/:id/documents', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'migration', id);
    const tasks = await store.listTasks(req.ctx, id);
    return { data: documentsJson(tasks) };
  });

  app.get('/v1/migrations/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'migration', id);
    const events = await store.listEvents(req.ctx, id);
    return {
      data: events.map((e) => ({
        sequence: e.sequence,
        type: e.type,
        occurred_at: e.occurredAt,
        payload: e.payload,
      })),
    };
  });

  app.post('/v1/migrations/:id/authorize', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:execute', 'migration', id);
    const state = await service.authorize(req.ctx, id);
    return { migration_id: id, state };
  });

  app.post('/v1/migrations/:id/actions', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:execute', 'migration', id);
    const body = req.body as {
      action?: 'start_task' | 'complete_task' | 'block_task' | 'simulate';
      task_id?: string;
      code?: string;
      message?: string;
      block_task_type?: string;
    };

    switch (body?.action) {
      case 'simulate': {
        const state = await service.simulate(req.ctx, id, body.block_task_type);
        return { migration_id: id, state };
      }
      case 'start_task':
      case 'complete_task':
      case 'block_task': {
        if (!body.task_id) throw new ValidationError('task_id is required', 'task_id');
        const map = {
          start_task: 'start',
          complete_task: 'complete',
          block_task: 'block',
        } as const;
        const state = await service.advanceTask(req.ctx, id, body.task_id, map[body.action], {
          code: body.code,
          message: body.message,
        });
        return { migration_id: id, state };
      }
      default:
        throw new ValidationError(
          'action must be one of start_task, complete_task, block_task, simulate',
          'action',
        );
    }
  });

  // -------------------------------------------------------------------------
  // Exceptions
  // -------------------------------------------------------------------------

  app.get('/v1/exceptions', async (req) => {
    await guard(req, 'migrations:read', 'exception');
    const q = req.query as { migration_id?: string; open?: string };
    const rows = await store.listExceptions(req.ctx, {
      migrationId: q.migration_id,
      openOnly: q.open !== 'false',
    });
    return {
      data: rows.map((e) => ({
        ...exceptionJson(e),
        migration_id: e.migrationId,
        resolved_at: e.resolvedAt,
      })),
    };
  });

  app.post('/v1/exceptions/:id/resolve', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'exceptions:resolve', 'exception', id);
    const body = req.body as { note?: string };
    await store.resolveException(
      req.ctx,
      id,
      req.ctx.apiKeyId ?? 'unknown',
      body?.note ?? '',
    );
    return { id, resolved: true };
  });

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  app.post('/v1/webhooks/endpoints', async (req, reply) => {
    await guard(req, 'webhooks:manage', 'webhook_endpoint');
    const body = req.body as { url?: string; event_types?: string[] };
    if (!body?.url) throw new ValidationError('url is required', 'url');

    const endpoint: WebhookEndpoint = {
      id: newId('whe'),
      tenantId: req.ctx.tenantId,
      url: body.url,
      secret: `whsec_${randomBytes(24).toString('base64url')}`,
      eventTypes: body.event_types ?? [],
      active: true,
      createdAt: new Date().toISOString(),
    };
    await store.putWebhookEndpoint(req.ctx, endpoint);
    // The signing secret is shown once, like the API key.
    return reply.code(201).send({
      id: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret,
      event_types: endpoint.eventTypes,
    });
  });

  app.get('/v1/webhooks/deliveries', async (req) => {
    await guard(req, 'webhooks:manage', 'webhook_delivery');
    const q = req.query as { status?: string };
    const rows = await store.listDeliveries(req.ctx, { status: q.status as never });
    return {
      data: rows.map((d) => ({
        id: d.id,
        endpoint_id: d.endpointId,
        event_type: d.eventType,
        status: d.status,
        attempts: d.attempts,
        next_attempt_at: d.nextAttemptAt,
        last_status_code: d.lastStatusCode,
        last_error: d.lastError,
      })),
    };
  });

  app.post('/v1/webhooks/deliveries/:id/replay', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'webhooks:manage', 'webhook_delivery', id);
    await webhooks.replay(req.ctx, id);
    return { id, requeued: true };
  });

  app.post('/v1/webhooks/drain', async (req) => {
    await guard(req, 'webhooks:manage', 'webhook_delivery');
    return await webhooks.drain();
  });

  // -------------------------------------------------------------------------
  // Batches
  // -------------------------------------------------------------------------

  app.post('/v1/batches', async (req, reply) => {
    await guard(req, 'batches:write', 'batch');
    const body = req.body as {
      name?: string;
      origin_institution_id?: string;
      destination_institution_id?: string;
    };
    if (!body?.name || !body?.origin_institution_id || !body?.destination_institution_id) {
      throw new ValidationError(
        'name, origin_institution_id and destination_institution_id are required',
      );
    }
    const batch = await batches.createBatch(req.ctx, {
      name: body.name,
      originInstitutionId: body.origin_institution_id,
      destinationInstitutionId: body.destination_institution_id,
    });
    return reply.code(201).send({ id: batch.id, status: batch.status });
  });

  app.post('/v1/batches/:id/import', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'batches:write', 'batch', id);
    const body = req.body as { rows?: unknown[] };
    if (!Array.isArray(body?.rows)) throw new ValidationError('rows[] is required', 'rows');

    const { imported, failures } = await batches.importRows(req.ctx, id, body.rows as never);
    return { batch_id: id, imported: imported.length, customer_ids: imported, failures };
  });

  app.post('/v1/batches/:id/plan', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'batches:write', 'batch', id);
    const body = req.body as { customer_ids?: string[]; concurrency?: number };
    if (!Array.isArray(body?.customer_ids)) {
      throw new ValidationError('customer_ids[] is required', 'customer_ids');
    }
    const result = await batches.planBatch(req.ctx, id, body.customer_ids, {
      concurrency: body.concurrency,
    });
    return {
      batch_id: id,
      status: result.batch.status,
      planned: result.planned,
      blocked: result.blocked,
      failed: result.failed,
      failures: result.failures,
    };
  });

  app.get('/v1/batches/:id', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'batch', id);
    const batch = await store.getBatch(req.ctx, id);
    if (!batch) throw new NotFoundError('batch', id);
    return batch;
  });

  app.get('/v1/batches/:id/exceptions', async (req) => {
    const { id } = req.params as { id: string };
    await guard(req, 'migrations:read', 'batch', id);
    return { data: await batches.exceptionQueue(req.ctx, id) };
  });

  // -------------------------------------------------------------------------
  // Portfolio and dashboard
  // -------------------------------------------------------------------------

  app.get('/v1/portfolio/stats', async (req) => {
    await guard(req, 'migrations:read', 'portfolio');
    return await store.portfolioStats(req.ctx);
  });

  app.get('/v1/audit', async (req) => {
    await guard(req, 'audit:read', 'audit');
    const q = req.query as { limit?: string };
    return { data: await store.listAudit(req.ctx, q.limit ? Number(q.limit) : 100) };
  });

  app.get('/dashboard', async (req, reply) => {
    await guard(req, 'migrations:read', 'dashboard');
    const stats = await store.portfolioStats(req.ctx);
    const migrations = await store.listMigrations(req.ctx, { limit: 200 });
    const exceptions = await store.listExceptions(req.ctx, { openOnly: true });
    const batchList = await store.listBatches(req.ctx);
    const html = renderDashboard({ stats, migrations, exceptions, batches: batchList });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  return app;
}
