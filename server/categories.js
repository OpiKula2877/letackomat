// Jednoduchá klasifikace produktu do kategorie podle klíčových slov v názvu.
// kupi.cz neumí filtr kategorie uvnitř obchodu, proto kategorizujeme sami.
import { normalize } from './util.js';

export const CATEGORIES = [
  { id: 'maso', label: 'Maso a uzeniny', re: /\b(sunk|salam|klobas|parek|maso|kure|kurec|krut|veprov|hovezi|mlet|slanin|uzen|rizek|steak|kridl|stehn|prsa|sekana|spekacek|lunch|debrecin|parky|ryb|losos|treska|pstruh|tunak|krevet|kaprr?|sledi|hermelin?ovy salam)/ },
  { id: 'mlecne', label: 'Mléčné a vejce', re: /\b(mleko|jogurt|syr|tvaroh|maslo|smetan|vejce|vajic|kefir|eidam|gouda|mozzarel|camembert|hermelin|niva|tavene|margarin|rama|zakysan|skyr|cottage|parmaz|feta)/ },
  { id: 'ovoce', label: 'Ovoce a zelenina', re: /\b(banan|jablk|pomeranc|citron|hrozn|brambor|rajc|okurk|paprik|mrkev|cibul|salat|zeli|avokad|mandarink|kiwi|jahod|boruvk|malin|hruš|hrusk|broskv|merunk|svestk|melou|meloun|houby|champion|cesnek|zelen|ovoc|brokolic|kvetak|cuketa|dyne|tykev|reditk|ředkv|spenat|petrzel)/ },
  { id: 'pecivo', label: 'Pečivo', re: /\b(chleb|rohlik|houska|bageta|pecivo|kolac|croissant|donut|bulk|toust|veka|buchta|vanocka|kobliha|trdelnik|zavin)/ },
  { id: 'napoje', label: 'Nápoje', re: /\b(coca|cola|pepsi|fanta|sprite|kofola|limonad|dzus|dzusu|voda|minerál|mineral|nealko|caj\b|caje|caju|energy|monster|redbull|red bull|ice tea|ledovy|sirup|smoothie|mattoni|magnesia|rajec|lipton|nestea)/ },
  { id: 'alkohol', label: 'Alkohol', re: /\b(pivo|vino|prosecco|sekt|vodka|whisky|whiskey|rum\b|gin\b|likér|liker|tuzemsk|becherov|jagermeister|jägermeister|lezak|cider|pilsner|kozel|budvar|gambrinus|radegast|staropramen|svijany|birell)/ },
  { id: 'sladkosti', label: 'Sladkosti a snacky', re: /\b(cokolad|bonbon|susenk|keks|chips|brambůrk|bramburk|tycink|zmrzlin|gumov|oplatk|piskot|popcorn|oresk|arasid|mandle|pernik|nutella|lentilk|haribo|milka|orion|kinder|snickers|mars\b|bounty|twix)/ },
  { id: 'trvanlive', label: 'Trvanlivé potraviny', re: /\b(testovin|rýže|ryze|mouka|cukr|olej|ocet|konzerv|kecup|majonez|horcic|musli|vlocky|kava|káva|caj|med\b|marmelad|dzem|lusten|fazole|cocka|cizrna|polevk|knedl|nudl|spagety|sul\b|koreni|omacka|pate|paštik|pastik)/ },
  { id: 'mrazene', label: 'Mražené', re: /\b(mrazen|pizza|mraz\b|hranolk|zmrz|nugget|zelenina mraz)/ },
  { id: 'drogerie', label: 'Drogerie a péče', re: /\b(prasek|prací|praci|aviváž|avaz|jar\b|savo|domestos|toalet|papir|kapesnik|sampon|sprchov|zubn|pasta|mydlo|deodorant|kremy?\b|krem\b|plen|vlhcene|odlicovac|holic|gillette|ariel|persil|lenor|palmolive|nivea|dove|ubrousk|tablety do|myci|odstranovac|cistic|cistici)/ },
  { id: 'domacnost', label: 'Domácnost a ostatní', re: /\b(hrnec|pann|nuz|ložní|lozni|rucnik|baterie|zarovk|svic|kvetin|zahrad|nastroj|vrtack|akumulator|lego|hracka|auto|pneu|obleceni|ponožk|ponozk|triko|boty|pyzamo)/ },
];

// Specifičtější kategorie (mražené, sladkosti, pečivo, alkohol) se testují dřív,
// aby "máslové sušenky" nespadly do mléčných a "mražená zelenina" do ovoce.
const PRIORITY = ['mrazene', 'sladkosti', 'pecivo', 'alkohol', 'napoje'];
const ORDERED = [
  ...PRIORITY.map((id) => CATEGORIES.find((c) => c.id === id)),
  ...CATEGORIES.filter((c) => !PRIORITY.includes(c.id)),
];

export function categorize(name) {
  const n = normalize(name);
  for (const c of ORDERED) if (c.re.test(n)) return c.id;
  return 'ostatni';
}

export const CATEGORY_LABELS = Object.fromEntries([
  ...CATEGORIES.map((c) => [c.id, c.label]),
  ['ostatni', 'Ostatní'],
]);
