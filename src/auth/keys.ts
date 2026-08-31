import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiRole, TenantContext } from '../store/types.js';

/**
 * API key authentication and RBAC.
 *
 * Keys are stored as SHA-256 hashes and never recoverable — a dump of the key
 * table yields nothing usable. The plaintext key is returned exactly once, at
 * issue time, which is the only moment it exists outside the caller's config.
 */

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  hash: string;
  role: ApiRole;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type Scope =
  | 'customers:read'
  | 'customers:write'
  | 'migrations:read'
  | 'migrations:write'
  | 'migrations:execute'
  | 'exceptions:resolve'
  | 'webhooks:manage'
  | 'batches:write'
  | 'audit:read';

/**
 * Role → scope mapping.
 *
 * READ_ONLY exists because an institution's analysts and its dashboards should
 * not hold a credential that can authorize a customer's migration. SERVICE is
 * the machine role: it can plan and execute, but cannot resolve an exception,
 * because clearing a compliance block is a human judgement with a name attached.
 */
export const ROLE_SCOPES: Record<ApiRole, Scope[]> = {
  ADMIN: [
    'customers:read',
    'customers:write',
    'migrations:read',
    'migrations:write',
    'migrations:execute',
    'exceptions:resolve',
    'webhooks:manage',
    'batches:write',
    'audit:read',
  ],
  OPERATOR: [
    'customers:read',
    'migrations:read',
    'migrations:write',
    'migrations:execute',
    'exceptions:resolve',
  ],
  SERVICE: [
    'customers:read',
    'customers:write',
    'migrations:read',
    'migrations:write',
    'migrations:execute',
    'batches:write',
  ],
  READ_ONLY: ['migrations:read', 'customers:read'],
};

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export interface IssuedKey {
  record: ApiKeyRecord;
  /** Returned once. Not stored anywhere. */
  plaintext: string;
}

export function issueApiKey(params: {
  tenantId: string;
  name: string;
  role: ApiRole;
  live?: boolean;
  scopes?: Scope[];
}): IssuedKey {
  const secret = randomBytes(24).toString('base64url');
  const env = params.live === false ? 'test' : 'live';
  const plaintext = `fmos_${env}_${secret}`;
  const id = `key_${randomBytes(8).toString('hex')}`;

  return {
    plaintext,
    record: {
      id,
      tenantId: params.tenantId,
      name: params.name,
      // Enough to identify the key in a UI or a log line, not enough to use it.
      prefix: plaintext.slice(0, 14),
      hash: sha256(plaintext),
      role: params.role,
      scopes: params.scopes ?? ROLE_SCOPES[params.role],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
  };
}

/** Constant-time comparison, so lookup latency cannot be used to probe keys. */
function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class ApiKeyRegistry {
  private readonly byHash = new Map<string, ApiKeyRecord>();

  add(record: ApiKeyRecord): void {
    this.byHash.set(record.hash, record);
  }

  issue(params: Parameters<typeof issueApiKey>[0]): IssuedKey {
    const issued = issueApiKey(params);
    this.add(issued.record);
    return issued;
  }

  revoke(id: string): void {
    for (const record of this.byHash.values()) {
      if (record.id === id) record.revokedAt = new Date().toISOString();
    }
  }

  /** Resolve a presented key to a tenant context, or throw. */
  authenticate(presented: string | undefined): TenantContext & { scopes: Scope[] } {
    if (!presented) {
      throw new AuthError('Missing API key', 401, 'missing_credentials');
    }
    const candidate = sha256(presented);
    let found: ApiKeyRecord | undefined;
    for (const record of this.byHash.values()) {
      if (hashesMatch(record.hash, candidate)) {
        found = record;
        break;
      }
    }
    if (!found) {
      throw new AuthError('Invalid API key', 401, 'invalid_credentials');
    }
    if (found.revokedAt) {
      throw new AuthError('API key has been revoked', 401, 'revoked_credentials');
    }
    found.lastUsedAt = new Date().toISOString();
    return {
      tenantId: found.tenantId,
      apiKeyId: found.id,
      role: found.role,
      scopes: found.scopes,
    };
  }
}

/** Extract a bearer token, tolerating the `Authorization: Bearer x` form only. */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

export function requireScope(
  ctx: { scopes: Scope[]; role?: ApiRole },
  scope: Scope,
): void {
  if (!ctx.scopes.includes(scope)) {
    throw new AuthError(
      `This key's role (${ctx.role ?? 'unknown'}) does not carry the ${scope} scope`,
      403,
      'insufficient_scope',
    );
  }
}
