'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  SOMMELIER.JS — la logique du sommelier, partagée par la borne et le serveur central
//
//  Extrait tel quel de serveur.js (octobre 2026) : détection du budget et de
//  l'accord, chat libre (/sommelier), sélection guidée (/selection-accord),
//  couleurs conseillées, profils des vins, appel à l'API Mistral.
//  Ce module ne connaît ni Express ni les fichiers du magasin : chaque fonction
//  reçoit un « env » = { catalogue, commercial, config } et renvoie sa réponse.
//    catalogue  : les vins du magasin (prix et stocks à jour, sans prix d'achat
//                 sauf dans commercial.prixAchat pour la stratégie « marge »)
//    commercial : { strategie, prixAchat } (départage seulement, jamais envoyé à Mistral)
//    config     : { apiKey, model } pour Mistral
// ═══════════════════════════════════════════════════════════════════════════

const https = require('https');

// Moteur d'accords par profils (accords.js + profils-reference.js). S'il
// manque, le sommelier fonctionne comme avant, avec le tri par catégorie.
let ACCORDS = null;
try { ACCORDS = require('./accords.js'); }
catch (e) { console.warn('⚠️  accords.js absent : tri par catégorie uniquement (' + e.message + ')'); }

const COMMERCIAL_NEUTRE = { strategie: 'neutre', prixAchat: {} };

// ── Identité des vins (libellé) ─────────────────────────────────────────────
// Même règle que libelleVin() dans WineSelect.html — les deux doivent rester
// identiques pour que le sommelier écrive les noms affichés à l'écran.
function libelleVin(w) {
  if (!w) return '';
  if (!w.domaine && !w.cuvee) return w.millesime ? w.name + ' ' + w.millesime : w.name;
  let s = w.domaine && w.cuvee ? w.domaine + ' — ' + w.cuvee : (w.cuvee || w.domaine);
  if (w.appellation && s.toLowerCase().indexOf(String(w.appellation).toLowerCase()) < 0) s += ', ' + w.appellation;
  if (w.millesime) s += ' ' + w.millesime;
  return s;
}
// Ajoute le libellé à chaque vin (catalogue tel que le sommelier le reçoit).
const avecLibelles = vins => vins.map(w => Object.assign({}, w, { libelle: libelleVin(w) }));

// Imite la réponse d'Express pour le moteur d'accords, qui répond par res.json().
function reponseCapturee() {
  const r = { code: 200, corps: undefined, headersSent: false };
  r.status = c => { r.code = c; return r; };
  r.json = o => { r.corps = o; r.headersSent = true; return r; };
  return r;
}

// ── Conversion des nombres écrits en toutes lettres ───────────────────────────
// La dictée vocale (micro de la borne) transcrit parfois les nombres en toutes
// lettres ("vingt-cinq euros") plutôt qu'en chiffres. Les regex de detectBudget
// ne matchent que des chiffres : sans cette normalisation, un budget dicté à la
// voix n'est jamais détecté et le sommelier perd toute contrainte de prix.
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
// Règles : on ne sort JAMAIS du budget du client (confiance envers le sommelier).
//  • max = maximum annoncé, avec une tolérance de 5 % au plus (plafond() ci-dessous)...
//  • ...et aucune tolérance si le client verrouille son budget ("100€ grand maximum",
//    "pas plus de 80€", "ne pas dépasser 50€", "moins de 60€") → plafond STRICT.
//  • min = minimum annoncé ("entre 30 et 50€" → 30€), ou 70 % du max si le client
//    n'a donné qu'un plafond ("moins de 20€", "20€") ; "autour de 20€" → 80 %.
//  • paliers = prix visés pour les 3 vins, tous DANS la fourchette.
// Seule exception : "25€ et plus" (aucun plafond annoncé) → montée en gamme progressive.
const TOLERANCE_BUDGET = 1.05;
function plafondBudget(budget) {
  return budget.max * (budget.strict ? 1 : TOLERANCE_BUDGET);
}
const prixTexte = p => (Math.round(p * 100) / 100).toString().replace('.', ',') + '€';
// Consigne de budget injectée dans le prompt du sommelier (chat libre, avec ou sans
// moteur d'accords) : les 3 paliers et le prix maximum absolu.
function consigneBudget(budget) {
  const t = budget.paliers;
  return '\nBUDGET DU CLIENT : ' + budget.label + '.' +
    '\nSTRUCTURE DE PRIX pour tes 3 propositions :' +
    '\n  🥇 premier vin, la belle affaire : environ ' + Math.round(t[0]) + '€ ou moins' +
    '\n  ⭐ deuxième vin, au cœur du budget : environ ' + Math.round(t[1]) + '€' +
    '\n  ✨ troisième vin, le haut de la fourchette : environ ' + Math.round(t[2]) + '€' +
    '\nLes prix doivent monter du 🥇 au ✨.' +
    (budget.openFloor
      ? ' Aucun vin en dessous de ' + Math.round(budget.min) + '€.'
      : '\nPRIX MAXIMUM ABSOLU : ' + prixTexte(plafondBudget(budget)) + '. Ne le dépasse JAMAIS, même de 1€, sous aucun prétexte : le client doit pouvoir faire confiance à ton conseil.');
}
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

  // min/max = fourchette RÉELLE du client ; ref = maximum annoncé ;
  // paliers = 3 prix visés, du quart de la fourchette jusqu'au maximum.
  const mk = (min, max, label, forceStrict) => {
    const s = strict || !!forceStrict;
    const span = max - min;
    return { min, max, ref: max, strict: s, label: label + (s ? ' (plafond strict)' : ''),
      paliers: [min + span * 0.25, min + span * 0.6, max] };
  };

  const range = txt.match(/entre\s*(\d+)\s*(?:et|à|-)\s*(\d+)/);
  if (range) {
    const a = parseInt(range[1]), b = parseInt(range[2]);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return mk(lo, hi, lo + '-' + hi + '€');
  }

  // Plancher ouvert, sans plafond annoncé par le client : "25€ et plus",
  // "à partir de 25€", "au moins 25€", "minimum 25€". On calcule un plafond
  // raisonnable (montée en gamme progressive) plutôt que de laisser le sommelier
  // sans aucune limite haute.
  const floorOpen = txt.match(/(\d+)\s*(?:€|euros?)?\s*(?:et\s+plus|ou\s+plus|voire\s+plus)/)
                  || txt.match(/(?:à\s+partir\s+de|au\s+moins|minimum|min\.?)\s*(?:de)?\s*(\d+)/);
  if (floorOpen) {
    const p = parseInt(floorOpen[1]);
    const ref = Math.round(p * 1.6);
    return { min: p, max: p * 3, ref, strict: false, label: 'à partir de ' + p + '€', openFloor: true,
      paliers: [ref * 0.8, ref, ref * 1.2] };
  }

  const around = txt.match(/(?:autour|environ)\s*(?:de)?\s*(\d+)/);
  if (around) {
    const p = parseInt(around[1]);
    return mk(p * 0.8, p, 'autour de ' + p + '€');
  }
  const capped = txt.match(/(?:moins\s+de|pas\s+plus\s+de|ne\s+pas\s+d[ée]passer|sans\s+d[ée]passer|max(?:imum)?\s*(?:de)?)\s*(\d+)/)
              || txt.match(/(\d+)\s*(?:€|euros?)?\s*(?:grand\s+max(?:imum)?|max\b|maxi\b|maximum|tout\s+au\s+plus)/);
  if (capped) {
    const p = parseInt(capped[1]);
    return mk(p * 0.7, p, 'max ' + p + '€', true);
  }
  const exact = txt.match(/(\d+)\s*(?:€|euros?)/);
  if (exact) {
    const p = parseInt(exact[1]);
    return mk(p * 0.7, p, p + '€');
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

// ── Chat libre avec le sommelier (route /sommelier) ──────────────────────────
// body = { messages, system, featuredIds } envoyé par l'écran.
// Renvoie { status, body } : c'est au serveur (borne ou central) de répondre.
async function repondreSommelier(body, env) {
  // env.callApi permet de remplacer l'appel à Mistral (ex. borne hors connexion : appel impossible → replis).
  const callApi = env.callApi || appelHttps;
  const WINES_CATALOG = env.catalogue || [], CONFIG = env.config;
  const { messages, system, featuredIds } = body;
  const featuredSet = new Set(Array.isArray(featuredIds) ? featuredIds : []);
  const featuredBonus = w => featuredSet.has(w.id) ? 3 : 0; // même logique de départage que /selection-accord
  const commercial = env.commercial || COMMERCIAL_NEUTRE;
  if (commercial.strategie !== 'neutre') console.log('🎯 Stratégie magasin :', commercial.strategie);

  const budget  = detectBudget(messages);
  // Moteur d'accords : l'IA décrit le plat, les vins sont notés selon leur profil.
  // null si aucun plat n'est évoqué ou si l'analyse échoue → ancien tri ci-dessous.
  const moteur = (ACCORDS && WINES_CATALOG.length)
    ? await ACCORDS.preparerSommelier({ messages, system, budget, featuredSet, catalogue: WINES_CATALOG, callApi, config: CONFIG,
        plafond: budget ? plafondBudget(budget) : null, consigneBudget, commercial }).catch(() => null)
    : null;
  const pairing = moteur ? null : detectPairing(messages);

  if (budget)  console.log('💰 Budget:', budget.label, '→', Math.round(budget.min) + '€ –', Math.round(budget.max) + '€');
  if (pairing) console.log('🍽  Accord:', pairing);

  // Injecter les contraintes + liste des vins disponibles directement dans le prompt
  let finalSystem = system;
  let tierWines = null, available = [];

  if (moteur) {
    finalSystem = moteur.finalSystem; tierWines = moteur.tierWines; available = moteur.available;
  } else if ((budget || pairing) && WINES_CATALOG.length) {
    const pairingOk = w => !pairing || (w.pairings && w.pairings.includes(pairing));

    // ── Escalier de prix sur 3 paliers, tous DANS la fourchette du client ──
    //   (budget.paliers, calculés par parseBudget) : on ne dépasse jamais le plafond.
    let tiers = null;
    if (budget) {
      const ref = budget.ref || budget.max;
      tiers = budget.paliers;
      const ceiling = plafondBudget(budget);

      // Constitution du vivier, avec replis progressifs si le rayon est pauvre
      // sur ce budget+accord : 1) bande normale  2) plancher abaissé  3) sans accord
      // (on n'élargit que vers le BAS : le plafond ne bouge jamais)
      const inBand = (w, lo) => w.price >= lo && w.price <= ceiling;
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
        const bonusCom = ACCORDS ? ACCORDS.bonusStrategie(commercial, cands) : () => 0;
        return [...cands].sort((a, b) => {
          const da = Math.abs(a.price - target), db = Math.abs(b.price - target);
          if (Math.abs(da - db) > 2) return da - db;
          return (featuredBonus(b) + bonusCom(b)) - (featuredBonus(a) + bonusCom(a));
        }).slice(0, 5);
      });
      available = tierWines.flat();
    } else {
      // Sans budget annoncé : on reste grand public (45 € maximum), autour du prix médian
      // de ces vins ; mise en avant magasin et stratégie départagent.
      const grandPublic = WINES_CATALOG.filter(w => pairingOk(w) && w.price <= 45);
      const vivier = grandPublic.length >= 3 ? grandPublic : WINES_CATALOG.filter(w => pairingOk(w));
      const prixTries = vivier.map(w => w.price).sort((a, b) => a - b);
      const median = prixTries[Math.floor(prixTries.length / 2)] || 15;
      const bonusCom = ACCORDS ? ACCORDS.bonusStrategie(commercial, vivier) : () => 0;
      const val = w => featuredBonus(w) + bonusCom(w) - Math.abs(w.price - median) / Math.max(1, median) * 10;
      available = [...vivier].sort((a, b) => val(b) - val(a)).slice(0, 15);
    }

    let inject = '\n\n>>> CONTRAINTES OBLIGATOIRES <<<';

    if (budget) {
      inject += consigneBudget(budget);
    }

    if (pairing) {
      inject += '\nACCORD : ' + (PAIRING_RULES[pairing] || 'adapte le vin au plat.');
    }

    if (available.length >= 3) {
      inject += '\nVINS DISPONIBLES — RÈGLE ABSOLUE : tes 3 propositions doivent EXCLUSIVEMENT provenir de ces listes.';
      inject += '\nIgnore tout autre vin du catalogue général, même s\'il te semble pertinent. Proposer un vin hors liste est une erreur grave.';
      const fmt = w => '\n  ID:' + w.id + ' | ' + (w.libelle || w.name) + ' | ' + w.type + ' | ' + w.price + '€ | ' + w.region +
        (featuredSet.has(w.id) ? ' | [MIS EN AVANT PAR LE MAGASIN]' : '');
      if (tierWines) {
        inject += '\nCandidats pour le vin 🥇, la BELLE AFFAIRE (le meilleur rapport qualité-prix pour ce plat) :'; tierWines[0].forEach(w => inject += fmt(w));
        inject += '\nCandidats pour le vin ⭐, au CŒUR du budget :';  tierWines[1].forEach(w => inject += fmt(w));
        inject += '\nCandidats pour le vin ✨, dans le HAUT de la fourchette (sans la dépasser) :';  tierWines[2].forEach(w => inject += fmt(w));
      } else {
        available.forEach(w => inject += fmt(w));
      }
      if (featuredSet.size) {
        inject += '\nCertains vins sont marqués [MIS EN AVANT PAR LE MAGASIN] : en cas d\'ÉGALITÉ de pertinence entre ' +
          'plusieurs candidats pour un même palier, privilégie ceux-là. Mais ne choisis JAMAIS un vin uniquement parce ' +
          'qu\'il est marqué s\'il correspond moins bien au plat ou au budget qu\'une alternative non marquée.';
      }
      if (ACCORDS) inject += ACCORDS.consigneOrdre(commercial);
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
      return { status: 500, body: { error: data.error.message } };
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
        // Plafond : jamais dépassé. Plancher souple : le vivier peut descendre sous le
        // minimum quand le rayon est pauvre (jusqu'à 55 % du maximum annoncé).
        const hardMax = plafondBudget(budget) + 0.01;
        const hardMin = Math.min(budget.min - 3, (budget.ref || budget.max) * 0.55);
        const outOfRange = chosen.some(w => w.price < hardMin || w.price > hardMax);
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
      console.warn('⚠️  Réponse du sommelier non conforme (' + check.reason + ') → retry correctif');

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
      console.log('✅ Sommelier propose:', check.chosen.map(w => w.name + ' (' + w.price + '€)').join(', '));
    }

    return { status: 200, body: { text } };

  } catch (e) {
    console.error('Erreur:', e.message);
    return { status: 500, body: { error: e.message } };
  }
}

// ── Route questionnaire guidé (3 questions) ───────────────────────────────────
// Applique le même raisonnement que le sommelier (chat libre) : le type/budget/
// accord choisis par le client servent de FILTRE DE SÉCURITÉ (jamais de
// contresens comme un rouge tannique avec un poisson cru), puis le sommelier
// choisit 3 vins DANS ce sous-ensemble en se basant sur les vraies données
// du vin (cépage, région, notes de dégustation) plutôt que sur un simple
// tri par prix — exactement le même travail que dans le chat.
const BUDGET_BRACKETS = {
  '-8':    { min: 0,  max: 8   },
  '8-15':  { min: 8,  max: 15  },
  '15-25': { min: 15, max: 25  },
  '25-50': { min: 25, max: 50  },
  '50+':   { min: 50, max: Infinity },
  '25+':   { min: 25, max: Infinity },   // ancienne tranche, gardée pour les écrans pas encore à jour
};

// Couleurs conseillées pour un plat de la liste (écran « Avez-vous une préférence ? »).
// Calcul local par le moteur d'accords, sans appel à l'API.
function couleursConseillees(body, env) {
  const WINES_CATALOG = env.catalogue || [];
  const bracket = BUDGET_BRACKETS[body.budget];
  if (!ACCORDS || !WINES_CATALOG.length || !bracket) return { couleurs: null };
  const plat = ACCORDS.platDepuisCategorie(body.pairing, body.detail);
  if (!plat) return { couleurs: null };
  try { return { couleurs: ACCORDS.couleursConseillees(WINES_CATALOG, plat, bracket) }; }
  catch (e) { console.warn('⚠️  Couleurs conseillées :', e.message); return { couleurs: null }; }
}

// Profils gustatifs du catalogue, chargés par l'écran au démarrage : ils servent au
// repli local de la sélection guidée si /selection-accord ne répond pas (sinon ce
// repli ignore le goût et propose, par exemple, un Pomerol pour un « rouge léger »).
function profilsVins(env) {
  try {
    const { profilerVin } = require('./profils-reference.js');
    const out = {};
    (env.catalogue || []).forEach(w => {
      const p = w.profil || profilerVin(w);
      out[w.id] = { corps: p.corps, tanins: p.tanins || 0, fraicheur: p.fraicheur, sucrosite: p.sucrosite || 0, boise: p.boise || 0 };
    });
    return out;
  } catch (e) { console.warn('⚠️  Profils des vins :', e.message); return {}; }
}

// Sélection guidée (route /selection-accord). Renvoie { status, body }.
async function selectionAccord(body, env) {
  const callApi = env.callApi || appelHttps;
  const WINES_CATALOG = env.catalogue || [], CONFIG = env.config;
  const { type, budget, pairing, detail, featuredIds } = body;
  const featuredSet = new Set(Array.isArray(featuredIds) ? featuredIds : []);

  if (!WINES_CATALOG.length) {
    return { status: 500, body: { error: 'catalogue non chargé' } };
  }
  // « fourchette » (facultative) : budget exact repéré dans une phrase du client
  // (chat de la borne hors connexion), à la place d'une tranche de la sélection guidée.
  const f = body.fourchette;
  const fourchetteValide = f && typeof f.min === 'number' && typeof f.max === 'number' && f.min >= 0 && f.max > f.min && f.max <= 100000;
  const bracket = fourchetteValide ? { min: f.min, max: f.max } : BUDGET_BRACKETS[budget];
  if (!bracket) {
    return { status: 400, body: { error: 'budget invalide' } };
  }

  // Nouveau parcours « Je cherche un vin pour… » : l'écran envoie une occasion.
  // Sans occasion (ancienne version de l'écran), on garde l'ancien fonctionnement ci-dessous.
  if (ACCORDS && body.occasion) {
    // Le moteur répond par res.json() : on lui passe une réponse « capturée ».
    const res = reponseCapturee();
    try {
      await ACCORDS.selectionGuidee(body, bracket, featuredSet, res, { catalogue: WINES_CATALOG, callApi, config: CONFIG, commercial: env.commercial || COMMERCIAL_NEUTRE });
    } catch (e) {
      console.error('Erreur moteur parcours guidé:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'parcours guidé indisponible' });
    }
    if (res.corps === undefined) return { status: 500, body: { error: 'parcours guidé indisponible' } };
    return { status: res.code, body: res.corps };
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

  // Pour la tranche "50€ et plus" (sans plafond), on limite le vivier envoyé
  // au sommelier à des prix raisonnables (jusqu'à 110€) pour ne pas partir sur
  // des cuvées d'exception dès le premier questionnaire.
  const closedBracket = bracket.max !== Infinity;
  const basePool = closedBracket ? pool : pool.filter(w => w.price <= 110);

  // ── Biais "tranche haute" ────────────────────────────────────────────────
  // Le client choisit une tranche fermée (ex. 15-25€) mais s'attend à des
  // propositions qui tirent vers le HAUT de cette tranche plutôt que
  // réparties uniformément — même logique que /sommelier (chat libre) où
  // le budget de référence est le max annoncé. On pondère donc la note par
  // la proximité au point de référence (75% de la tranche), sans jamais
  // exclure les vins moins chers : l'IA choisit ensuite selon l'accord.
  const ref = closedBracket ? bracket.min + (bracket.max - bracket.min) * 0.75 : null;
  const span = closedBracket ? Math.max(1, bracket.max - bracket.min) : 1;
  // Bonus "sélection magasin" : même ordre de grandeur que le biais tranche
  // haute (max 15) — ça augmente les chances qu'un vin mis en avant fasse
  // partie du vivier envoyé au sommelier, mais ne dicte jamais SON choix parmi
  // ce vivier : le raisonnement accord/structure reste géré exclusivement
  // par le prompt ci-dessous, jamais par ce score.
  const FEATURED_BONUS = 8;
  const scored = basePool.map(w => {
    const proximityBonus = ref !== null ? Math.max(0, 1 - Math.abs(w.price - ref) / span) * 15 : 0;
    const featuredBonus = featuredSet.has(w.id) ? FEATURED_BONUS : 0;
    return { w, score: proximityBonus + featuredBonus };
  });

  const candidates = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(s => s.w);

  // ── Repli sans IA : on choisit 3 vins à prix croissants dans le vivier,
  //    puis on leur assigne un rôle par heuristique simple (le moins cher
  //    des trois = valeur sûre).
  const fallbackWines = candidates.slice().sort((a, b) => a.price - b.price).slice(0, 3);
  const fallbackIds = fallbackWines.map(w => w.id);
  const fallbackRoles = (() => {
    if (fallbackWines.length < 3) return {};
    const roles = { [fallbackWines[0].id]: 'valeur_sure' };
    const rest = fallbackWines.slice(1);
    roles[rest[0].id] = 'coup_de_coeur';
    roles[rest[1].id] = 'decouverte';
    return roles;
  })();

  if (!candidates.length) {
    return { status: 200, body: { ids: fallbackIds, roles: fallbackRoles, reasons: {} } };
  }

  const fmt = w => '\n  ID:' + w.id + ' | ' + (w.libelle || w.name) + ' | ' + w.price + '€ | ' + w.region +
    ' | cépage: ' + w.grape + ' | dégustation: ' + w.tastingNotes +
    (featuredSet.has(w.id) ? ' | [MIS EN AVANT PAR LE MAGASIN]' : '');

  const system = 'Tu es le sommelier de la borne WineSelect (sans prénom), sommelier expert. Un client a choisi, via un questionnaire guidé : ' +
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
    '  - "valeur_sure" : vin fiable, typique de son appellation/cépage, bon rapport qualité-prix — le choix sans surprise.\n' +
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
    if (data.error || !data.choices || !data.choices.length) throw new Error((data.error && data.error.message) || data.message || 'réponse API inattendue');
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
      return { status: 200, body: { ids: fallbackIds, roles: fallbackRoles, reasons: {} } };
    }
    console.log('✅ /selection-accord →', parsed.ids.map(id => id + ':' + parsed.roles[id]).join(', '));
    return { status: 200, body: { ids: parsed.ids, roles: parsed.roles, reasons: parsed.reasons || {} } };
  } catch (e) {
    console.error('Erreur /selection-accord:', e.message, '→ repli sur sélection automatique');
    return { status: 200, body: { ids: fallbackIds, roles: fallbackRoles, reasons: {} } };
  }
}

// ── Helper HTTPS ──────────────────────────────────────────────────────────────
// Rejette toute réponse non-2xx avec le message de Mistral : avant, une erreur
// (429, 401, 5xx…) arrivait sans champ "choices" et faisait planter
// data.choices[0] avec un message incompréhensible. Un 429 ou 5xx est retenté
// une fois après 1,5 s (pic de trafic ponctuel).
function appelHttps({ hostname, path, headers, payload }, tentative = 1) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers, timeout: 30000 }, apiRes => {
      let data = '';
      apiRes.setEncoding('utf-8'); // évite de casser un accent coupé entre deux paquets
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        const status = apiRes.statusCode;
        if (status >= 200 && status < 300) return resolve(data);

        let detail = '';
        try {
          const j = JSON.parse(data);
          detail = j.message || (j.error && j.error.message) || '';
          if (typeof detail !== 'string') detail = JSON.stringify(detail).slice(0, 200);
        } catch (e) { detail = data.slice(0, 200); }

        if ((status === 429 || status >= 500) && tentative < 2) {
          console.warn('⚠️  Mistral HTTP ' + status + ' → nouvel essai dans 1,5 s');
          return setTimeout(() => {
            appelHttps({ hostname, path, headers, payload }, tentative + 1).then(resolve, reject);
          }, 1500);
        }
        reject(new Error('Mistral HTTP ' + status + (detail ? ' — ' + detail : '')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Mistral : délai de 30 s dépassé')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  libelleVin,
  avecLibelles,
  repondreSommelier,
  selectionAccord,
  couleursConseillees,
  profilsVins,
  callApi: appelHttps,
  detectBudget,
  parseBudget,
  plafondBudget,
  detectPairing,
  BUDGET_BRACKETS,
};
