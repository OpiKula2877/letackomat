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
import { rootDir } from './install.js';
import { dataDir } from './paths.js';
import { migrateLegacyData } from './migrate.js';
import { repairProtocolHandler } from './protocol.js';
import { createAlerts } from './watch/alerts.js';
import { quickRefresh } from './watch/quick.js';
import { createWatcher } from './watch/watcher.js';
import { repairAutostart } from './watch/autostart.js';

const here = dirname(fileURLToPath(import.meta.url));

export function buildApp(db, { logger = false, onShutdown, update, alerts } = {}) {
  // forceCloseConnections: otevřené spojení prohlížeče (keep-alive) nesmí vypnutí zablokovat
  const app = Fastify({ logger, forceCloseConnections: true });
  // prázdné tělo s hlavičkou application/json (např. POST bez dat) je v pořádku, ne chyba 400
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body));
    } catch {
      const err = new Error('Neplatný JSON');
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  registerRoutes(app, db, { onShutdown, update, alerts });
  app.register(fastifyStatic, { root: resolve(here, '..', 'web'), maxAge: 0 });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // aplikace z instalátoru při prvním spuštění převezme data ze starší instalace ze zipu
  const migrated = await migrateLegacyData().catch((e) => ({ status: 'failed', error: e.message }));
  const db = openDb();
  const pidFile = resolve(process.env.PID_FILE ?? join(dataDir(), 'server.pid'));

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

  const port = Number(process.env.PORT) || 3000;
  const update = createUpdateService(db);
  const alerts = createAlerts(db, { port, refresh: () => quickRefresh(db) });
  const app = buildApp(db, { logger: { level: 'info' }, onShutdown: shutdown, update, alerts });
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  if (migrated.status === 'migrated') app.log.info(`data převzata ze starší instalace: ${migrated.from}`);
  if (migrated.status === 'failed') app.log.warn(`převzetí dat selhalo: ${migrated.error}`);

  // po přejmenování nebo přesunu složky opraví cesty v tlačítku Spustit server a ve skriptu po přihlášení
  // (NO_REPAIR=1 to vypne, aby zkušební spuštění nepřepisovalo nastavení skutečné instalace)
  if (process.env.NO_REPAIR !== '1') {
  repairProtocolHandler(rootDir).then((r) => r.status === 'repaired' && app.log.info('letackomat://start přepsáno na tuto složku')).catch(() => {});
  try { if (repairAutostart(rootDir) === 'repaired') app.log.info('skript po přihlášení přepsán na tuto složku'); } catch { /* nevadí */ }
  }

  update.check().catch((e) => app.log.warn(`kontrola aktualizací: ${e.message}`)); // na pozadí, bez internetu nevadí

  // PID pro end.bat, kdyby se server nedal vypnout slušně
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  process.on('exit', () => rmSync(pidFile, { force: true }));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);

  // upozornění: po každém stažení dat a při startu (po delším vypnutí PC doběhne zameškané)
  const checkAlerts = () => alerts.run().then((r) => r.matches && app.log.info(`upozornění: ${r.sent}/${r.matches} odesláno`)).catch((e) => app.log.error(e));
  // rychlá kontrola hlídaných pravidel hned po startu, každých 30 minut a po probuzení počítače (bez čekání na stažení všech obchodů)
  if (process.env.NO_ALERTS !== '1') {
    createWatcher({ alerts, quick: () => quickRefresh(db, { log: (m) => app.log.warn(m) }), log: (m) => app.log.info(m) }).start();
  }

  if (process.env.NO_SCRAPE !== '1') {
    const scrape = () => runScrape(db, undefined, (m) => app.log.info(m)).then(checkAlerts).catch((e) => app.log.error(e));
    cron.schedule('0 6,14 * * *', scrape, { timezone: 'Europe/Prague' });
    const last = getMeta(db, 'last_scrape');
    if (!last || Date.now() - Date.parse(last) > 20 * 3600 * 1000) scrape();
  }
}
