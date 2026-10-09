const express = require('express');
const path    = require('path');
const fs      = require('fs');

const crypto  = require('crypto');

const app  = express();
const PORT = parseInt(process.env.PORT_BORNE || '3000', 10);
app.use(express.json({ limit: '10mb' }));

// ── Mode de la borne ────────────────────────────────────────────────────────
// • Autonome (par défaut, démo) : catalogue wines-data.js, données dans data/,
//   clé Mistral sur la borne (api-key.txt). Fonctionnement d'avant 2026-10.
// • Connecté : si borne-config.json (adresse du serveur central) ET
//   borne-jeton.txt (jeton de cette borne, créé dans l'espace super admin)
//   sont présents. Le catalogue, la stratégie et le sommelier viennent alors du
//   serveur central ; la borne en garde une copie (cache-central/) et continue
//   de proposer 3 vins sans Internet. Plus aucune clé Mistral sur la borne.
//   (Variables WINESELECT_SERVEUR et WINESELECT_JETON : même effet, pour les tests.)
const VERSION_BORNE = '2026.10';
// Dossier de borne-config.json et borne-jeton.txt (celui de la borne ; autre dossier pour les tests).
const DOSSIER_BORNE = path.resolve(process.env.WINESELECT_DOSSIER_BORNE || __dirname);
const FICHIER_CONFIG_BORNE = path.join(DOSSIER_BORNE, 'borne-config.json');
const FICHIER_JETON_BORNE = path.join(DOSSIER_BORNE, 'borne-jeton.txt');
function lireConnexion() {
  let serveur = process.env.WINESELECT_SERVEUR || '';
  let jeton = process.env.WINESELECT_JETON || '';
  try {
    if (!serveur) serveur = JSON.parse(fs.readFileSync(FICHIER_CONFIG_BORNE, 'utf-8')).serveur || '';
  } catch (e) { /* pas de fichier : mode autonome */ }
  try {
    if (!jeton) jeton = fs.readFileSync(FICHIER_JETON_BORNE, 'utf-8').trim();
  } catch (e) { /* pas de jeton : mode autonome */ }
  if (!serveur || !jeton) return null;
  if (typeof fetch !== 'function') {
    console.error('❌ Mode connecté impossible : Node.js est trop ancien (version 18 ou plus récente requise). La borne reste en mode autonome.');
    return null;
  }
  return { serveur: String(serveur).trim().replace(/\/+$/, ''), jeton };
}
// Modifiable sans redémarrer : l'écran de dépannage installe la borne (adresse + jeton).
let CONNEXION = lireConnexion();

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

// En mode connecté, la clé Mistral est sur le serveur central : aucune ici.
// Sans clé ni jeton (borne neuve, pas encore installée), la borne démarre quand
// même : elle conseille sans IA et son écran de dépannage permet de l'installer.
if (!CONFIG.apiKey && !CONNEXION) {
  console.warn('\n⚠️  Ni clé Mistral ni jeton de borne : la borne conseille sans IA.');
  console.warn('   Pour l\'installer : appui long sur le logo de l\'écran, puis le code (PIN de la borne).\n');
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

// Le dossier de la borne est servi tel quel (WineSelect.html, wines-data.js...), mais
// jamais ses secrets ni ses données : la clé API, le PIN admin, data/ (profils
// clients, prix d'achat...), les sauvegardes et les outils. Sans ce filtre, n'importe
// quel appareil du réseau du magasin pouvait lire http://<borne>:3000/api-key.txt.
// Mode connecté (2026-10) : aussi le jeton de la borne, sa copie du catalogue
// central, et le serveur central lui-même (sa configuration .env contient la clé
// Mistral) quand les deux tournent sur le même PC.
const CHEMINS_INTERDITS = /^\/(data|node_modules|tests|site-vitrine|central|central-data|central-emails|cache-central)(\/|$)|^\/(api-key|admin-pin|borne-jeton)\.txt$|^\/borne-config[\w.-]*\.json$|\.(bak|tmp|log|bat|md|env)$|\.bak-|(^|\/)\./i;
app.use((req, res, next) => {
  let chemin = '/';
  try { chemin = decodeURIComponent(req.path); } catch (e) { return res.status(400).end(); }
  if (CHEMINS_INTERDITS.test(chemin.replace(/\\/g, '/'))) return res.status(404).end();
  next();
});
// Mode connecté : le catalogue servi à l'écran est celui du serveur central
// (copie en mémoire), à la place du fichier wines-data.js de la borne.
// (Routes toujours déclarées, actives seulement en mode connecté : la borne
// peut être installée depuis l'écran de dépannage sans redémarrer.)
{
  app.get('/wines-data.js', (req, res, next) => {
    if (!CONNEXION) return next();
    res.type('application/javascript');
    res.set('Cache-Control', 'no-store');
    res.send('// Catalogue du magasin, reçu du serveur central (version ' + ETAT_CENTRAL.versionCatalogue + ')\n' +
      'window.WS_MODE_CONNECTE = true;\n' +
      'window.WS_VERSION_CATALOGUE = ' + JSON.stringify(ETAT_CENTRAL.versionCatalogue) + ';\n' +
      'window.WINES_DATA = ' + JSON.stringify(BASE_CATALOG) + ';\n');
  });
  // L'administration se fait désormais dans l'espace de gestion en ligne :
  // la borne ne garde plus de stocks, prix d'achat ni stratégie à elle.
  const LECTURE_VIDE = { '/api/stock-overrides': [], '/api/config-reco': { strategie: 'neutre' }, '/api/prix-achat': {} };
  app.use(Object.keys(LECTURE_VIDE), (req, res, next) => {
    if (!CONNEXION) return next();
    if (req.method === 'GET') return res.json(LECTURE_VIDE[req.baseUrl]);
    res.status(409).json({ ok: false, error: 'Cette borne est gérée depuis l\'espace de gestion en ligne.' });
  });
}
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));
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
// les overrides sur le catalogue servi au sommelier (voir applyStockOverrides).
makePersistedRoute('stock-overrides', {
  protect: true,
  defaultValue: [],
  onWrite: () => applyStockOverrides(),
});
// config-reco : stratégie de recommandation choisie par le gérant (Admin > Config).
// Lecture libre (rien de sensible), écriture réservée à l'admin.
makePersistedRoute('config-reco', { protect: true, defaultValue: { strategie: 'neutre' } });

// prix-achat : { id: prix d'achat HT ou TTC, au choix du magasin, tant que c'est
// cohérent }. Donnée confidentielle : lecture ET écriture réservées à l'admin
// (contrairement à makePersistedRoute, dont la lecture est libre), jamais copiée
// dans le navigateur, jamais envoyée à Mistral. Sert au tri « marge » et à
// l'affichage de la marge dans Admin > Catalogue.
// POST = fusion : { id: prix } ajoute ou remplace, { id: null } efface.
app.get('/api/prix-achat', requireAdminToken, (req, res) => res.json(readJSON('prix-achat', {}) || {}));
app.post('/api/prix-achat', requireAdminToken, (req, res) => {
  try {
    const actuel = readJSON('prix-achat', {}) || {};
    const maj = (req.body && typeof req.body === 'object') ? req.body : {};
    Object.keys(maj).forEach(id => {
      const v = maj[id];
      if (v === null) delete actuel[id];
      else if (typeof v === 'number' && v > 0 && v < 100000) actuel[id] = Math.round(v * 100) / 100;
    });
    writeJSONAtomic('prix-achat', actuel);
    res.json({ ok: true, total: Object.keys(actuel).length });
  } catch (e) {
    console.error('❌ Écriture data/prix-achat.json impossible :', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Objectif commercial du magasin, lu à chaque demande (fichiers minuscules) :
// { strategie, prixAchat }. Sert UNIQUEMENT au départage côté serveur (voir
// bonusStrategie dans accords.js) : jamais envoyé à Mistral ni à l'écran client.
function lireCommercial() {
  const conf = readJSON('config-reco', { strategie: 'neutre' }) || {};
  const strategie = ['neutre', 'panier', 'marge', 'stock'].includes(conf.strategie) ? conf.strategie : 'neutre';
  const prixAchat = strategie === 'marge' ? (readJSON('prix-achat', {}) || {}) : {};
  return { strategie, prixAchat };
}

// ── Chargement du catalogue ───────────────────────────────────────────────────
// BASE_CATALOG = données brutes de wines-data.js, jamais modifiées en mémoire.
// WINES_CATALOG = BASE_CATALOG + overrides stock/prix/mise en avant importés
// depuis Admin > Config (data/stock-overrides.json). C'est TOUJOURS
// WINES_CATALOG qu'utilisent /sommelier et /selection-accord, pour que
// le sommelier raisonne sur les mêmes prix/stock que ceux affichés sur les
// cartes côté client après un import CSV — avant ce correctif, un import
// mettait à jour l'affichage mais le sommelier continuait de filtrer avec les
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
  // Mode connecté : on part de la dernière copie du catalogue central ; à défaut
  // (première mise en route sans Internet), du wines-data.js présent.
  if (CONNEXION && chargerCacheCentral()) return;
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
// chaque import CSV / mise en avant depuis Admin > Config, pour que le sommelier
// voie immédiatement les nouveaux prix/stocks sans redémarrer le serveur.
// ── Identité des vins (libellé) ─────────────────────────────────────────────
// La règle est dans sommelier.js (libelleVin), partagée avec le serveur central.
const CHAMPS_FICHE = ['domaine', 'cuvee', 'millesime', 'photo', 'emplacement'];
const libelleVin = w => SOMMELIER.libelleVin(w);
// Après l'application des stocks/prix : recopie les champs de fiche importés
// par l'admin et calcule le libellé de chaque vin du catalogue serveur.
function enrichirFiches() {
  const overrides = readJSON('stock-overrides', []);
  const byId = new Map((Array.isArray(overrides) ? overrides : []).map(o => [o.id, o]));
  WINES_CATALOG = WINES_CATALOG.map(w => {
    const o = byId.get(w.id);
    const x = Object.assign({}, w);
    if (o) CHAMPS_FICHE.forEach(k => { if (o[k] != null && String(o[k]).trim()) x[k] = String(o[k]).trim(); });
    x.libelle = libelleVin(x);
    return x;
  });
}
function applyStockOverrides() {
  applyStockOverridesBase();
  try { enrichirFiches(); } catch (e) { console.warn('⚠️  Libellés des vins non calculés :', e.message); }
}
function applyStockOverridesBase() {
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

// ═══════════════════════════════════════════════════════════════════════════
//  MODE CONNECTÉ : catalogue et sommelier du serveur central
//  • Au démarrage puis toutes les 5 minutes : la borne demande la version du
//    catalogue de son magasin, le télécharge s'il a changé et en garde une copie
//    (cache-central/). C'est aussi le « signe de vie » vu dans le back office.
//  • Sommelier et sélection guidée : transmis au serveur central. S'il ne répond
//    pas (Internet coupé, serveur en panne, quota atteint), la sélection guidée
//    tourne ici avec le moteur d'accords, sans IA (3 vins, rôles, raisons) ; le
//    chat renvoie une erreur et l'écran utilise son repli habituel.
//  • Couleurs conseillées, profils des vins : toujours calculés ici (sans IA).
// ═══════════════════════════════════════════════════════════════════════════
const DOSSIER_CACHE = path.resolve(process.env.WINESELECT_CACHE || path.join(__dirname, 'cache-central'));
const FICHIER_CACHE_CATALOGUE = path.join(DOSSIER_CACHE, 'catalogue.json');
const FICHIER_CACHE_CONFIG = path.join(DOSSIER_CACHE, 'config.json');
const SYNCHRO_MS = (parseFloat(process.env.WINESELECT_SYNCHRO_SECONDES) || 300) * 1000;
const ETAT_CENTRAL = { versionCatalogue: null, derniereSynchro: null, joignable: null, derniereErreur: null, magasin: null };

async function appelCentral(chemin, options) {
  const o = options || {};
  const r = await fetch(CONNEXION.serveur + '/api/borne' + chemin, {
    method: o.corps ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + CONNEXION.jeton, 'X-WineSelect-Version': VERSION_BORNE },
      o.corps ? { 'Content-Type': 'application/json' } : {}),
    body: o.corps ? JSON.stringify(o.corps) : undefined,
    signal: AbortSignal.timeout(o.delai || 15000),
  });
  let corps = null;
  try { corps = await r.json(); } catch (e) { /* réponse vide ou illisible */ }
  return { status: r.status, corps };
}

// Écriture atomique : jamais de copie à moitié écrite si la borne s'éteint.
function ecrireCache(fichier, donnees) {
  fs.mkdirSync(DOSSIER_CACHE, { recursive: true });
  fs.writeFileSync(fichier + '.tmp', JSON.stringify(donnees), 'utf-8');
  fs.renameSync(fichier + '.tmp', fichier);
}

function installerCatalogue(vins, version, source) {
  BASE_CATALOG = vins;
  WINES_CATALOG = SOMMELIER.avecLibelles(vins);
  ETAT_CENTRAL.versionCatalogue = version;
  console.log('📦 Catalogue : ' + vins.length + ' vins (' + source + ', version ' + version + ')');
}

function chargerCacheCentral() {
  try {
    const c = JSON.parse(fs.readFileSync(FICHIER_CACHE_CATALOGUE, 'utf-8'));
    if (!Array.isArray(c.vins)) return false;
    installerCatalogue(c.vins, c.version, 'copie locale du catalogue central');
    return true;
  } catch (e) {
    return false;
  }
}

async function synchroniser() {
  try {
    const conf = await appelCentral('/config');
    if (conf.status !== 200 || !conf.corps) {
      throw new Error('HTTP ' + conf.status + (conf.corps && conf.corps.error ? ' — ' + conf.corps.error : ''));
    }
    ecrireCache(FICHIER_CACHE_CONFIG, conf.corps);
    ETAT_CENTRAL.magasin = conf.corps.magasin;
    if (conf.corps.versionCatalogue !== ETAT_CENTRAL.versionCatalogue || !WINES_CATALOG.length) {
      const cat = await appelCentral('/catalogue', { delai: 30000 });
      if (cat.status !== 200 || !cat.corps || !Array.isArray(cat.corps.vins)) throw new Error('catalogue : HTTP ' + cat.status);
      ecrireCache(FICHIER_CACHE_CATALOGUE, cat.corps);
      installerCatalogue(cat.corps.vins, cat.corps.version, 'serveur central');
    }
    if (ETAT_CENTRAL.joignable === false) console.log('✅ Serveur central de nouveau joignable.');
    ETAT_CENTRAL.joignable = true;
    ETAT_CENTRAL.derniereSynchro = new Date().toISOString();
    ETAT_CENTRAL.derniereErreur = null;
  } catch (e) {
    if (ETAT_CENTRAL.joignable !== false) console.warn('⚠️  Serveur central injoignable (' + e.message + ') : la borne continue avec sa copie locale.');
    ETAT_CENTRAL.joignable = false;
    ETAT_CENTRAL.derniereErreur = e.message;
  }
}

// Transmet une demande au sommelier central. Renvoie null s'il faut répondre
// ici : serveur injoignable, en panne, quota atteint, borne refusée...
// (Une demande invalide, 400, est renvoyée telle quelle : la refaire ici ne
// donnerait pas mieux.)
async function relayer(chemin, corps) {
  try {
    const r = await appelCentral(chemin, { corps, delai: 90000 });
    if ((r.status >= 200 && r.status < 300) || r.status === 400) return r;
    console.warn('⚠️  ' + chemin + ' : serveur central HTTP ' + r.status + (r.corps && r.corps.error ? ' (' + r.corps.error + ')' : '') + ' → réponse de la borne');
  } catch (e) {
    console.warn('⚠️  ' + chemin + ' : serveur central injoignable (' + e.message + ') → réponse de la borne');
    ETAT_CENTRAL.joignable = false;
  }
  return null;
}
// Hors connexion : tout appel à l'IA échoue tout de suite, le moteur prend ses replis.
const SANS_IA = () => Promise.reject(new Error('serveur central injoignable'));

// Chat hors connexion : la demande du client est traduite en sélection guidée
// (plat, budget et couleur repérés par les mêmes règles que le sommelier), puis
// le moteur d'accords choisit 3 vins, sans IA. La réponse garde le format du
// chat (🥇 ⭐ ✨ puis [WINES:…]) pour que l'écran l'affiche normalement.
const LIBELLES_PLAT = { 'viande': 'votre viande', 'volaille': 'votre volaille', 'poisson': 'votre poisson',
  'fruits de mer': 'vos fruits de mer', 'fromage': 'vos fromages', 'charcuterie': 'votre charcuterie',
  'dessert': 'votre dessert', 'barbecue': 'votre barbecue', 'méditerranéen': 'votre plat', 'asiatique': 'votre plat' };
async function chatHorsLigne(messages) {
  const duClient = (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user' && typeof m.content === 'string');
  if (!duClient.length || !WINES_CATALOG.length) return null;
  const dernier = duClient[duClient.length - 1].content.toLowerCase();
  const plat = SOMMELIER.detectPairing(duClient);
  const budget = SOMMELIER.detectBudget(duClient);
  const tranche = !budget ? '8-15' : budget.max <= 8 ? '-8' : budget.max <= 15 ? '8-15' : budget.max <= 25 ? '15-25' : budget.max <= 50 ? '25-50' : '50+';
  // Budget annoncé : sa fourchette exacte, jamais au-dessus du plafond (règle du sommelier).
  const fourchette = budget ? { min: budget.min, max: budget.openFloor ? budget.max : SOMMELIER.plafondBudget(budget) } : undefined;
  const couleur = /\brouges?\b/.test(dernier) ? 'rouge' : /\bblancs?\b/.test(dernier) ? 'blanc' : /\bros[ée]s?\b/.test(dernier) ? 'rosé'
    : /bulles|champagne|cr[ée]mant|p[ée]tillant/.test(dernier) ? 'bulles' : null;
  const cadeau = /cadeau|offrir|offert|à offrir/.test(dernier);
  const demande = cadeau ? { occasion: 'offrir', gout: 'inconnu', budget: tranche, fourchette, couleur }
    : plat === 'apéritif' ? { occasion: 'aperitif', budget: tranche, fourchette, couleur }
    : plat ? { occasion: 'repas', pairing: plat, budget: tranche, fourchette, couleur }
    : { occasion: 'offrir', gout: 'inconnu', budget: tranche, fourchette, couleur };
  const r = await SOMMELIER.selectionAccord(demande, envSommelier());
  const vins = ((r.body && r.body.ids) || []).map(id => WINES_CATALOG.find(w => w.id === id)).filter(Boolean)
    .sort((a, b) => a.price - b.price);
  if (vins.length !== 3) return null;
  const raisons = r.body.reasons || {};
  const prix = p => (Math.round(p * 100) / 100).toString().replace('.', ',') + '€';
  const intro = cadeau ? 'Pour offrir, voici trois vins de notre rayon :'
    : plat === 'apéritif' ? 'Pour l\'apéritif, voici trois vins de notre rayon :'
    : plat ? 'Pour accompagner ' + (LIBELLES_PLAT[plat] || 'votre plat') + ', voici trois vins de notre rayon :'
    : 'Voici trois valeurs sûres de notre rayon :';
  const texte = intro + '\n\n' + ['🥇', '⭐', '✨'].map((icone, i) =>
    icone + ' ' + (vins[i].libelle || vins[i].name) + ' — ' + prix(vins[i].price) + '\n' + (raisons[vins[i].id] || vins[i].tastingNotes || '')).join('\n\n') +
    '\n\n[WINES:' + vins.map(w => w.id).join(',') + ']';
  return { text: texte };
}

// ── Sommelier : chat, sélection guidée, couleurs conseillées, profils ─────────
// Toute la logique est dans sommelier.js, partagée avec le serveur central.
// Ici, on lui passe seulement le catalogue de CETTE borne, la stratégie du
// magasin et la clé Mistral, puis on renvoie sa réponse.
const SOMMELIER = chargerSommelier();
function envSommelier() {
  // Borne connectée (secours local) ou borne sans clé : moteur d'accords sans IA.
  if (CONNEXION || !CONFIG.apiKey) return { catalogue: WINES_CATALOG, config: CONFIG, callApi: SANS_IA };
  return { catalogue: WINES_CATALOG, commercial: lireCommercial(), config: CONFIG };
}
const repondre = res => r => res.status(r.status || 200).json(r.body);
const erreur500 = res => e => {
  console.error('Erreur:', e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
};

app.post('/sommelier', rateLimit(30), (req, res) => {
  if (CONNEXION) {
    // Seule la conversation part : le serveur central construit lui-même le prompt.
    const messages = (req.body || {}).messages;
    return relayer('/sommelier', { messages }).then(async r => {
      if (r) return res.status(r.status).json(r.corps);
      const local = await chatHorsLigne(messages).catch(e => { console.warn('⚠️  Chat hors connexion :', e.message); return null; });
      if (local) return res.json(local);
      res.status(503).json({ error: 'Sommelier momentanément indisponible.' });
    }).catch(erreur500(res));
  }
  if (!CONFIG.apiKey) {
    // Borne pas encore installée (ni clé ni jeton) : chat sans IA.
    return chatHorsLigne((req.body || {}).messages).then(local => local
      ? res.json(local) : res.status(503).json({ error: 'Sommelier momentanément indisponible.' }), erreur500(res));
  }
  SOMMELIER.repondreSommelier(req.body || {}, envSommelier()).then(repondre(res), erreur500(res));
});
app.post('/couleurs-conseillees', (req, res) => {
  res.json(SOMMELIER.couleursConseillees(req.body || {}, { catalogue: WINES_CATALOG }));
});
app.get('/profils-vins', (req, res) => {
  res.json(SOMMELIER.profilsVins({ catalogue: WINES_CATALOG }));
});
app.post('/selection-accord', rateLimit(30), (req, res) => {
  if (CONNEXION) {
    const corps = Object.assign({}, req.body || {});
    delete corps.featuredIds; // la mise en avant vient du serveur central
    return relayer('/selection-accord', corps).then(r => r
      ? res.status(r.status).json(r.corps)
      : SOMMELIER.selectionAccord(req.body || {}, envSommelier()).then(repondre(res)), erreur500(res));
  }
  SOMMELIER.selectionAccord(req.body || {}, envSommelier()).then(repondre(res), erreur500(res));
});

// sommelier.js est arrivé avec la mise à jour d'octobre 2026. Une borne encore
// équipée de l'ancien check-update.js reçoit le nouveau serveur.js sans lui :
// on relance alors la mise à jour (le nouveau check-update.js, déjà téléchargé,
// connaît sommelier.js) avant d'abandonner.
function chargerSommelier() {
  try { return require('./sommelier.js'); }
  catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || e.message.indexOf('sommelier.js') < 0) throw e;
    console.warn('⚠️  sommelier.js absent : récupération par check-update.js...');
    try {
      require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'check-update.js')], { stdio: 'inherit' });
    } catch (e2) { console.error('❌ Mise à jour impossible :', e2.message); }
    return require('./sommelier.js');
  }
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
const startedAt = Date.now();
const server = app.listen(PORT, () => {
  loadCatalog();
  console.log('\n🍷  WineSelect — Serveur');
  console.log('──────────────────────────────────');
  console.log('   http://localhost:' + PORT);
  if (CONNEXION) {
    console.log('   Mode     : connecté à ' + CONNEXION.serveur);
  } else {
    console.log('   Mode     : autonome' + (CONFIG.apiKey ? '' : ' (sans IA : borne pas encore installée)'));
    console.log('   Modèle   : ' + CONFIG.model);
    if (CONFIG.apiKey) console.log('   Clé API  : ' + CONFIG.apiKey.substring(0, 8) + '...  ✅');
  }
  console.log('   PID      : ' + process.pid);
  console.log('   Démarré  : ' + new Date().toLocaleString('fr-FR'));
  console.log('──────────────────────────────────\n');
  if (CONNEXION) demarrerSynchro();
});

// Synchronisation avec le serveur central : tout de suite, puis toutes les 5 minutes.
let minuterieSynchro = null;
function demarrerSynchro() {
  synchroniser();
  if (!minuterieSynchro) minuterieSynchro = setInterval(() => { if (CONNEXION) synchroniser(); }, SYNCHRO_MS);
  minuterieSynchro.unref();
}

// ═══════════════════════════════════════════════════════════════════════════
//  ÉCRAN DE DÉPANNAGE (appui long sur le logo de l'écran, puis le code)
//  Pour l'installateur ou le technicien, jamais pour les clients :
//  état de la connexion et du catalogue, synchronisation, test du sommelier,
//  installation de la borne (adresse du serveur + jeton).
//  Code : en mode connecté, le code commun défini dans l'espace super admin
//  (vérifié ici grâce à son empreinte, même sans Internet) ; en mode autonome
//  (démo, borne pas encore installée), le PIN de la borne.
//  5 essais, puis blocage d'une minute. Session de dépannage : jeton X-Admin-Token.
// ═══════════════════════════════════════════════════════════════════════════
// Seul le vrai serveur WineSelect peut être choisi à l'installation (localhost
// pour les tests) : un code deviné ne permet pas de détourner la borne.
const SERVEURS_AUTORISES = ['https://gestion.wineselect-france.fr'];
const serveurAutorise = s => SERVEURS_AUTORISES.includes(s) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s);

function verifierCodeDepannage(code) {
  const saisi = String(code || '');
  if (!CONNEXION) return saisi === ADMIN_PIN;
  let d = null;
  try { d = JSON.parse(fs.readFileSync(FICHIER_CACHE_CONFIG, 'utf-8')).depannage; } catch (e) { /* jamais synchronisée */ }
  if (!d || !d.sel || !d.empreinte) return null; // aucun code commun défini
  try {
    const calcule = crypto.scryptSync(saisi, d.sel, 32, { N: d.N, r: d.r, p: d.p });
    return crypto.timingSafeEqual(calcule, Buffer.from(d.empreinte, 'hex'));
  } catch (e) {
    return false;
  }
}

function etatBorne() {
  let codeDefini = !CONNEXION;
  try { codeDefini = codeDefini || !!JSON.parse(fs.readFileSync(FICHIER_CACHE_CONFIG, 'utf-8')).depannage; } catch (e) {}
  return {
    mode: CONNEXION ? 'connecte' : 'autonome',
    versionBorne: VERSION_BORNE,
    serveur: CONNEXION ? CONNEXION.serveur : null,
    jeton: CONNEXION ? CONNEXION.jeton.slice(0, 4) + '…' + CONNEXION.jeton.slice(-4) : null,
    magasin: ETAT_CENTRAL.magasin,
    catalogue: { vins: WINES_CATALOG.length, version: CONNEXION ? ETAT_CENTRAL.versionCatalogue : null },
    synchro: CONNEXION ? { joignable: ETAT_CENTRAL.joignable, derniere: ETAT_CENTRAL.derniereSynchro, erreur: ETAT_CENTRAL.derniereErreur } : null,
    sommelier: CONNEXION ? 'serveur central' : (CONFIG.apiKey ? 'IA sur la borne' : 'sans IA'),
    codeDepannageDefini: codeDefini,
  };
}

app.post('/api/depannage/ouvrir', (req, res) => {
  const ip = 'depannage:' + (req.ip || req.socket.remoteAddress || '');
  const now = Date.now();
  const entry = pinAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil > now) {
    return res.status(429).json({ ok: false, error: 'Trop d\'essais. Réessayez dans ' + Math.ceil((entry.lockedUntil - now) / 1000) + ' s.' });
  }
  const verdict = verifierCodeDepannage((req.body || {}).code);
  if (verdict === null) {
    return res.status(403).json({ ok: false, error: 'Aucun code de dépannage n\'est défini pour les bornes : réglez-le dans l\'espace super admin, puis synchronisez la borne.' });
  }
  if (!verdict) {
    entry.count += 1;
    if (entry.count >= PIN_MAX_ATTEMPTS) { entry.lockedUntil = now + PIN_LOCKOUT_MS; entry.count = 0; }
    pinAttempts.set(ip, entry);
    return res.status(401).json({ ok: false, error: 'Code incorrect.' });
  }
  pinAttempts.delete(ip);
  console.log('🔧 Écran de dépannage ouvert.');
  res.json({ ok: true, token: issueAdminToken(), etat: etatBorne() });
});

app.get('/api/depannage/etat', requireAdminToken, (req, res) => res.json(etatBorne()));

app.post('/api/depannage/synchroniser', requireAdminToken, async (req, res) => {
  if (!CONNEXION) return res.status(400).json({ error: 'Borne en mode autonome : rien à synchroniser.' });
  await synchroniser();
  res.json(etatBorne());
});

// Test du sommelier : une sélection guidée type, par le même chemin qu'un client.
app.post('/api/depannage/tester', requireAdminToken, async (req, res) => {
  const demande = { occasion: 'repas', pairing: 'viande', budget: '15-25' };
  const debut = Date.now();
  try {
    let source = CONNEXION ? 'serveur central (IA)' : (CONFIG.apiKey ? 'IA sur la borne' : 'borne, sans IA');
    let reponse = CONNEXION ? await relayer('/selection-accord', demande) : null;
    let corps = reponse ? reponse.corps : null;
    if (!corps) {
      if (CONNEXION) source = 'borne, sans IA (serveur central injoignable)';
      corps = (await SOMMELIER.selectionAccord(demande, envSommelier())).body;
    }
    const vins = ((corps && corps.ids) || []).map(id => WINES_CATALOG.find(w => w.id === id)).filter(Boolean)
      .map(w => (w.libelle || w.name) + ' — ' + String(w.price).replace('.', ',') + ' €'); // espace insécable : le € ne passe jamais seul à la ligne
    res.json({ ok: vins.length === 3, source, duree: Date.now() - debut, demande: 'Repas, viande, 15 à 25 €', vins });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Installation (ou changement de jeton) : vérifiée auprès du serveur avant d'être enregistrée.
app.post('/api/depannage/installer', requireAdminToken, async (req, res) => {
  const serveur = String((req.body || {}).serveur || '').trim().replace(/\/+$/, '');
  const jeton = String((req.body || {}).jeton || '').trim();
  if (!serveurAutorise(serveur)) return res.status(400).json({ error: 'Adresse non reconnue. Adresse attendue : ' + SERVEURS_AUTORISES[0] });
  if (!/^wsb_[\w-]{20,}$/.test(jeton)) return res.status(400).json({ error: 'Jeton invalide : il commence par « wsb_ » (copiez-le depuis l\'espace super admin).' });
  if (typeof fetch !== 'function') return res.status(400).json({ error: 'Node.js est trop ancien sur cette borne (version 18 ou plus récente requise).' });
  let test;
  try {
    test = await fetch(serveur + '/api/borne/config', { headers: { Authorization: 'Bearer ' + jeton, 'X-WineSelect-Version': VERSION_BORNE }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return res.status(502).json({ error: 'Serveur injoignable (' + e.message + '). Vérifiez la connexion Internet de la borne.' });
  }
  if (test.status === 401) return res.status(400).json({ error: 'Jeton refusé par le serveur (inconnu ou révoqué).' });
  if (test.status === 403) return res.status(400).json({ error: 'Le magasin de cette borne est suspendu.' });
  if (test.status !== 200) return res.status(502).json({ error: 'Réponse inattendue du serveur (HTTP ' + test.status + ').' });

  const ecrire = (fichier, contenu) => { fs.writeFileSync(fichier + '.tmp', contenu, 'utf-8'); fs.renameSync(fichier + '.tmp', fichier); };
  fs.mkdirSync(DOSSIER_BORNE, { recursive: true });
  ecrire(FICHIER_CONFIG_BORNE, JSON.stringify({ serveur }, null, 2) + '\n');
  ecrire(FICHIER_JETON_BORNE, jeton + '\n');
  // Nouvelle installation : l'ancienne copie (peut-être d'un autre magasin) ne sert plus.
  try { fs.rmSync(DOSSIER_CACHE, { recursive: true, force: true }); } catch (e) {}
  CONNEXION = { serveur, jeton };
  ETAT_CENTRAL.versionCatalogue = null;
  ETAT_CENTRAL.magasin = null;
  ETAT_CENTRAL.joignable = null;
  console.log('🔧 Borne installée depuis l\'écran de dépannage : ' + serveur);
  demarrerSynchro();
  await attendreSynchro();
  res.json(etatBorne());
});
// Laisse le temps à la première synchronisation (au plus 20 s).
async function attendreSynchro() {
  const fin = Date.now() + 20000;
  while (Date.now() < fin && ETAT_CENTRAL.versionCatalogue === null && ETAT_CENTRAL.joignable !== false) {
    await new Promise(ok => setTimeout(ok, 200));
  }
}

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
    versionBorne: VERSION_BORNE,
    mode: CONNEXION ? 'connecte' : 'autonome',
    // Mode connecté : l'écran compare cette version à la sienne pour se recharger
    // entre deux clients quand le catalogue a changé.
    versionCatalogue: CONNEXION ? ETAT_CENTRAL.versionCatalogue : null,
    serveurCentral: CONNEXION ? {
      joignable: ETAT_CENTRAL.joignable, derniereSynchro: ETAT_CENTRAL.derniereSynchro,
      erreur: ETAT_CENTRAL.derniereErreur, magasin: ETAT_CENTRAL.magasin,
    } : null,
  });
});
