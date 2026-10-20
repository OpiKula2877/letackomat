# Letáčkomat

Akční ceny ze všech českých obchodů na jednom místě. Vyber den, obchody, hvězdičkuj produkty.
Funguje jako web i jako instalovatelná appka (PWA). Obsahuje nákupní seznam se sekcemi.

## Stažení a spuštění (Windows)

1. Nainstaluj [Node.js](https://nodejs.org/) (verze LTS, minimálně 22.13). Stačí potvrzovat výchozí volby.
2. Otevři [Releases](https://github.com/OpiKula2877/letackomat/releases/latest) a stáhni `letackomat-vX.Y.Z.zip`.
3. Zip **rozbal** (pravé tlačítko, Extrahovat vše) do libovolné složky, třeba do Dokumentů. Ze zipu to nespouštěj.
4. Dvojklikem spusť `start.bat`. Při prvním spuštění se stáhnou závislosti (potřebuje internet) a pak data o akcích, což trvá několik minut.
   Když Windows ukáže "Počítač byl chráněn", klikni na Další informace a Přesto spustit.
5. Otevře se prohlížeč na <http://localhost:3000>. Volitelně klikni na ikonu instalace v adresním řádku (nebo na tlačítko "Nainstalovat appku") a máš ji jako aplikaci.
6. Vypnout ji jde tlačítkem "Vypnout server" v aplikaci, nebo dvojklikem na `end.bat`.

**Aktualizace na novou verzi:** stáhni nový zip, rozbal ho a zkopíruj do něj složku `data` ze staré verze. Je v ní tvůj nákupní seznam.

**Mac a Linux:** `.bat` soubory jsou jen pro Windows. Nainstaluj Node.js, ve složce spusť `npm install` a `npm start` a otevři <http://localhost:3000>.

**Pro vývojáře:** `git clone https://github.com/OpiKula2877/letackomat.git`, pak `npm install` a `npm start`.

## Spuštění

Potřebuješ Node.js 22.13 nebo novější (testováno na 24).

**Windows, bez příkazové řádky:**

- `start.bat` spustí server na pozadí (bez okna) a otevře prohlížeč. Když už běží, jen otevře prohlížeč.
- `end.bat` server vypne.
- Log serveru je v `data/server.log`.

**Vypnutí z aplikace:** V záhlaví je tlačítko "Vypnout server" (dvojklik na potvrzení), vidí ho jen aplikace otevřená na tomtéž počítači.

**Spuštění z aplikace:** Webová stránka nemůže sama spustit program, a když server neběží, nemá kdo odpovídat.
Vypnutá appka proto ukáže okno "Server neběží" s tlačítkem "Spustit server". To funguje po jednorázovém spuštění
`install-start-button.bat`, které zaregistruje adresu `letackomat://start` (jen pro tvého uživatele, bez admin práv).
Při prvním kliknutí se prohlížeč zeptá, jestli ji otevřít. Zrušit to jde přes `uninstall-start-button.bat`.
Jakmile server naběhne, stránka se obnoví sama.

**Z příkazové řádky:**

```bash
npm install
npm start
```

Otevři <http://localhost:3000>. Při prvním startu se na pozadí stáhnou data (několik minut, pak se vše aktualizuje samo ve 6:00 a 14:00).

Ruční stažení dat (všechny obchody, nebo jen vybrané):

```bash
npm run scrape
npm run scrape -- lidl albert
```

Testy:

```bash
npm test
```

### Instalace jako appka

V Chrome/Edge: ikona instalace v adresním řádku, nebo tlačítko "Nainstalovat appku" v záhlaví.
Na mobilu k appce přistupuj přes adresu počítače v síti (`HOST=0.0.0.0 npm start`) nebo ji nasaď na hosting
(service worker na jiné adrese než `localhost` vyžaduje HTTPS).

## API

| Endpoint | Popis |
| --- | --- |
| `GET /api/deals` | Akce platné v daný den. Parametry: `date=YYYY-MM-DD` (výchozí dnes), `to=YYYY-MM-DD` (volitelně konec období, vrátí akce platné alespoň jeden den v rozsahu), `shops=albert,lidl`, `q=šunka`, `category=maso`, `minDiscount=30`, `sort=discount\|price\|name\|shop`, `limit`, `offset` |
| `GET /api/shops?date=` | Obchody a počet akcí v daný den |
| `GET /api/days?from=&count=14` | Počty akcí po dnech (pásek dnů) |
| `GET /api/range` | Nejstarší a nejnovější známé datum |
| `GET /api/cart?date=&to=` | Nákupní seznam: položky, sekce a slevy položek v období |
| `POST /api/cart` `{productSlug, sectionId?}`, `PATCH/DELETE /api/cart/:slug` | Přidání, změna (`sectionId`, `checked`) a smazání položky |
| `POST /api/cart/clear-checked` | Smaže odškrtnuté položky |
| `GET /api/cart/slugs`, `GET /api/cart/days` | Produkty v seznamu, počty položek v akci po dnech |
| `POST /api/sections`, `PATCH/DELETE /api/sections/:id` | Sekce seznamu (smazání sekce položky nesmaže) |
| `GET /api/health` | Čas posledního stažení dat |
| `POST /api/scrape?shops=` | Spustí stažení dat (jen z tohoto počítače, vyžaduje hlavičku `X-Letackomat: 1`) |
| `POST /api/shutdown` | Vypne server (jen z tohoto počítače, vyžaduje hlavičku `X-Letackomat: 1`) |

Příklady:

- `/api/deals?date=2026-10-23&shops=albert,lidl&q=sunka&sort=price` (jeden den)
- `/api/deals?date=2026-10-24&to=2026-10-25` (víkend)

Každá položka vrací `priceSale`, `priceOrig`, `discountPct`, `validFrom`, `validTo`, obchod, odkaz na produkt a leták.

## Nákupní seznam

Košík u produktu ho přidá do seznamu. Položka se ukládá do databáze a zůstane, dokud ji nesmažeš, i když akce skončí.
U každé položky vidíš slevy v právě vybraném období, jinak poslední známou akci. Položky jdou řadit do vlastních sekcí
(třeba Kalba, Žrádlo) a odškrtávat jako koupené.

## Odkud data jsou a co to znamená

Žádný obchod nemá veřejné API. Letáčkomat stahuje výpisy slev z [kupi.cz](https://www.kupi.cz/),
které sbírá letáky všech řetězců na jednom místě (`/slevy/<obchod>`, povoleno v `robots.txt`).

- **Platnost** se čte z textu na kupi.cz ("st 21. 10. – út 27. 10.", "dnes končí", "platí do …").
  U slev, které kupi.cz označí jen "dnes končí", není znám začátek. Takové akce se ukazují
  od prvního dne, kdy je Letáčkomat viděl.
- **Původní cena** se dopočítá z ceny a procenta slevy, takže může být o desetihaléř vedle.
  Pokud kupi.cz procento slevy neuvádí (časté u Lidlu), zobrazí se jen akční cena.
- **Kategorie** se určují podle klíčových slov v názvu, takže občas se spletou.
- Scraper je slušný: jeden požadavek za 0,8 s, dvakrát denně, s identifikačním User-Agentem.
  Je určen pro osobní použití. Dodržuj podmínky kupi.cz a data dál nešiř.
- Když kupi.cz změní HTML, parser přestane něco najít. Oprav selektory v
  [`server/scraper/kupi.js`](server/scraper/kupi.js) a uprav fixture
  [`test/fixtures/kupi-listing.html`](test/fixtures/kupi-listing.html).

## Nastavení

| Proměnná | Výchozí | Význam |
| --- | --- | --- |
| `PORT` | `3000` | Port serveru |
| `HOST` | `127.0.0.1` | Adresa, na které server poslouchá |
| `DB_FILE` | `data/letackomat.db` | Soubor SQLite |
| `SHOPS` | viz `DEFAULT_SHOPS` | Obchody ke stažení, např. `albert,lidl` |
| `NO_SCRAPE` | | `1` vypne automatické stahování |

Seznam obchodů je v `DEFAULT_SHOPS` v [`server/scraper/kupi.js`](server/scraper/kupi.js). Slug obchodu najdeš v adrese `kupi.cz/slevy/<slug>`.

## Struktura

```
server/   Fastify API, SQLite (node:sqlite), scraper kupi.cz
web/      Frontend bez buildu + PWA (manifest, service worker, ikony)
test/     Testy parseru, datumů a API (node:test)
scripts/  Generátor ikon
```

## Licence

[MIT](LICENSE). Můžeš to volně používat, upravovat i šířit. Data o akcích patří kupi.cz a obchodům, viz sekce o zdroji dat výše.
