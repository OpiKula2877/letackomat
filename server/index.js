import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getMeta, openDb } from './db.js';
import { registerRoutes } from './routes.js';
import { runScrape } from './scraper/run.js';
import { createUpdateService } from './update.js';

const here = dirname(fileURLToPath(import.meta.url));

export function buildApp(db, { logger = false, onShutdown, update } = {}) {
  // forceCloseConnections: otevřené spojení prohlížeče (keep-alive) nesmí vypnutí zablokovat
  const app = Fastify({ logger, forceCloseConnections: true });
  registerRoutes(app, db, { onShutdown, update });
  app.register(fastifyStatic, { root: resolve(here, '..', 'web'), maxAge: 0 });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const pidFile = resolve(process.env.PID_FILE ?? join('data', 'server.pid'));

  async function shutdown() {
    // nejdéle 3 s na slušné zavření, pak se končí tak jako tak
    const killer = setTimeout(() => process.exit(0), 3000);
    try {
      await app.close();
      db.close();
    } catch { /* i tak končíme */ }
    clearTimeout(killer);
    process.exit(0);
  }

  const update = createUpdateService(db);
  const app = buildApp(db, { logger: { level: 'info' }, onShutdown: shutdown, update });
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });

  update.check().catch((e) => app.log.warn(`kontrola aktualizací: ${e.message}`)); // na pozadí, bez internetu nevadí

  // PID pro end.bat, kdyby se server nedal vypnout slušně
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  process.on('exit', () => rmSync(pidFile, { force: true }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

  if (process.env.NO_SCRAPE !== '1') {
    const scrape = () => runScrape(db, undefined, (m) => app.log.info(m)).catch((e) => app.log.error(e));
    cron.schedule('0 6,14 * * *', scrape, { timezone: 'Europe/Prague' });
    const last = getMeta(db, 'last_scrape');
    if (!last || Date.now() - Date.parse(last) > 20 * 3600 * 1000) scrape();
  }
}
