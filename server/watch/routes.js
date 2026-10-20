// API upozornění. Čtení jen z tohoto počítače, změny navíc s hlavičkou X-Letackomat (viz server/local.js).
import { isLocal, isTrusted } from '../local.js';
import { todayISO } from '../util.js';
import {
  countMatches, createRule, deleteRule, findProductRule, listRules, matchesFor, normalizeRule, updateRule,
} from './rules.js';

const example = (d) => ({
  name: d.name,
  priceSale: d.priceSale,
  discountPct: d.discountPct,
  shop: d.shop.name,
  validFrom: d.validFrom,
  validTo: d.validTo,
  url: d.url,
});

export function registerAlerts(app, db, alerts) {
  const handler = (needsTrust, fn) => async (req, reply) => {
    if (!(needsTrust ? isTrusted(req) : isLocal(req))) return reply.code(403).send({ error: 'jen z tohoto počítače' });
    try {
      return await fn(req, reply);
    } catch (e) {
      return reply.code(e.code ?? 500).send({ error: e.message });
    }
  };

  const withMatches = (rule) => {
    const today = todayISO();
    const found = matchesFor(db, rule, today, { limit: 3 });
    return { ...rule, matches: { count: countMatches(db, rule, today), examples: found.map(example) } };
  };

  app.get('/api/alerts', handler(false, async (req) => ({
    ...(await alerts.status({ withSetting: req.query.setting === '1' })),
    rules: listRules(db).map(withMatches),
  })));

  app.get('/api/alerts/watched', handler(false, async () => ({
    slugs: listRules(db).filter((r) => r.kind === 'product').map((r) => r.value),
  })));

  app.put('/api/alerts/settings', handler(true, async (req) => {
    await alerts.setEnabled(Boolean(req.body?.enabled));
    return alerts.status();
  }));

  app.post('/api/alerts/rules', handler(true, async (req, reply) => {
    const { rule, created } = createRule(db, req.body ?? {}, todayISO());
    return reply.code(created ? 201 : 200).send(withMatches(rule));
  }));

  app.patch('/api/alerts/rules/:id', handler(true, async (req) => withMatches(updateRule(db, Number(req.params.id), req.body ?? {}, todayISO()))));

  app.delete('/api/alerts/rules/:id', handler(true, async (req) => {
    deleteRule(db, Number(req.params.id));
    return { ok: true };
  }));

  /** Náhled při zadávání: co by pravidlo teď chytilo. */
  app.get('/api/alerts/preview', handler(false, async (req) => {
    const rule = normalizeRule(db, req.query);
    const today = todayISO();
    return { count: countMatches(db, rule, today), examples: matchesFor(db, rule, today, { limit: 5 }).map(example) };
  }));

  /** Zvonek u produktu: hlídat / přestat hlídat bez podmínek. */
  app.post('/api/alerts/watch/:slug', handler(true, async (req, reply) => {
    const { rule, created } = createRule(db, { kind: 'product', value: req.params.slug }, todayISO());
    return reply.code(created ? 201 : 200).send(withMatches(rule));
  }));

  app.delete('/api/alerts/watch/:slug', handler(true, async (req) => {
    let rule;
    while ((rule = findProductRule(db, req.params.slug))) deleteRule(db, rule.id);
    return { ok: true };
  }));

  app.post('/api/alerts/test', handler(true, async () => {
    const res = await alerts.test();
    return { ok: Boolean(res.ok), setting: res.setting ?? null, error: res.error ?? null };
  }));

  app.post('/api/alerts/run', handler(true, async () => alerts.run()));
}
