const express = require('express');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = 3000;

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

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'WineSelect.html')));

// ── Chargement du catalogue ───────────────────────────────────────────────────
let WINES_CATALOG = [];

function loadCatalog() {
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.html'));
    for (const file of files) {
      const html = fs.readFileSync(path.join(__dirname, file), 'utf-8');
      const m = html.match(/window\.WINES_DATA=(\[.+?\]);/s) ||
                html.match(/window\.WINES_DATA = (\[.+?\]);/s);
      if (m) {
        WINES_CATALOG = JSON.parse(m[1]);
        console.log('📦 Catalogue:', WINES_CATALOG.length, 'vins depuis', file);
        return;
      }
    }
    console.warn('⚠️  Catalogue non trouvé');
  } catch(e) {
    console.warn('⚠️  Erreur catalogue:', e.message);
  }
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
    { p: 'apéritif',       r: /apéro|apéritif|mise en bouche|tapas|verrines|amuse.?bouche|avant le repas|canapé|grignotage/ },
    { p: 'barbecue',       r: /barbecue|barbec|bbq|grill|plancha|brochette|merguez|saucisse grillée|grillades|ribs|burgers?/ },
    { p: 'méditerranéen',  r: /méditerranéen|pizza|pasta|pâtes|risotto|ratatouille|niçoise|provençal|couscous|paella|moussaka|lasagnes?|tapenade/ },
    { p: 'asiatique',      r: /asiatique|sushi|japonais|thaï|curry|wok|chinois|coréen|vietnamien|indien|pad thaï|ramen|pho|gyoza|bibimbap/ },
    { p: 'fête',           r: /anniversaire|fête|mariage|célébration|réveillon|noël|nouvel an|baptême|communion|cadeau|événement/ },
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
app.post('/sommelier', async (req, res) => {
  const { messages, system } = req.body;

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
          return b.rating - a.rating;
        }).slice(0, 5);
      });
      available = tierWines.flat();
    } else {
      available = WINES_CATALOG
        .filter(w => pairingOk(w))
        .sort((a, b) => b.rating - a.rating)
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
      const rules = {
        'poisson':       'UNIQUEMENT blancs secs ou rosés très légers. AUCUN rouge.',
        'fruits de mer': 'UNIQUEMENT blancs vifs, rosés très secs, ou bulles. AUCUN rouge.',
        'volaille':      'Blancs ronds ou rouges très légers (Gamay, Pinot Noir léger).',
        'viande':        'UNIQUEMENT rouges structurés. Pas de blanc.',
        'barbecue':      'Rouges fruités ou rosés charnus. Pas de blanc.',
        'fromage':       'Blanc ou rouge léger selon le fromage.',
        'dessert':       'Vins doux (Banyuls, Sauternes, Muscat) ou bulles demi-sec.',
        'apéritif':      'Bulles, blancs vifs, rosés légers.',
        'méditerranéen': 'Rouges légers, rosés ou blancs du sud.',
        'asiatique':     'Blancs aromatiques (Gewurztraminer, Viognier, Riesling).',
        'charcuterie':   'Rouges fruités ou rosés généreux.',
        'fête':          'Champagne, Crémant, ou blancs festifs.',
      };
      inject += '\nACCORD : ' + (rules[pairing] || 'adapte le vin au plat.');
    }

    if (available.length >= 3) {
      inject += '\nVINS DISPONIBLES — RÈGLE ABSOLUE : tes 3 propositions doivent EXCLUSIVEMENT provenir de ces listes.';
      inject += '\nIgnore tout autre vin du catalogue général, même s\'il te semble pertinent. Proposer un vin hors liste est une erreur grave.';
      const fmt = w => '\n  ID:' + w.id + ' | ' + w.name + ' | ' + w.type + ' | ' + w.price + '€ | ' + w.region + ' | Note:' + w.rating;
      if (tierWines) {
        inject += '\nCandidats pour le vin 🥇 :'; tierWines[0].forEach(w => inject += fmt(w));
        inject += '\nCandidats pour le vin ⭐ :';  tierWines[1].forEach(w => inject += fmt(w));
        inject += '\nCandidats pour le vin ✨ :';  tierWines[2].forEach(w => inject += fmt(w));
      } else {
        available.forEach(w => inject += fmt(w));
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
app.listen(PORT, () => {
  loadCatalog();
  console.log('\n🍷  Wine Select — Serveur Gabriel');
  console.log('──────────────────────────────────');
  console.log('   http://localhost:' + PORT);
  console.log('   Modèle : ' + CONFIG.model);
  console.log('   Clé API : ' + CONFIG.apiKey.substring(0, 8) + '...  ✅');
  console.log('──────────────────────────────────\n');
});
