// Letáčkomat – klient. Vanilla JS, žádný build.

const $ = (id) => document.getElementById(id);
const PAGE = 60;

const SHOP_COLORS = {
  albert: '#00a0e0', lidl: '#0050aa', kaufland: '#e10915', 'penny-market': '#cd1719', billa: '#ffd400',
  tesco: '#00539f', globus: '#e30613', coop: '#d4151c', cba: '#e30613', makro: '#003a80',
  rossmann: '#c8102e', 'dm-drogerie': '#005aa0', 'teta-drogerie': '#e6007e', 'dr-max': '#e30613',
};

const state = {
  date: null, // první den období
  dateTo: null, // poslední den období (stejné jako date = jeden den)
  today: null,
  shops: new Set(),
  q: '',
  category: '',
  minDiscount: '0',
  sort: 'discount',
  view: 'all', // 'all' = všechny akce, 'cart' = nákupní seznam
  offset: 0,
  cartSlugs: new Set(), // produkty v nákupním seznamu (pro označení karet)
  cart: { sections: [], items: [], active: 'all', editor: null, onlySale: false }, // active: 'all' | 'none' | id sekce
  health: null,
};

try {
  const saved = JSON.parse(localStorage.getItem('letackomat') ?? '{}');
  if (Array.isArray(saved.shops)) state.shops = new Set(saved.shops);
  if (saved.sort) state.sort = saved.sort;
  if (['cart', 'alerts', 'settings'].includes(saved.view)) state.view = saved.view;
  if (saved.onlySale === true) state.cart.onlySale = true;
} catch { /* localStorage nemusí být dostupné */ }

function persist() {
  try {
    localStorage.setItem(
      'letackomat',
      JSON.stringify({ shops: [...state.shops], sort: state.sort, view: state.view, onlySale: state.cart.onlySale }),
    );
  } catch { /* ignoruj */ }
  saveShops();
}

/* ——— předvolby: vybrané obchody se ukládají na server, takže zůstanou i po restartu ——— */
let prefsLoaded = false; // dokud nepřijdou předvolby ze serveru, nic se nezapisuje (nepřepsal by se starší výběr)
let savedShops = ''; // výběr, který je na serveru (slugy seřazené a spojené čárkou)
const shopsKey = (set) => [...set].sort().join(',');

async function loadPrefs() {
  try {
    const prefs = await api('/api/prefs');
    const onServer = Array.isArray(prefs.shops);
    if (onServer) state.shops = new Set(prefs.shops);
    prefsLoaded = true;
    // první spuštění po aktualizaci: výběr z tohoto prohlížeče se přenese na server
    savedShops = onServer ? shopsKey(state.shops) : '';
    saveShops();
  } catch {
    // bez serveru zůstane výběr z prohlížeče a nic se neukládá
  }
  alertsState.shops = new Set(state.shops);
}

function saveShops() {
  if (!prefsLoaded) return;
  const key = shopsKey(state.shops);
  if (key === savedShops) return;
  savedShops = key;
  fetch('/api/prefs', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-letackomat': '1' },
    body: JSON.stringify({ shops: [...state.shops] }),
  })
    .then((res) => { if (!res.ok) throw new Error(`chyba ${res.status}`); })
    .catch(() => { savedShops = ''; toast('Výběr obchodů se nepodařilo uložit na server.'); });
}

const fmtPrice = (n) =>
  Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',').replace(/,00$/, '').replace(/(,\d)0$/, '$1');
const dm = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}. ${m}.`;
};
const dow = (iso) =>
  new Intl.DateTimeFormat('cs-CZ', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function params(extra = {}) {
  const p = new URLSearchParams({ date: state.date });
  if (state.dateTo && state.dateTo !== state.date) p.set('to', state.dateTo);
  if (state.shops.size) p.set('shops', [...state.shops].join(','));
  if (state.q) p.set('q', state.q);
  if (state.category) p.set('category', state.category);
  if (Number(state.minDiscount) > 0) p.set('minDiscount', state.minDiscount);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ——— pásek dnů ——— */
/** Počty po dnech: v seznamu slev z /api/days, v nákupním seznamu jen pro moje produkty. */
async function fetchDayCounts(from, count) {
  if (state.view === 'cart') {
    const { days } = await api(`/api/cart/days?${new URLSearchParams({ from, count })}`);
    return days;
  }
  const p = params({ from, count });
  p.delete('date');
  p.delete('to');
  p.delete('category');
  return (await api(`/api/days?${p}`)).days;
}

const dayCountLabel = (n) => (state.view === 'cart' ? `${n}× v akci` : `${n} akcí`);

async function renderDays() {
  const days = await fetchDayCounts(state.today, 14);
  const strip = $('days');
  strip.replaceChildren(
    ...days.map((d) => {
      const b = document.createElement('button');
      const wd = new Date(`${d.date}T12:00:00Z`).getUTCDay();
      b.className = 'day' + (d.count ? '' : ' day--empty') + (wd === 0 || wd === 6 ? ' day--weekend' : '') + (d.date === state.today ? ' day--today' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(inRange(d.date)));
      b.dataset.date = d.date;
      b.innerHTML = `<span class="day__dow">${dow(d.date)}</span><span class="day__num">${Number(d.date.slice(8))}.${Number(d.date.slice(5, 7))}.</span><span class="day__n">${dayCountLabel(d.count)}</span>`;
      b.addEventListener('click', () => setRange(d.date, d.date));
      return b;
    }),
  );
  strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

const inRange = (iso) => iso >= state.date && iso <= (state.dateTo ?? state.date);

/* ——— vlastní kalendář ——— */
const MONTHS = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
const cal = { y: 0, m: 0, open: false, anchor: null };
const HINT_IDLE = 'Klikni na první a pak na poslední den';
const HINT_PICK = 'Teď klikni na poslední den (nebo znovu na stejný)';

function dateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${dow(iso)} ${d}. ${m}. ${y}`;
}

function periodLabel() {
  if (state.dateTo === state.date) return dateLabel(state.date);
  return `${dow(state.date)} ${dm(state.date)} – ${dow(state.dateTo)} ${dm(state.dateTo)}`;
}

/** Předvolby období pro tlačítka v kalendáři. */
function preset(name) {
  const t = state.today;
  const wd = (new Date(`${t}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = pondělí
  const monday = addDays(t, -wd);
  switch (name) {
    case 'today': return [t, t];
    case 'tomorrow': return [addDays(t, 1), addDays(t, 1)];
    case 'weekend': return [addDays(monday, 5), addDays(monday, 6)];
    case 'week': return [t, addDays(monday, 6)];
    case 'nextweek': return [addDays(monday, 7), addDays(monday, 13)];
    default: return [t, t];
  }
}

async function renderCal() {
  $('calTitle').textContent = `${MONTHS[cal.m]} ${cal.y}`;
  const first = new Date(Date.UTC(cal.y, cal.m, 1, 12));
  const offset = (first.getUTCDay() + 6) % 7; // pondělí první
  const start = addDays(first.toISOString().slice(0, 10), -offset);
  let counts = new Map();
  try {
    counts = new Map((await fetchDayCounts(start, 42)).map((d) => [d.date, d.count]));
  } catch { /* bez teček */ }
  $('calGrid').replaceChildren(
    ...Array.from({ length: 42 }, (_, i) => {
      const iso = addDays(start, i);
      const wd = i % 7;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal__day'
        + (new Date(`${iso}T12:00:00Z`).getUTCMonth() !== cal.m ? ' cal__day--out' : '')
        + (wd >= 5 ? ' cal__day--weekend' : '')
        + (iso === state.today ? ' cal__day--today' : '')
        + (counts.get(iso) ? ' cal__day--has' : '');
      b.textContent = Number(iso.slice(8));
      b.dataset.date = iso;
      b.setAttribute('aria-label', `${dateLabel(iso)}${counts.get(iso) ? `, ${counts.get(iso)} akcí` : ''}`);
      b.addEventListener('click', () => pickDay(iso));
      return b;
    }),
  );
  markCal();
}

/** Označí konce a vnitřek vybraného období bez nového stahování počtů. */
function markCal() {
  $('calHint').textContent = cal.anchor ? HINT_PICK : HINT_IDLE;
  $('calGrid').querySelectorAll('.cal__day').forEach((b) => {
    const iso = b.dataset.date;
    const end = iso === state.date || iso === state.dateTo;
    b.setAttribute('aria-pressed', String(end));
    b.classList.toggle('cal__day--in', inRange(iso) && !end);
    b.classList.toggle('cal__day--start', iso === state.date && state.dateTo !== state.date);
    b.classList.toggle('cal__day--end', iso === state.dateTo && state.dateTo !== state.date);
  });
}

/** První klik = jeden den (použije se hned), druhý klik = konec období. */
function pickDay(iso) {
  if (!cal.anchor) {
    cal.anchor = iso;
    setRange(iso, iso);
    markCal();
    return;
  }
  const [from, to] = iso < cal.anchor ? [iso, cal.anchor] : [cal.anchor, iso];
  cal.anchor = null;
  closeCal(true);
  setRange(from, to);
}

function openCal() {
  const [y, m] = state.date.split('-').map(Number);
  cal.y = y;
  cal.m = m - 1;
  cal.open = true;
  $('cal').hidden = false;
  $('dateBtn').setAttribute('aria-expanded', 'true');
  renderCal().then(() => $('calGrid').querySelector('[aria-pressed="true"]')?.focus());
}

function closeCal(refocus = false) {
  if (!cal.open) return;
  cal.open = false;
  cal.anchor = null;
  $('cal').hidden = true;
  $('dateBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('dateBtn').focus();
}

function shiftMonth(delta) {
  const d = new Date(Date.UTC(cal.y, cal.m + delta, 1, 12));
  cal.y = d.getUTCFullYear();
  cal.m = d.getUTCMonth();
  renderCal();
}

$('dateBtn').addEventListener('click', () => (cal.open ? closeCal() : openCal()));
$('calPrev').addEventListener('click', () => shiftMonth(-1));
$('calNext').addEventListener('click', () => shiftMonth(1));
document.querySelectorAll('[data-preset]').forEach((b) =>
  b.addEventListener('click', () => {
    const [from, to] = preset(b.dataset.preset);
    closeCal(true);
    setRange(from, to);
  }),
);
document.addEventListener('click', (e) => { if (cal.open && !e.target.closest('.days__pick')) closeCal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCal(true); });

function setRange(from, to = from) {
  state.date = from;
  state.dateTo = to;
  $('dateBtn').textContent = periodLabel();
  document.querySelectorAll('.day').forEach((b) => b.setAttribute('aria-selected', String(inRange(b.dataset.date))));
  load(true);
}

/* ——— obchody a kategorie ——— */
const knownShops = new Map();

function renderShops(facetShops) {
  const box = $('shops');
  // zapamatuj si obchody, ať vybraný obchod nezmizí, když má v daném dni 0 akcí
  for (const s of facetShops) knownShops.set(s.slug, s);
  const counts = new Map(facetShops.map((s) => [s.slug, s.count]));
  const shops = [...knownShops.values()]
    .map((s) => ({ ...s, count: counts.get(s.slug) ?? 0 }))
    .filter((s) => s.count > 0 || state.shops.has(s.slug))
    .sort((a, b) => b.count - a.count);
  box.replaceChildren(
    ...shops.map((s) => {
      const b = document.createElement('button');
      b.className = 'shop';
      b.setAttribute('aria-pressed', String(state.shops.has(s.slug)));
      const ph = `<span class="shop__ph">${s.name.slice(0, 2)}</span>`;
      b.innerHTML = `${s.logo ? `<img src="${s.logo}" alt="" loading="lazy" width="26" height="26">` : ph}<span>${esc(s.name)}</span><span class="shop__n">${s.count}</span>`;
      b.querySelector('img')?.addEventListener('error', (e) => e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'shop__ph', textContent: s.name.slice(0, 2) })));
      b.addEventListener('click', () => {
        if (state.shops.has(s.slug)) state.shops.delete(s.slug);
        else state.shops.add(s.slug);
        persist();
        load(true);
        renderDays();
      });
      return b;
    }),
  );
  if (state.shops.size) {
    const clear = document.createElement('button');
    clear.className = 'shop shop--clear';
    clear.textContent = 'Zrušit výběr obchodů';
    clear.addEventListener('click', () => {
      state.shops.clear();
      persist();
      load(true);
      renderDays();
    });
    box.append(clear);
  }
}

function renderCategories(cats) {
  const sel = $('category');
  sel.replaceChildren(
    new Option('Všechny kategorie', ''),
    ...cats.map((c) => new Option(`${c.label} (${c.count})`, c.id)),
  );
  sel.value = cats.some((c) => c.id === state.category) ? state.category : '';
}

/* ——— vlastní dropdown (rozbalovací seznam nativního <select> nejde obarvit) ——— */
let openDd = null;
let ddId = 0;

function closeDd(refocus = false) {
  if (!openDd) return;
  const { root, btn } = openDd;
  root.classList.remove('dd--open', 'dd--up', 'dd--right');
  btn.setAttribute('aria-expanded', 'false');
  openDd = null;
  if (refocus) btn.focus();
}
document.addEventListener('click', (e) => { if (openDd && !openDd.root.contains(e.target)) closeDd(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openDd) closeDd(true); });
window.addEventListener('resize', () => closeDd());

/**
 * Nahradí <select> vzhledově sladěným výběrem. Původní <select> zůstává v DOM jako zdroj hodnoty
 * (čtení .value, událost "change"), takže zbytek kódu se nemění.
 * Po programové změně hodnoty stačí na select poslat událost "sync".
 */
function enhanceSelect(select, { small = false } = {}) {
  const uid = `dd${++ddId}`;
  const root = document.createElement('div');
  root.className = `dd${small ? ' dd--sm' : ''}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd__btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const text = document.createElement('span');
  text.className = 'dd__text';
  btn.append(text);
  const list = document.createElement('ul');
  list.className = 'dd__list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  const label = select.getAttribute('aria-label');
  if (label) { btn.setAttribute('aria-label', label); list.setAttribute('aria-label', label); }
  root.append(btn, list);
  select.classList.add('dd__native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.after(root);

  let active = -1;
  const opts = () => [...list.children];

  function build() {
    list.replaceChildren(
      ...[...select.options].map((o, i) => {
        const li = document.createElement('li');
        li.className = 'dd__opt';
        li.id = `${uid}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(o.selected));
        li.textContent = o.textContent;
        li.addEventListener('click', () => choose(i));
        li.addEventListener('mousemove', () => setActive(i, false));
        return li;
      }),
    );
    text.textContent = select.selectedOptions[0]?.textContent ?? '';
  }

  function setActive(i, scroll = true) {
    const items = opts();
    if (!items.length) return;
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((li, idx) => li.classList.toggle('dd__opt--active', idx === active));
    list.setAttribute('aria-activedescendant', items[active].id);
    if (scroll) items[active].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    closeDd();
    root.classList.add('dd--open');
    btn.setAttribute('aria-expanded', 'true');
    openDd = { root, btn };
    // místo pod/nad a u pravého okraje
    const r = btn.getBoundingClientRect();
    const need = Math.min(list.scrollHeight, 280) + 14;
    if (innerHeight - r.bottom < need && r.top > innerHeight - r.bottom) root.classList.add('dd--up');
    if (list.getBoundingClientRect().right > innerWidth - 8) root.classList.add('dd--right');
    setActive(select.selectedIndex);
    list.focus({ preventScroll: true });
  }

  function choose(i) {
    if (select.selectedIndex !== i) {
      select.selectedIndex = i;
      build();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeDd(true);
  }

  btn.addEventListener('click', () => (openDd?.root === root ? closeDd() : open()));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); open(); }
  });

  let typed = '';
  let typedTimer;
  list.addEventListener('keydown', (e) => {
    const n = opts().length;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive(active + 1); break;
      case 'ArrowUp': e.preventDefault(); setActive(active - 1); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(n - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); if (active >= 0) choose(active); break;
      case 'Tab': closeDd(); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          clearTimeout(typedTimer);
          typed += e.key.toLowerCase();
          typedTimer = setTimeout(() => (typed = ''), 700);
          const hit = opts().findIndex((li) => li.textContent.toLowerCase().startsWith(typed));
          if (hit >= 0) setActive(hit);
        }
    }
  });

  select.addEventListener('sync', build);
  new MutationObserver(build).observe(select, { childList: true });
  build();
  return root;
}

/* ——— karty ——— */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function validity(d) {
  const date = state.date;
  const single = state.dateTo === state.date;
  if (single && d.validTo === date) return { text: date === state.today ? 'dnes končí' : `poslední den ${dm(d.validTo)}`, soon: true };
  if (d.validFrom && d.validTo) return { text: `platí ${dm(d.validFrom)} – ${dm(d.validTo)}`, soon: false };
  if (d.validTo) return { text: `platí do ${dm(d.validTo)}`, soon: false };
  if (d.validFrom) return { text: `platí od ${dm(d.validFrom)}`, soon: false };
  return { text: 'platnost neznámá', soon: false };
}

/** Ikona košíku; zapnutá má uvnitř fajfku, vypnutá plus. */
const cartIcon = (on) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h2.3l2.2 10.6a1.5 1.5 0 0 0 1.5 1.2h8.2a1.5 1.5 0 0 0 1.5-1.1L20 7.5H5.7"/><circle cx="9.5" cy="19.5" r="1.3"/><circle cx="16.5" cy="19.5" r="1.3"/>${on ? '<path d="m9.8 10.8 1.9 1.9 3.6-3.8"/>' : '<path d="M12.5 8.4v4.2M10.4 10.5h4.2"/>'}</svg>`;

function card(d) {
  const v = validity(d);
  const inCart = state.cartSlugs.has(d.productSlug);
  const el = document.createElement('article');
  el.className = 'deal';
  el.style.setProperty('--shop-color', SHOP_COLORS[d.shop.slug] ?? 'var(--ink)');
  el.dataset.slug = d.productSlug;
  el.innerHTML = `
    <button class="bellbtn" data-slug="${esc(d.productSlug)}" aria-pressed="${alertsState.watched.has(d.productSlug)}" aria-label="${alertsState.watched.has(d.productSlug) ? 'Přestat hlídat slevu' : 'Hlídat slevu'}: ${esc(d.name)}" title="${alertsState.watched.has(d.productSlug) ? 'Hlídám, kliknutím přestaneš' : 'Hlídat slevu a poslat oznámení'}"${alertsState.available ? '' : ' hidden'}>${bellIcon(alertsState.watched.has(d.productSlug))}</button>
    <button class="cartbtn" aria-pressed="${inCart}" aria-label="${inCart ? 'Odebrat z nákupního seznamu' : 'Přidat do nákupního seznamu'}: ${esc(d.name)}" title="${inCart ? 'V nákupním seznamu' : 'Přidat do nákupního seznamu'}">${cartIcon(inCart)}</button>
    <div class="deal__img ${d.image ? '' : 'deal__img--none'}">${d.image ? `<img src="${esc(d.image)}" alt="" loading="lazy">` : '🛒'}</div>
    <div class="deal__body">
      <p class="deal__shop">${esc(d.shop.name)}</p>
      <h2 class="deal__name"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a></h2>
      ${d.quantity ? `<p class="deal__qty">${esc(d.quantity)}${d.note ? ` · ${esc(d.note)}` : ''}</p>` : ''}
    </div>
    <div class="price" ${d.discountPct ? `title="Původní cena je dopočtená ze slevy ${d.discountPct} %"` : ''}>
      <span><span class="price__sale">${fmtPrice(d.priceSale)}</span><span class="price__cur">Kč</span></span>
      ${d.priceOrig ? `<span class="price__old">${fmtPrice(d.priceOrig)} Kč</span>` : ''}
      ${d.discountPct ? `<span class="price__pct">−${d.discountPct} %</span>` : ''}
    </div>
    ${d.unitPrice != null ? `<p class="deal__unit deal__unit--norm"><b>${fmtPrice(d.unitPrice)} Kč</b> / ${unitText(d.unitKind)}</p>` : d.pricePerUnit ? `<p class="deal__unit">${esc(d.pricePerUnit)}</p>` : ''}
    <div class="deal__foot">
      <span class="validity ${v.soon ? 'validity--soon' : ''}">${v.text}</span>
      <span class="deal__links"><button type="button" class="linkbtn cmpbtn">Porovnat ceny</button>${d.leafletUrl ? `<a href="${esc(d.leafletUrl)}" target="_blank" rel="noopener">V letáku</a>` : ''}</span>
    </div>`;
  el.querySelector('.cartbtn').addEventListener('click', () => toggleCart(d));
  el.querySelector('.bellbtn').addEventListener('click', () => toggleWatch(d.productSlug));
  el.querySelector('.cmpbtn').addEventListener('click', () => openCompare(d.productSlug, d.name));
  return el;
}

/** Přidá/odebere produkt do nákupního seznamu (všechny karty stejného produktu se přepnou). */
async function toggleCart(d) {
  const slug = d.productSlug;
  const on = !state.cartSlugs.has(slug);
  setCardsInCart(slug, on);
  try {
    const res = await fetch(on ? '/api/cart' : `/api/cart/${encodeURIComponent(slug)}`, {
      method: on ? 'POST' : 'DELETE',
      headers: on ? { 'content-type': 'application/json' } : undefined,
      body: on ? JSON.stringify({ productSlug: slug }) : undefined,
    });
    if (!res.ok) throw new Error(String(res.status));
    toast(on ? 'Přidáno do nákupního seznamu' : 'Odebráno z nákupního seznamu');
  } catch {
    setCardsInCart(slug, !on);
    toast('Nepodařilo se uložit, zkus to znovu');
  }
}

function setCardsInCart(slug, on) {
  if (on) state.cartSlugs.add(slug);
  else state.cartSlugs.delete(slug);
  updateCartCount();
  document.querySelectorAll(`.deal[data-slug="${CSS.escape(slug)}"] .cartbtn`).forEach((b) => {
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = cartIcon(on);
    const name = b.closest('.deal').querySelector('.deal__name').textContent;
    b.setAttribute('aria-label', `${on ? 'Odebrat z nákupního seznamu' : 'Přidat do nákupního seznamu'}: ${name}`);
    b.title = on ? 'V nákupním seznamu' : 'Přidat do nákupního seznamu';
  });
}

function updateCartCount() {
  $('cartCount').textContent = state.cartSlugs.size;
}

/* ——— toast ——— */
let toastTimer;
function toast(message, action) {
  const el = $('toast');
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: action.label });
    b.addEventListener('click', () => { el.hidden = true; action.run(); });
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 7000 : 2800);
}

/* ——— nákupní seznam ——— */
const periodQuery = () => {
  const p = new URLSearchParams({ date: state.date });
  if (state.dateTo !== state.date) p.set('to', state.dateTo);
  return p;
};

async function loadCart() {
  const id = ++reqId;
  try {
    const data = await api(`/api/cart?${periodQuery()}`);
    if (id !== reqId) return;
    state.cart.sections = data.sections;
    state.cart.items = data.items;
    state.cartSlugs = new Set(data.items.map((i) => i.slug));
    updateCartCount();
    renderCart();
  } catch {
    if (id !== reqId) return;
    checkAlive();
    $('cartList').innerHTML = '<div class="empty"><strong>Seznam se nepodařilo načíst</strong>Zkontroluj, jestli běží server (npm start), a zkus to znovu.</div>';
  }
}

const sectionName = (id) => state.cart.sections.find((s) => s.id === id)?.name ?? 'Nezařazeno';

function renderCart() {
  const c = state.cart;
  if (typeof c.active === 'number' && !c.sections.some((s) => s.id === c.active)) c.active = 'all';
  if (c.active === 'none' && !c.items.some((i) => i.sectionId == null)) c.active = 'all';

  renderSectionTabs();
  renderSectionEditor();

  // položky aktivní sekce; přepínač "Jen v akci" je filtruje dál podle slev v zvoleném období
  const inSection = c.items.filter((i) => c.active === 'all' || (c.active === 'none' ? i.sectionId == null : i.sectionId === c.active));
  const saleCount = inSection.filter((i) => i.deals.length).length;
  const visible = c.onlySale ? inSection.filter((i) => i.deals.length) : inSection;
  $('segAll').textContent = inSection.length;
  $('segSale').textContent = saleCount;
  $('saleSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.only === '1') === c.onlySale)));

  const open = visible.filter((i) => !i.checked);
  const onSale = open.filter((i) => i.deals.length);
  const total = onSale.reduce((sum, i) => sum + i.deals[0].priceSale, 0);
  $('cartSum').innerHTML = open.length
    ? `<strong>${onSale.length}</strong> z ${open.length} ${open.length === 1 ? 'položky' : 'položek'} je v akci${onSale.length ? ` · nejlevněji dohromady <strong>${fmtPrice(Math.round(total * 100) / 100)} Kč</strong>` : ''}`
    : '';
  $('clearChecked').hidden = !visible.some((i) => i.checked);

  const list = $('cartList');
  if (!c.items.length) {
    list.innerHTML = `<div class="empty"><strong>Nákupní seznam je prázdný</strong>U produktu klikni na ikonu košíku a přidá se sem. Zůstane tu, dokud ho nesmažeš, i když akce skončí.</div>`;
    return;
  }
  if (!visible.length) {
    list.innerHTML = c.onlySale && inSection.length
      ? `<div class="empty"><strong>V tomto období není nic z tvého seznamu v akci</strong>Přepni na Všechny, nebo zkus jiný den či období.</div>`
      : `<div class="empty"><strong>V téhle sekci nic není</strong>Produkt sem přesuneš výběrem sekce u položky.</div>`;
    return;
  }

  const byOrder = (a, b) => Number(a.checked) - Number(b.checked);
  if (c.active === 'all' && c.sections.length) {
    const groups = [...c.sections.map((s) => ({ id: s.id, name: s.name })), { id: null, name: 'Nezařazeno' }];
    list.replaceChildren(
      ...groups.flatMap((g) => {
        const items = visible.filter((i) => i.sectionId === g.id).sort(byOrder);
        if (!items.length) return [];
        const h = Object.assign(document.createElement('h2'), { className: 'cart__group' });
        h.innerHTML = `${esc(g.name)} <span>${items.length}</span>`;
        return [h, ...items.map(cartRow)];
      }),
    );
  } else {
    list.replaceChildren(...visible.slice().sort(byOrder).map(cartRow));
  }
}

function renderSectionTabs() {
  const c = state.cart;
  const box = $('sections');
  const unsorted = c.items.filter((i) => i.sectionId == null).length;
  const tabs = [{ key: 'all', label: 'Vše', n: c.items.length }];
  for (const s of c.sections) tabs.push({ key: s.id, label: s.name, n: c.items.filter((i) => i.sectionId === s.id).length });
  if (c.sections.length && unsorted) tabs.push({ key: 'none', label: 'Nezařazeno', n: unsorted });

  box.replaceChildren(
    ...tabs.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sec';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(c.active === t.key));
      b.innerHTML = `<span>${esc(t.label)}</span><span class="sec__n">${t.n}</span>`;
      b.addEventListener('click', () => {
        c.active = t.key;
        c.editor = null;
        renderCart();
      });
      return b;
    }),
  );
  if (typeof c.active === 'number') {
    const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'sec sec--tool', textContent: 'Upravit sekci' });
    edit.addEventListener('click', () => {
      c.editor = c.editor?.mode === 'edit' ? null : { mode: 'edit', id: c.active };
      renderCart();
    });
    box.append(edit);
  }
  const add = Object.assign(document.createElement('button'), { type: 'button', className: 'sec sec--tool', textContent: '+ Nová sekce' });
  add.addEventListener('click', () => {
    c.editor = c.editor?.mode === 'new' ? null : { mode: 'new' };
    renderCart();
  });
  box.append(add);
}

function renderSectionEditor() {
  const c = state.cart;
  const box = $('sectionEditor');
  const ed = c.editor;
  box.hidden = !ed;
  if (!ed) return box.replaceChildren();

  const editing = ed.mode === 'edit';
  const input = Object.assign(document.createElement('input'), {
    type: 'text', maxLength: 40, className: 'cart__input',
    placeholder: 'Název sekce, třeba Kalba nebo Žrádlo',
    value: editing ? sectionName(ed.id) : '',
  });
  input.setAttribute('aria-label', 'Název sekce');
  const save = Object.assign(document.createElement('button'), { type: 'button', className: 'cart__btn cart__btn--main', textContent: editing ? 'Uložit název' : 'Přidat sekci' });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'cart__btn', textContent: 'Zrušit' });
  box.replaceChildren(input, save, cancel);

  const submit = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    try {
      const res = await fetch(editing ? `/api/sections/${ed.id}` : '/api/sections', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.status);
      const section = await res.json();
      c.editor = null;
      if (!editing) c.active = section.id;
      await loadCart();
    } catch (e) {
      toast(`Sekci se nepodařilo uložit: ${e.message}`);
    }
  };
  save.addEventListener('click', submit);
  cancel.addEventListener('click', () => { c.editor = null; renderCart(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') { e.stopPropagation(); c.editor = null; renderCart(); }
  });

  if (editing) {
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'cart__btn cart__btn--danger', textContent: 'Smazat sekci' });
    let armed = false;
    del.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Opravdu smazat? Položky zůstanou';
        setTimeout(() => { armed = false; del.textContent = 'Smazat sekci'; }, 4000);
        return;
      }
      await fetch(`/api/sections/${ed.id}`, { method: 'DELETE' });
      c.editor = null;
      c.active = 'all';
      await loadCart();
      toast('Sekce smazána, položky jsou v Nezařazeno');
    });
    box.append(del);
  }
  requestAnimationFrame(() => input.focus());
}

function dealLine(d, best) {
  const v = validity(d);
  return `<li class="dl ${best ? 'dl--best' : ''}" style="--shop-color:${SHOP_COLORS[d.shop.slug] ?? 'var(--ink-soft)'}">
    <span class="dl__shop">${esc(d.shop.name)}</span>
    <span class="dl__price">${fmtPrice(d.priceSale)} Kč</span>
    ${d.discountPct ? `<span class="dl__pct">−${d.discountPct} %</span>` : ''}
    <span class="dl__valid ${v.soon ? 'validity--soon' : ''}">${v.text}</span>
    ${d.leafletUrl ? `<a class="dl__link" href="${esc(d.leafletUrl)}" target="_blank" rel="noopener">V letáku</a>` : ''}
  </li>`;
}

function cartRow(item) {
  const el = document.createElement('article');
  el.className = `item${item.checked ? ' item--done' : ''}`;
  el.dataset.slug = item.slug;

  let dealsHtml;
  if (item.deals.length) {
    const shown = item.deals.slice(0, 3);
    const rest = item.deals.slice(3);
    dealsHtml = `<ul class="dls">${shown.map((d, i) => dealLine(d, i === 0)).join('')}${rest.length ? `<li class="dl dl--more"><button type="button" class="dl__more">ještě ${rest.length} ${rest.length === 1 ? 'obchod' : rest.length < 5 ? 'obchody' : 'obchodů'}</button></li>` : ''}</ul>`;
  } else {
    const last = item.last;
    dealsHtml = `<p class="item__none">V tomto termínu není v akci.${last ? ` <span>Naposledy: ${esc(last.shop.name)} ${fmtPrice(last.priceSale)} Kč${last.validTo ? `, do ${dm(last.validTo)}` : ''}.</span>` : ''}</p>`;
  }

  const options = [`<option value="">Nezařazeno</option>`, ...state.cart.sections.map((s) => `<option value="${s.id}"${s.id === item.sectionId ? ' selected' : ''}>${esc(s.name)}</option>`)].join('');
  el.innerHTML = `
    <label class="item__check"><input type="checkbox" ${item.checked ? 'checked' : ''} aria-label="Koupeno: ${esc(item.name)}"><span aria-hidden="true"></span></label>
    <div class="item__img ${item.image ? '' : 'item__img--none'}">${item.image ? `<img src="${esc(item.image)}" alt="" loading="lazy">` : '🛒'}</div>
    <div class="item__main">
      <h3 class="item__name">${esc(item.name)}${item.quantity ? ` <small>${esc(item.quantity)}</small>` : ''}</h3>
      ${dealsHtml}
      <span class="item__links">
        <button type="button" class="linkbtn item__cmp">Porovnat ceny a historii</button>
        <button type="button" class="linkbtn item__watch" data-slug="${esc(item.slug)}"${alertsState.available ? '' : ' hidden'}>${alertsState.watched.has(item.slug) ? 'Hlídám slevu ✓' : 'Hlídat slevu'}</button>
      </span>
    </div>
    <div class="item__tools">
      <select class="item__sec" aria-label="Sekce pro ${esc(item.name)}">${options}</select>
      <button type="button" class="item__del" aria-label="Odebrat ze seznamu: ${esc(item.name)}" title="Odebrat ze seznamu"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M9 7V4.5h6V7"/></svg></button>
    </div>`;

  el.querySelector('.item__cmp').addEventListener('click', () => openCompare(item.slug, item.name));
  el.querySelector('.item__watch').addEventListener('click', () => toggleWatch(item.slug));
  el.querySelector('.dl__more')?.addEventListener('click', () => {
    el.querySelector('.dls').insertAdjacentHTML('beforeend', item.deals.slice(3).map((d) => dealLine(d, false)).join(''));
    el.querySelector('.dl--more').remove();
  });
  el.querySelector('input[type=checkbox]').addEventListener('change', (e) => patchItem(item, { checked: e.target.checked }));
  enhanceSelect(el.querySelector('.item__sec'), { small: true });
  el.querySelector('.item__sec').addEventListener('change', (e) => patchItem(item, { sectionId: e.target.value === '' ? null : Number(e.target.value) }));
  el.querySelector('.item__del').addEventListener('click', () => removeItem(item));
  return el;
}

async function patchItem(item, patch) {
  const before = { checked: item.checked, sectionId: item.sectionId };
  Object.assign(item, patch);
  renderCart();
  try {
    const res = await fetch(`/api/cart/${encodeURIComponent(item.slug)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    Object.assign(item, before);
    renderCart();
    toast('Změna se neuložila, zkus to znovu');
  }
}

async function removeItem(item) {
  const snapshot = { checked: item.checked, sectionId: item.sectionId };
  state.cart.items = state.cart.items.filter((i) => i !== item);
  state.cartSlugs.delete(item.slug);
  updateCartCount();
  renderCart();
  try {
    const res = await fetch(`/api/cart/${encodeURIComponent(item.slug)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(String(res.status));
    toast(`Odebráno: ${item.name}`, {
      label: 'Vrátit',
      run: async () => {
        await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productSlug: item.slug, sectionId: snapshot.sectionId }) });
        if (snapshot.checked) await fetch(`/api/cart/${encodeURIComponent(item.slug)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checked: true }) });
        loadCart();
      },
    });
  } catch {
    loadCart();
    toast('Položku se nepodařilo odebrat');
  }
}

$('saleSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-only]');
  if (!b) return;
  state.cart.onlySale = b.dataset.only === '1';
  persist();
  renderCart();
});

$('clearChecked').addEventListener('click', async () => {
  const res = await fetch('/api/cart/clear-checked', { method: 'POST' });
  const { removed } = await res.json();
  await loadCart();
  toast(`Smazáno odškrtnutých: ${removed}`);
});

/* ——— porovnání cen produktu ——— */
const CHART_COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6'];
const unitText = (kind) => ({ kg: 'kg', l: 'l', ks: 'ks' })[kind] ?? '';

async function openCompare(slug, fallbackName = '') {
  const dlg = $('cmp');
  dlg.innerHTML = `<div class="cmp__box"><p class="cmp__loading">Načítám porovnání…</p></div>`;
  if (!dlg.open) dlg.showModal();
  try {
    const data = await api(`/api/products/${encodeURIComponent(slug)}?${periodQuery()}`);
    renderCompare(dlg, data);
  } catch {
    dlg.innerHTML = `<div class="cmp__box"><button type="button" class="cmp__close" aria-label="Zavřít">✕</button><h2 id="cmpTitle">${esc(fallbackName) || 'Porovnání cen'}</h2><p>Porovnání se nepodařilo načíst. Zkus to znovu.</p></div>`;
    dlg.querySelector('.cmp__close').addEventListener('click', () => dlg.close());
    checkAlive();
  }
}

function renderCompare(dlg, p) {
  const period = periodLabel();
  const offerRow = (o) => {
    const v = validity(o);
    const unit = o.unitPrice != null ? `${fmtPrice(o.unitPrice)} Kč / ${unitText(o.unitKind)}` : '';
    return `<li class="offer ${o.cheapest ? 'offer--best' : ''}">
      <span class="offer__shop">${esc(o.shop.name)}${o.quantity ? `<small>${esc(o.quantity)}</small>` : ''}</span>
      <span class="offer__price"><b>${fmtPrice(o.priceSale)}</b> Kč${o.discountPct ? ` <i class="offer__pct">−${o.discountPct} %</i>` : ''}</span>
      <span class="offer__unit">${unit}</span>
      <span class="offer__diff">${o.cheapest ? '<em>Nejlevnější</em>' : o.moreExpensivePct > 0 ? `o ${o.moreExpensivePct} % dražší` : ''}</span>
      <span class="offer__valid ${v.soon ? 'validity--soon' : ''}">${v.text}</span>
    </li>`;
  };

  const caption = p.offers.length === 0 ? ''
    : p.offers.length === 1 ? 'V tomto období je v akci jen v jednom obchodě.'
    : p.metric === 'unit' ? `Porovnáno podle ceny za 1 ${unitText(p.unitKind)}, takže různě velká balení jdou srovnat.`
    : 'Balení jsou různá nebo bez ceny za jednotku, proto se porovnává cena za balení.';

  const offersHtml = p.offers.length
    ? `<ul class="offers">${p.offers.map(offerRow).join('')}</ul><p class="cmp__note">${caption}</p>`
    : `<p class="cmp__empty">V období ${esc(period)} není v žádném obchodě v akci.${p.stats.lowestFrom ? ` Naposledy nejlevněji: ${fmtPrice(p.stats.min)} Kč${p.stats.basis === 'unit' ? ` / ${unitText(p.stats.unitKind)}` : ''} (${esc(p.stats.lowestShop)}).` : ''}</p>`;

  dlg.innerHTML = `<div class="cmp__box">
    <header class="cmp__head">
      <div class="cmp__img ${p.image ? '' : 'cmp__img--none'}">${p.image ? `<img src="${esc(p.image)}" alt="">` : '🛒'}</div>
      <div class="cmp__title">
        <h2 id="cmpTitle">${esc(p.name)}</h2>
        <p>${p.quantity ? `${esc(p.quantity)} · ` : ''}${esc(period)}</p>
      </div>
      <button type="button" class="cmp__close" aria-label="Zavřít">✕</button>
    </header>
    <section aria-labelledby="cmpOffers">
      <h3 id="cmpOffers">Ceny v obchodech</h3>
      ${offersHtml}
    </section>
    <section aria-labelledby="cmpHist">
      <h3 id="cmpHist">Historie cen</h3>
      ${historyHtml(p)}
    </section>
    <footer class="cmp__foot">
      <button type="button" class="cmp__cart" aria-pressed="${p.inCart}">${p.inCart ? 'V nákupním seznamu ✓' : 'Přidat do nákupního seznamu'}</button>
      <a class="cmp__link" href="${esc(p.url)}" target="_blank" rel="noopener">Otevřít na kupi.cz</a>
    </footer>
  </div>`;

  dlg.querySelector('.cmp__close').addEventListener('click', () => dlg.close());
  const cartBtn = dlg.querySelector('.cmp__cart');
  cartBtn.addEventListener('click', async () => {
    await toggleCart({ productSlug: p.slug });
    const on = state.cartSlugs.has(p.slug);
    cartBtn.setAttribute('aria-pressed', String(on));
    cartBtn.textContent = on ? 'V nákupním seznamu ✓' : 'Přidat do nákupního seznamu';
    if (state.view === 'cart') loadCart();
  });
}

/** Historie jako vodorovné úseky ceny po dobu platnosti akce (krokový graf) + tabulka pro čtečky. */
function historyHtml(p) {
  const h = p.history;
  if (!h.length) return '<p class="cmp__empty">Zatím žádná historie.</p>';

  const shops = [...new Map(h.map((x) => [x.shop.slug, x.shop.name])).entries()];
  const color = (slug) => `var(${CHART_COLORS[shops.findIndex(([s]) => s === slug) % CHART_COLORS.length]})`;
  const day = (iso) => Date.parse(`${iso}T12:00:00Z`);
  const t0 = Math.min(...h.map((x) => day(x.validFrom)));
  const t1 = Math.max(...h.map((x) => day(x.validTo)), day(state.today));
  // při různě velkých baleních se kreslí cena za 1 kg / 1 l / 1 ks (stejný základ jako statistiky ze serveru)
  const byUnit = p.stats.basis === 'unit';
  const val = (e) => (byUnit ? e.unitPrice : e.priceSale);
  const suffix = byUnit ? ` / ${unitText(p.stats.unitKind)}` : '';
  const lo = Math.min(...h.map(val));
  const hi = Math.max(...h.map(val));
  const W = 640, H = 200, L = 52, R = 14, T = 14, B = 30;
  const x = (t) => L + (t1 === t0 ? (W - L - R) / 2 : ((t - t0) / (t1 - t0)) * (W - L - R));
  const pad = (hi - lo) * 0.15 || hi * 0.1 || 1;
  const yMin = Math.max(0, lo - pad), yMax = hi + pad;
  const y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);

  const bars = h.map((e) => {
    const xa = x(day(e.validFrom)), xb = Math.max(x(day(e.validTo)), xa + 6);
    return `<line x1="${xa.toFixed(1)}" x2="${xb.toFixed(1)}" y1="${y(val(e)).toFixed(1)}" y2="${y(val(e)).toFixed(1)}" stroke="${color(e.shop.slug)}" stroke-width="6" stroke-linecap="round"><title>${esc(e.shop.name)}: ${fmtPrice(val(e))} Kč${suffix}, ${dm(e.validFrom)} – ${dm(e.validTo)}</title></line>`;
  }).join('');
  const tx = x(day(state.today));

  const chart = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Graf cen${suffix}: od ${fmtPrice(p.stats.min)} do ${fmtPrice(p.stats.max)} Kč">
    <line class="chart__grid" x1="${L}" x2="${W - R}" y1="${y(hi).toFixed(1)}" y2="${y(hi).toFixed(1)}"/>
    <line class="chart__grid" x1="${L}" x2="${W - R}" y1="${y(lo).toFixed(1)}" y2="${y(lo).toFixed(1)}"/>
    <text class="chart__txt" x="${L - 8}" y="${(y(hi) + 4).toFixed(1)}" text-anchor="end">${fmtPrice(hi)}</text>
    ${hi !== lo ? `<text class="chart__txt" x="${L - 8}" y="${(y(lo) + 4).toFixed(1)}" text-anchor="end">${fmtPrice(lo)}</text>` : ''}
    <line class="chart__today" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${T}" y2="${H - B}"/>
    ${bars}
    <text class="chart__txt" x="${L}" y="${H - 8}">${dm(new Date(t0).toISOString().slice(0, 10))}</text>
    <text class="chart__txt" x="${(W - R).toFixed(1)}" y="${H - 8}" text-anchor="end">${dm(new Date(t1).toISOString().slice(0, 10))}</text>
  </svg>`;

  const legend = `<ul class="legend">${shops.map(([slug, name]) => `<li><i style="background:${color(slug)}"></i>${esc(name)}</li>`).join('')}<li class="legend__today"><i></i>dnes</li></ul>`;
  const s = p.stats;
  const chips = `<ul class="stats">
    <li><span>Nejnižší</span><b>${fmtPrice(s.min)} Kč${suffix}</b><small>${esc(s.lowestShop ?? '')}${s.lowestFrom ? `, ${dm(s.lowestFrom)}` : ''}</small></li>
    <li><span>Medián</span><b>${fmtPrice(s.median)} Kč${suffix}</b></li>
    <li><span>Nejvyšší</span><b>${fmtPrice(s.max)} Kč${suffix}</b></li>
    <li><span>Záznamů</span><b>${s.count}</b></li>
  </ul>`;
  const rows = [...h].reverse().slice(0, 30).map((e) => `<tr><td>${esc(e.shop.name)}</td><td>${fmtPrice(e.priceSale)} Kč</td>${byUnit ? `<td>${fmtPrice(e.unitPrice)} Kč${suffix}</td>` : ''}<td>${dm(e.validFrom)} – ${dm(e.validTo)}</td></tr>`).join('');
  return `${chips}${chart}${legend}
    <p class="cmp__note">Historie je z našich dat od ${dm(s.since)} a s časem se prodlužuje.</p>
    <details class="cmp__table"><summary>Zobrazit záznamy tabulkou</summary><table><thead><tr><th>Obchod</th><th>Cena balení</th>${byUnit ? `<th>Cena za 1 ${unitText(p.stats.unitKind)}</th>` : ''}<th>Platnost</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

$('cmp').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ——— načítání ——— */
let reqId = 0;
async function load(reset) {
  if (state.view === 'cart') return loadCart();
  if (state.view === 'alerts') return loadAlerts();
  if (state.view === 'settings') return loadSettings();
  if (reset) {
    state.offset = 0;
    $('grid').replaceChildren(...Array.from({ length: 8 }, () => Object.assign(document.createElement('div'), { className: 'skeleton' })));
    $('moreBtn').hidden = true;
  }
  const id = ++reqId;
  try {
    const data = await api(`/api/deals?${params({ sort: state.sort, limit: PAGE, offset: state.offset })}`);
    if (id !== reqId) return;
    renderShops(data.facets.shops);
    renderCategories(data.facets.categories);
    const grid = $('grid');
    if (reset) grid.replaceChildren();
    data.items.forEach((d) => grid.append(card(d)));
    state.offset += data.items.length;
    $('moreBtn').hidden = state.offset >= data.total;
    $('summary').innerHTML = data.total
      ? `<strong>${data.total}</strong> ${plural(data.total)} platných ${
        state.dateTo !== state.date
          ? `v období ${dm(state.date)} – ${dm(state.dateTo)}`
          : state.date === state.today ? 'dnes' : `v ${dow(state.date)} ${dm(state.date)}`
      }`
      : '';
    if (!data.total && reset) {
      if (state.health && state.health.deals === 0) showFirstData(grid);
      else grid.innerHTML = `<div class="empty"><strong>V tomto termínu nic není</strong>Zkus jiný den nebo období, zruš filtry nebo vyber další obchody.</div>`;
    }
  } catch (e) {
    if (id !== reqId) return;
    checkAlive();
    $('grid').innerHTML = `<div class="empty"><strong>Data se nepodařilo načíst</strong>Zkontroluj, jestli běží server (npm start), a zkus to znovu.</div>`;
  }
}

const plural = (n) => (n === 1 ? 'akce' : n >= 2 && n <= 4 ? 'akce' : 'akcí');

/* ——— první data: ukazatel stahování ——— */
const shopsWord = (n) => (n === 1 ? 'obchod' : n >= 2 && n <= 4 ? 'obchody' : 'obchodů');

/** Obsah rámečku podle průběhu stahování ze serveru (`/api/health`). */
function firstDataView(h) {
  const p = h.progress ?? { phase: 'idle' };
  if (p.phase === 'running' || p.phase === 'waiting') {
    // hotové obchody jsou přesně, rozdělaný se počítá odhadem podle stránek (obchod má zhruba 10 stránek), ať ukazatel nestojí
    const partial = p.phase === 'running' ? Math.min(p.page / 10, 0.9) : 0;
    const pct = p.total ? Math.min(99, Math.round(((p.done + partial) / p.total) * 100)) : 0;
    const where = p.phase === 'waiting'
      ? `Něco se nepovedlo (${p.failed} ${shopsWord(p.failed)}), zkusím to znovu za ${Math.max(1, Math.ceil((p.retryAt - Date.now()) / 60_000))} min.`
      : p.current ? `Teď: ${esc(p.current)}${p.page ? `, stránka ${p.page}` : ''}` : 'Připravuju stahování…';
    return `<strong>${p.phase === 'waiting' ? 'Stahování čeká na další pokus' : 'Stahují se první data'}</strong>
      <div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Průběh stahování"><span style="width:${pct}%"></span></div>
      <p class="prog__txt"><b>${p.done} z ${p.total}</b> ${shopsWord(p.total)} · ${pct} % · ${p.deals.toLocaleString('cs-CZ')} ${plural(p.deals)}</p>
      <p class="prog__where">${where}</p>`;
  }
  if (h.deals > 0) {
    return `<strong>Akce jsou stažené</strong>Je jich ${h.deals.toLocaleString('cs-CZ')}. Obnov stránku a uvidíš je.
      <div class="empty__act"><button class="empty__btn" type="button" data-act="reload">Obnovit</button></div>`;
  }
  return `<strong>Zatím tu nejsou žádná data</strong>Stáhni akce z kupi.cz, potrvá to pár minut.
    <div class="empty__act"><button class="empty__btn" type="button" data-act="scrape">Stáhnout akce</button></div>`;
}

/** Místo prázdné stránky ukáže, kolik stahování zbývá; po dokončení nabídne tlačítko Obnovit. */
function showFirstData(grid) {
  const box = Object.assign(document.createElement('div'), { className: 'empty empty--first' });
  box.setAttribute('aria-live', 'polite');
  grid.replaceChildren(box);
  let last = '';
  const paint = (h) => {
    const html = firstDataView(h);
    if (html !== last) box.innerHTML = last = html; // stejný obsah se nepřekresluje, ať neblikají tlačítka
  };
  paint(state.health);
  box.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reload') location.reload();
    if (act === 'scrape') {
      try { await alertsApi('POST', '/api/scrape'); } catch (err) { toast(`Stahování se nepodařilo spustit: ${err.message}`); return; }
      poll();
    }
  });
  let timer = null;
  async function poll() {
    clearTimeout(timer);
    if (!box.isConnected) return; // stránka se mezitím přepnula jinam
    const h = await api('/api/health').catch(() => null);
    if (h) {
      state.health = h;
      paint(h);
      if (h.progress?.phase === 'idle' && h.deals > 0) return; // hotovo, zbývá jen tlačítko Obnovit
    }
    timer = setTimeout(poll, 1000);
  }
  const h0 = state.health;
  if (h0?.progress?.phase !== 'idle' || h0?.deals === 0) timer = setTimeout(poll, 1000);
}

function setView(view) {
  if (view === 'alerts' && $('alertsTab').hidden) view = 'all'; // upozornění jsou jen na počítači, kde aplikace běží
  state.view = view;
  persist();
  const deals = view === 'all';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.view === view)));
  for (const el of [document.querySelector('.filters'), $('summary'), $('grid'), document.querySelector('.more')]) el.hidden = !deals;
  $('cart').hidden = view !== 'cart';
  $('alerts').hidden = view !== 'alerts';
  $('settings').hidden = view !== 'settings';
  document.querySelector('.days').hidden = view === 'alerts' || view === 'settings'; // upozornění a nastavení na dni nezávisí
  load(true);
  if (view !== 'alerts' && view !== 'settings') renderDays();
}

/** Přečte #alerts nebo #alerts/ID z adresy, adresu vyčistí a vrátí true, když se má otevřít záložka Upozornění. */
function consumeAlertsHash() {
  const m = /^#alerts(?:\/(\d+))?$/.exec(location.hash);
  if (!m || $('alertsTab').hidden) return false;
  if (m[1]) alertsState.focusRule = Number(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
window.addEventListener('hashchange', () => { if (consumeAlertsHash()) setView('alerts'); });

async function init() {
  const range = await api('/api/range').catch(() => null);
  state.today = range?.today ?? new Date().toISOString().slice(0, 10);
  state.date = state.today;
  state.dateTo = state.today;
  $('dateBtn').textContent = periodLabel();
  $('sort').value = state.sort;
  $('sort').dispatchEvent(new Event('sync'));

  api('/api/cart/slugs')
    .then(({ slugs }) => {
      state.cartSlugs = new Set(slugs);
      updateCartCount();
      // karty už mohly být vykreslené dřív, než odpověděl server
      document.querySelectorAll('.deal').forEach((el) => setCardsInCart(el.dataset.slug, state.cartSlugs.has(el.dataset.slug)));
    })
    .catch(() => {});
  state.health = await api('/api/health').catch(() => null);
  if (!state.health) showDown();
  else {
    $('stopBtn').hidden = !state.health.canShutdown;
    if (state.health.installed) $('installBtn').hidden = true; // kdyby událost přišla dřív, než přišlo zdraví serveru
    document.querySelector('.brand').title = `Verze ${state.health.version}`;
    initUpdate(); // na pozadí, nic nezdržuje
    await initAlerts(); // rychlé; potřebuje se vědět, jestli se má ukázat záložka a zvonky
  }

  await loadPrefs(); // předvolené obchody ze serveru, dřív než se něco vykreslí

  // kliknutí na Windows oznámení otevře aplikaci s #alerts (nebo #alerts/ID jednoho pravidla)
  if (consumeAlertsHash()) state.view = 'alerts';
  setView(state.view);
}

/* ——— ovládání ——— */
let qTimer;
$('q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    load(true);
    renderDays();
  }, 250);
});
for (const id of ['category', 'minDiscount', 'sort']) enhanceSelect($(id));
$('category').addEventListener('change', (e) => { state.category = e.target.value; load(true); });
$('minDiscount').addEventListener('change', (e) => { state.minDiscount = e.target.value; load(true); renderDays(); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; persist(); load(true); });
$('moreBtn').addEventListener('click', () => load(false));
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

/* ——— upozornění: hlídač slev s oznámením ve Windows ——— */
const alertsState = { data: null, available: true, watched: new Set(), kind: 'keyword', picked: null, shops: new Set(), shopList: [], expanded: new Set(), focusRule: null };

/** Jednoduché jednobarevné ikony pravidel (barvu dává CSS). */
const RULE_ICON_KEYWORD = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V4h9l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="8.5" r="1.4"/></svg>';
const RULE_ICON_PRODUCT = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';
async function alertsApi(method, path, body) {
  // content-type jen s tělem; prázdné tělo s JSON hlavičkou by server odmítl jako Bad Request
  const headers = body === undefined ? { 'x-letackomat': '1' } : { 'content-type': 'application/json', 'x-letackomat': '1' };
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `chyba ${res.status}`);
  return data;
}

const bellIcon = (on) => `<svg viewBox="0 0 24 24" width="21" height="21" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/></svg>`;
const whenText = (iso) => (iso ? new Date(iso).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' }) : '');

/** Zjistí, jestli jsou upozornění dostupná (jen na počítači, kde aplikace běží), a načte hlídané produkty. */
async function initAlerts() {
  try {
    const [watched, status] = await Promise.all([api('/api/alerts/watched'), api('/api/alerts')]);
    alertsState.watched = new Set(watched.slugs);
    alertsState.data = status;
    $('alertsTab').hidden = false;
    updateAlertCount();
  } catch {
    alertsState.available = false; // například aplikace otevřená z mobilu v síti
    document.querySelectorAll('.bellbtn, .item__watch').forEach((b) => (b.hidden = true));
  }
}

function updateAlertCount() {
  const rules = alertsState.data?.rules ?? [];
  $('alertCount').textContent = rules.filter((r) => r.enabled).length;
}

function setBells(slug, on) {
  if (on) alertsState.watched.add(slug);
  else alertsState.watched.delete(slug);
  const sel = CSS.escape(slug);
  document.querySelectorAll(`.bellbtn[data-slug="${sel}"]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = bellIcon(on);
    const name = b.closest('.deal')?.querySelector('.deal__name')?.textContent ?? '';
    b.setAttribute('aria-label', `${on ? 'Přestat hlídat slevu' : 'Hlídat slevu'}: ${name}`);
    b.title = on ? 'Hlídám, kliknutím přestaneš' : 'Hlídat slevu a poslat oznámení';
  });
  document.querySelectorAll(`.item__watch[data-slug="${sel}"]`).forEach((b) => (b.textContent = on ? 'Hlídám slevu ✓' : 'Hlídat slevu'));
}

async function refreshAlertStatus() {
  try {
    alertsState.data = await api('/api/alerts');
    updateAlertCount();
  } catch { /* nevadí */ }
}

async function toggleWatch(slug) {
  const on = !alertsState.watched.has(slug);
  setBells(slug, on);
  try {
    await alertsApi(on ? 'POST' : 'DELETE', `/api/alerts/watch/${encodeURIComponent(slug)}`);
    await refreshAlertStatus();
    toast(on
      ? (alertsState.data?.enabled ? 'Hlídám produkt, oznámení přijde, až bude ve slevě' : 'Hlídám produkt. Oznámení na pozadí zapneš v záložce Upozornění')
      : 'Hlídání zrušeno');
    if (state.view === 'alerts') loadAlerts();
  } catch (e) {
    setBells(slug, !on);
    toast(`Nepodařilo se uložit: ${e.message}`);
  }
}

async function loadAlerts() {
  try {
    alertsState.data = await api('/api/alerts?setting=1');
    updateAlertCount();
    renderAlerts();
    if (!alertsState.shopList.length) {
      const t = state.today ?? new Date().toISOString().slice(0, 10);
      const { shops } = await api(`/api/shops?date=${t}&to=${addDays(t, 14)}`);
      alertsState.shopList = shops;
      renderAlertShops();
    }
  } catch (e) {
    $('alList').innerHTML = `<div class="empty"><strong>Upozornění se nepodařilo načíst</strong>${esc(e.message)}</div>`;
    checkAlive();
  }
}

function renderAlerts() {
  const d = alertsState.data;
  const sw = $('alSwitch');
  sw.setAttribute('aria-checked', String(d.enabled));
  $('alState').textContent = d.enabled
    ? `Zapnuto. Aplikace se po přihlášení do Windows sama spustí na pozadí a po každém stažení dat pošle oznámení o nových slevách.${d.lastRun ? ` Poslední kontrola: ${whenText(d.lastRun)}.` : ''}`
    : 'Vypnuto. Pravidla se ukládají, ale oznámení nechodí. Po zapnutí se aplikace spustí sama po přihlášení do Windows.';

  const warns = [];
  if (!d.autostart.supported) warns.push('Spouštění po přihlášení funguje jen ve Windows, oznámení tedy přijdou jen když aplikace běží.');
  else if (d.enabled && !d.autostart.installed) warns.push('Spouštění po přihlášení se nenašlo. Vypni oznámení a znovu je zapni.');
  if (d.windowsSetting && d.windowsSetting !== 'Enabled') warns.push('Windows má oznámení pro Letáčkomat vypnutá. Zapni je v Nastavení, Systém, Oznámení.');
  if (d.lastError) warns.push(`Poslední oznámení se nepodařilo odeslat: ${d.lastError}`);
  $('alWarn').hidden = !warns.length;
  $('alWarn').textContent = warns.join(' ');

  $('alCount').textContent = d.rules.length ? String(d.rules.length) : '';
  const list = $('alList');
  if (!d.rules.length) {
    list.innerHTML = '<div class="empty"><strong>Zatím nic nehlídáš</strong>Přidej slovo v názvu nahoře, nebo klikni na zvonek u produktu.</div>';
    return;
  }
  list.replaceChildren(...d.rules.map(ruleCard));
}

function ruleCard(r) {
  const el = document.createElement('article');
  el.className = `rule${r.enabled ? '' : ' rule--off'}`;
  const chips = [r.kind === 'keyword' ? 'Slovo v názvu' : 'Konkrétní produkt'];
  if (r.minDiscount) chips.push(`sleva od ${r.minDiscount} %`);
  if (r.maxPrice) chips.push(`do ${fmtPrice(r.maxPrice)} Kč`);
  if (r.shops.length) chips.push(r.shops.map((s) => alertsState.shopList.find((x) => x.slug === s)?.name ?? knownShops.get(s)?.name ?? s).join(', '));
  const count = r.matches.count;
  chips.push(count ? `teď ${count} v akci` : 'teď nic v akci');
  const chevron = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  el.innerHTML = `
    <div class="rule__icon" aria-hidden="true">${r.kind === 'keyword' ? RULE_ICON_KEYWORD : RULE_ICON_PRODUCT}</div>
    <div class="rule__main">
      <h3>${esc(r.label)}</h3>
      <ul class="rule__chips">${chips.map((c, i) => `<li${i === chips.length - 1 ? ` class="${count ? 'chip--live' : ''}"` : ''}>${esc(c)}</li>`).join('')}</ul>
    </div>
    <button type="button" class="rule__toggle" aria-expanded="false" aria-controls="rule-body-${r.id}" aria-label="Zobrazit akce pravidla ${esc(r.label)} (${count})" title="${count ? 'Zobrazit všechny akce' : 'Teď nic v akci. Oznámení přijde, až se to objeví.'}"${count ? '' : ' disabled'}>${chevron}</button>
    <button type="button" class="switch switch--sm" role="switch" aria-checked="${r.enabled}" aria-label="Hlídat: ${esc(r.label)}"><span class="switch__knob"></span></button>
    <button type="button" class="item__del" aria-label="Smazat pravidlo: ${esc(r.label)}" title="Smazat pravidlo"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M9 7V4.5h6V7"/></svg></button>`;
  // rozbalení: všechny akce, které pravidlu teď odpovídají (stejné karty jako v seznamu akcí)
  const body = document.createElement('div');
  body.className = 'rule__body';
  body.id = `rule-body-${r.id}`;
  body.hidden = true;
  el.append(body);
  const toggle = el.querySelector('.rule__toggle');
  const setOpen = async (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    el.classList.toggle('rule--open', open);
    body.hidden = !open;
    if (open) alertsState.expanded.add(r.id);
    else alertsState.expanded.delete(r.id);
    if (!open || body.dataset.loaded === '1') return;
    body.innerHTML = '<p class="rule__loading">Načítám akce…</p>';
    try {
      const { items, total } = await api(`/api/alerts/rules/${r.id}/matches`);
      body.dataset.loaded = '1';
      body.replaceChildren(
        ...(items.length
          ? [Object.assign(document.createElement('div'), { className: 'grid' }), ...(total > items.length ? [Object.assign(document.createElement('p'), { className: 'rule__loading', textContent: `Zobrazeno ${items.length} z ${total}.` })] : [])]
          : [Object.assign(document.createElement('p'), { className: 'rule__loading', textContent: 'Teď nic v akci.' })]),
      );
      items.forEach((d) => body.querySelector('.grid')?.append(card(d)));
    } catch (e) {
      body.innerHTML = `<p class="rule__loading">Akce se nepodařilo načíst: ${esc(e.message)}</p>`;
    }
  };
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  if (count && alertsState.expanded.has(r.id)) setOpen(true);
  if (count && alertsState.focusRule === r.id) {
    alertsState.focusRule = null;
    alertsState.expanded.add(r.id);
    setOpen(true);
    requestAnimationFrame(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  el.querySelector('.switch').addEventListener('click', async () => {
    try {
      await alertsApi('PATCH', `/api/alerts/rules/${r.id}`, { enabled: !r.enabled });
      loadAlerts();
    } catch (e) { toast(`Nepodařilo se uložit: ${e.message}`); }
  });
  el.querySelector('.item__del').addEventListener('click', async () => {
    try {
      await alertsApi('DELETE', `/api/alerts/rules/${r.id}`);
      if (r.kind === 'product') setBells(r.value, false);
      await loadAlerts();
      toast(`Pravidlo smazáno: ${r.label}`, {
        label: 'Vrátit',
        run: async () => {
          await alertsApi('POST', '/api/alerts/rules', { kind: r.kind, value: r.kind === 'keyword' ? r.label : r.value, label: r.label, minDiscount: r.minDiscount, maxPrice: r.maxPrice, shops: r.shops });
          if (r.kind === 'product') setBells(r.value, true);
          loadAlerts();
        },
      });
    } catch (e) { toast(`Nepodařilo se smazat: ${e.message}`); }
  });
  return el;
}

function renderAlertShops() {
  const box = $('alShops');
  box.replaceChildren(
    ...alertsState.shopList.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'shop shop--sm';
      b.setAttribute('aria-pressed', String(alertsState.shops.has(s.slug)));
      b.textContent = s.name;
      b.addEventListener('click', () => {
        if (alertsState.shops.has(s.slug)) alertsState.shops.delete(s.slug);
        else alertsState.shops.add(s.slug);
        b.setAttribute('aria-pressed', String(alertsState.shops.has(s.slug)));
        previewRule();
      });
      return b;
    }),
  );
}

/* ——— nastavení: vybrané obchody (stejný výběr jako v seznamu akcí) ——— */
async function loadSettings() {
  const t = state.today ?? new Date().toISOString().slice(0, 10);
  try {
    const { shops } = await api(`/api/shops?date=${t}&to=${addDays(t, 14)}`);
    // obchod vybraný dřív, který v tomhle období nemá akce, se přesto ukáže, ať jde zrušit
    const listed = new Set(shops.map((s) => s.slug));
    const unlisted = [...state.shops].filter((slug) => !listed.has(slug)).map((slug) => knownShops.get(slug) ?? { slug, name: slug, logo: null });
    renderSettingsShops([...shops, ...unlisted]);
  } catch (e) {
    $('setShops').innerHTML = `<div class="empty"><strong>Obchody se nepodařilo načíst</strong>${esc(e.message)}</div>`;
  }
}

function renderSettingsShops(list) {
  const chips = list.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shop';
    b.setAttribute('aria-pressed', String(state.shops.has(s.slug)));
    const ph = `<span class="shop__ph">${esc(s.name.slice(0, 2))}</span>`;
    b.innerHTML = `${s.logo ? `<img src="${esc(s.logo)}" alt="" loading="lazy" width="26" height="26">` : ph}<span>${esc(s.name)}</span>`;
    b.querySelector('img')?.addEventListener('error', (e) => e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'shop__ph', textContent: s.name.slice(0, 2) })));
    b.addEventListener('click', () => {
      if (state.shops.has(s.slug)) state.shops.delete(s.slug);
      else state.shops.add(s.slug);
      b.setAttribute('aria-pressed', String(state.shops.has(s.slug)));
      shopsChanged();
    });
    return b;
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'shop shop--clear';
  clear.textContent = 'Zrušit výběr';
  clear.addEventListener('click', () => {
    state.shops.clear();
    shopsChanged();
    renderSettingsShops(list);
  });
  $('setShops').replaceChildren(...chips, clear);
  updateShopsStatus();
}

/** Výběr obchodů se změnil: uložit na server a předvyplnit nová pravidla upozornění. */
function shopsChanged() {
  persist();
  alertsState.shops = new Set(state.shops);
  updateShopsStatus();
}

function updateShopsStatus() {
  const n = state.shops.size;
  $('setStatus').textContent = n
    ? `Vybráno ${n} ${shopsWord(n)}. Seznam akcí ukazuje jen tyto obchody.`
    : 'Nic není vybrané, seznam akcí ukazuje všechny obchody.';
  const clear = document.querySelector('#setShops .shop--clear');
  if (clear) clear.disabled = !n;
}

/** Podmínky z formuláře; null, když ještě není co hlídat. */
function formRule() {
  const kind = alertsState.kind;
  const text = $('alInput').value.trim();
  if (kind === 'keyword' ? text.length < 2 : !alertsState.picked) return null;
  return {
    kind,
    value: kind === 'keyword' ? text : alertsState.picked.slug,
    label: kind === 'keyword' ? text : alertsState.picked.name,
    minDiscount: $('alMin').value || null,
    maxPrice: $('alMax').value || null,
    shops: [...alertsState.shops],
  };
}

let previewTimer;
function previewRule() {
  clearTimeout(previewTimer);
  const rule = formRule();
  $('alAdd').disabled = !rule;
  if (!rule) { $('alPreview').textContent = ''; return; }
  previewTimer = setTimeout(async () => {
    const p = new URLSearchParams({ kind: rule.kind, value: rule.value });
    if (rule.minDiscount) p.set('minDiscount', rule.minDiscount);
    if (rule.maxPrice) p.set('maxPrice', rule.maxPrice);
    if (rule.shops.length) p.set('shops', rule.shops.join(','));
    try {
      const r = await api(`/api/alerts/preview?${p}`);
      $('alPreview').innerHTML = r.count
        ? `Teď odpovídá <strong>${r.count}</strong> ${r.count === 1 ? 'akce' : r.count < 5 ? 'akce' : 'akcí'}: ${r.examples.slice(0, 3).map((e) => `${esc(e.name)} ${fmtPrice(e.priceSale)} Kč (${esc(e.shop)})`).join(', ')}${r.count > 3 ? ' …' : ''}`
        : 'Teď nic neodpovídá. Oznámení přijde, až se to objeví v akci.';
    } catch (e) {
      $('alPreview').textContent = e.message;
    }
  }, 300);
}

let pickTimer;
function searchProducts() {
  clearTimeout(pickTimer);
  const q = $('alInput').value.trim();
  const box = $('alPick');
  if (alertsState.kind !== 'product' || q.length < 2) { box.hidden = true; return; }
  pickTimer = setTimeout(async () => {
    try {
      const { products } = await api(`/api/products?q=${encodeURIComponent(q)}`);
      box.replaceChildren(
        ...(products.length
          ? products.map((p) => {
              const li = document.createElement('li');
              li.setAttribute('role', 'option');
              const b = document.createElement('button');
              b.type = 'button';
              b.innerHTML = `${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span class="al-pick__ph">🛒</span>'}<span>${esc(p.name)}${p.quantity ? ` <small>${esc(p.quantity)}</small>` : ''}</span>`;
              b.addEventListener('click', () => {
                alertsState.picked = { slug: p.slug, name: p.name };
                $('alInput').value = p.name;
                box.hidden = true;
                previewRule();
              });
              li.append(b);
              return li;
            })
          : [Object.assign(document.createElement('li'), { className: 'al-pick__none', textContent: 'Nic takového jsem nenašel.' })]),
      );
      box.hidden = false;
    } catch { box.hidden = true; }
  }, 250);
}

function setKind(kind) {
  alertsState.kind = kind;
  alertsState.picked = null;
  $('alInput').value = '';
  $('alPick').hidden = true;
  document.querySelectorAll('#alKind button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  const keyword = kind === 'keyword';
  $('alInput').placeholder = keyword ? 'Např. Jägermeister' : 'Hledej produkt podle názvu';
  $('alInput').setAttribute('aria-label', keyword ? 'Slovo v názvu' : 'Název produktu');
  $('alKindHint').textContent = keyword
    ? 'Oznámí každý produkt, který má slovo v názvu, třeba každé pití s názvem Jägermeister.'
    : 'Oznámí přesně ten jeden produkt, až bude ve slevě. Začni psát název a vyber ho ze seznamu.';
  previewRule();
}

$('alKind').addEventListener('click', (e) => { const b = e.target.closest('button[data-kind]'); if (b) setKind(b.dataset.kind); });
$('alInput').addEventListener('input', () => {
  if (alertsState.kind === 'product') alertsState.picked = null;
  previewRule();
  searchProducts();
});
$('alMax').addEventListener('input', previewRule);
enhanceSelect($('alMin'), { small: true });
$('alMin').addEventListener('change', previewRule);

$('alForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rule = formRule();
  if (!rule) return;
  try {
    const created = await alertsApi('POST', '/api/alerts/rules', rule);
    if (rule.kind === 'product') setBells(rule.value, true);
    $('alInput').value = '';
    $('alMax').value = '';
    $('alMin').value = '';
    $('alMin').dispatchEvent(new Event('sync'));
    alertsState.picked = null;
    alertsState.shops = new Set(state.shops); // nová pravidla začínají s předvybranými obchody
    renderAlertShops();
    $('alPreview').textContent = '';
    $('alAdd').disabled = true;
    await loadAlerts();
    toast(created.matches.count
      ? `Pravidlo přidáno. Teď v akci: ${created.matches.count}, oznámení přijde u dalších nových akcí.`
      : 'Pravidlo přidáno, oznámení přijde, až bude ve slevě.');
  } catch (err) {
    toast(`Pravidlo se nepodařilo přidat: ${err.message}`);
  }
});

$('alSwitch').addEventListener('click', async () => {
  const on = $('alSwitch').getAttribute('aria-checked') !== 'true';
  $('alSwitch').disabled = true;
  try {
    await alertsApi('PUT', '/api/alerts/settings', { enabled: on });
    await loadAlerts();
    toast(on ? 'Oznámení zapnuta. Aplikace se po přihlášení do Windows spustí na pozadí.' : 'Oznámení vypnuta, spouštění po přihlášení zrušeno.');
  } catch (e) {
    toast(`Nepodařilo se změnit: ${e.message}`);
  } finally {
    $('alSwitch').disabled = false;
  }
});

$('alTest').addEventListener('click', async () => {
  try {
    const r = await alertsApi('POST', '/api/alerts/test');
    toast(r.ok ? 'Zkušební oznámení odesláno, mělo by se objevit vpravo dole' : `Oznámení se nepodařilo zobrazit: ${r.error ?? 'neznámá chyba'}`);
    loadAlerts();
  } catch (e) { toast(`Nepodařilo se odeslat: ${e.message}`); }
});

$('alRun').addEventListener('click', async () => {
  if (!alertsState.data?.enabled) return toast('Nejdřív zapni oznámení na pozadí');
  try {
    const r = await alertsApi('POST', '/api/alerts/run');
    toast(r.matches ? (r.sent ? `Odesláno oznámení o ${r.sent} nových akcích` : `Nová akce je, ale oznámení se nepodařilo odeslat: ${r.error ?? ''}`) : 'Žádné nové slevy u hlídaných produktů');
    loadAlerts();
  } catch (e) { toast(`Kontrola selhala: ${e.message}`); }
});

/* ——— server: vypnutí a znovupřipojení ——— */
async function alive() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let downTimer;
function showDown(message) {
  if (message) $('downText').textContent = message;
  $('down').hidden = false;
  clearInterval(downTimer);
  // jakmile server naběhne, stránka se obnoví sama
  downTimer = setInterval(async () => { if (await alive()) location.reload(); }, 2000);
}

async function checkAlive() {
  if (!(await alive())) showDown();
}

$('stopBtn').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (!b.dataset.armed) {
    b.dataset.armed = '1';
    b.textContent = 'Opravdu vypnout?';
    setTimeout(() => { delete b.dataset.armed; b.textContent = 'Vypnout server'; }, 4000);
    return;
  }
  try {
    const res = await fetch('/api/shutdown', { method: 'POST', headers: { 'x-letackomat': '1' } });
    if (!res.ok) throw new Error(String(res.status));
    showDown('Server je vypnutý. Spustíš ho tlačítkem níže.');
  } catch {
    toast('Server se nepodařilo vypnout');
  }
});
$('downRetry').addEventListener('click', async () => {
  if (await alive()) location.reload();
  else toast('Server pořád neběží');
});

/* ——— aktualizace aplikace z GitHubu ——— */
const LATER_KEY = 'letackomat.updLater';
const SEEN_KEY = 'letackomat.updSeen';
const LATER_MS = 24 * 3600 * 1000;

const readLater = () => {
  try { return JSON.parse(localStorage.getItem(LATER_KEY) ?? 'null'); } catch { return null; }
};
const isSnoozed = (version) => {
  const l = readLater();
  return Boolean(l) && l.version === version && Date.now() < l.until;
};

async function healthInfo() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Poznámky k vydání: jen odrážky (bez návodů k instalaci), bez markdownu. */
function releaseNotes(md) {
  const plain = (s) => s.replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
  const bullets = String(md ?? '').split('\n').filter((l) => /^\s*[-*] /.test(l)).map((l) => plain(l.replace(/^\s*[-*] /, ''))).filter(Boolean);
  return bullets.slice(0, 6);
}

function renderUpd(st) {
  const box = $('upd');
  const notes = releaseNotes(st.notes);
  const reason = {
    git: 'Tahle instalace je z gitu, aktualizuj ji příkazem git pull.',
    'no-asset': 'Nová verze zatím nemá stažitelný balíček.',
  }[st.reason];
  box.innerHTML = `
    <h2 id="updTitle">Je dostupná verze ${esc(st.latest)}</h2>
    <p class="upd__ver">Máš verzi ${esc(st.current)}</p>
    ${notes.length ? `<ul class="upd__notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${reason ? `<p class="upd__hint">${esc(reason)}</p>` : `<p class="upd__hint">${st.mode === 'installer' ? (st.needsAdmin ? 'Stáhne se instalátor z GitHubu a Windows se zeptá na potvrzení správce. Potom se aplikace sama restartuje.' : 'Stáhne se instalátor z GitHubu a aplikace se sama restartuje.') : 'Stáhne se z GitHubu a aplikace se sama restartuje.'} Tvoje data a nákupní seznam zůstanou.</p>`}
    <div class="upd__actions">
      ${st.canApply ? '<button type="button" class="upd__go">Aktualizovat</button>' : ''}
      ${st.releaseUrl ? `<a class="upd__link" href="${esc(st.releaseUrl)}" target="_blank" rel="noopener">${st.canApply ? 'Podrobnosti' : 'Otevřít na GitHubu'}</a>` : ''}
      <button type="button" class="upd__later">Později</button>
    </div>`;
  box.querySelector('.upd__later').addEventListener('click', () => {
    try { localStorage.setItem(LATER_KEY, JSON.stringify({ version: st.latest, until: Date.now() + LATER_MS })); } catch { /* nevadí */ }
    closeUpd(true);
  });
  box.querySelector('.upd__go')?.addEventListener('click', () => startUpdate(st));
}

function openUpd() {
  const card = $('upd');
  card.hidden = false;
  $('updBtn').setAttribute('aria-expanded', 'true');
  // karta se zarovná k tlačítku, ale nikdy nepřeteče přes okraj okna (i když je tlačítko vlevo na zalomeném řádku)
  const wrap = $('updWrap').getBoundingClientRect();
  const width = card.getBoundingClientRect().width;
  const left = Math.min(Math.max(wrap.right - width, 16), innerWidth - width - 16);
  card.style.left = `${left - wrap.left}px`;
  card.style.right = 'auto';
}
function closeUpd(refocus = false) {
  if ($('upd').hidden) return;
  $('upd').hidden = true;
  $('updBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('updBtn').focus();
}
$('updBtn').addEventListener('click', () => ($('upd').hidden ? openUpd() : closeUpd()));
document.addEventListener('click', (e) => { if (!$('upd').hidden && !e.target.closest('.updwrap')) closeUpd(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUpd(true); });

function showBusy(title, text) {
  $('busyTitle').textContent = title;
  $('busyText').textContent = text;
  $('busy').hidden = false;
}

async function startUpdate(st) {
  let installerMode = false;
  let elevated = false;
  closeUpd();
  showBusy(`Aktualizuji na verzi ${st.latest}`, 'Stahuji novou verzi z GitHubu…');
  try {
    const res = await fetch('/api/update/apply', { method: 'POST', headers: { 'x-letackomat': '1' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `chyba ${res.status}`);
    installerMode = Boolean(body.installer);
    elevated = Boolean(body.elevated);
  } catch (e) {
    $('busy').hidden = true;
    toast(`Aktualizace se nepodařila: ${e.message}`);
    return;
  }
  $('busyText').textContent = elevated
    ? 'Potvrď okno Windows (správce), instalace pak proběhne sama. Aplikace se po dokončení obnoví, nezavírej ji.'
    : installerMode
      ? 'Instalátor aktualizuje aplikaci. Po dokončení se sama obnoví, nezavírej ji.'
      : 'Aplikace se restartuje. Po dokončení se sama obnoví, nezavírej ji.';
  // u instalátoru jde okno zavřít (třeba když uživatel potvrzení správce zruší), aplikace zatím normálně běží
  $('busyClose').hidden = !installerMode;
  $('busyClose').onclick = () => { clearInterval(timer); $('busy').hidden = true; };
  // server se vypne a updater ho po výměně souborů spustí znovu; po návratu se stránka obnoví
  let wentDown = false;
  const t0 = Date.now();
  const timer = setInterval(async () => {
    const h = await healthInfo();
    if (!h) wentDown = true;
    else if (wentDown || h.version === st.latest) {
      clearInterval(timer);
      location.reload();
    } else if (Date.now() - t0 > (installerMode ? 240_000 : 90_000)) {
      clearInterval(timer);
      $('busy').hidden = true;
      toast('Aktualizace trvá nezvykle dlouho. Zkus stránku obnovit.');
    }
  }, 1500);
}

function showUpdateResult(r) {
  if (!r?.at) return;
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { /* nevadí */ }
  if (seen === r.at) return;
  try { localStorage.setItem(SEEN_KEY, r.at); } catch { /* nevadí */ }
  toast(r.ok ? `Aplikace je aktualizovaná na verzi ${r.to}` : `Aktualizace na ${r.to} se nepodařila (${r.error}). Běží původní verze ${r.from}.`);
}

async function initUpdate() {
  let st;
  try { st = await api('/api/update'); } catch { return; }
  showUpdateResult(st.lastResult);
  if (!st.enabled || !st.available) return;
  $('updWrap').hidden = false;
  $('updLabel').textContent = `Nová verze ${st.latest}`;
  $('updBtn').title = `Je dostupná aktualizace ${st.latest}`;
  $('updBtn').setAttribute('aria-label', `Je dostupná aktualizace ${st.latest}`);
  renderUpd(st);
  // při každém spuštění aplikace jednou vyjede karta, pokud uživatel neklikl na Později
  let shown = false;
  try { shown = sessionStorage.getItem('letackomat.updShown') === '1'; sessionStorage.setItem('letackomat.updShown', '1'); } catch { /* nevadí */ }
  if (!shown && !isSnoozed(st.latest)) openUpd();
}

/* ——— PWA ——— */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // nainstalovaná aplikace (z instalátoru) už má zástupce na ploše, druhá instalace z prohlížeče by ho zdvojila
  if (!state.health?.installed) $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});

init();
