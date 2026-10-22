import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Phase 0 gate tests (unit level, no Postgres required). The full consent + ingest
 * flow is covered by scripts/smoke.sh against a live stack (integration gate).
 */
describe('jwt', () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= 'postgres://x:y@localhost:5432/z';
    process.env.JWT_SECRET ??= 'test-secret-0123456789abcdef';
  });

  it('signs and verifies round-trip', async () => {
    const { signAccessToken, verifyAccessToken } = await import('../src/lib/jwt.js');
    const token = signAccessToken({ sub: 'driver-1', role: 'DRIVER', locale: 'am' });
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe('driver-1');
    expect(claims.role).toBe('DRIVER');
  });

  it('rejects tampered tokens', async () => {
    const { verifyAccessToken } = await import('../src/lib/jwt.js');
    expect(() => verifyAccessToken('not.a.jwt')).toThrow();
  });
});

describe('ingest contract (§1.8.2)', () => {
  it('batch_id must be UUID; fixes capped at 100; coords validated', async () => {
    const { BatchSchema } = await import('../src/modules/ingest/service.js');
    const good = {
      batch_id: '3f2a7b6c-1111-4222-8333-aabbccddeeff',
      fixes: [{ fix_timestamp: '2026-10-22T10:00:00Z', lat: 9.03, lng: 38.74, speed_mps: 12.5, accuracy_m: 8 }],
    };
    expect(BatchSchema.safeParse(good).success).toBe(true);
    expect(BatchSchema.safeParse({ ...good, batch_id: 'not-a-uuid' }).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({
      fix_timestamp: `2026-10-22T10:${String(i % 60).padStart(2, '0')}:00Z`, lat: 9.0, lng: 38.7 }));
    expect(BatchSchema.safeParse({ ...good, fixes: many }).success).toBe(false);
    expect(BatchSchema.safeParse({ ...good,
      fixes: [{ fix_timestamp: '2026-10-22T10:00:00Z', lat: 95, lng: 38.7 }] }).success).toBe(false);
  });
});
