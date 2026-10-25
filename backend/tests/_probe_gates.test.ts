import { describe, it } from 'vitest';
const DB = process.env.YET_TEST_DB!;
process.env.DATABASE_URL = DB;
process.env.JWT_SECRET ??= 'phase0-test-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
describe('probe', () => {
  it('raw fastify handler check', async () => {
    const Fastify = (await import('fastify')).default;
    const sensible = (await import('@fastify/sensible')).default;
    const app = Fastify();
    await app.register(sensible);
    app.get('/t', async () => { throw Object.assign(new Error('consent_required'), { statusCode: 403 }); });
    app.setErrorHandler((err: any, _req: any, reply: any) => {
      console.log('RAW_HANDLER_RAN ' + err.message);
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/t' });
    console.log('RAW ' + r.statusCode + ' ' + r.body);
    await app.close();
  });
});
