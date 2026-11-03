import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface TokenClaims {
  sub: string;          // user id
  role: 'DRIVER' | 'FLEET_MANAGER' | 'ADMIN';
  locale?: string;
  /** Phase 0 tenant identity: fleet a DRIVER/FLEET_MANAGER belongs to. ADMIN is
   *  platform-global and carries no fleetId. Stamped at login from users.fleet_id
   *  (migration 0013 makes the column non-null for tenant roles via trigger). */
  fleetId?: string;
  /** Revocation epoch (migration 0017). Stamped from users.token_version at mint
   *  time; guards reject tokens whose tv no longer matches the live row. This is
   *  the pre-expiry revocation path requested by the audit: un-pairing a device,
   *  suspending a driver, or self-revoking a lost phone bumps token_version and
   *  every outstanding JWT for that user dies immediately — without waiting out
   *  the 12 h TTL. Optional on the interface because tokens minted BEFORE the
   *  migration carry no claim; verifyAccessToken reports undefined and guards
   *  treat undefined as "legacy token" (accepted only while the DB-side checks
   *  they already perform pass — see lib/revocation.ts). */
  tokenVersion?: number;
}

export function signAccessToken(claims: TokenClaims): string {
  // env.JWT_ACCESS_TTL is zod-validated at boot (config/env.ts, audit P3) —
  // a malformed TTL aborts startup instead of silently mis-signing tokens.
  return jwt.sign(claimsToPayload(claims), env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): TokenClaims {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === 'string') throw new Error('bad token');
  return {
    sub: payload.sub as string,
    role: payload.role as TokenClaims['role'],
    locale: payload.locale as string | undefined,
    fleetId: payload.fleet_id as string | undefined,
    tokenVersion: typeof payload.tv === 'number' ? payload.tv : undefined,
  };
}

/** Claims → JWT payload (fleet_id snake_case on the wire; stays optional so
 *  pre-tenant tokens keep verifying during rollout). */
export function claimsToPayload(c: TokenClaims): Record<string, unknown> {
  return { sub: c.sub, role: c.role, locale: c.locale, fleet_id: c.fleetId, tv: c.tokenVersion };
}
