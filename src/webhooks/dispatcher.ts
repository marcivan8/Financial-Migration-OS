import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MigrationEvent, MigrationEventType } from '../domain/migration.js';
import type {
  MigrationStore,
  TenantContext,
  WebhookDelivery,
  WebhookEndpoint,
} from '../store/types.js';

/**
 * Webhook dispatch.
 *
 * Institutions should not poll a migration that takes 45 days to settle. The
 * mapping below is deliberately narrow: internal events (every TaskStarted,
 * every StateChanged) stay internal, and only the events an institution can act
 * on cross the boundary. A webhook feed that mirrors the event log is a feed
 * nobody reads.
 */

export type WebhookEventType =
  | 'migration.created'
  | 'migration.started'
  | 'product.detected'
  | 'action.required'
  | 'document.required'
  | 'transfer.started'
  | 'transfer.completed'
  | 'migration.blocked'
  | 'migration.completed';

const EVENT_MAP: Partial<Record<MigrationEventType, WebhookEventType>> = {
  MigrationCreated: 'migration.created',
  CustomerAuthorized: 'migration.started',
  ProductDetected: 'product.detected',
  TransferRequested: 'transfer.started',
  TransferCompleted: 'transfer.completed',
  ExceptionRaised: 'migration.blocked',
  TaskBlocked: 'action.required',
  MigrationCompleted: 'migration.completed',
};

export function toWebhookEvent(event: MigrationEvent): WebhookEventType | null {
  return EVENT_MAP[event.type] ?? null;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Stripe-style signature: `t=<unix>,v1=<hmac>` over `<t>.<body>`.
 *
 * The timestamp is inside the signed payload so a captured request cannot be
 * replayed later — the receiver rejects anything outside its tolerance window.
 */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const signed = `${timestamp}.${body}`;
  const mac = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, ...v] = kv.split('=');
      return [k?.trim() ?? '', v.join('=')];
    }),
  );
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Exponential backoff with a hard ceiling: 1m, 5m, 25m, 2h, 6h, 6h… */
export const BACKOFF_SECONDS = [60, 300, 1_500, 7_200, 21_600];
export const MAX_ATTEMPTS = 6;

export function nextAttemptAt(attempts: number, from: Date): string | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const idx = Math.min(attempts, BACKOFF_SECONDS.length - 1);
  const seconds = BACKOFF_SECONDS[idx]!;
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

export type HttpPoster = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

const defaultPoster: HttpPoster = async (url, body, headers) => {
  const res = await fetch(url, { method: 'POST', body, headers });
  return { status: res.status };
};

export class WebhookDispatcher {
  constructor(
    private readonly store: MigrationStore,
    private readonly post: HttpPoster = defaultPoster,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Fan an event out to every subscribed endpoint for the tenant. */
  async publish(ctx: TenantContext, event: MigrationEvent): Promise<number> {
    const type = toWebhookEvent(event);
    if (!type) return 0;

    const endpoints = (await this.store.listWebhookEndpoints(ctx)).filter(
      (e) => e.eventTypes.length === 0 || e.eventTypes.includes(type),
    );

    for (const endpoint of endpoints) {
      const delivery: WebhookDelivery = {
        id: `whd_${randomBytes(8).toString('hex')}`,
        tenantId: ctx.tenantId,
        endpointId: endpoint.id,
        eventType: type,
        payload: {
          event: type,
          migration_id: event.migrationId,
          sequence: event.sequence,
          occurred_at: event.occurredAt,
          data: event.payload,
        },
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: this.clock().toISOString(),
        lastStatusCode: null,
        lastError: null,
        createdAt: this.clock().toISOString(),
        deliveredAt: null,
      };
      await this.store.enqueueDelivery(ctx, delivery);
    }
    return endpoints.length;
  }

  /**
   * Drain due deliveries. In production this is a BullMQ worker (or a Temporal
   * activity); the logic is identical, which is why it lives here rather than
   * inside a queue framework.
   */
  async drain(limit = 50): Promise<{ delivered: number; retried: number; dead: number }> {
    const now = this.clock();
    const due = await this.store.listDueDeliveries(now.toISOString(), limit);
    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const delivery of due) {
      const endpoint = await this.endpointFor(delivery);
      if (!endpoint) {
        await this.store.updateDelivery({
          ...delivery,
          status: 'DEAD_LETTERED',
          lastError: 'endpoint no longer exists',
        });
        dead++;
        continue;
      }

      const body = JSON.stringify(delivery.payload);
      const ts = Math.floor(now.getTime() / 1000);
      const attempts = delivery.attempts + 1;

      try {
        const res = await this.post(endpoint.url, body, {
          'content-type': 'application/json',
          'fmos-signature': signPayload(endpoint.secret, body, ts),
          'fmos-event-type': delivery.eventType,
          'fmos-delivery-id': delivery.id,
          // Receivers dedupe on this: at-least-once delivery means a retry can
          // land after the original succeeded from the receiver's point of view.
          'fmos-idempotency-key': delivery.id,
        });

        if (res.status >= 200 && res.status < 300) {
          await this.store.updateDelivery({
            ...delivery,
            status: 'DELIVERED',
            attempts,
            lastStatusCode: res.status,
            deliveredAt: now.toISOString(),
            nextAttemptAt: null,
          });
          delivered++;
          continue;
        }
        const outcome = this.scheduleRetry(delivery, attempts, now, res.status, null);
        await this.store.updateDelivery(outcome.delivery);
        outcome.dead ? dead++ : retried++;
      } catch (err) {
        const outcome = this.scheduleRetry(
          delivery,
          attempts,
          now,
          null,
          err instanceof Error ? err.message : String(err),
        );
        await this.store.updateDelivery(outcome.delivery);
        outcome.dead ? dead++ : retried++;
      }
    }

    return { delivered, retried, dead };
  }

  private scheduleRetry(
    delivery: WebhookDelivery,
    attempts: number,
    now: Date,
    statusCode: number | null,
    error: string | null,
  ): { delivery: WebhookDelivery; dead: boolean } {
    const next = nextAttemptAt(attempts, now);
    const dead = next === null;
    return {
      dead,
      delivery: {
        ...delivery,
        attempts,
        // Dead-lettered, not deleted: an institution whose endpoint was down
        // for a day needs to see and replay what it missed.
        status: dead ? 'DEAD_LETTERED' : 'PENDING',
        nextAttemptAt: next,
        lastStatusCode: statusCode,
        lastError: error,
      },
    };
  }

  /** Reset a dead-lettered delivery for another run, once the endpoint is fixed. */
  async replay(ctx: TenantContext, deliveryId: string): Promise<void> {
    const rows = await this.store.listDeliveries(ctx, { status: 'DEAD_LETTERED' });
    const delivery = rows.find((d) => d.id === deliveryId);
    if (!delivery) throw new Error(`dead-lettered delivery ${deliveryId} not found`);
    await this.store.updateDelivery({
      ...delivery,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: this.clock().toISOString(),
      lastError: null,
    });
  }

  private async endpointFor(delivery: WebhookDelivery): Promise<WebhookEndpoint | null> {
    const endpoints = await this.store.listWebhookEndpoints({
      tenantId: delivery.tenantId,
    });
    return endpoints.find((e) => e.id === delivery.endpointId) ?? null;
  }
}
