import { describe, it, expect, vi, beforeAll } from 'vitest';

/**
 * Audit P3 fix (PDPP data minimization): raw phone numbers must never be
 * written to audit_log.detail — they are replaced with a deterministic
 * HMAC pseudonym (`phone_hmac`) at the single choke point, lib/audit.ts.
 * No Postgres required: the pool is mocked.
 */
describe('audit log phone minimization', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://x:y@localhost:5432/z';
    process.env.JWT_SECRET ??= 'test-secret-0123456789abcdef';
    mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    vi.doMock('../src/db/pool.js', () => ({ pool: { query: mockQuery } }));
  });

  async function captureAudit(detail: Record<string, unknown>): Promise<unknown> {
    const mod = await import('../src/lib/audit.js');
    await mod.audit({ action: 'otp_requested', ip: '203.0.113.7', detail });
    const params = mockQuery.mock.calls.at(-1)?.[1] as unknown[];
    return JSON.parse(params[4] as string);
  }

  it('replaces phone with a hex pseudonym and keeps other fields', async () => {
    const stored = await captureAudit({ phone: '+251911123456', delivered: true }) as Record<string, unknown>;
    expect(stored.phone).toBeUndefined();
    expect(typeof stored.phone_hmac).toBe('string');
    expect(stored.phone_hmac).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.delivered).toBe(true);
  });

  it('is deterministic per number but not reversible-looking', async () => {
    const a = await captureAudit({ phone: '+251911123456' }) as Record<string, unknown>;
    const b = await captureAudit({ phone: '+251911123456' }) as Record<string, unknown>;
    const c = await captureAudit({ phone: '+251911999888' }) as Record<string, unknown>;
    expect(a.phone_hmac).toBe(b.phone_hmac); // correlatable across rows
    expect(a.phone_hmac).not.toBe(c.phone_hmac);
    expect(JSON.stringify(a)).not.toContain('251911123456');
  });

  it('leaves details without a phone field untouched', async () => {
    const stored = await captureAudit({ stage: 'request', attempts: 2 }) as Record<string, unknown>;
    expect(stored).toEqual({ stage: 'request', attempts: 2 });
  });

  it('nulls malformed IPs instead of failing the INET insert', async () => {
    await (await import('../src/lib/audit.js')).audit({ action: 'x', ip: 'not-an-ip' });
    const params = mockQuery.mock.calls.at(-1)![1] as unknown[];
    expect(params[3]).toBeNull();
  });
});
