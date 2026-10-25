import { pool } from '../db/pool.js';
import type { TokenClaims } from './jwt.js';

/**
 * Phase 0 — Fleet/tenant scoping helpers (shared lib, so every module enforces
 * the SAME rule at its route boundary; PDPP §1.7 minimization).
 *
 * Model (migration 0013): fleets is the tenant entity; DRIVER and FLEET_MANAGER
 * users belong to exactly one fleet (DB trigger); vehicles carry fleet_id; ADMIN
 * is platform-global (fleetId undefined) and therefore unscoped.
 *
 * Rules enforced here:
 *  - assertSameFleet: a token may only touch data whose owning user/vehicle is
 *    in the token's fleet. Cross-fleet access => 403 cross_fleet_denied.
 *  - resolveTargetFleet: canonical "which fleet owns this read target" lookup.
 *  - getDriverFleet / getVehicleFleet: single source for those joins.
 */

export function forbiddenCrossFleet(): never {
  throw Object.assign(new Error('cross_fleet_denied'), { statusCode: 403 });
}

/** Look up the fleet of a driver (users row) or a vehicle; null when missing. */
export async function getDriverFleet(driverId: string): Promise<string | null> {
  const { rows } = await pool.query<{ fleet_id: string | null }>(
    `SELECT fleet_id FROM users WHERE id = $1`, [driverId]);
  return rows[0]?.fleet_id ?? null;
}

export async function getVehicleFleet(vehicleId: string): Promise<string | null> {
  const { rows } = await pool.query<{ fleet_id: string | null }>(
    `SELECT fleet_id FROM vehicles WHERE id = $1`, [vehicleId]);
  return rows[0]?.fleet_id ?? null;
}

/**
 * Resolve which fleet a read/write target belongs to, given either a driver id
 * or a vehicle id (driver wins when both are supplied — driver scope implies
 * their assigned vehicle in practice). Throws 404 when the target does not
 * exist, so probing other tenants' UUIDs yields no information leak beyond
 * existence (same shape as existing *_not_found responses).
 */
export async function resolveTargetFleet(target: { driverId?: string | null; vehicleId?: string | null }): Promise<string | null> {
  if (target.driverId) {
    const { rows } = await pool.query<{ fleet_id: string | null }>(
      `SELECT fleet_id FROM users WHERE id = $1`, [target.driverId]);
    if (rows.length === 0) throw Object.assign(new Error('target_not_found'), { statusCode: 404 });
    return rows[0].fleet_id;
  }
  if (target.vehicleId) {
    const { rows } = await pool.query<{ fleet_id: string | null }>(
      `SELECT fleet_id FROM vehicles WHERE id = $1`, [target.vehicleId]);
    if (rows.length === 0) throw Object.assign(new Error('target_not_found'), { statusCode: 404 });
    return rows[0].fleet_id;
  }
  return null; // whole-tenant-list read — caller must require an unscoped admin OR pass fleet filter
}

/**
 * Route-boundary check for any request that names a specific driver/vehicle.
 *  - ADMIN tokens pass unconditionally (platform operator).
 *  - DRIVER tokens may only name themselves (existing role rules upstream do
 *    the identity check; this adds the tenant layer on top).
 *  - FLEET_MANAGER tokens are confined to their own fleet_id.
 * A tenant-role token WITHOUT a fleet claim (legacy pre-0013 JWT) is denied on
 * scoped reads rather than silently trusted — fail closed.
 */
export async function assertTargetInFleet(claims: TokenClaims, target: { driverId?: string | null; vehicleId?: string | null }): Promise<void> {
  if (claims.role === 'ADMIN') return;
  if (!claims.fleetId) forbiddenCrossFleet();
  const ownerFleet = await resolveTargetFleet(target);
  // Target has no fleet (e.g. Unassigned Fleet edge never happens post-0013:
  // trigger guarantees tenant roles always resolve to a fleet). Fail closed.
  if (ownerFleet !== claims.fleetId) forbiddenCrossFleet();
}

/** Filter value for whole-collection reads: returns the caller's fleet id when
 *  the token is fleet-scoped, or undefined for ADMIN (see=ALL). Consumers add
 *  `WHERE <alias>.fleet_id = $n` only when this returns a string. */
export function scopeFleetId(claims: TokenClaims): string | undefined {
  if (claims.role === 'ADMIN') return undefined;
  if (!claims.fleetId) forbiddenCrossFleet();
  return claims.fleetId;
}
