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
  cart: { sections: [], items: [], active: 'all', editor: null }, // active: 'all' | 'none' | id sekce
  health: null,
};

try {
  const saved = JSON.parse(localStorage.getItem('letackomat') ?? '{}');
  if (Array.isArray(saved.shops)) state.shops = new Set(saved.shops);
  if (saved.sort) state.sort = saved.sort;
  if (saved.view === 'cart') state.view = 'cart';
} catch { /* localStorage nemusí být dostupné */ }

function persist() {
  try {
    localStorage.setItem('letackomat', JSON.stringify({ shops: [...state.shops], sort: state.sort, view: state.view }));
  } catch { /* ignoruj */ }
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
    ${d.pricePerUnit ? `<p class="deal__unit">${esc(d.pricePerUnit)}</p>` : ''}
    <div class="deal__foot">
      <span class="validity ${v.soon ? 'validity--soon' : ''}">${v.text}</span>
      <span class="deal__links">${d.leafletUrl ? `<a href="${esc(d.leafletUrl)}" target="_blank" rel="noopener">V letáku</a>` : ''}</span>
    </div>`;
  el.querySelector('.cartbtn').addEventListener('click', () => toggleCart(d));
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

  const visible = c.items.filter((i) => c.active === 'all' || (c.active === 'none' ? i.sectionId == null : i.sectionId === c.active));
  const open = visible.filter((i) => !i.checked);
  const onSale = open.filter((i) => i.deals.length);
  const total = onSale.reduce((sum, i) => sum + i.deals[0].priceSale, 0);
  $('cartSum').innerHTML = open.length
    ? `<strong>${onSale.length}</strong> z ${open.length} ${open.length === 1 ? 'položky' : open.length < 5 ? 'položek' : 'položek'} je v akci${onSale.length ? ` · nejlevněji dohromady <strong>${fmtPrice(Math.round(total * 100) / 100)} Kč</strong>` : ''}`
    : '';
  $('clearChecked').hidden = !visible.some((i) => i.checked);

  const list = $('cartList');
  if (!c.items.length) {
    list.innerHTML = `<div class="empty"><strong>Nákupní seznam je prázdný</strong>U produktu klikni na ikonu košíku a přidá se sem. Zůstane tu, dokud ho nesmažeš, i když akce skončí.</div>`;
    return;
  }
  if (!visible.length) {
    list.innerHTML = `<div class="empty"><strong>V téhle sekci nic není</strong>Produkt sem přesuneš výběrem sekce u položky.</div>`;
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
    </div>
    <div class="item__tools">
      <select class="item__sec" aria-label="Sekce pro ${esc(item.name)}">${options}</select>
      <button type="button" class="item__del" aria-label="Odebrat ze seznamu: ${esc(item.name)}" title="Odebrat ze seznamu"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7M9 7V4.5h6V7"/></svg></button>
    </div>`;

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

$('clearChecked').addEventListener('click', async () => {
  const res = await fetch('/api/cart/clear-checked', { method: 'POST' });
  const { removed } = await res.json();
  await loadCart();
  toast(`Smazáno odškrtnutých: ${removed}`);
});

/* ——— načítání ——— */
let reqId = 0;
async function load(reset) {
  if (state.view === 'cart') return loadCart();
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
      const noData = state.health && state.health.deals === 0;
      grid.innerHTML = noData
        ? `<div class="empty"><strong>${state.health.scraping ? 'Stahují se první data' : 'Zatím tu nejsou žádná data'}</strong>${state.health.scraping ? 'Potrvá to pár minut. Pak stránku obnov.' : 'Spusť npm run scrape.'}</div>`
        : `<div class="empty"><strong>V tomto termínu nic není</strong>Zkus jiný den nebo období, zruš filtry nebo vyber další obchody.</div>`;
    }
  } catch (e) {
    if (id !== reqId) return;
    checkAlive();
    $('grid').innerHTML = `<div class="empty"><strong>Data se nepodařilo načíst</strong>Zkontroluj, jestli běží server (npm start), a zkus to znovu.</div>`;
  }
}

const plural = (n) => (n === 1 ? 'akce' : n >= 2 && n <= 4 ? 'akce' : 'akcí');

function setView(view) {
  state.view = view;
  persist();
  const cart = view === 'cart';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.view === view)));
  for (const el of [document.querySelector('.filters'), $('summary'), $('grid'), document.querySelector('.more')]) el.hidden = cart;
  $('cart').hidden = !cart;
  load(true);
  renderDays();
}

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
  else $('stopBtn').hidden = !state.health.canShutdown;

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

/* ——— PWA ——— */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('installBtn').hidden = false;
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('installBtn').hidden = true;
});

init();
