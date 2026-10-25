import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
export function signAccessToken(claims) {
    return jwt.sign(claimsToPayload(claims), env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL });
}
export function verifyAccessToken(token) {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload === 'string')
        throw new Error('bad token');
    return {
        sub: payload.sub,
        role: payload.role,
        locale: payload.locale,
        fleetId: payload.fleet_id,
    };
}
/** Claims → JWT payload (fleet_id snake_case on the wire; stays optional so
 *  pre-tenant tokens keep verifying during rollout). */
export function claimsToPayload(c) {
    return { sub: c.sub, role: c.role, locale: c.locale, fleet_id: c.fleetId };
}
//# sourceMappingURL=jwt.js.map