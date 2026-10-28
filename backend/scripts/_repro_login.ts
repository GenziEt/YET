/* temporary diagnostic — reproduces the /auth/login 500 seen in phase5_gates */
process.env.DATABASE_URL ??= 'postgres://yet:postgres@127.0.0.1:5432/yet';
process.env.JWT_SECRET ??= 'local-dev-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
import pg from 'pg';
import crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const poolX = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const tag = randomUUID().slice(0, 8);
const fleet = randomUUID(); const drv = randomUUID();
await poolX.query(`INSERT INTO fleets (id,name,status) VALUES ($1,$2,'ACTIVE')`, [fleet, `repro-fleet-${tag}`]);
const salt = crypto.randomBytes(16);
const hash = `scrypt$${salt.toString('hex')}$${crypto.scryptSync('repro-password', salt, 64).toString('hex')}`;
const email = `repro-${tag}@yet.local`;
await poolX.query(
  `INSERT INTO users (id, role, full_name, email, password_hash, locale, is_active, fleet_id)
   VALUES ($1,'DRIVER','Repro',$2,$3,'en',true,$4)`, [drv, email, hash, fleet]);

const { buildApp } = await import('../src/app.js');
const app = await buildApp(); await app.ready();
const res = await app.inject({ method: 'POST', url: '/auth/login',
  payload: { identifier: email, password: 'repro-password' } });
console.log('STATUS', res.statusCode);
console.log('BODY', res.body.slice(0, 1200));
await app.close();
await poolX.query(`DELETE FROM audit_log WHERE action LIKE 'login%' AND ip IS NULL`).catch(() => {});
await poolX.end();
