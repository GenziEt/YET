import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
export function signAccessToken(claims) {
    return jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL });
}
export function verifyAccessToken(token) {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (typeof payload === 'string')
        throw new Error('bad token');
    return { sub: payload.sub, role: payload.role, locale: payload.locale };
}
//# sourceMappingURL=jwt.js.map