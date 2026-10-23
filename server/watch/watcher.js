// Plánovač hlídače: rychlá kontrola hlídaných pravidel hned po startu, každých 30 minut
// a hned po probuzení počítače ze spánku, bez čekání na stažení všech obchodů.

/**
 * @param {{ enabled: () => boolean, run: () => Promise<any> }} alerts
 * @param {() => Promise<{requested:number, ok:number, failed:number}>} quick
 */
export function createWatcher({ alerts, quick, intervalMs = 30 * 60_000, tickMs = 10_000, retryMs = 15_000, now = Date.now, log = () => {} }) {
  let lastQuick = 0;
  let lastTick = now();
  let retryAt = 0;
  let busy = false;
  let timer = null;

  /** Jeden krok plánovače; volá se každých tickMs (a v testech ručně). */
  async function tick() {
    const t = now();
    const gap = t - lastTick;
    lastTick = t;
    if (busy || !alerts.enabled()) return { skipped: true };

    // časovač se zastavil na delší dobu = počítač spal, kontrola hned po probuzení
    const woke = gap > tickMs * 3;
    const due = lastQuick === 0 || t - lastQuick >= intervalMs || woke;
    if (!due || (!woke && t < retryAt)) return { skipped: true };

    busy = true;
    try {
      const r = await quick();
      if (r.requested > 0 && r.ok === 0 && r.failed > 0) {
        retryAt = t + retryMs; // bez připojení (po startu často Wi-Fi ještě není) se zkusí brzy znovu
        log(`rychlá kontrola selhala (${r.failed}x), zkusím znovu za ${Math.round(retryMs / 1000)} s`);
        return { retry: true };
      }
      lastQuick = now();
      retryAt = 0;
      const res = await alerts.run();
      return { ok: true, woke, ...res };
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start() {
      if (!timer) timer = setInterval(() => tick().catch((e) => log(`hlídač: ${e.message}`)), tickMs);
      tick().catch((e) => log(`hlídač: ${e.message}`)); // hned po startu, ne až po prvním intervalu
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
