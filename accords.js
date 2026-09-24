'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  ACCORDS.JS — moteur d'accords mets-vins de Gabriel
//
//  1. analyserPlat()  : l'IA décrit ce que le plat DEMANDE (corps, gras,
//                       sauce, acidité, sucre, épices...). Elle ne choisit
//                       aucun vin à cette étape.
//  2. noterVin()      : chaque vin reçoit une note de compatibilité avec le
//                       plat, calculée avec les règles de SA couleur (on ne
//                       compare jamais un rouge et un blanc entre eux, on
//                       compare chacun au plat).
//  3. choisirDecouverte() : de temps en temps, et seulement si l'accord est
//                       vraiment bon, un vin d'une autre couleur que celle
//                       attendue est proposé comme découverte.
//
//  Les profils des vins viennent de profils-reference.js (champ "profil"
//  de wines-data.js, calculé à la volée s'il est absent).
// ═══════════════════════════════════════════════════════════════════════════

const { profilerVin, libelle } = require('./profils-reference.js');

const REGLAGES = {
  seuilCompatible: 65,     // note minimale pour être proposé
  decouverteProba: 0.5,    // « de temps en temps » : 1 fois sur 2 quand une découverte existe
  decouverteEcartMax: 10,  // la découverte doit être à moins de 10 points du meilleur vin
  decouverteNoteMin: 75,   // ... et avoir au moins 75
  prixMaxSansBudget: 45,   // sans budget annoncé, on reste grand public (sauf intention premium)
};

const LISTES = {
  proteine: ['boeuf', 'agneau', 'porc', 'veau', 'volaille', 'canard', 'gibier', 'poisson', 'fruits de mer',
    'oeuf', 'fromage', 'charcuterie', 'vegetal', 'dessert', 'aucun'],
  cuisson: ['cru', 'vapeur', 'poche', 'grille', 'roti', 'poele', 'frit', 'mijote', 'gratine', 'aucune'],
  sauce: ['aucune', 'creme', 'beurre', 'vin rouge', 'vin blanc', 'tomate', 'sucre sale', 'curry coco',
    'pimentee', 'moutarde', 'champignons', 'fromage', 'agrumes', 'herbes', 'autre'],
  couleur: ['rouge', 'blanc', 'rosé', 'bulles'],
};

// ── 1. Analyse du plat ──────────────────────────────────────────────────────
const PROMPT_ANALYSE =
  'Tu es sommelier. On te donne la conversation d\'un client avec une borne de conseil en vin. ' +
  'Décris UNIQUEMENT le plat qu\'il veut accompagner (le dernier plat évoqué), sans proposer de vin. ' +
  'Raisonne sur la recette réelle : un hachis parmentier est un bœuf mijoté sous une purée beurrée gratinée, ' +
  'un poulet aux morilles est une volaille en sauce crème aux champignons, un poulet rôti une chair maigre au jus. ' +
  'Réponds UNIQUEMENT en JSON avec EXACTEMENT ces clés :\n' +
  '{\n' +
  '  "present": true si un plat, un aliment ou un moment de repas précis est évoqué, sinon false,\n' +
  '  "plat": "nom court du plat",\n' +
  '  "proteine": "' + LISTES.proteine.join('|') + '",\n' +
  '  "cuisson": "' + LISTES.cuisson.join('|') + '",\n' +
  '  "sauce": "' + LISTES.sauce.join('|') + '",\n' +
  '  "corps": 1 léger, 2 moyen, 3 riche et puissant,\n' +
  '  "gras": 0 à 3,\n' +
  '  "acidite": 0 à 3 (tomate, citron, vinaigrette, câpres...),\n' +
  '  "sucre": 0 aucun, 1 sucré-salé (teriyaki, canard à l\'orange, miel), 2 dessert peu sucré, 3 dessert très sucré,\n' +
  '  "epice": 0 à 3 (piquant : piment, poivre fort),\n' +
  '  "aromatique": 0 à 3 (épices parfumées, herbes, gingembre, citronnelle, curry doux),\n' +
  '  "iode": 0 à 3 (huîtres, coquillages, algues),\n' +
  '  "sousbois": 0 à 3 (champignons, truffe, noix, fromages affinés),\n' +
  '  "intensite": 1 à 3 (intensité de goût globale),\n' +
  '  "affinite_moelleux": true si un vin moelleux peut classiquement l\'accompagner (foie gras, bleu, cuisine épicée ou sucrée-salée), sinon false,\n' +
  '  "region": "région viticole française d\'origine du plat s\'il en a une (Alsace, Bourgogne, Sud-Ouest, Provence...), sinon null",\n' +
  '  "couleur_demandee": "rouge|blanc|rosé|bulles" si le client impose une couleur, sinon null,\n' +
  '  "sucrosite_demandee": 0 sec, 1 demi-sec, 2 moelleux, 3 liquoreux si le client demande explicitement un style, sinon null,\n' +
  '  "resume": "une phrase : ce qui guide l\'accord (ex. plat mijoté riche et beurré, peu acide)"\n' +
  '}';

async function analyserPlat(messages, appelIA) {
  const derniers = messages.filter(m => m.role === 'user').slice(-3).map(m => m.content).join('\n');
  if (!derniers.trim()) return null;
  const cle = derniers.toLowerCase().trim();
  if (cacheAnalyse.has(cle)) return cacheAnalyse.get(cle);

  const texte = await appelIA([
    { role: 'system', content: PROMPT_ANALYSE },
    { role: 'user', content: derniers },
  ]);
  const m = String(texte || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[0]); } catch (e) { return null; }
  d = nettoyer(d);
  if (cacheAnalyse.size > 300) cacheAnalyse.delete(cacheAnalyse.keys().next().value);
  cacheAnalyse.set(cle, d);
  return d;
}
const cacheAnalyse = new Map();

function nettoyer(d) {
  const n = (v, lo, hi, def) => { const x = parseInt(v, 10); return isNaN(x) ? def : Math.max(lo, Math.min(hi, x)); };
  const s = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const dans = (v, liste, def) => { const x = s(v); return liste.map(s).includes(x) ? x : def; };
  const couleur = d.couleur_demandee ? String(d.couleur_demandee).toLowerCase().replace('rose', 'rosé').replace('roséé', 'rosé') : null;
  return {
    present: d.present !== false,
    plat: String(d.plat || '').slice(0, 80),
    proteine: dans(d.proteine, LISTES.proteine, 'aucun'),
    cuisson: dans(d.cuisson, LISTES.cuisson, 'aucune'),
    sauce: dans(d.sauce, LISTES.sauce, 'aucune'),
    corps: n(d.corps, 1, 3, 2), gras: n(d.gras, 0, 3, 1), acidite: n(d.acidite, 0, 3, 0),
    sucre: n(d.sucre, 0, 3, 0), epice: n(d.epice, 0, 3, 0), aromatique: n(d.aromatique, 0, 3, 0),
    iode: n(d.iode, 0, 3, 0), sousbois: n(d.sousbois, 0, 3, 0), intensite: n(d.intensite, 1, 3, 2),
    affinite_moelleux: d.affinite_moelleux === true,
    region: d.region ? String(d.region).slice(0, 40) : null,
    couleur_demandee: LISTES.couleur.includes(couleur) ? couleur : null,
    sucrosite_demandee: d.sucrosite_demandee == null ? null : n(d.sucrosite_demandee, 0, 3, null),
    resume: String(d.resume || '').slice(0, 200),
  };
}

// ── 2. Note de compatibilité ────────────────────────────────────────────────
// Base 40, puis bonus/malus (pas de plafond : ça départage les bons vins).
// Un interdit absolu renvoie -100.
function noterVin(wine, d) {
  const p = wine.profil || (wine.profil = profilerVin(wine));
  const t = wine.type;
  const plus = [], moins = [];
  let s = 40;
  const add = (v, raison) => { s += v; if (raison) (v >= 0 ? plus : moins).push(raison); };
  const veto = raison => ({ score: -100, plus: [], moins: [raison] });

  const mer = d.proteine === 'poisson' || d.proteine === 'fruits de mer';
  const viandeRouge = ['boeuf', 'agneau', 'gibier', 'canard'].includes(d.proteine);
  const dessert = d.proteine === 'dessert' || d.sucre >= 2;
  const creme = ['creme', 'beurre', 'fromage', 'champignons'].includes(d.sauce);
  const tendre = ['mijote', 'gratine', 'poche'].includes(d.cuisson);
  const foieGrasOuBleu = d.affinite_moelleux && d.gras >= 3 && ['canard', 'fromage'].includes(d.proteine);
  // Plat très gras : un vin vif et plus léger « allège » (fondue + Apremont, choucroute + Riesling)
  const allege = d.gras >= 3 && p.fraicheur === 3 && (t === 'blanc' || t === 'bulles');

  // ─ Interdits absolus
  if (t === 'rouge' && mer && (d.cuisson === 'cru' || d.iode >= 2)) return veto('rouge sur produit de la mer cru ou iodé');
  if (t === 'rouge' && mer && p.tanins >= 2) return veto('tanins et poisson donnent un goût métallique');
  if (dessert && d.sucre >= 2 && p.sucrosite === 0) return veto('vin sec sur un dessert sucré');
  if (d.sucrosite_demandee != null && Math.abs(p.sucrosite - d.sucrosite_demandee) >= 2) return veto('pas le style demandé par le client');

  // ─ Socle commun : corps, intensité, sucre
  const dc = Math.max(0, Math.abs(p.corps - d.corps) - (allege ? 1 : 0));
  add([22, 8, -15][dc], ['corps à la hauteur du plat', 'corps proche du plat', 'corps décalé avec le plat'][dc]);
  const di = Math.abs(p.intensite - d.intensite);
  add([8, 3, -6][di], di === 0 ? 'même intensité que le plat' : di === 2 ? 'intensité décalée' : null);

  if (d.sucrosite_demandee != null) {
    add(p.sucrosite === d.sucrosite_demandee ? 20 : 0, p.sucrosite === d.sucrosite_demandee ? 'le style demandé' : null);
  }
  if (dessert) {
    if (p.sucrosite >= d.sucre) add(20, 'au moins aussi doux que le dessert');
    else if (p.sucrosite === d.sucre - 1) add(8, 'douceur proche du dessert');
  } else if (foieGrasOuBleu) {
    if (p.sucrosite >= 2) add(t === 'blanc' ? 22 : 10, 'accord doux classique');
    else if (t === 'rouge') add(-8, null);
  } else if (d.sucre === 1) {
    add([0, 12, 6, -10][p.sucrosite], ['', 'sa douceur répond au sucré-salé', 'sa douceur répond au sucré-salé', 'trop liquoreux pour un plat salé'][p.sucrosite] || null);
  } else if (p.sucrosite >= 2 && d.sucrosite_demandee == null) {
    if (d.affinite_moelleux && p.sucrosite === 2) add(8, 'moelleux qui calme les épices');
    else add(-25, 'trop sucré pour ce plat');
  }

  // ─ Gras, acidité, épices : règles communes appliquées selon la structure
  if (d.gras >= 2 && p.fraicheur === 3) add(10, 'sa fraîcheur coupe le gras');
  if (d.gras >= 2 && p.fraicheur === 1 && p.sucrosite === 0) add(-8, 'manque de fraîcheur face au gras');
  if (d.acidite >= 2) add(p.fraicheur >= 2 ? (p.fraicheur === 3 ? 8 : 2) : -15,
    p.fraicheur === 3 ? 'acidité qui tient face au plat acide' : p.fraicheur === 1 ? 'trop mou face à l\'acidité du plat' : null);
  if (d.region && wine.region && String(wine.region).toLowerCase().includes(String(d.region).toLowerCase())) {
    add(18, 'accord de terroir (' + wine.region + ')');
  }
  if (allege) {
    add(15, 'vivacité qui allège un plat riche');
  }

  // ─ Règles propres à chaque couleur
  if (t === 'rouge') {
    if (mer) add(p.fraicheur === 3 ? -5 : -20, 'rouge sur poisson : seulement très léger et frais');
    if (d.epice >= 2 && p.tanins >= 2) add(-20, 'tanins exacerbés par le piquant');
    if (d.epice >= 2 && p.boise === 2) add(-8, 'boisé qui chauffe avec les épices');
    if (viandeRouge && d.corps >= 2 && p.tanins >= 2) {
      // viande saisie : tanins fermes bienvenus ; viande mijotée/hachée : tanins présents, pas fermes
      const bonus = tendre ? (p.tanins === 2 ? 12 : 2) : (p.tanins === 3 ? 12 : 10);
      add(bonus, 'tanins qui accompagnent la viande');
    }
    if (tendre && viandeRouge && p.tanins === 1 && p.fruit >= 2) add(6, 'rouge souple et fruité pour un plat mijoté');
    if (d.gras >= 2 && p.tanins >= 2 && !mer) add(6, 'tanins qui nettoient le gras');
    if (d.sauce === 'vin rouge') add(15, 'sauce au vin rouge');
    if (creme && p.tanins === 3) add(-12, 'tanins fermes durs sur la crème');
    if (creme && p.tanins === 1) add(4, 'tanins souples compatibles avec la sauce');
    if (d.proteine === 'volaille' && p.tanins === 1) add(8, 'rouge souple sur volaille');
    if (['grille', 'roti'].includes(d.cuisson) && p.boise >= 1) add(4, 'élevage qui répond au rôti/grillé');
    if (['mijote', 'gratine'].includes(d.cuisson) && p.fruit >= 2) add(5, 'fruit mûr pour un plat mijoté');
    if (['cru', 'vapeur', 'poche'].includes(d.cuisson) && p.boise === 2) add(-10, 'boisé trop marqué pour une cuisson douce');
    if (d.proteine === 'fromage' && p.tanins === 3) add(-6, 'tanins fermes sur fromage');
    if (d.sousbois >= 2 && p.corps >= 2 && p.fruit >= 2) add(6, 'répond au sous-bois');
    if (d.proteine === 'dessert' && p.sucrosite >= 2 && /chocolat|cafe|caramel/i.test(d.plat)) add(15, 'vin doux naturel et chocolat');
  }

  if (t === 'blanc') {
    if (mer) add(10, 'blanc sur produit de la mer');
    if (d.iode >= 2 && p.mineralite === 3) add(12, 'minéralité qui prolonge l\'iode');
    if (mer && p.mineralite >= 2 && p.boise === 0) add(4, null);
    if (creme && p.texture >= 2) add(12, 'texture ronde pour la sauce');
    if (creme && p.boise >= 1) add(4, 'élevage qui accompagne la crème');
    if (d.gras >= 2 && p.texture === 1 && p.fraicheur === 3) add(3, null);
    if ((d.epice >= 1 || d.aromatique >= 2) && p.aromatique === 3) add(12, 'aromatique qui répond aux épices');
    if (d.intensite === 1 && p.aromatique === 3) add(-10, 'trop exubérant pour un plat délicat');
    if (p.oxydatif) add(d.sousbois >= 2 || d.proteine === 'fromage' || (d.proteine === 'volaille' && creme) ? 20 : -15,
      d.sousbois >= 2 || d.proteine === 'fromage' || creme ? 'accord classique du vin jaune' : 'style oxydatif trop typé ici');
    if (viandeRouge && d.corps >= 2) add(p.texture === 3 && p.corps === 3 ? -4 : -18, 'blanc face à une viande rouge');
    if (d.sauce === 'vin rouge') add(-15, 'sauce au vin rouge');
    if (d.proteine === 'volaille') add(6, 'blanc sur volaille');
    if (['volaille', 'veau', 'porc'].includes(d.proteine) && ['roti', 'grille', 'poele'].includes(d.cuisson) && p.texture >= 2) add(8, 'rondeur sur la chair rôtie');
    if (d.proteine === 'dessert' && /chocolat|cafe/i.test(d.plat)) add(-12, 'blanc liquoreux moins juste sur le chocolat');
    if (d.sousbois >= 2 && p.texture >= 2) add(5, 'rondeur sur le sous-bois');
  }

  if (t === 'rosé') {
    if (p.style === 3 && d.corps >= 2) add(5, 'rosé vineux qui tient le plat');
    if (p.style === 1 && d.corps === 3) add(-12, 'rosé trop léger pour ce plat');
    if (!dessert && (d.cuisson === 'grille' || d.sauce === 'tomate')) add(6, 'rosé sur grillades / tomate');
    if (!dessert && (d.epice >= 1 || d.aromatique >= 2)) add(5, 'fruit qui accompagne les épices');
    if (creme) add(-10, 'rosé peu à l\'aise sur une sauce crème');
    if (d.proteine === 'fromage') add(-8, null);
    if (mer && d.cuisson === 'cru') add(-8, null);
    if (d.sauce === 'vin rouge' || (viandeRouge && d.corps === 3)) add(-10, null);
  }

  if (t === 'bulles') {
    const contexteBulles = d.cuisson === 'frit' || d.iode >= 2 || creme || dessert || d.proteine === 'aucun';
    if (!contexteBulles) add(-8, null);
    if (d.cuisson === 'frit') add(15, 'bulles et friture');
    if (d.iode >= 2 && p.dosage <= 1) add(10, 'bulles vives sur l\'iode');
    if (p.vinosite === 3 && d.corps >= 2) add(8, 'bulles vineuses qui tiennent le plat');
    if (creme && p.evolution === 2) add(5, 'notes briochées sur la crème');
    if (viandeRouge && d.corps === 3) add(-15, 'bulles trop légères pour ce plat');
    if (d.sauce === 'vin rouge' || ['mijote'].includes(d.cuisson) && d.corps === 3) add(-10, null);
    if (d.epice >= 2) add(-5, null);
  }

  return { score: Math.max(-99, Math.round(s)), plus, moins };
}

// ── 3. Découverte d'une autre couleur (occasionnelle) ───────────────────────
function choisirDecouverte(notes, d, aleatoire) {
  if (d.couleur_demandee) return null;                 // le client a choisi sa couleur : on la respecte
  const hasard = aleatoire != null ? aleatoire : Math.random();
  if (hasard > REGLAGES.decouverteProba) return null;  // seulement de temps en temps
  if (!notes.length) return null;
  const top = notes.slice(0, 5);
  const attendues = new Set(top.map(n => n.wine.type));
  const meilleur = notes[0].score;
  return notes.find(n => !attendues.has(n.wine.type) &&
    n.score >= REGLAGES.decouverteNoteMin &&
    n.score >= meilleur - REGLAGES.decouverteEcartMax) || null;
}

// ── Description courte d'un profil (pour le prompt de Gabriel) ──────────────
const AXES_PROMPT = {
  rouge: ['corps', 'tanins', 'fraicheur', 'fruit', 'boise'],
  blanc: ['corps', 'texture', 'fraicheur', 'aromatique', 'mineralite', 'boise'],
  'rosé': ['corps', 'style', 'fraicheur', 'fruit'],
  bulles: ['dosage', 'vinosite', 'evolution'],
};
const NOMS = { corps: 'corps', tanins: 'tanins', fraicheur: 'fraîcheur', fruit: 'fruit', boise: 'boisé',
  texture: 'texture', aromatique: 'aromatique', mineralite: 'minéralité', style: 'style',
  dosage: 'dosage', vinosite: 'vinosité', evolution: 'évolution' };

function decrireProfil(wine) {
  const p = wine.profil || profilerVin(wine);
  const t = wine.type;
  const parts = (AXES_PROMPT[t] || []).map(ax => NOMS[ax] + ' ' + libelle(t, ax, p[ax]));
  if (t !== 'bulles' && p.sucrosite > 0) parts.push(libelle(t, 'sucrosite', p.sucrosite));
  if (t === 'blanc' && p.oxydatif) parts.push('style oxydatif');
  return parts.join(', ');
}

const JOLI = {
  cru: 'cru', vapeur: 'vapeur', poche: 'poché', grille: 'grillé', roti: 'rôti', poele: 'poêlé', frit: 'frit',
  mijote: 'mijoté', gratine: 'gratiné', creme: 'crème', beurre: 'beurre', 'vin rouge': 'au vin rouge',
  'vin blanc': 'au vin blanc', tomate: 'tomate', 'sucre sale': 'sucrée-salée', 'curry coco': 'curry coco',
  pimentee: 'pimentée', moutarde: 'moutarde', champignons: 'aux champignons', fromage: 'au fromage',
  agrumes: 'aux agrumes', herbes: 'aux herbes', autre: 'particulière',
};
function decrirePlat(d) {
  const bits = [d.plat];
  if (d.sauce && d.sauce !== 'aucune') bits.push('sauce ' + (JOLI[d.sauce] || d.sauce));
  if (d.cuisson && d.cuisson !== 'aucune') bits.push('cuisson ' + (JOLI[d.cuisson] || d.cuisson));
  bits.push('corps ' + ['', 'léger', 'moyen', 'riche'][d.corps]);
  if (d.gras >= 2) bits.push('gras');
  if (d.acidite >= 2) bits.push('acide');
  if (d.sucre === 1) bits.push('sucré-salé');
  if (d.sucre >= 2) bits.push('sucré');
  if (d.epice >= 2) bits.push('piquant');
  if (d.aromatique >= 2) bits.push('épices parfumées');
  if (d.iode >= 2) bits.push('iodé');
  if (d.sousbois >= 2) bits.push('notes de sous-bois');
  return bits.join(', ');
}

// ── 4. Candidats envoyés à Gabriel ──────────────────────────────────────────
// Même escalier de prix que l'ancien système (🥇 ≈ 80 % du max, ⭐ ≈ 100 %,
// ✨ ≈ 120 %, ou 80/90/100 % si plafond strict), mais les vins sont retenus
// et classés selon leur note d'accord avec le plat, plus selon une étiquette.
const PREMIUM = /peu importe le prix|grande occasion|grand cru|prestige|meilleur vin|sans limite|exceptionnel/i;

function construireCandidats(wines, d, budget, featuredSet, texteClient, aleatoire) {
  featuredSet = featuredSet || new Set();
  const bonusSel = w => featuredSet.has(w.id) ? 3 : 0;
  const notes = wines
    .filter(w => !d.couleur_demandee || w.type === d.couleur_demandee)
    .map(w => Object.assign({ wine: w }, noterVin(w, d)))
    .filter(n => n.score > -99)
    .sort((a, b) => (b.score + bonusSel(b.wine)) - (a.score + bonusSel(a.wine)) || b.wine.rating - a.wine.rating);
  const parId = new Map(notes.map(n => [n.wine.id, n]));

  // Vivier : les vins compatibles ; si le rayon est pauvre, les mieux notés quand même
  const compatibles = lst => {
    const ok = lst.filter(n => n.score >= REGLAGES.seuilCompatible);
    return ok.length >= 6 ? ok : lst.slice(0, Math.max(ok.length, 12));
  };

  let tierWines = null, available, fenetre;

  if (budget) {
    const ref = budget.ref || budget.max;
    const ratios = budget.strict ? [0.80, 0.90, 1.00] : [0.80, 1.00, 1.20];
    const tiers = ratios.map(r => ref * r);
    const ceiling = budget.max * (budget.strict ? 1.0 : 1.05);
    const dansBande = (n, lo) => n.wine.price >= lo && n.wine.price <= ceiling;
    fenetre = notes.filter(n => dansBande(n, budget.min * 0.95));
    let pool = compatibles(fenetre);
    if (pool.length < 6) { fenetre = notes.filter(n => dansBande(n, ref * 0.55)); pool = compatibles(fenetre); }

    const cut1 = (tiers[0] + tiers[1]) / 2, cut2 = (tiers[1] + tiers[2]) / 2;
    const bandes = [
      pool.filter(n => n.wine.price < cut1),
      pool.filter(n => n.wine.price >= cut1 && n.wine.price < cut2),
      pool.filter(n => n.wine.price >= cut2),
    ];
    tierWines = tiers.map((target, i) => {
      const cands = bandes[i].length ? bandes[i] : pool;
      const val = n => n.score + bonusSel(n.wine) - Math.abs(n.wine.price - target) / target * 20;
      return [...cands].sort((a, b) => val(b) - val(a)).slice(0, 5).map(n => n.wine);
    });
    available = [...new Set(tierWines.flat())];
    tierWines._tiers = tiers;
  } else {
    const plafond = PREMIUM.test(texteClient || '') ? Infinity : REGLAGES.prixMaxSansBudget;
    fenetre = notes.filter(n => n.wine.price <= plafond);
    available = compatibles(fenetre).slice(0, 15).map(n => n.wine);
  }

  // Découverte : un vin d'une autre couleur, seulement si l'accord est excellent
  let decouverte = null;
  const dec = choisirDecouverte(fenetre, d, aleatoire);
  if (dec && !available.includes(dec.wine)) {
    decouverte = dec.wine;
    if (tierWines) {
      const t = tierWines._tiers;
      const cut1 = (t[0] + t[1]) / 2, cut2 = (t[1] + t[2]) / 2;
      const i = dec.wine.price < cut1 ? 0 : dec.wine.price < cut2 ? 1 : 2;
      tierWines[i] = [...tierWines[i], dec.wine];
    }
    available = [...available, dec.wine];
  } else if (dec) {
    decouverte = dec.wine; // déjà présent dans la liste : on le signale simplement
  }

  return { tierWines, available, decouverte, notes: parId };
}

// Ligne d'un candidat dans le prompt de Gabriel
function ligneCandidat(w, note, featuredSet, decouverte) {
  const raisons = note ? note.plus.slice(0, 3).join(' ; ') : '';
  return '\n  ID:' + w.id + ' | ' + w.name + ' | ' + w.type + ' | ' + w.price + '€ | ' + (w.region || '') +
    ' | profil : ' + decrireProfil(w) +
    (note ? ' | accord ' + Math.min(100, note.score) + '/100' + (raisons ? ' : ' + raisons : '') : '') +
    (featuredSet && featuredSet.has(w.id) ? ' | [MIS EN AVANT PAR LE MAGASIN]' : '') +
    (decouverte && decouverte.id === w.id ? ' | [DÉCOUVERTE]' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
//  PARCOURS GUIDÉ — « Je cherche un vin pour… »
//    … l'apéritif / … offrir  → note de STYLE (goûts du client)
//    … accompagner un repas   → note d'ACCORD (noterVin, ci-dessus)
//    … cuisiner avec          → note de RECETTE (rôle du vin dans la recette)
// ═══════════════════════════════════════════════════════════════════════════

// Plats des boutons du questionnaire (catégorie + précision éventuelle) :
// profils écrits à la main, sans appel à l'IA → réponse immédiate.
const PLATS_CATEGORIES = {
  'viande':         { plat: 'viande rouge', proteine: 'boeuf', cuisson: 'roti', corps: 3, gras: 2, intensite: 3 },
  'viande/boeuf':   { plat: 'bœuf (steak, entrecôte, bourguignon...)', proteine: 'boeuf', cuisson: 'grille', corps: 3, gras: 2, intensite: 3 },
  'viande/agneau':  { plat: 'agneau', proteine: 'agneau', cuisson: 'roti', corps: 3, gras: 2, intensite: 3, aromatique: 1 },
  'viande/porcveau':{ plat: 'porc ou veau', proteine: 'porc', cuisson: 'roti', corps: 2, gras: 1, intensite: 2 },
  'viande/gibier':  { plat: 'gibier', proteine: 'gibier', cuisson: 'mijote', corps: 3, gras: 2, intensite: 3, sousbois: 2 },
  'volaille':       { plat: 'volaille', proteine: 'volaille', cuisson: 'roti', corps: 2, gras: 1, intensite: 2 },
  'volaille/grillee': { plat: 'volaille grillée ou rôtie', proteine: 'volaille', cuisson: 'roti', corps: 2, gras: 1, intensite: 2 },
  'volaille/sauce': { plat: 'volaille en sauce', proteine: 'volaille', cuisson: 'mijote', sauce: 'creme', corps: 3, gras: 2, intensite: 2 },
  'volaille/canard':{ plat: 'canard (magret, confit)', proteine: 'canard', cuisson: 'grille', corps: 3, gras: 3, intensite: 3 },
  'poisson':        { plat: 'poisson', proteine: 'poisson', cuisson: 'poele', corps: 1, gras: 1, intensite: 1 },
  'poisson/cru':    { plat: 'poisson cru (sushi, carpaccio)', proteine: 'poisson', cuisson: 'cru', corps: 1, gras: 1, iode: 1, intensite: 1 },
  'poisson/grille': { plat: 'poisson grillé ou au four', proteine: 'poisson', cuisson: 'grille', corps: 2, gras: 1, intensite: 2 },
  'poisson/sauce':  { plat: 'poisson en sauce', proteine: 'poisson', cuisson: 'poche', sauce: 'beurre', corps: 2, gras: 2, intensite: 2 },
  'fruits de mer':      { plat: 'fruits de mer', proteine: 'fruits de mer', cuisson: 'poche', corps: 1, gras: 0, iode: 2, intensite: 2 },
  'fruits de mer/cru':  { plat: 'fruits de mer crus (huîtres)', proteine: 'fruits de mer', cuisson: 'cru', corps: 1, gras: 0, iode: 3, intensite: 2 },
  'fruits de mer/cuit': { plat: 'fruits de mer cuits (crevettes, moules)', proteine: 'fruits de mer', cuisson: 'poche', corps: 1, gras: 1, iode: 1, intensite: 2 },
  'fromage':        { plat: 'fromage', proteine: 'fromage', corps: 2, gras: 2, intensite: 2 },
  'fromage/frais':  { plat: 'fromage frais (chèvre, mozzarella)', proteine: 'fromage', corps: 1, gras: 1, acidite: 1, intensite: 1 },
  'fromage/molle':  { plat: 'fromage à pâte molle (brie, camembert)', proteine: 'fromage', corps: 2, gras: 3, intensite: 2 },
  'fromage/dure':   { plat: 'fromage à pâte dure (comté, gruyère)', proteine: 'fromage', corps: 3, gras: 2, sousbois: 1, intensite: 3 },
  'fromage/bleu':   { plat: 'fromage bleu (roquefort)', proteine: 'fromage', corps: 3, gras: 3, intensite: 3, affinite_moelleux: true },
  'charcuterie':    { plat: 'charcuterie', proteine: 'charcuterie', corps: 2, gras: 2, intensite: 2 },
  'dessert':        { plat: 'dessert', proteine: 'dessert', sucre: 2, corps: 2, intensite: 2 },
  'méditerranéen':  { plat: 'cuisine méditerranéenne', proteine: 'aucun', sauce: 'tomate', corps: 2, acidite: 2, aromatique: 2, intensite: 2 },
  'asiatique':      { plat: 'cuisine asiatique', proteine: 'volaille', cuisson: 'poele', corps: 2, epice: 1, aromatique: 2, sucre: 1, intensite: 3, affinite_moelleux: true },
  'barbecue':       { plat: 'barbecue, grillades', proteine: 'porc', cuisson: 'grille', corps: 3, gras: 2, intensite: 3 },
};
function platDepuisCategorie(pairing, detailId) {
  const base = PLATS_CATEGORIES[pairing + '/' + detailId] || PLATS_CATEGORIES[pairing];
  return base ? nettoyer(Object.assign({ present: true }, base)) : null;
}

// ── Goûts (apéritif, offrir) ────────────────────────────────────────────────
const GOUTS = {
  leger_frais:     'léger et frais',
  fruite_gourmand: 'fruité et gourmand',
  riche_intense:   'riche et intense',
  doux:            'doux',
  inconnu:         'sans préférence',
};

function noterStyle(wine, gout, occasion) {
  const p = wine.profil || (wine.profil = profilerVin(wine));
  const t = wine.type;
  const plus = [], moins = [];
  let s = 40;
  const add = (v, r) => { s += v; if (r) (v >= 0 ? plus : moins).push(r); };
  const tanins = t === 'rouge' ? p.tanins : 0;
  const fruit = p.fruit || 0;

  if (gout === 'leger_frais') {
    add([0, 20, 6, -15][p.corps], p.corps === 1 ? 'léger comme demandé' : null);
    if (p.fraicheur === 3) add(15, 'belle fraîcheur');
    if (t === 'rouge') add(tanins <= 1 ? 8 : tanins === 3 ? -20 : -5, tanins <= 1 ? 'tanins souples' : null);
    if (p.sucrosite >= 2) add(-20, null);
    if (p.boise === 2) add(-10, null);
  } else if (gout === 'fruite_gourmand') {
    add([0, 4, 18, 4][p.corps], p.corps === 2 ? 'rond et gourmand' : null);
    if ((t === 'rouge' || t === 'rosé') && fruit >= 2) add(12, 'plein de fruit');
    if (t === 'blanc' && p.texture >= 2 && p.aromatique >= 2) add(10, 'fruité et rond');
    if (t === 'bulles' && p.evolution === 1) add(6, 'bulles fruitées');
    if (tanins === 3) add(-10, null);
    if (p.sucrosite >= 2) add(-12, null);
  } else if (gout === 'riche_intense') {
    add([0, -15, 6, 20][p.corps], p.corps === 3 ? 'ample, de la matière' : null);
    if (p.intensite === 3) add(15, 'beaucoup de caractère');
    if (p.boise >= 1) add(4, null);
    if (t === 'bulles' && p.vinosite === 3) add(8, 'bulles vineuses');
    if (p.sucrosite >= 2) add(-10, null);
  } else if (gout === 'doux') {
    if (p.sucrosite === 0) return { score: -100, plus: [], moins: ['vin sec'] };
    add(p.sucrosite === 1 ? 15 : 20, 'une douceur comme demandé');
  } else { // inconnu : des vins consensuels
    if (p.corps <= 2) add(10, 'facile à apprécier');
    if (p.fraicheur >= 2) add(6, null);
    if (tanins <= 2) add(5, null);
    if (p.sucrosite <= 1) add(5, null);
    if (p.intensite === 2) add(5, null);
    if (p.oxydatif) add(-15, null);
  }

  if (occasion === 'aperitif') {
    add({ bulles: 10, blanc: 6, 'rosé': 6, rouge: 0 }[t] || 0, t === 'bulles' ? 'bulles, l\'apéritif par excellence' : null);
    if (tanins === 3) add(-12, 'trop tannique sans rien à manger');
    if (p.boise === 2) add(-8, null);
    if (p.sucrosite === 3 && gout !== 'doux') add(-12, null);
    if (p.corps === 3 && gout !== 'riche_intense') add(-8, null);
  }
  if (occasion === 'offrir') {
    add(Math.round(((wine.rating || 85) - 85) * 1.5), (wine.rating || 0) >= 90 ? 'une cuvée reconnue, idéale à offrir' : null);
    if (p.source === 'appellation' || p.source === 'manuel') add(4, null);
    if (p.oxydatif && gout === 'inconnu') add(-10, null);
  }
  return { score: Math.round(s), plus, moins };
}

// ── Recettes (cuisiner avec) ────────────────────────────────────────────────
const RECETTES = {
  bourguignon: { plat: 'bœuf bourguignon', couleur: 'rouge', region: 'Bourgogne', corps: 2, eviter_tanins: true,
    resume: 'longue cuisson au vin rouge : un rouge fruité, pas trop tannique ni boisé' },
  coq_au_vin:  { plat: 'coq au vin', couleur: 'rouge', region: 'Bourgogne', corps: 2, eviter_tanins: true,
    resume: 'volaille mijotée au vin rouge : un rouge souple et fruité' },
  moules:      { plat: 'moules marinières', couleur: 'blanc', region: 'Loire', corps: 1, eviter_aromatique: true,
    resume: 'cuisson courte au vin blanc : un blanc sec et vif' },
  risotto:     { plat: 'risotto', couleur: 'blanc', region: null, corps: 2, eviter_aromatique: true,
    resume: 'déglaçage au vin blanc : un blanc sec, neutre, sans boisé' },
  fondue:      { plat: 'fondue savoyarde', couleur: 'blanc', region: 'Savoie', corps: 1, eviter_aromatique: true,
    resume: 'le vin blanc fond le fromage : un blanc sec et vif' },
  sauce:       { plat: 'sauce ou déglaçage', couleur: null, region: null, corps: 2, eviter_aromatique: true,
    resume: 'réduction d\'une sauce : un vin sec, simple, ni tannique ni boisé' },
};

const PROMPT_RECETTE =
  'Tu es sommelier et cuisinier. Un client veut acheter du vin POUR CUISINER la recette indiquée. ' +
  'Dis quel vin la recette demande. Réponds UNIQUEMENT en JSON avec EXACTEMENT ces clés :\n' +
  '{\n' +
  '  "plat": "nom court de la recette",\n' +
  '  "contient_vin": true si la recette classique utilise du vin, sinon false,\n' +
  '  "couleur": "rouge|blanc|rosé|doux" (doux = vin moelleux, liquoreux ou vin doux naturel), ou null si indifférent,\n' +
  '  "autre_alcool": "nom" si la recette demande surtout un autre alcool (Madère, Porto, Cognac, bière...), sinon null,\n' +
  '  "region": "région viticole française d\'origine de la recette, sinon null",\n' +
  '  "corps": 1 à 3 (corps du vin souhaité),\n' +
  '  "eviter_tanins": true si un vin tannique rendrait la recette amère,\n' +
  '  "eviter_aromatique": true si un vin très aromatique masquerait la recette,\n' +
  '  "resume": "une phrase : le rôle du vin dans la recette"\n' +
  '}';

async function analyserRecette(texte, appelIA) {
  const cle = 'recette:' + String(texte).toLowerCase().trim();
  if (cacheAnalyse.has(cle)) return cacheAnalyse.get(cle);
  const rep = await appelIA([{ role: 'system', content: PROMPT_RECETTE }, { role: 'user', content: texte }]);
  const m = String(rep || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let r; try { r = JSON.parse(m[0]); } catch (e) { return null; }
  const couleur = r.couleur ? String(r.couleur).toLowerCase().replace(/^rose$/, 'rosé') : null;
  const res = {
    plat: String(r.plat || texte).slice(0, 80),
    contient_vin: r.contient_vin !== false,
    couleur: ['rouge', 'blanc', 'rosé', 'doux'].includes(couleur) ? couleur : null,
    autre_alcool: r.autre_alcool ? String(r.autre_alcool).slice(0, 40) : null,
    region: r.region ? String(r.region).slice(0, 40) : null,
    corps: Math.max(1, Math.min(3, parseInt(r.corps, 10) || 2)),
    eviter_tanins: r.eviter_tanins !== false,
    eviter_aromatique: r.eviter_aromatique === true,
    resume: String(r.resume || '').slice(0, 200),
  };
  cacheAnalyse.set(cle, res);
  return res;
}

function noterRecette(wine, r) {
  const p = wine.profil || (wine.profil = profilerVin(wine));
  const t = wine.type;
  const veto = raison => ({ score: -100, plus: [], moins: [raison] });
  if (t === 'bulles') return veto('pas de bulles en cuisine');
  if (r.couleur === 'doux') { if (p.sucrosite < 2) return veto('la recette demande un vin doux'); }
  else {
    if (r.couleur && t !== r.couleur) return veto('pas la couleur de la recette');
    if (!r.couleur && t === 'rosé') return veto(null);
    if (p.sucrosite >= 1) return veto('trop sucré pour cette recette');
  }
  const plus = [], moins = [];
  let s = 40;
  const add = (v, raison) => { s += v; if (raison) (v >= 0 ? plus : moins).push(raison); };
  if (t === 'rouge') {
    if (p.tanins === 3) add(-20, 'trop tannique : il devient amer en réduisant');
    else if (p.tanins === 2 && r.eviter_tanins) add(-6, null);
    else if (p.tanins === 1) add(8, 'tanins souples, sans amertume à la cuisson');
    if (p.fruit >= 2) add(4, 'fruit qui parfume la sauce');
  }
  if (p.boise === 2) add(-15, 'boisé qui ressort à la cuisson');
  if (t === 'blanc') {
    if (p.aromatique === 3 && r.eviter_aromatique) add(-15, 'trop aromatique pour cette recette');
    if (p.fraicheur === 3) add(8, 'acidité utile en cuisine');
    if (p.oxydatif) add(-12, null);
  }
  const dc = Math.abs(p.corps - r.corps);
  add([10, 3, -8][dc], dc === 0 ? 'le bon corps pour la recette' : null);
  if (r.region && wine.region && String(wine.region).toLowerCase().includes(String(r.region).toLowerCase())) {
    add(18, 'vin de la région de la recette (' + wine.region + ')');
  }
  return { score: Math.round(s), plus, moins };
}

// ── Candidats du parcours guidé ─────────────────────────────────────────────
// demande = { occasion, budget:{min,max}, couleur, plat?, gout?, recette?, featuredSet }
function candidatsGuides(wines, demande) {
  const { occasion, budget, couleur } = demande;
  const featuredSet = demande.featuredSet || new Set();
  const ouvert = budget.max === Infinity;
  const dansBudget = w => w.price >= budget.min && (ouvert ? w.price <= 110 : w.price <= budget.max);
  const couleurOk = w => !couleur || w.type === couleur;

  const noter = w => occasion === 'repas' ? noterVin(w, demande.plat)
    : occasion === 'cuisiner' ? noterRecette(w, demande.recette)
    : noterStyle(w, demande.gout || 'inconnu', occasion);

  const notes = wines.filter(w => dansBudget(w) && couleurOk(w))
    .map(w => Object.assign({ wine: w }, noter(w)))
    .filter(n => n.score > -99);

  // Positionnement dans la tranche : haut de tranche pour boire et offrir,
  // bas de tranche pour cuisiner (pas besoin d'un grand vin dans la casserole).
  const ref = ouvert ? null : budget.min + (budget.max - budget.min) * (occasion === 'cuisiner' ? 0.25 : 0.75);
  const span = ouvert ? 1 : Math.max(1, budget.max - budget.min);
  const val = n => n.score + (featuredSet.has(n.wine.id) ? 8 : 0) +
    (ref === null ? 0 : Math.max(0, 1 - Math.abs(n.wine.price - ref) / span) * 8);
  notes.sort((a, b) => val(b) - val(a) || (b.wine.rating || 0) - (a.wine.rating || 0));

  const ok = notes.filter(n => n.score >= REGLAGES.seuilCompatible);
  let retenus = (ok.length >= 6 ? ok : notes.slice(0, Math.max(ok.length, 10))).slice(0, 14);
  // Recette sans couleur imposée (sauce, déglaçage) : on garde des rouges ET des blancs
  if (occasion === 'cuisiner' && !demande.recette.couleur && !couleur) {
    const rouges = notes.filter(n => n.wine.type === 'rouge').slice(0, 7);
    const blancs = notes.filter(n => n.wine.type === 'blanc').slice(0, 7);
    retenus = [];
    for (let i = 0; i < 7; i++) { if (rouges[i]) retenus.push(rouges[i]); if (blancs[i]) retenus.push(blancs[i]); }
  }

  let decouverte = null;
  if (occasion === 'repas' && demande.plat) {
    const d = Object.assign({}, demande.plat, { couleur_demandee: couleur || null });
    const dec = choisirDecouverte([...notes].sort((a, b) => b.score - a.score), d);
    if (dec) {
      decouverte = dec.wine;
      if (!retenus.find(n => n.wine.id === dec.wine.id)) retenus.push(dec);
    }
  }
  return { candidats: retenus.map(n => n.wine), notes: new Map(notes.map(n => [n.wine.id, n])), decouverte };
}


// ═══════════════════════════════════════════════════════════════════════════
//  BRANCHEMENT DANS serveur.js
//  Tout le code du moteur vit ici : serveur.js ne contient que quelques
//  lignes d'appel (installées par maj-serveur.js), pour ne jamais écraser
//  le reste du serveur.
// ═══════════════════════════════════════════════════════════════════════════

// Appel court à Mistral qui renvoie seulement le texte (analyses en JSON)
async function appelMistral(callApi, config, messages) {
  const payload = JSON.stringify({
    model: config.model, max_tokens: 400, temperature: 0,
    response_format: { type: 'json_object' }, messages,
  });
  const raw = await callApi({
    hostname: 'api.mistral.ai', path: '/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.apiKey,
      'Content-Length': Buffer.byteLength(payload),
    },
    payload,
  });
  const data = JSON.parse(raw);
  if (data.error || !data.choices) throw new Error((data.error && data.error.message) || data.message || 'réponse API inattendue');
  return data.choices[0].message.content;
}

// Chat (/sommelier) : si un plat est évoqué, renvoie { finalSystem, tierWines, available }.
// Renvoie null si aucun plat n'est évoqué ou si l'analyse échoue → le serveur
// garde alors son ancien tri par catégorie.
async function preparerSommelier(env) {
  const { messages, system, budget, featuredSet, catalogue, callApi, config } = env;
  if (!catalogue || !catalogue.length) return null;
  let plat;
  try { plat = await analyserPlat(messages, msgs => appelMistral(callApi, config, msgs)); }
  catch (e) { console.warn('⚠️  Analyse du plat impossible (' + e.message + ') → ancien tri par catégorie'); return null; }
  if (!plat || !plat.present) return null;
  console.log('🍽  Plat analysé:', decrirePlat(plat));

  const texteClient = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const c = construireCandidats(catalogue, plat, budget, featuredSet, texteClient);
  const tierWines = c.tierWines, available = c.available;
  if (c.decouverte) console.log('✨ Découverte proposée:', c.decouverte.name, '(' + c.decouverte.type + ')');
  const fmt = w => ligneCandidat(w, c.notes.get(w.id), featuredSet, c.decouverte);

  let inject = '\n\n>>> CONTRAINTES OBLIGATOIRES <<<';
  if (budget) {
    const tiers = tierWines._tiers;
    inject += '\nBUDGET MAXIMUM DE RÉFÉRENCE : ' + Math.round(budget.ref || budget.max) + '€ (annoncé par le client).';
    inject += '\nSTRUCTURE DE PRIX OBLIGATOIRE pour tes 3 propositions :';
    inject += '\n  🥇 premier vin  : environ ' + Math.round(tiers[0]) + '€';
    inject += '\n  ⭐ deuxième vin : environ ' + Math.round(tiers[1]) + '€';
    inject += '\n  ✨ troisième vin : environ ' + Math.round(tiers[2]) + '€' + (budget.strict ? '' : ' (légère montée en gamme au-dessus du budget, à présenter comme telle)');
    inject += '\nLes prix doivent monter du 🥇 au ✨. Aucun vin en dessous de ' + Math.round(budget.min) + '€.';
    if (budget.strict) inject += '\nPLAFOND STRICT : le client a fixé un maximum absolu. Ne dépasse JAMAIS ' + Math.round(budget.max) + '€, même de 1€, sous aucun prétexte.';
  }
  inject += '\nPLAT DU CLIENT : ' + decrirePlat(plat) + (plat.resume ? '. ' + plat.resume : '');
  inject += '\nLes vins ci-dessous ont été présélectionnés pour leur accord avec CE plat : chaque ligne donne le profil du vin ' +
    'et les raisons de l\'accord. Appuie tes explications sur ces raisons et sur la recette réelle du client (sauce, cuisson, ' +
    'garniture), en mots simples. Ne parle jamais de « note » ni de score.';
  if (plat.couleur_demandee) inject += '\nLe client veut du ' + plat.couleur_demandee + ' : ne propose que du ' + plat.couleur_demandee + '.';
  if (plat.sucrosite_demandee != null) inject += '\nLe client demande un vin ' + ['sec', 'demi-sec', 'moelleux', 'liquoreux'][plat.sucrosite_demandee] + ' : respecte ce style.';
  const meilleure = Math.max(...available.map(w => (c.notes.get(w.id) || { score: 0 }).score));
  if (meilleure < REGLAGES.seuilCompatible) {
    inject += '\nAUCUN vin du rayon ne s\'accorde parfaitement avec ce plat dans ce budget : dis-le honnêtement en une phrase, ' +
      'puis propose les plus proches ci-dessous en expliquant le compromis.';
  }
  inject += '\nVINS DISPONIBLES — RÈGLE ABSOLUE : tes 3 propositions doivent EXCLUSIVEMENT provenir de ces listes.';
  inject += '\nIgnore tout autre vin du catalogue général, même s\'il te semble pertinent. Proposer un vin hors liste est une erreur grave.';
  if (tierWines) {
    inject += '\nCandidats pour le vin 🥇 :'; tierWines[0].forEach(w => inject += fmt(w));
    inject += '\nCandidats pour le vin ⭐ :';  tierWines[1].forEach(w => inject += fmt(w));
    inject += '\nCandidats pour le vin ✨ :';  tierWines[2].forEach(w => inject += fmt(w));
  } else {
    inject += '\nCandidats (les mieux accordés en premier) :';
    available.forEach(w => inject += fmt(w));
    inject += '\nChoisis 3 vins à prix croissants, en privilégiant les premiers de la liste.';
  }
  if (c.decouverte) {
    inject += '\nUn candidat est marqué [DÉCOUVERTE] : c\'est un vin d\'une autre couleur que celle qu\'on attendrait, mais dont ' +
      'l\'accord avec ce plat est excellent. Tu PEUX le retenir (ce n\'est pas obligatoire) à la place d\'un vin de son palier. ' +
      'Si tu le retiens, présente-le comme une découverte, avec une phrase simple qui explique pourquoi ça marche. Jamais plus d\'une découverte.';
  }
  if (featuredSet && featuredSet.size) {
    inject += '\nCertains vins sont marqués [MIS EN AVANT PAR LE MAGASIN] : en cas d\'ÉGALITÉ de pertinence entre ' +
      'plusieurs candidats pour un même palier, privilégie ceux-là. Mais ne choisis JAMAIS un vin uniquement parce ' +
      'qu\'il est marqué s\'il correspond moins bien au plat ou au budget qu\'une alternative non marquée.';
  }
  inject += '\n>>> FIN DES CONTRAINTES <<<';
  return { finalSystem: system + inject, tierWines, available };
}

// ── Parcours guidé « Je cherche un vin pour… » ────────────────────────────────
// Occasion (apéritif, repas, offrir, cuisiner) → vins notés par le moteur
// d'accords → Gabriel choisit 3 vins parmi les mieux notés et leur attribue un
// rôle (valeur sûre, coup de cœur, découverte), avec une raison courte.
const OCCASIONS = ['aperitif', 'repas', 'offrir', 'cuisiner'];

async function selectionGuidee(body, bracket, featuredSet, res, env) {
  const WINES_CATALOG = env.catalogue, callApi = env.callApi, CONFIG = env.config;
  const appelMistralTexte = msgs => appelMistral(callApi, CONFIG, msgs);
  const ACCORDS = module.exports;
  const occasion = OCCASIONS.includes(body.occasion) ? body.occasion : 'repas';
  const couleurs = ['rouge', 'blanc', 'rosé', 'bulles'];
  const demande = { occasion, budget: bracket, couleur: couleurs.includes(body.couleur) ? body.couleur : null, featuredSet };
  let contexte = '';

  if (occasion === 'repas') {
    let plat = null;
    if (body.platLibre) {
      try { plat = await ACCORDS.analyserPlat([{ role: 'user', content: 'Mon plat : ' + body.platLibre }], appelMistralTexte); }
      catch (e) { console.warn('⚠️  Analyse du plat impossible (' + e.message + ')'); }
    }
    if (!plat || !plat.present) plat = ACCORDS.platDepuisCategorie(body.pairing, body.detail);
    if (!plat) plat = ACCORDS.nettoyer({ present: true, plat: body.platLibre || 'un repas', corps: 2, intensite: 2 });
    if (plat.couleur_demandee && !demande.couleur) demande.couleur = plat.couleur_demandee;
    demande.plat = plat;
    console.log('🍽  Parcours guidé (repas):', ACCORDS.decrirePlat(plat));
    contexte = 'Le client cherche un vin pour ACCOMPAGNER UN REPAS. Son plat : ' + ACCORDS.decrirePlat(plat) +
      (plat.resume ? '. ' + plat.resume : '') + '. Chaque raison doit citer un élément concret du plat.';
  } else if (occasion === 'cuisiner') {
    let recette = body.recette && ACCORDS.RECETTES[body.recette];
    if (!recette && body.recetteLibre) {
      try { recette = await ACCORDS.analyserRecette(body.recetteLibre, appelMistralTexte); }
      catch (e) { console.warn('⚠️  Analyse de la recette impossible (' + e.message + ')'); }
    }
    if (!recette) recette = Object.assign({}, ACCORDS.RECETTES.sauce, { plat: body.recetteLibre || 'votre recette' });
    if (recette.contient_vin === false) {
      console.log('🍳 Recette sans vin :', recette.plat);
      return res.json({ ids: [], info: 'sansVin', plat: recette.plat });
    }
    demande.recette = recette;
    console.log('🍳 Parcours guidé (cuisiner):', recette.plat, recette.couleur ? '(' + recette.couleur + ')' : '');
    contexte = 'Le client cherche un vin POUR CUISINER : ' + recette.plat + '. ' + recette.resume + '. ' +
      'Chaque raison explique le rôle du vin dans la recette, en mots simples. Pas besoin d\'un grand vin pour cuisiner.' +
      (recette.autre_alcool ? ' ATTENTION : cette recette demande surtout du ' + recette.autre_alcool +
        ', qui n\'est pas au rayon vin : dis-le honnêtement dans "message" et présente ces vins comme la solution la plus proche.' : '');
  } else {
    const gout = ACCORDS.GOUTS[body.gout] ? body.gout : 'inconnu';
    demande.gout = gout;
    console.log('🥂 Parcours guidé (' + occasion + '):', ACCORDS.GOUTS[gout]);
    contexte = occasion === 'aperitif'
      ? 'Le client cherche un vin pour L\'APÉRITIF (un verre, avec ou sans grignotage). Ce qu\'il aime : ' + ACCORDS.GOUTS[gout] + '.'
      : 'Le client cherche une bouteille À OFFRIR. Goûts de la personne : ' + (gout === 'inconnu'
        ? 'inconnus. Vise des vins consensuels et reconnus, qui font plaisir sans prendre de risque.'
        : ACCORDS.GOUTS[gout] + '.');
  }

  const c = ACCORDS.candidatsGuides(WINES_CATALOG, demande);
  const candidates = c.candidats;
  if (c.decouverte) console.log('✨ Découverte possible:', c.decouverte.name, '(' + c.decouverte.type + ')');

  // Repli sans IA : les 3 mieux notés, présentés à prix croissants
  const fallbackWines = candidates.slice(0, 3).sort((a, b) => a.price - b.price);
  const fallbackIds = fallbackWines.map(w => w.id);
  const fallbackRoles = {};
  if (fallbackWines.length === 3) {
    const byScore = [...fallbackWines].sort((a, b) => c.notes.get(b.id).score - c.notes.get(a.id).score);
    fallbackRoles[byScore[0].id] = 'coup_de_coeur';
    fallbackRoles[byScore[1].id] = 'valeur_sure';
    fallbackRoles[byScore[2].id] = 'decouverte';
  }
  const fallbackReasons = {};
  fallbackWines.forEach(w => {
    const n = c.notes.get(w.id);
    if (n && n.plus[0]) fallbackReasons[w.id] = n.plus[0].charAt(0).toUpperCase() + n.plus[0].slice(1);
  });
  if (candidates.length < 3) return res.json({ ids: fallbackIds, roles: fallbackRoles, reasons: fallbackReasons });

  const system = 'Tu es Gabriel, sommelier d\'une borne de supermarché. Ton sobre, pédagogique et factuel : ' +
    'tu n\'incites jamais à consommer davantage et ne présentes jamais l\'alcool comme festif.\n' +
    contexte + '\n' +
    (demande.couleur ? 'Le client a choisi : ' + demande.couleur + '.\n' : '') +
    'Budget choisi : ' + body.budget + '€.\n' +
    'Voici les vins présélectionnés pour lui (profil du vin et raisons de l\'accord) :' +
    candidates.map(w => ACCORDS.ligneCandidat(w, c.notes.get(w.id), featuredSet, c.decouverte)).join('') +
    '\n\nChoisis EXACTEMENT 3 vins parmi ces IDs, de préférence parmi les mieux accordés, avec des profils ou des prix différents ' +
    'pour offrir un vrai choix, et des prix croissants du premier au troisième.\n' +
    (featuredSet.size ? 'En cas d\'ÉGALITÉ de pertinence, privilégie les vins [MIS EN AVANT PAR LE MAGASIN], mais jamais au détriment de l\'accord.\n' : '') +
    'Attribue à CHAQUE vin un rôle, chacun utilisé UNE SEULE fois :\n' +
    '  - "valeur_sure" : vin fiable, typique, bon rapport qualité-prix, le choix sans surprise.\n' +
    '  - "coup_de_coeur" : le meilleur accord, ou le plus séduisant.\n' +
    '  - "decouverte" : le plus original (cépage rare, région moins connue, style inattendu), quel que soit son prix.' +
    (c.decouverte ? ' Le vin marqué [DÉCOUVERTE] est d\'une autre couleur que celle qu\'on attendrait, avec un excellent accord : ' +
      'tu peux le retenir pour ce rôle, sans obligation.' : '') + '\n' +
    'Pour chaque vin, une raison courte (12 mots maximum), en français simple, sans jamais parler de note ni de score.\n' +
    (occasion === 'cuisiner'
      ? 'Dans "message", une phrase courte et utile sur la cuisson (par exemple : ce vin pourra aussi accompagner le plat à table).\n'
      : 'Laisse "message" vide, sauf information importante pour le client.\n') +
    'Réponds UNIQUEMENT en JSON, sans aucun texte avant ou après, sous cette forme exacte :\n' +
    '{"ids":[id1,id2,id3],"roles":{"id1":"valeur_sure|coup_de_coeur|decouverte","id2":"...","id3":"..."},' +
    '"reasons":{"id1":"...","id2":"...","id3":"..."},"message":""}';

  const askOnce = async (extra) => {
    const payload = JSON.stringify({
      model: CONFIG.model, max_tokens: 600, temperature: 0.4,
      messages: [{ role: 'system', content: system + (extra || '') }, { role: 'user', content: 'Choisis mes 3 vins.' }],
    });
    const raw = await callApi({
      hostname: 'api.mistral.ai', path: '/v1/chat/completions',
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
  const validate = (p) => {
    if (!p || !Array.isArray(p.ids) || p.ids.length !== 3) return false;
    if (!p.ids.every(id => candidateIds.has(id))) return false;
    if (!p.roles || typeof p.roles !== 'object') return false;
    const r = p.ids.map(id => p.roles[id]);
    return r.every(x => VALID_ROLES.has(x)) && new Set(r).size === 3;
  };

  try {
    let parsed = await askOnce();
    if (!validate(parsed)) {
      console.warn('⚠️  Parcours guidé : réponse non conforme → retry correctif');
      parsed = await askOnce('\n\n>>> CORRECTION : choisis STRICTEMENT 3 IDs parmi la liste ci-dessus, et assigne les 3 rôles ' +
        '"valeur_sure"/"coup_de_coeur"/"decouverte" chacun une seule fois, dans le champ "roles". <<<');
    }
    if (!validate(parsed)) {
      console.warn('⚠️  Parcours guidé toujours non conforme → sélection automatique');
      return res.json({ ids: fallbackIds, roles: fallbackRoles, reasons: fallbackReasons });
    }
    console.log('✅ Parcours guidé →', parsed.ids.map(id => id + ':' + parsed.roles[id]).join(', '));
    return res.json({
      ids: parsed.ids, roles: parsed.roles, reasons: parsed.reasons || {},
      message: typeof parsed.message === 'string' ? parsed.message.slice(0, 220) : '',
    });
  } catch (e) {
    console.error('Erreur parcours guidé:', e.message, '→ sélection automatique');
    return res.json({ ids: fallbackIds, roles: fallbackRoles, reasons: fallbackReasons });
  }
}

module.exports = {
  analyserPlat, noterVin, choisirDecouverte, construireCandidats, ligneCandidat,
  decrireProfil, decrirePlat, nettoyer, REGLAGES,
  platDepuisCategorie, noterStyle, noterRecette, analyserRecette, candidatsGuides, GOUTS, RECETTES,
  appelMistral, preparerSommelier, selectionGuidee,
};
