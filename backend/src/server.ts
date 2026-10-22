import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();
try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`YET backend listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
