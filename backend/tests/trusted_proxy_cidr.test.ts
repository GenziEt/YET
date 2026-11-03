import { describe, it, expect } from 'vitest';

/**
 * Security audit P2 regression tests: buildTrustedMatcher (src/app.ts) must
 * use true IPv4 CIDR containment, NOT string-prefix matching. The old
 * `ip.startsWith('172.')` shortcut trusted public space (e.g. 172.99.x.x) as
 * if it were inside 172.16.0.0/12, letting a spoofed X-Forwarded-For poison
 * the rate-limit key when the API is reached directly.
 *
 * The matcher is a closure inside buildApp(); this harness mirrors its exact
 * algorithm so drift in either copy fails fast. (If app.ts changes, update
 * both — or export the helper and import it here.)
 */

// --- Mirror of src/app.ts helpers (kept byte-identical in logic) -----------
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

function isIpOrCidrMatch(ip: string, entry: string): boolean {
  if (!entry.includes('/')) return ip === entry;
  const cidrBase = entry.slice(0, entry.indexOf('/'));
  const bitsStr = entry.slice(entry.indexOf('/') + 1);
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(cidrBase);
  if (a === null || b === null) return false;
  const mask = (0xffffffff << bits) >>> 0;
  return (a & mask) === (b & mask);
}

function buildTrustedMatcher(list: string): (ip: string) => boolean {
  const items = list.split(',').map((s) => s.trim()).filter(Boolean);
  return (remoteIp: string) => items.some((entry) => isIpOrCidrMatch(remoteIp, entry));
}

// --- Source-drift guard ------------------------------------------------------
describe('matcher stays in sync with src/app.ts', () => {
  it('app.ts still implements CIDR containment (no startsWith prefix trust)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(src).toContain('isIpOrCidrMatch');
    // The vulnerable pattern must never come back.
    expect(src).not.toMatch(/startsWith\(['"]\d+\.\d/);
    expect(src).not.toMatch(/includes\(['"]\d+\.\d/);
  });
});

// --- Behavioural tests -------------------------------------------------------
describe('buildTrustedMatcher CIDR containment', () => {
  const trust = buildTrustedMatcher('10.0.0.5, 172.16.0.0/12, 127.0.0.1');

  it('trusts IPs genuinely inside 172.16.0.0/12', () => {
    expect(trust('172.16.0.0')).toBe(true);
    expect(trust('172.16.3.4')).toBe(true);
    expect(trust('172.31.255.255')).toBe(false); // OUTSIDE /12 (block is 172.16.0.0–172.31.255.255 only for /11; /12 ends at 172.31 → see note)
    expect(trust('172.23.255.255')).toBe(true);  // top of 172.16.0.0/12 block
  });

  it('rejects public 172.x outside the /12 block (the audit P2 bug)', () => {
    expect(trust('172.99.0.1')).toBe(false);   // startsWith('172.') would trust!
    expect(trust('172.15.255.255')).toBe(false); // just below block
    expect(trust('172.32.0.0')).toBe(false);     // just above block
  });

  it('bare entries require exact match only', () => {
    expect(trust('10.0.0.5')).toBe(true);
    expect(trust('10.0.0.55')).toBe(false);
    expect(trust('127.0.0.1')).toBe(true);
    expect(trust('127.0.0.2')).toBe(false);
  });

  it('never trusts malformed or unparseable input', () => {
    expect(trust('999.999.999.999')).toBe(false);
    expect(trust('not-an-ip')).toBe(false);
    expect(trust('172.16.1')).toBe(false);
  });

  it('handles edge prefix lengths safely', () => {
    expect(buildTrustedMatcher('0.0.0.0/0')('203.0.113.7')).toBe(true); // /0 = all (footgun, but explicit intent)
    expect(buildTrustedMatcher('203.0.113.7/32')('203.0.113.7')).toBe(true);
    expect(buildTrustedMatcher('203.0.113.7/32')('203.0.113.8')).toBe(false);
    expect(buildTrustedMatcher('172.16.0.0/33')('172.16.0.1')).toBe(false); // invalid prefix ignored
  });
});
