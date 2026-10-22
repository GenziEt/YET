import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface TokenClaims {
  sub: string;          // user id
  role: 'DRIVER' | 'FLEET_MANAGER' | 'ADMIN';
  locale?: string;
}

export function signAccessToken(claims: TokenClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'] });
}

export function verifyAccessToken(token: string): TokenClaims {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === 'string') throw new Error('bad token');
  return { sub: payload.sub as string, role: payload.role as TokenClaims['role'], locale: payload.locale as string | undefined };
}
