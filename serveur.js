const express = require('express');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;
app.use(express.json({ limit: '10mb' }));

// ── Clé API Mistral ────────────────────────────────────────────────────────────
// Plus AUCUNE clé en dur dans le code source. Deux façons de la fournir :
//   1. Variable d'environnement MISTRAL_API_KEY (prioritaire)
//   2. Fichier "api-key.txt" à côté de ce fichier, contenant uniquement la clé
// Le fichier api-key.txt ne doit JAMAIS être partagé, envoyé par email, ou
// mis dans un dossier synchronisé/partagé publiquement.
function loadApiKey() {
  if (process.env.MISTRAL_API_KEY) return process.env.MISTRAL_API_KEY.trim();
  const keyFile = path.join(__dirname, 'api-key.txt');
  if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile, 'utf-8').trim();
    if (key) return key;
  }
  return null;
}

const CONFIG = {
  apiKey : loadApiKey(),
  model  : 'mistral-large-latest',
};

if (!CONFIG.apiKey) {
  console.error('\n❌ Clé API Mistral introuvable.\n');
  console.error('   Solution la plus simple : crée un fichier nommé "api-key.txt"');
  console.error('   dans ce même dossier, et colle uniquement ta clé API dedans');
  console.error('   (rien d\'autre dans le fichier, pas de guillemets).\n');
  console.error('   Alternative : définis la variable d\'environnement MISTRAL_API_KEY.\n');
  process.exit(1);
}

// ── PIN admin ────────────────────────────────────────────────────────────────
// Avant : le PIN était une constante en clair dans WineSelect.html, lisible
// par n'importe qui via F12 (Inspecter / Sources). Il est maintenant vérifié
// uniquement côté serveur, sur le même principe que la clé API Mistral.
function loadAdminPin() {
  if (process.env.ADMIN_PIN) return process.env.ADMIN_PIN.trim();
  const pinFile = path.join(__dirname, 'admin-pin.txt');
  if (fs.existsSync(pinFile)) {
    const pin = fs.readFileSync(pinFile, 'utf-8').trim();
    if (pin) return pin;
  }
  return null;
}
const DEFAULT_ADMIN_PIN = '2024';
const ADMIN_PIN = loadAdminPin() || DEFAULT_ADMIN_PIN;
if (ADMIN_PIN === DEFAULT_ADMIN_PIN) {
  console.warn('\n⚠️  PIN admin par défaut (' + DEFAULT_ADMIN_PIN + ') encore utilisé.');
  console.warn('   À changer avant tout déploiement en magasin : crée un fichier');
  console.warn('   "admin-pin.txt" à côté de serveur.js avec ton propre code dedans.\n');
}

// Limite le nombre d'essais de PIN pour empêcher un essai automatisé de
// toutes les combinaisons à 4 chiffres (10 000 possibilités, testables en
// quelques secondes sans cette limite). Compteur en mémoire, réinitialisé
// au redémarrage du serveur — suffisant pour une borne à usage local.
const pinAttempts = new Map(); // ip -> { count, lockedUntil }
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 60 * 1000;

// ── Session admin (token) ───────────────────────────────────────────────────
// Avant : le PIN protégeait l'écran Admin côté React, mais les routes REST
// d'écriture (/api/profiles, /api/global-ratings, /api/stock-overrides)
// acceptaient n'importe quel POST sans aucune vérification — quelqu'un avec
// un accès réseau à la borne pouvait écraser ces fichiers sans jamais taper
// le PIN. On délivre maintenant un token à la validation du PIN, à fournir
// en header X-Admin-Token sur les routes qui doivent rester admin-only.
// (profiles/global-ratings restent ouvertes en écriture : elles sont
// alimentées en continu par les clients eux-mêmes, pas seulement l'admin.)
const adminTokens = new Map(); // token -> expiresAt
const ADMIN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h, large pour une session gérant

function issueAdminToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}

function requireAdminToken(req, res, next) {
  const token = req.get('X-Admin-Token') || '';
  const expiresAt = adminTokens.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    adminTokens.delete(token);
    return res.status(401).json({ ok: false, error: 'Session admin expirée ou invalide — reconnecte-toi.' });
  }
  next();
}

// Nettoyage périodique des tokens expirés (mémoire, remise à zéro au redémarrage).
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of adminTokens) {
    if (expiresAt < now) adminTokens.delete(token);
  }
}, 10 * 60 * 1000).unref();

app.post('/api/admin-auth', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, lockedUntil: 0 };

  if (entry.lockedUntil > now) {
    const waitSec = Math.ceil((entry.lockedUntil - now) / 1000);
    return res.status(429).json({ ok: false, error: 'Trop d\'essais. Réessaie dans ' + waitSec + 's.' });
  }

  const pin = (req.body && req.body.pin) ? String(req.body.pin) : '';
  if (pin === ADMIN_PIN) {
    pinAttempts.delete(ip);
    return res.json({ ok: true, token: issueAdminToken() });
  }

  entry.count += 1;
  if (entry.count >= PIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + PIN_LOCKOUT_MS;
    entry.count = 0;
  }
  pinAttempts.set(ip, entry);
  res.json({ ok: false });
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'WineSelect.html')));

// ── Limitation de débit sur les routes qui appellent l'API Mistral ─────────
// Chaque appel à /sommelier ou /selection-accord consomme du budget API,
// sans frein jusqu'ici. Une boucle de requêtes (bug client, page qui se
// recharge en boucle, borne exposée au-delà du réseau local) pouvait donc
// consommer le budget sans qu'on s'en aperçoive. Fenêtre glissante simple,
// en mémoire — remise à zéro au redémarrage, suffisant pour une borne à
// usage local. 30/min est large pour un usage normal (quelques messages
// par session de chat) tout en bloquant un emballement.
const rateLimitHits = new Map(); // ip -> [timestamps des requêtes dans la dernière minute]
function rateLimit(maxPerMinute) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - 60 * 1000;
    const hits = (rateLimitHits.get(ip) || []).filter(t => t > windowStart);
    if (hits.length >= maxPerMinute) {
      console.warn('⚠️  Limite de débit atteinte pour', ip, '(' + hits.length + ' requêtes/min sur ' + req.path + ')');
      return res.status(429).json({ error: 'Trop de requêtes. Réessaie dans quelques instants.' });
    }
    hits.push(now);
    rateLimitHits.set(ip, hits);
    next();
  };
}
// Nettoyage périodique pour ne pas accumuler indéfiniment des entrées IP
// devenues inactives (mémoire, pas fichier — pas de risque de corruption).
setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [ip, hits] of rateLimitHits) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length) rateLimitHits.set(ip, fresh);
    else rateLimitHits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ── Persistance serveur (data/*.json) ───────────────────────────────────────
// Sauvegarde de secours des données client (profils, notes, stocks importés).
// Le front continue de fonctionner en priorité avec localStorage (rapide,
// aucune dépendance réseau pour l'usage normal) ; ces routes servent de
// copie de sûreté et de point de restauration en cas de borne réinstallée
// ou de cache navigateur vidé — voir bouton "Restaurer depuis le serveur"
// dans Admin > Config.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFile(name) { return path.join(DATA_DIR, name + '.json'); }

function readJSON(name, fallback) {
  try {
    const raw = fs.readFileSync(dataFile(name), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

// Écriture atomique : on écrit dans un fichier temporaire puis on renomme.
// Ça évite un fichier corrompu si la borne s'éteint pendant l'écriture.
function writeJSONAtomic(name, data) {
  const tmp = dataFile(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, dataFile(name));
}

function makePersistedRoute(name, opts) {
  opts = opts || {};
  const fallback = opts.defaultValue !== undefined ? opts.defaultValue : {};
  const writeMiddlewares = opts.protect ? [requireAdminToken] : [];

  app.get('/api/' + name, (req, res) => {
    res.json(readJSON(name, fallback));
  });
  app.post('/api/' + name, ...writeMiddlewares, (req, res) => {
    try {
      writeJSONAtomic(name, req.body !== undefined ? req.body : fallback);
      if (opts.onWrite) opts.onWrite();
      res.json({ ok: true });
    } catch (e) {
      console.error('❌ Écriture data/' + name + '.json impossible :', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

makePersistedRoute('profiles');         // ws_profiles — écriture continue par les clients, pas admin-only
makePersistedRoute('global-ratings');   // ws_global_ratings — idem
// stock-overrides : alimenté UNIQUEMENT depuis Admin > Config (import CSV /
// mise en avant), donc protégé par token admin. onWrite réapplique aussitôt
// les overrides sur le catalogue servi à Gabriel (voir applyStockOverrides).
makePersistedRoute('stock-overrides', {
  protect: true,
  defaultValue: [],
  onWrite: () => applyStockOverrides(),
});

// ── Chargement du catalogue ───────────────────────────────────────────────────
// BASE_CATALOG = données brutes de wines-data.js, jamais modifiées en mémoire.
// WINES_CATALOG = BASE_CATALOG + overrides stock/prix/mise en avant importés
// depuis Admin > Config (data/stock-overrides.json). C'est TOUJOURS
// WINES_CATALOG qu'utilisent /sommelier et /selection-accord, pour que
// Gabriel raisonne sur les mêmes prix/stock que ceux affichés sur les
// cartes côté client après un import CSV — avant ce correctif, un import
// mettait à jour l'affichage mais Gabriel continuait de filtrer avec les
// anciens prix de wines-data.js (budget/stock potentiellement incohérents).
let BASE_CATALOG   = [];
let WINES_CATALOG  = [];

function loadCatalog() {
  // Le catalogue vit désormais dans son propre fichier (wines-data.js),
  // séparé de WineSelect.html. Ça permet à chaque magasin d'avoir son
  // propre catalogue sans dupliquer toute l'application : WineSelect.html
  // et serveur.js restent identiques partout et se mettent à jour via le
  // système auto-update habituel ; seul wines-data.js change d'un magasin
  // à l'autre et n'est PAS écrasé par cette mise à jour générique.
  try {
    const file = path.join(__dirname, 'wines-data.js');
    if (!fs.existsSync(file)) {
      console.warn('⚠️  wines-data.js introuvable — voir INSTALLER.bat / migration');
      return;
    }
    const code = fs.readFileSync(file, 'utf-8');
    const sandbox = { window: {} };
    // Le fichier ne fait que peupler window.WINES_DATA / window.CATALOG_DATA :
    // l'exécuter dans un contexte minimal isolé suffit, pas besoin d'un
    // vrai bac à sable (fichier généré et maintenu par nous, pas une entrée
    // utilisateur).
    new Function('window', code)(sandbox.window);
    BASE_CATALOG = sandbox.window.WINES_DATA || [];
    console.log('📦 Catalogue:', BASE_CATALOG.length, 'vins depuis wines-data.js');
    applyStockOverrides();
  } catch(e) {
    console.warn('⚠️  Erreur catalogue:', e.message);
  }
}

// Fusionne data/stock-overrides.json (id, stock, price, featured) sur
// BASE_CATALOG pour produire WINES_CATALOG. Appelé au démarrage et après
// chaque import CSV / mise en avant depuis Admin > Config, pour que Gabriel
// voie immédiatement les nouveaux prix/stocks sans redémarrer le serveur.
function applyStockOverrides() {
  const overrides = readJSON('stock-overrides', []);
  if (!Array.isArray(overrides) || !overrides.length) {
    WINES_CATALOG = BASE_CATALOG;
    return;
  }
  const byId = new Map(overrides.map(o => [o.id, o]));
  WINES_CATALOG = BASE_CATALOG.map(w => {
    const o = byId.get(w.id);
    if (!o) return w;
    const price = (typeof o.price === 'number' && o.price > 0) ? o.price : w.price;
    return {
      ...w,
      price,
      stock: (typeof o.stock === 'number' && o.stock >= 0) ? o.stock : w.stock,
      featured: typeof o.featured === 'boolean' ? o.featured : w.featured,
    };
  });
  console.log('🔄 Overrides stock/prix appliqués au catalogue serveur (' + overrides.length + ' vin(s)).');
}

// ── Conversion des nombres écrits en toutes lettres ───────────────────────────
// La dictée vocale (micro de la borne) transcrit parfois les nombres en toutes
// lettres ("vingt-cinq euros") plutôt qu'en chiffres. Les regex de detectBudget
// ne matchent que des chiffres : sans cette normalisation, un budget dicté à la
// voix n'est jamais détecté et Gabriel perd toute contrainte de prix.
const FR_UNITS = {zero:0,un:1,une:1,deux:2,trois:3,quatre:4,cinq:5,six:6,sept:7,huit:8,neuf:9,
  dix:10,onze:11,douze:12,treize:13,quatorze:14,quinze:15,seize:16};
const FR_TENS  = {vingt:20,trente:30,quarante:40,cinquante:50,soixante:60,septante:70,octante:80,nonante:90};
const FR_NUM_WORDS = Object.keys(FR_UNITS).concat(Object.keys(FR_TENS), ['cent','cents','mille']);
// Le mot de liaison "et" n'est PAS inclus dans le motif général : "entre trente
// et cinquante" ne doit jamais fusionner en un seul nombre. Les seuls composés
// avec "et" en français sont vingt-et-un, trente-et-un, ... et soixante-et-onze :
// on les fusionne au préalable avec un tiret avant d'appliquer le motif général.
const FR_NUM_RE = new RegExp('\\b(?:' + FR_NUM_WORDS.join('|') + ')(?:[\\s-]+(?:' + FR_NUM_WORDS.join('|') + '))*\\b', 'gi');

function frenchWordsToNumber(phrase) {
  const words = phrase.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(w => w && w !== 'et');
  let result = 0, group = 0;
  for (const w of words) {
    if (w in FR_UNITS) {
      group += FR_UNITS[w];
    } else if (w in FR_TENS) {
      if (w === 'vingt' && group >= 2 && group <= 9) group = group * 20;
      else group += FR_TENS[w];
    } else if (w === 'cent' || w === 'cents') {
      group = (group === 0 ? 1 : group) * 100;
      result += group; group = 0;
    } else if (w === 'mille') {
      group = (group === 0 ? 1 : group) * 1000;
      result += group; group = 0;
    }
  }
  return result + group;
}

function normalizeFrenchNumbers(text) {
  const merged = text.replace(/\b(vingt|trente|quarante|cinquante|soixante)\s+et\s+(un|une|onze)\b/gi, '$1-$2');
  return merged.replace(FR_NUM_RE, (match) => {
    const num = frenchWordsToNumber(match);
    return isNaN(num) ? match : String(num);
  });
}

// ── Détection du budget ───────────────────────────────────────────────────────
// Règles :
//  • Cible TOUJOURS la tranche haute : plancher = 80% du maximum annoncé.
//  • Plafond souple = 120% du maximum annoncé (légère montée en gamme tolérée)...
//  • ...SAUF si le client verrouille son budget ("100€ grand maximum", "pas plus
//    de 80€", "ne pas dépasser 50€", "moins de 60€") → plafond STRICT, jamais dépassé.
function detectBudget(messages) {
  // On analyse chaque message client du PLUS RÉCENT au plus ancien :
  // si le client change de budget en cours de conversation, c'est le dernier qui compte.
  const userMsgs = messages.filter(m => m.role === 'user').map(m => m.content);
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const normalized = normalizeFrenchNumbers(userMsgs[i]).toLowerCase();
    const found = parseBudget(normalized);
    if (found) return found;
  }
  return null;
}

function parseBudget(txt) {
  // Budget verrouillé ? (mot-clé avant OU après le montant)
  const strictRe = /grand\s+max(?:imum)?|pas\s+plus|ne\s+pas\s+d[ée]passer|sans\s+d[ée]passer|tout\s+au\s+plus|au\s+max(?:imum)?\b|plafond|moins\s+de|\d+\s*(?:€|euros?)?\s*(?:max\b|maxi\b|maximum)|(?:max\b|maxi\b|maximum)\s*(?:de)?\s*\d+/;
  const strict = strictRe.test(txt);

  // ref = maximum ANNONCÉ par le client ; min/max = fourchette de tolérance globale
  const mk = (max, label) => strict
    ? { min: max * 0.80, max: max,        ref: max, strict: true,  label: label + ' (plafond strict)' }
    : { min: max * 0.80, max: max * 1.20, ref: max, strict: false, label: label };

  const range = txt.match(/entre\s*(\d+)\s*(?:et|à|-)\s*(\d+)/);
  if (range) {
    const lo = parseInt(range[1]), hi = parseInt(range[2]);
    return mk(hi, lo + '-' + hi + '€');
  }

  // Plancher ouvert, sans plafond annoncé par le client : "25€ et plus",
  // "à partir de 25€", "au moins 25€", "minimum 25€". On calcule un plafond
  // raisonnable (montée en gamme progressive) plutôt que de laisser Gabriel
  // sans aucune limite haute.
  const floorOpen = txt.match(/(\d+)\s*(?:€|euros?)?\s*(?:et\s+plus|ou\s+plus|voire\s+plus)/)
                  || txt.match(/(?:à\s+partir\s+de|au\s+moins|minimum|min\.?)\s*(?:de)?\s*(\d+)/);
  if (floorOpen) {
    const p = parseInt(floorOpen[1]);
    return { min: p, max: p * 3, ref: Math.round(p * 1.6), strict: false, label: 'à partir de ' + p + '€', openFloor: true };
  }

  const around = txt.match(/(?:autour|environ)\s*(?:de)?\s*(\d+)/);
  if (around) {
    const p = parseInt(around[1]);
    return mk(p, 'autour de ' + p + '€');
  }
  const capped = txt.match(/(?:moins\s+de|pas\s+plus\s+de|ne\s+pas\s+d[ée]passer|sans\s+d[ée]passer|max(?:imum)?\s*(?:de)?)\s*(\d+)/)
              || txt.match(/(\d+)\s*(?:€|euros?)?\s*(?:grand\s+max(?:imum)?|max\b|maxi\b|maximum|tout\s+au\s+plus)/);
  if (capped) {
    const p = parseInt(capped[1]);
    return { min: p * 0.80, max: p, ref: p, strict: true, label: 'max ' + p + '€ (plafond strict)' };
  }
  const exact = txt.match(/(\d+)\s*(?:€|euros?)/);
  if (exact) {
    const p = parseInt(exact[1]);
    return mk(p, p + '€');
  }
  return null;
}

// ── Règles de style par accord ──────────────────────────────────────────────
// Utilisées à la fois par /sommelier (chat libre) et /selection-accord
// (questionnaire guidé) pour que les deux entrées appliquent le même
// raisonnement mets-vins.
const PAIRING_RULES = {
  'poisson':       'UNIQUEMENT blancs secs ou rosés très légers. AUCUN rouge.',
  'fruits de mer': 'UNIQUEMENT blancs vifs, rosés très secs, ou bulles. AUCUN rouge.',
  'volaille':      'Blancs ronds ou rouges très légers (Gamay, Pinot Noir léger).',
  'viande':        'UNIQUEMENT rouges structurés. Pas de blanc.',
  'barbecue':      'Rouges fruités ou rosés charnus. Pas de blanc.',
  'fromage':       'Blanc ou rouge léger selon le fromage.',
  'dessert':       'Vins doux (Banyuls, Sauternes, Muscat) ou bulles demi-sec.',
  'apéritif':      'Bulles, blancs vifs, rosés légers — ou Champagne/Crémant pour une réception.',
  'méditerranéen': 'Rouges légers, rosés ou blancs du sud.',
  'asiatique':     'Blancs aromatiques (Gewurztraminer, Viognier, Riesling).',
  'charcuterie':   'Rouges fruités ou rosés généreux.',
};

// ── Détection de l'accord ─────────────────────────────────────────────────────
function detectPairing(messages) {
  const txt = messages.filter(m => m.role === 'user').map(m => m.content).join(' ').toLowerCase();

  const map = [
    { p: 'poisson',        r: /poisson|saumon|cabillaud|sole|truite|bar |daurade|thon|rouget|sardine|maquereau|anchois|merlu|lieu|brandade|skrei|morue/ },
    { p: 'fruits de mer',  r: /fruits de mer|huître|crevette|homard|langouste|moule|crustacé|coquille|langoustine|poulpe|calmar|seiche|tourteau|bouillabaisse|bourride|plateau de mer|soupe de poisson|bisque|bulot|palourde/ },
    { p: 'volaille',       r: /poulet|volaille|canard|pintade|dinde|chapon|caille|faisan|pigeon|magret|confit|blanquette de volaille|fricassée|suprême/ },
    { p: 'viande',         r: /viande|bœuf|agneau|veau|entrecôte|côte de bœuf|steak|gigot|bifteck|filet mignon|rôti|côtelette|carré|daube|bourguignon|osso.?bucco|navarin|tajine|cassoulet|ragoût|gibier|sanglier|cerf|chevreuil|lièvre/ },
    { p: 'fromage',        r: /fromage|comté|brie|camembert|roquefort|chèvre|raclette|fondue|munster|époisses|reblochon|beaufort|emmental|gruyère|parmesan|plateau de fromage/ },
    { p: 'charcuterie',    r: /charcuterie|jambon|saucisson|pâté|terrine|rillette|coppa|chorizo|salami|mortadelle|andouille|boudin/ },
    { p: 'dessert',        r: /dessert|gâteau|tarte|chocolat|moelleux|tiramisu|fondant|crème brûlée|panna cotta|mousse|sorbet|glace|macaron|sucré/ },
    { p: 'apéritif',       r: /apéro|apéritif|mise en bouche|tapas|verrines|amuse.?bouche|avant le repas|canapé|grignotage|anniversaire|fête|mariage|célébration|réveillon|noël|nouvel an|baptême|communion|cadeau|événement/ },
    { p: 'barbecue',       r: /barbecue|barbec|bbq|grill|plancha|brochette|merguez|saucisse grillée|grillades|ribs|burgers?/ },
    { p: 'méditerranéen',  r: /méditerranéen|pizza|pasta|pâtes|risotto|ratatouille|niçoise|provençal|couscous|paella|moussaka|lasagnes?|tapenade/ },
    { p: 'asiatique',      r: /asiatique|sushi|japonais|thaï|curry|wok|chinois|coréen|vietnamien|indien|pad thaï|ramen|pho|gyoza|bibimbap/ },
  ];

  for (const { p, r } of map) {
    if (r.test(txt)) {
      console.log('🍽  Accord détecté:', p);
      return p;
    }
  }
  return null;
}

// ── Route sommelier ───────────────────────────────────────────────────────────
app.post('/sommelier', rateLimit(30), async (req, res) => {
  const { messages, system, featuredIds } = req.body;
  const featuredSet = new Set(Array.isArray(featuredIds) ? featuredIds : []);
  const featuredBonus = w => featuredSet.has(w.id) ? 3 : 0; // même logique de départage que /selection-accord

  const budget  = detectBudget(messages);
  const pairing = detectPairing(messages);

  if (budget)  console.log('💰 Budget:', budget.label, '→', Math.round(budget.min) + '€ –', Math.round(budget.max) + '€');
  if (pairing) console.log('🍽  Accord:', pairing);

  // Injecter les contraintes + liste des vins disponibles directement dans le prompt
  let finalSystem = system;
  let tierWines = null, available = [];

  if ((budget || pairing) && WINES_CATALOG.length) {
    const pairingOk = w => !pairing || (w.pairings && w.pairings.includes(pairing));

    // ── Escalier de prix sur 3 paliers, basé sur le MAXIMUM annoncé ──
    //   🥇 ≈ 80% du max  ·  ⭐ ≈ 100% du max  ·  ✨ ≈ 120% du max (montée en gamme)
    //   Si plafond strict : 80% / 90% / 100% — on ne dépasse jamais.
    let tiers = null;
    if (budget) {
      const ref = budget.ref || budget.max;
      const ratios = budget.strict ? [0.80, 0.90, 1.00] : [0.80, 1.00, 1.20];
      tiers = ratios.map(r => ref * r);
      const ceiling = budget.max; // déjà égal à ref (strict) ou ref*1.20

      // Constitution du vivier, avec replis progressifs si le rayon est pauvre
      // sur ce budget+accord : 1) bande normale  2) plancher abaissé  3) sans accord
      const inBand = (w, lo) => w.price >= lo && w.price <= ceiling * (budget.strict ? 1.0 : 1.05);
      let pool = WINES_CATALOG.filter(w => pairingOk(w) && inBand(w, budget.min * 0.95));
      if (pool.length < 6) pool = WINES_CATALOG.filter(w => pairingOk(w) && inBand(w, ref * 0.55));
      if (pool.length < 3) pool = WINES_CATALOG.filter(w => inBand(w, budget.min * 0.95));
      if (pool.length < 3) pool = WINES_CATALOG.filter(w => inBand(w, ref * 0.55));

      // Découpage en 3 bandes de prix autour des paliers (pas d'épuisement entre paliers)
      const cut1 = (tiers[0] + tiers[1]) / 2;
      const cut2 = (tiers[1] + tiers[2]) / 2;
      const bands = [
        pool.filter(w => w.price <  cut1),
        pool.filter(w => w.price >= cut1 && w.price < cut2),
        pool.filter(w => w.price >= cut2),
      ];
      tierWines = tiers.map((target, i) => {
        let cands = bands[i];
        if (!cands.length) cands = pool; // bande vide → on propose les plus proches du palier
        return [...cands].sort((a, b) => {
          const da = Math.abs(a.price - target), db = Math.abs(b.price - target);
          if (Math.abs(da - db) > 2) return da - db;
          return (b.rating + featuredBonus(b)) - (a.rating + featuredBonus(a));
        }).slice(0, 5);
      });
      available = tierWines.flat();
    } else {
      available = WINES_CATALOG
        .filter(w => pairingOk(w))
        .sort((a, b) => (b.rating + featuredBonus(b)) - (a.rating + featuredBonus(a)))
        .slice(0, 15);
    }

    let inject = '\n\n>>> CONTRAINTES OBLIGATOIRES <<<';

    if (budget) {
      inject += '\nBUDGET MAXIMUM DE RÉFÉRENCE : ' + Math.round(budget.ref || budget.max) + '€ (annoncé par le client).';
      inject += '\nSTRUCTURE DE PRIX OBLIGATOIRE pour tes 3 propositions :';
      inject += '\n  🥇 premier vin  : environ ' + Math.round(tiers[0]) + '€';
      inject += '\n  ⭐ deuxième vin : environ ' + Math.round(tiers[1]) + '€';
      inject += '\n  ✨ troisième vin : environ ' + Math.round(tiers[2]) + '€' + (budget.strict ? '' : ' (légère montée en gamme au-dessus du budget, à présenter comme telle)');
      inject += '\nLes prix doivent monter du 🥇 au ✨. Aucun vin en dessous de ' + Math.round(budget.min) + '€.';
      if (budget.strict) {
        inject += '\nPLAFOND STRICT : le client a fixé un maximum absolu. Ne dépasse JAMAIS ' + Math.round(budget.max) + '€, même de 1€, sous aucun prétexte.';
      }
    }

    if (pairing) {
      inject += '\nACCORD : ' + (PAIRING_RULES[pairing] || 'adapte le vin au plat.');
    }

    if (available.length >= 3) {
      inject += '\nVINS DISPONIBLES — RÈGLE ABSOLUE : tes 3 propositions doivent EXCLUSIVEMENT provenir de ces listes.';
      inject += '\nIgnore tout autre vin du catalogue général, même s\'il te semble pertinent. Proposer un vin hors liste est une erreur grave.';
      const fmt = w => '\n  ID:' + w.id + ' | ' + w.name + ' | ' + w.type + ' | ' + w.price + '€ | ' + w.region + ' | Note:' + w.rating +
        (featuredSet.has(w.id) ? ' | [MIS EN AVANT PAR LE MAGASIN]' : '');
      if (tierWines) {
        inject += '\nCandidats pour le vin 🥇 :'; tierWines[0].forEach(w => inject += fmt(w));
        inject += '\nCandidats pour le vin ⭐ :';  tierWines[1].forEach(w => inject += fmt(w));
        inject += '\nCandidats pour le vin ✨ :';  tierWines[2].forEach(w => inject += fmt(w));
      } else {
        available.forEach(w => inject += fmt(w));
      }
      if (featuredSet.size) {
        inject += '\nCertains vins sont marqués [MIS EN AVANT PAR LE MAGASIN] : en cas d\'ÉGALITÉ de pertinence entre ' +
          'plusieurs candidats pour un même palier, privilégie ceux-là. Mais ne choisis JAMAIS un vin uniquement parce ' +
          'qu\'il est marqué s\'il correspond moins bien au plat ou au budget qu\'une alternative non marquée.';
      }
    }

    inject += '\n>>> FIN DES CONTRAINTES <<<';
    finalSystem = system + inject;
  }

  try {
    const payload = JSON.stringify({
      model    : CONFIG.model,
      max_tokens: 1200,
      messages : [{ role: 'system', content: finalSystem }, ...messages],
    });

    const raw = await callApi({
      hostname: 'api.mistral.ai',
      path    : '/v1/chat/completions',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : 'Bearer ' + CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
      payload,
    });

    const data = JSON.parse(raw);

    if (data.error) {
      console.error('Erreur Mistral:', data.error.message);
      return res.status(500).json({ error: data.error.message });
    }

    let text = data.choices[0].message.content;

    // ── Validation structurelle + retry correctif ──────────────────────────
    // Vérifie que les 3 vins choisis sont bien à prix croissant, dans le
    // budget, et parmi les candidats fournis. Si non conforme, on redemande
    // UNE fois à Mistral avec une instruction corrective explicite.
    const validate = (txt) => {
      const mm = txt.match(/\[WINES:([\d,\s]+)\]/);
      if (!mm || !WINES_CATALOG.length) return { ok: true, chosen: null };
      const chosen = mm[1].split(',')
        .map(id => WINES_CATALOG.find(w => w.id === parseInt(id.trim())))
        .filter(Boolean);
      if (chosen.length !== 3) return { ok: false, chosen, reason: 'nombre de vins ≠ 3' };

      const prices = chosen.map(w => w.price);
      const ascending = prices[1] >= prices[0] - 1 && prices[2] >= prices[1] - 1;
      if (!ascending) return { ok: false, chosen, reason: 'ordre de prix non croissant' };

      if (budget) {
        const hardMax = budget.max + (budget.strict ? 1 : 3);
        const outOfRange = chosen.some(w => w.price < budget.min - 3 || w.price > hardMax);
        if (outOfRange) return { ok: false, chosen, reason: 'vin hors budget' };
      }

      if (available.length) {
        const allowedIds = new Set(available.map(w => w.id));
        const outsideCandidates = chosen.some(w => !allowedIds.has(w.id));
        if (outsideCandidates) return { ok: false, chosen, reason: 'vin hors liste de candidats' };
      }

      return { ok: true, chosen };
    };

    let check = validate(text);

    if (!check.ok) {
      console.warn('⚠️  Réponse Gabriel non conforme (' + check.reason + ') → retry correctif');

      let correction = '\n\n>>> CORRECTION OBLIGATOIRE <<<';
      correction += '\nTa réponse précédente était invalide (' + check.reason + ').';
      if (tierWines) {
        correction += '\nChoisis EXACTEMENT un ID dans chaque liste 🥇/⭐/✨ ci-dessus, dans cet ordre, prix strictement croissants.';
      } else if (available.length) {
        correction += '\nChoisis UNIQUEMENT parmi les IDs de la liste "VINS DISPONIBLES" ci-dessus, à prix croissants.';
      }
      correction += '\nRéponds à nouveau en respectant scrupuleusement cette contrainte.';

      try {
        const retryPayload = JSON.stringify({
          model     : CONFIG.model,
          max_tokens: 1200,
          messages  : [{ role: 'system', content: finalSystem + correction }, ...messages],
        });
        const raw2  = await callApi({
          hostname: 'api.mistral.ai',
          path    : '/v1/chat/completions',
          headers : {
            'Content-Type'  : 'application/json',
            'Authorization' : 'Bearer ' + CONFIG.apiKey,
            'Content-Length': Buffer.byteLength(retryPayload),
          },
          payload: retryPayload,
        });
        const data2 = JSON.parse(raw2);
        if (!data2.error) {
          const text2  = data2.choices[0].message.content;
          const check2 = validate(text2);
          // On garde la version corrigée même si elle n'est pas parfaite :
          // un retry conforme aux consignes vaut mieux qu'un premier jet fautif.
          text  = text2;
          check = check2;
          console.log(check.ok ? '✅ Correction réussie' : '⚠️  Correction toujours non conforme, on renvoie quand même');
        }
      } catch (e) {
        console.error('Erreur retry correctif:', e.message);
        // on garde la réponse d'origine si le retry échoue techniquement
      }
    }

    if (check.chosen) {
      console.log('✅ Gabriel propose:', check.chosen.map(w => w.name + ' (' + w.price + '€)').join(', '));
    }

    return res.json({ text });

  } catch (e) {
    console.error('Erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Route questionnaire guidé (3 questions) ───────────────────────────────────
// Applique le même raisonnement que Gabriel (chat libre) : le type/budget/
// accord choisis par le client servent de FILTRE DE SÉCURITÉ (jamais de
// contresens comme un rouge tannique avec un poisson cru), puis Gabriel
// choisit 3 vins DANS ce sous-ensemble en se basant sur les vraies données
// du vin (cépage, région, notes de dégustation) plutôt que sur un simple
// tri par prix — exactement le même travail que dans le chat.
const BUDGET_BRACKETS = {
  '-8':    { min: 0,  max: 8   },
  '8-15':  { min: 8,  max: 15  },
  '15-25': { min: 15, max: 25  },
  '25+':   { min: 25, max: Infinity },
};

app.post('/selection-accord', rateLimit(30), async (req, res) => {
  const { type, budget, pairing, detail, featuredIds } = req.body;
  const featuredSet = new Set(Array.isArray(featuredIds) ? featuredIds : []);

  if (!WINES_CATALOG.length) {
    return res.status(500).json({ error: 'catalogue non chargé' });
  }
  const bracket = BUDGET_BRACKETS[budget];
  if (!bracket) {
    return res.status(400).json({ error: 'budget invalide' });
  }

  // ── Constitution du vivier, avec replis progressifs (même logique que
  //    le repli côté client) : 1) type+budget+accord  2) type+budget
  //    3) type seul — pour ne jamais renvoyer un panier vide.
  const matchBudget = w => w.price >= bracket.min && (bracket.max === Infinity || w.price <= bracket.max);
  const matchType    = w => !type || w.type === type;
  const matchPairing = w => !pairing || (w.pairings || []).includes(pairing);

  let pool = WINES_CATALOG.filter(w => matchType(w) && matchBudget(w) && matchPairing(w));
  let poolLabel = 'type + budget + accord';
  if (pool.length < 3) { pool = WINES_CATALOG.filter(w => matchType(w) && matchBudget(w)); poolLabel = 'type + budget'; }
  if (pool.length < 3) { pool = WINES_CATALOG.filter(w => matchType(w)); poolLabel = 'type seul'; }
  if (!pool.length) pool = WINES_CATALOG;

  // Pour la tranche "25€ et plus" (sans plafond), on limite le vivier envoyé
  // à Gabriel à des prix raisonnables (jusqu'à 110€) pour ne pas partir sur
  // des cuvées d'exception dès le premier questionnaire.
  const closedBracket = bracket.max !== Infinity;
  const basePool = closedBracket ? pool : pool.filter(w => w.price <= 110);

  // ── Biais "tranche haute" ────────────────────────────────────────────────
  // Le client choisit une tranche fermée (ex. 15-25€) mais s'attend à des
  // propositions qui tirent vers le HAUT de cette tranche plutôt que
  // réparties uniformément — même logique que /sommelier (chat libre) où
  // le budget de référence est le max annoncé. On pondère donc la note par
  // la proximité au point de référence (75% de la tranche), sans jamais
  // exclure les vins moins chers : un vin nettement mieux noté ou plus
  // singulier reste éligible même s'il est proche du bas de la tranche.
  const ref = closedBracket ? bracket.min + (bracket.max - bracket.min) * 0.75 : null;
  const span = closedBracket ? Math.max(1, bracket.max - bracket.min) : 1;
  // Bonus "sélection magasin" : même ordre de grandeur que le biais tranche
  // haute (max 15) — ça augmente les chances qu'un vin mis en avant fasse
  // partie du vivier envoyé à Gabriel, mais ne dicte jamais SON choix parmi
  // ce vivier : le raisonnement accord/structure reste géré exclusivement
  // par le prompt ci-dessous, jamais par ce score.
  const FEATURED_BONUS = 8;
  const scored = basePool.map(w => {
    const proximityBonus = ref !== null ? Math.max(0, 1 - Math.abs(w.price - ref) / span) * 15 : 0;
    const featuredBonus = featuredSet.has(w.id) ? FEATURED_BONUS : 0;
    return { w, score: w.rating + proximityBonus + featuredBonus };
  });

  const candidates = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(s => s.w);

  // ── Repli sans IA : on choisit 3 vins à prix croissants dans le vivier,
  //    puis on leur assigne un rôle par heuristique simple (le mieux noté
  //    des trois = valeur sûre, le plus atypique en prix = découverte).
  const fallbackWines = candidates.slice().sort((a, b) => a.price - b.price).slice(0, 3);
  const fallbackIds = fallbackWines.map(w => w.id);
  const fallbackRoles = (() => {
    if (fallbackWines.length < 3) return {};
    const byRating = [...fallbackWines].sort((a, b) => b.rating - a.rating);
    const roles = { [byRating[0].id]: 'valeur_sure' };
    const rest = fallbackWines.filter(w => w.id !== byRating[0].id);
    roles[rest[0].id] = 'coup_de_coeur';
    roles[rest[1].id] = 'decouverte';
    return roles;
  })();

  if (!candidates.length) {
    return res.json({ ids: fallbackIds, roles: fallbackRoles, reasons: {} });
  }

  const fmt = w => '\n  ID:' + w.id + ' | ' + w.name + ' | ' + w.price + '€ | ' + w.region +
    ' | cépage: ' + w.grape + ' | note:' + w.rating + ' | dégustation: ' + w.tastingNotes +
    (featuredSet.has(w.id) ? ' | [MIS EN AVANT PAR LE MAGASIN]' : '');

  const system = 'Tu es Gabriel, sommelier expert. Un client a choisi, via un questionnaire guidé : ' +
    'type de vin = ' + type + ', budget = ' + budget + '€, accord recherché = ' + (pairing || 'aucun en particulier') +
    (detail ? ', précision sur le plat = ' + detail : '') + '.\n' +
    (pairing ? 'RÈGLE D\'ACCORD : ' + (PAIRING_RULES[pairing] || 'adapte le vin au plat.') + '\n' : '') +
    (detail ? 'IMPORTANT : utilise la précision "' + detail + '" pour affiner ton choix (poids du plat, cuisson, intensité) — ne te contente pas de la catégorie générale.\n' : '') +
    'Voici les vins disponibles (filtre : ' + poolLabel + ') :' +
    candidates.map(fmt).join('') +
    '\n\nChoisis EXACTEMENT 3 vins parmi ces IDs, en te comportant comme un vrai sommelier : ' +
    'raisonne sur le poids et la structure du vin par rapport au plat, l\'acidité, les tanins face au gras, ' +
    'l\'intensité aromatique — pas seulement sur le prix. Les 3 vins doivent couvrir des profils ou prix différents ' +
    'pour offrir un vrai choix, avec des prix croissants du premier au troisième.\n' +
    (featuredSet.size ? 'Certains vins sont marqués [MIS EN AVANT PAR LE MAGASIN] : en cas d\'ÉGALITÉ de pertinence entre ' +
      'plusieurs vins pour un même rôle, privilégie ceux-là. Mais ne choisis JAMAIS un vin uniquement parce qu\'il est ' +
      'marqué s\'il correspond moins bien au plat, au budget ou au profil recherché qu\'une alternative non marquée — ' +
      'l\'accord et la qualité de la recommandation priment toujours sur ce marquage.\n' : '') +
    '\n' +
    'En plus du choix, attribue à CHAQUE vin un rôle parmi ces 3 (chacun utilisé UNE SEULE fois) :\n' +
    '  - "valeur_sure" : vin fiable, typique de son appellation/cépage, bon rapport note/prix — le choix sans surprise.\n' +
    '  - "coup_de_coeur" : le vin qui fait le meilleur accord avec le plat, ou le plus séduisant en intensité/équilibre.\n' +
    '  - "decouverte" : vin plus atypique — cépage rare, région moins connue, style original — indépendamment de son prix ' +
    '(une découverte n\'est PAS forcément la plus chère des trois).\n' +
    'Le rôle ne doit PAS être déduit du rang de prix : base-toi sur les caractéristiques réelles du vin (cépage, région, notes de dégustation).\n' +
    'Réponds UNIQUEMENT en JSON, sans aucun texte avant ou après, sous cette forme exacte :\n' +
    '{"ids":[id1,id2,id3],' +
    '"roles":{"id1":"valeur_sure|coup_de_coeur|decouverte","id2":"...","id3":"..."},' +
    '"reasons":{"id1":"raison courte en français, 12 mots max","id2":"...","id3":"..."}}';

  const askOnce = async (extra) => {
    const payload = JSON.stringify({
      model: CONFIG.model,
      max_tokens: 500,
      temperature: 0.4,
      messages: [{ role: 'system', content: system + (extra || '') }, { role: 'user', content: 'Choisis mes 3 vins.' }],
    });
    const raw = await callApi({
      hostname: 'api.mistral.ai',
      path: '/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
      payload,
    });
    const data = JSON.parse(raw);
    if (data.error) throw new Error(data.error.message || 'erreur API Mistral');
    const text = data.choices[0].message.content.trim();
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : text);
  };

  const candidateIds = new Set(candidates.map(w => w.id));
  const VALID_ROLES = new Set(['valeur_sure', 'coup_de_coeur', 'decouverte']);
  const validate = (parsed) => {
    if (!parsed || !Array.isArray(parsed.ids) || parsed.ids.length !== 3) return false;
    if (!parsed.ids.every(id => candidateIds.has(id))) return false;
    if (!parsed.roles || typeof parsed.roles !== 'object') return false;
    const assignedRoles = parsed.ids.map(id => parsed.roles[id]);
    if (!assignedRoles.every(r => VALID_ROLES.has(r))) return false;
    if (new Set(assignedRoles).size !== 3) return false; // les 3 rôles doivent être distincts
    return true;
  };

  try {
    let parsed = await askOnce();
    if (!validate(parsed)) {
      console.warn('⚠️  /selection-accord réponse non conforme → retry correctif');
      parsed = await askOnce(
        '\n\n>>> CORRECTION : choisis STRICTEMENT 3 IDs parmi la liste fournie ci-dessus, prix croissants, ' +
        'et assigne les 3 rôles "valeur_sure"/"coup_de_coeur"/"decouverte" chacun une seule fois, dans le champ "roles". <<<'
      );
    }
    if (!validate(parsed)) {
      console.warn('⚠️  /selection-accord toujours non conforme → repli sur sélection automatique');
      return res.json({ ids: fallbackIds, roles: fallbackRoles, reasons: {} });
    }
    console.log('✅ /selection-accord →', parsed.ids.map(id => id + ':' + parsed.roles[id]).join(', '));
    return res.json({ ids: parsed.ids, roles: parsed.roles, reasons: parsed.reasons || {} });
  } catch (e) {
    console.error('Erreur /selection-accord:', e.message, '→ repli sur sélection automatique');
    return res.json({ ids: fallbackIds, roles: fallbackRoles, reasons: {} });
  }
});

// ── Helper HTTPS ──────────────────────────────────────────────────────────────
function callApi({ hostname, path, headers, payload }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, apiRes => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
const startedAt = Date.now();
const server = app.listen(PORT, () => {
  loadCatalog();
  console.log('\n🍷  Wine Select — Serveur Gabriel');
  console.log('──────────────────────────────────');
  console.log('   http://localhost:' + PORT);
  console.log('   Modèle   : ' + CONFIG.model);
  console.log('   Clé API  : ' + CONFIG.apiKey.substring(0, 8) + '...  ✅');
  console.log('   PID      : ' + process.pid);
  console.log('   Démarré  : ' + new Date().toLocaleString('fr-FR'));
  console.log('──────────────────────────────────\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n❌ Le port ' + PORT + ' est déjà utilisé par un autre process.');
    console.error('   Un ancien serveur Wine Select (ou autre) tourne encore.');
    console.error('   → Ferme toutes les fenêtres "Wine Select Serveur" ouvertes,');
    console.error('     ou dans une invite de commandes : netstat -aon | findstr ":' + PORT + '"');
    console.error('     puis : taskkill /PID <numero> /F');
    console.error('   Ce serveur ne démarre PAS tant que le port est occupé.\n');
    process.exit(1);
  }
  throw err;
});

// Endpoint de vérification rapide : utile pour confirmer, après une mise à jour,
// que c'est bien LE NOUVEAU serveur qui répond (et pas un ancien process resté
// actif sur le port 3000). Ouvrir http://localhost:3000/version dans un navigateur.
app.get('/version', (req, res) => {
  res.json({
    pid: process.pid,
    demarre: new Date(startedAt).toLocaleString('fr-FR'),
    vinsEnCatalogue: WINES_CATALOG.length,
    modele: CONFIG.model,
  });
});
