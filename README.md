# Letáčkomat

Akční ceny ze všech českých obchodů na jednom místě. Funguje jako web i jako instalovatelná appka (PWA).

**Co umí**

- akce platné v zvolený den nebo období od–do, výběr obchodů, hledání bez diakritiky, kategorie, minimální sleva
- **porovnání cen**: u produktu ceny ve všech obchodech vedle sebe, přepočet na 1 kg / 1 l / 1 ks, nejlevnější varianta a historie cen
- řazení podle ceny za jednotku (Nejlevnější za jednotku)
- **nákupní seznam** se sekcemi, odškrtáváním a přepínačem Všechny / Jen v akci; položka zůstává, dokud ji nesmažeš
- **upozornění**: Windows oznámení na pozadí, když je ve slevě hlídané slovo v názvu (třeba Jägermeister) nebo konkrétní produkt

## Stažení a spuštění (Windows)

### Instalátor (doporučeno)

Od verze 1.4.1 se Letáčkomat instaluje instalátorem. Nepotřebuješ nic jiného: Node.js je v instalátoru přibalený.

1. Otevři [Releases](https://github.com/OpiKula2877/letackomat/releases/latest) a stáhni `Letackomat-Setup-X.Y.Z.exe`.
2. Spusť ho. Instalátor nabídne složku (výchozí `C:\Program Files\Letackomat`, vyžaduje potvrzení správcem) nebo volbu **jen pro mě** bez správce (`%LocalAppData%\Programs\Letackomat`).
3. Volitelně zaškrtni zástupce na ploše a tlačítko Spustit server v aplikaci (registrace adresy `letackomat://`).
4. Po dokončení se aplikace spustí a otevře se prohlížeč na <http://localhost:3000>. Při prvním spuštění se stáhnou data o akcích, což trvá několik minut. Dál ji najdeš ve Start menu: **Letáčkomat** (spustí a otevře), **Vypnout Letáčkomat**, **Odinstalovat Letáčkomat** (také v Nastavení, Aplikace).

Instalátor zatím není podepsaný certifikátem vydavatele, takže Windows (SmartScreen) ukáže "Neznámý vydavatel". Klikni na **Další informace** a **Přesto spustit**.

**Data** (nákupní seznam, pravidla hlídače, stažené akce) jsou mimo složku aplikace v `%LocalAppData%\Letackomat`. Aktualizace ani odinstalace je proto nesmažou (odinstalace se zeptá, jestli je smazat, výchozí je ponechat). Když máš starší instalaci ze zipu a po přihlášení se u ní spouští oznámení na pozadí, nebo funguje tlačítko Spustit server, převezme se její databáze sama při prvním spuštění nainstalované aplikace. Původní složka se nemění a můžeš ji pak smazat.

**Aktualizace:** aplikace při každém spuštění zkontroluje GitHub, a když je tam novější verze, v záhlaví se objeví malé kulaté tlačítko a vyjede karta **Aktualizovat / Později**. Po kliknutí se stáhne nový instalátor (ověří se kontrolní součet SHA-256), tiše se spustí a aplikace naběhne znovu v nové verzi. Když je aplikace v `C:\Program Files`, Windows při každé aktualizaci zobrazí okno správce, které potvrď. Kdyby ses rozhodl okno zrušit, aplikace dál běží ve staré verzi. Instalace "jen pro mě" se aktualizuje bez dotazů. Kontrolu jde vypnout proměnnou `NO_UPDATE_CHECK=1`.

### Přenosný zip (bez instalace)

1. Nainstaluj [Node.js](https://nodejs.org/) (verze LTS, minimálně 22.13). Stačí potvrzovat výchozí volby.
2. Z [Releases](https://github.com/OpiKula2877/letackomat/releases/latest) stáhni `letackomat-vX.Y.Z.zip` a **rozbal** ho (pravé tlačítko, Extrahovat vše) do libovolné složky, třeba do Dokumentů. Ze zipu to nespouštěj.
3. Dvojklikem spusť `start.bat`. Při prvním spuštění se stáhnou závislosti (potřebuje internet) a pak data o akcích.
4. Otevře se prohlížeč na <http://localhost:3000>. Vypnout ji jde tlačítkem "Vypnout server" v aplikaci, nebo dvojklikem na `end.bat`.

Data jsou tady ve složce `data` vedle aplikace. Zip se aktualizuje tlačítkem v aplikaci stejně jako dřív (stáhne se zip, vymění se soubory, v případě chyby se vrátí původní). Aplikaci ze zipu a z instalátoru nemíchej: instalátor je novější cesta, zip zůstává pro ty, kdo instalaci nechtějí.

Starší verze (1.0.0 a 1.1.0) aktualizovat neumí. Stáhni jednou nový instalátor, zbytek jde pak z aplikace.

**Mac a Linux:** `.bat` soubory jsou jen pro Windows. Nainstaluj Node.js, ve složce spusť `npm install` a `npm start` a otevři <http://localhost:3000>.

**Pro vývojáře:** `git clone https://github.com/OpiKula2877/letackomat.git`, pak `npm install` a `npm start`.

## Spuštění

Potřebuješ Node.js 22.13 nebo novější (testováno na 24).

**Windows, bez příkazové řádky:**

- `start.bat` spustí server na pozadí (bez okna) a otevře prohlížeč. Když už běží, jen otevře prohlížeč.
- `end.bat` server vypne.
- Když na stejném portu už běží Letáčkomat z jiné složky (třeba starší kopie), `start.bat` ho vypne a spustí tu kopii, ze které ho voláš.
- Log serveru je v `data/server.log`.

**Vypnutí z aplikace:** V záhlaví je tlačítko "Vypnout server" (dvojklik na potvrzení), vidí ho jen aplikace otevřená na tomtéž počítači.

**Spuštění z aplikace:** Webová stránka nemůže sama spustit program, a když server neběží, nemá kdo odpovídat.
Vypnutá appka proto ukáže okno "Server neběží" s tlačítkem "Spustit server". To funguje po jednorázovém spuštění
`install-start-button.bat`, které zaregistruje adresu `letackomat://start` (jen pro tvého uživatele, bez admin práv).
Při prvním kliknutí se prohlížeč zeptá, jestli ji otevřít. Zrušit to jde přes `uninstall-start-button.bat`.
Když složku s aplikací přejmenuješ nebo přesuneš, stačí jednou spustit `start.bat` z nového místa: cesta v tlačítku i ve skriptu po přihlášení (u oznámení na pozadí) se sama opraví, ale jen pokud původní složka už neexistuje.
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
| `GET /api/deals` | Akce platné v daný den. Parametry: `date=YYYY-MM-DD` (výchozí dnes), `to=YYYY-MM-DD` (volitelně konec období, vrátí akce platné alespoň jeden den v rozsahu), `shops=albert,lidl`, `q=šunka`, `category=maso`, `minDiscount=30`, `sort=discount\|price\|unit\|name\|shop`, `limit`, `offset` |
| `GET /api/products/:slug?date=&to=` | Porovnání cen produktu: nabídky v obchodech v období (seřazené podle ceny za 1 kg / 1 l / 1 ks, s označením nejlevnější), historie cen z našich dat a statistiky |
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
| `GET /api/update` | Je na GitHubu novější verze? (výsledek se na 15 minut cachuje, `?force=1` jen z tohoto počítače) |
| `GET /api/alerts`, `PUT /api/alerts/settings` | Stav upozornění a zapnutí / vypnutí oznámení na pozadí (jen z tohoto počítače) |
| `GET/POST /api/alerts/rules`, `PATCH/DELETE /api/alerts/rules/:id` | Pravidla hlídače: `kind` (`keyword` / `product`), `value`, `minDiscount`, `maxPrice`, `shops`, `enabled` |
| `GET /api/alerts/preview` | Co by pravidlo teď chytilo, bez uložení |
| `GET /api/alerts/rules/:id/matches` | Všechny akce, které pravidlu teď odpovídají (rozbalení pravidla v aplikaci) |
| `POST/DELETE /api/alerts/watch/:slug` | Zvonek u produktu: hlídat / přestat hlídat |
| `POST /api/alerts/test`, `POST /api/alerts/run` | Zkušební oznámení; okamžitá kontrola pravidel |
| `GET /api/products?q=` | Hledání produktů podle názvu (výběr produktu k hlídání) |
| `POST /api/update/apply` | Stáhne novou verzi, vypne server a spustí aktualizaci (jen z tohoto počítače, vyžaduje hlavičku `X-Letackomat: 1`) |

Příklady:

- `/api/deals?date=2026-10-23&shops=albert,lidl&q=sunka&sort=price` (jeden den)
- `/api/deals?date=2026-10-24&to=2026-10-25` (víkend)

Každá položka vrací `priceSale`, `priceOrig`, `discountPct`, `validFrom`, `validTo`, obchod, odkaz na produkt a leták.

## Nákupní seznam

Košík u produktu ho přidá do seznamu. Položka se ukládá do databáze a zůstane, dokud ji nesmažeš, i když akce skončí.
U každé položky vidíš slevy v právě vybraném období, jinak poslední známou akci. Položky jdou řadit do vlastních sekcí
(třeba Kalba, Žrádlo) a odškrtávat jako koupené.

## Upozornění (oznámení ve Windows)

V záložce **Upozornění** přidáš pravidla a zapneš přepínač **Oznámení na pozadí**:

- **Slovo v názvu**: hlídá každý produkt, který má slovo v názvu (bez ohledu na diakritiku a velikost písmen), třeba Jägermeister.
- **Konkrétní produkt**: najdeš ho podle názvu a vybereš ze seznamu. Rychle jde i zvonkem u produktu na kartě nebo v nákupním seznamu.
- Volitelně **sleva od** (%), **cena do** (Kč) a **vybrané obchody**. Při zadávání vidíš, kolik akcí pravidlu teď odpovídá.

Jak to funguje:

- Po zapnutí přepínače se do složky Po spuštění ve Windows (`shell:startup`) uloží malý skript `Letackomat-na-pozadi.vbs`, který po přihlášení spustí aplikaci skrytě na pozadí. Vypnutím přepínače se smaže.
- **Rychlá kontrola:** hlídaná slova a produkty se zjišťují přímo na kupi.cz (jeden dotaz na pravidlo, asi 1 až 2 sekundy), bez čekání na stažení všech obchodů. Probíhá hned po startu aplikace (oznámení přijde zhruba do 10 sekund), pak každých 30 minut a hned po probuzení počítače ze spánku. Pokud po startu ještě není připojení k internetu, zkusí to za 15 sekund znovu.
- Úplné stažení všech obchodů běží navíc (6:00, 14:00 a při startu, když jsou data starší než 20 hodin) a po něm se pravidla vyhodnotí znovu. Zameškané slevy po dlouhém vypnutí PC přijdou v jednom souhrnném oznámení.
- Oznámí se akce platná dnes nebo začínající do 3 dnů, každá jednou. Akce, které jsou ve slevě už při vytvoření pravidla, se neoznamují (uvidíš je u pravidla), oznámení chodí u nových.
- Oznámení se zobrazí jako běžné Windows oznámení pod názvem Letáčkomat. Kliknutím se otevře záložka Upozornění (když oznámení patří jednomu pravidlu, rovnou se jeho akce rozbalí). U každého pravidla je šipka, která rozbalí všechny akce, které mu teď odpovídají. Při prvním oznámení se ve Windows zaregistruje název aplikace (klíč v `HKCU\Software\Classes\AppUserModelId\Letackomat`, bez admin práv, smazat ho jde ručně).
- Tlačítko **Poslat zkušební oznámení** ukáže, jak oznámení vypadá. Když se neukáže, zkontroluj ve Windows Nastavení, Systém, Oznámení, že nejsou vypnutá, a že není zapnutý režim Soustředění.
- Upozornění jsou jen na počítači, kde aplikace běží (z mobilu v síti se záložka nezobrazí).

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
| `LETACKOMAT_DATA` | `data/` (zip) nebo `%LocalAppData%\Letackomat` (instalátor) | Složka s databází, logem a daty aktualizace |
| `DB_FILE` | `<data>/letackomat.db` | Soubor SQLite |
| `SHOPS` | viz `DEFAULT_SHOPS` | Obchody ke stažení, např. `albert,lidl` |
| `NO_SCRAPE` | | `1` vypne automatické stahování |
| `NO_UPDATE_CHECK` | | `1` vypne kontrolu nových verzí |
| `NO_ALERTS` | | `1` vypne automatické vyhodnocování upozornění |

Seznam obchodů je v `DEFAULT_SHOPS` v [`server/scraper/kupi.js`](server/scraper/kupi.js). Slug obchodu najdeš v adrese `kupi.cz/slevy/<slug>`.

## Struktura

```
server/   Fastify API, SQLite (node:sqlite), scraper kupi.cz
web/      Frontend bez buildu + PWA (manifest, service worker, ikony)
test/     Testy parseru, datumů, API, aktualizací a instalátoru (node:test)
scripts/  Generátor ikon, spouštěč serveru (launcher), aktualizátor zipu (updater), sestavení instalátoru
installer/ Skript Inno Setup (letackomat.iss)
```

## Licence

[MIT](LICENSE). Můžeš to volně používat, upravovat i šířit. Data o akcích patří kupi.cz a obchodům, viz sekce o zdroji dat výše.

## Vydání nové verze (pro autora)

Aplikace nabízí aktualizaci, když je na GitHubu nejnovější release s vyšší verzí, než má nainstalovaná. Aby to fungovalo, musí release obsahovat **instalátor** (pro aplikace z instalátoru) i **zip** (pro přenosnou verzi a pro starší verze do 1.4.0):

1. Zvyš `version` v `package.json` (tag releasu musí být stejné číslo s předponou `v`, třeba `v1.4.2`), spusť `npm install --package-lock-only --ignore-scripts` a commitni a pushni.
2. Sestav instalátor. Potřebuje [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`winget install JRSoftware.InnoSetup`) a stejnou verzi Node.js, jakou chceš přibalit. Vznikne `dist/Letackomat-Setup-X.Y.Z.exe` (asi 26 MB) a vypíše se jeho SHA-256:

```bash
node scripts/build-installer.js
```

3. Sestav zip tak, aby měl uvnitř jednu složku se stejným názvem jako soubor:

```bash
git archive --format=zip --prefix=letackomat-v1.4.2/ -o letackomat-v1.4.2.zip HEAD
```

4. Vytvoř release a přilož obě přílohy. Názvy musí být `Letackomat-Setup-X.Y.Z.exe` a `letackomat-vX.Y.Z.zip`:

```bash
gh release create v1.4.2 dist/Letackomat-Setup-1.4.2.exe letackomat-v1.4.2.zip --title "Letáčkomat 1.4.2" --notes-file poznamky.md
```

V okně aktualizace se uživateli ukážou odrážky (řádky začínající `- `) z poznámek k vydání.
Aplikace z instalátoru stáhne `.exe`, ověří SHA-256 z GitHubu (bez něj instalátor nespustí) a spustí ho tiše se stejnou cílovou složkou.
Aktualizátor zipu před výměnou zkontroluje, že zip obsahuje verzi, kterou ohlásil release, a při chybě vrátí původní soubory.
Pro rychlé zkušební sestavení instalátoru je `node scripts/build-installer.js --version 9.9.9 --fast --out <složka>`.
