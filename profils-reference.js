'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  PROFILS-REFERENCE.JS
//
//  Table de référence partagée par tous les magasins : déduit le PROFIL
//  gustatif d'un vin à partir de son appellation, de son cépage et des mots
//  de son libellé.
//
//  Grille par couleur :
//    SOCLE COMMUN (tous les vins, pour comparer un rouge et un blanc sur un
//    même plat) : corps · fraîcheur · intensité · sucrosité
//    + ROUGE  : tanins · fruit · boisé
//    + BLANC  : texture · aromatique · minéralité · boisé · oxydatif
//    + ROSÉ   : style · fruit
//    + BULLES : dosage · vinosité · évolution · aromatique
//               (pour les bulles, la sucrosité est déduite du dosage)
//
//  Ordre de priorité :
//    1. appellation connue (la plus précise trouvée dans appellation + nom)
//    2. sinon cépage connu (IGP, Vin de France, Alsace...)
//    3. sinon profil par défaut de la couleur, marqué « à vérifier »
//  puis les mots du libellé ajustent (Vieilles Vignes, fût, demi-sec, VT...).
//
//  Pour ajouter une appellation : une ligne dans la table de sa couleur,
//  dans l'ordre des colonnes indiqué en tête de table.
// ═══════════════════════════════════════════════════════════════════════════

// ── Axes et libellés ────────────────────────────────────────────────────────
const AXES = {
  rouge:  ['corps', 'fraicheur', 'intensite', 'tanins', 'fruit', 'boise', 'sucrosite'],
  blanc:  ['corps', 'fraicheur', 'intensite', 'texture', 'aromatique', 'mineralite', 'boise', 'sucrosite', 'oxydatif'],
  'rosé': ['corps', 'fraicheur', 'intensite', 'style', 'fruit', 'sucrosite'],
  bulles: ['corps', 'fraicheur', 'intensite', 'dosage', 'vinosite', 'evolution', 'aromatique'],
};

const LIBELLES = {
  corps:      ['', 'léger', 'moyen', 'ample'],
  fraicheur:  ['', 'douce', 'moyenne', 'vive'],
  intensite:  ['', 'discrète', 'moyenne', 'intense'],
  sucrosite:  ['sec', 'demi-sec', 'moelleux', 'liquoreux'],
  tanins:     ['', 'souples', 'présents', 'fermes'],
  fruit:      ['', 'frais', 'mûr', 'confit'],
  boise:      ['non', 'léger', 'marqué'],
  texture:    ['', 'vif', 'rond', 'gras'],
  aromatique: ['', 'neutre', 'fruité', 'très aromatique'],
  mineralite: ['', 'faible', 'présente', 'marquée'],
  oxydatif:   ['non', 'oui'],
  style:      ['', 'pâle et léger', 'fruité', 'vineux'],
  dosage:     ['brut nature', 'brut', 'demi-sec', 'doux'],
  vinosite:   ['', 'légère', 'équilibrée', 'vineuse'],
  evolution:  ['', 'fruit frais', 'brioché'],
};
// Libellés propres à une couleur (même nom d'axe, sens différent)
const LIBELLES_COULEUR = {
  bulles: { aromatique: ['', 'neutre', 'muscaté'] },
};

// ── ROUGE : [corps, fraicheur, intensite, tanins, fruit, boise, sucrosite?] ─
const ROUGE = {
  // Beaujolais
  'beaujolais nouveau': [1,2,1,1,1,0], 'primeur': [1,2,1,1,1,0], 'beaujolais': [1,2,1,1,1,0],
  'beaujolais villages': [1,2,2,1,1,0], 'brouilly': [1,2,2,1,1,0], 'cote de brouilly': [2,2,2,2,1,0],
  'fleurie': [1,2,2,1,1,0], 'morgon': [2,2,2,2,2,0], 'moulin a vent': [2,2,3,2,2,1], 'julienas': [2,2,2,2,1,0],
  'chenas': [2,2,2,2,1,0], 'regnie': [1,2,2,1,1,0], 'chiroubles': [1,2,2,1,1,0], 'saint amour': [1,2,2,1,1,0],
  // Bourgogne
  'bourgogne': [1,3,2,1,1,0], 'hautes cotes de nuits': [1,3,2,1,1,0], 'hautes cotes de beaune': [1,3,2,1,1,0],
  'cotes de nuits villages': [2,3,2,2,1,1], 'cote de beaune villages': [2,3,2,1,1,1],
  'marsannay': [2,3,2,2,1,1], 'fixin': [2,3,2,2,1,1], 'gevrey chambertin': [2,3,3,2,2,1],
  'morey saint denis': [2,3,3,2,2,1], 'chambolle musigny': [2,3,3,1,1,1], 'vosne romanee': [2,3,3,2,2,1],
  'clos de vougeot': [3,3,3,2,2,2], 'nuits saint georges': [3,3,3,2,2,1], 'aloxe corton': [3,3,3,2,2,1],
  'corton': [3,3,3,3,2,2], 'ladoix': [2,3,2,2,1,1], 'savigny les beaune': [2,3,2,2,1,1], 'beaune': [2,3,2,2,1,1],
  'pommard': [3,3,3,3,2,1], 'volnay': [2,3,3,1,1,1], 'monthelie': [2,3,2,1,1,1], 'santenay': [2,3,2,2,1,1],
  'maranges': [2,3,2,2,1,0], 'mercurey': [2,3,2,2,1,1], 'givry': [2,3,2,2,1,1], 'rully': [1,3,2,1,1,0],
  'irancy': [2,3,2,2,1,0], 'passetoutgrain': [1,3,1,1,1,0],
  // Bordeaux
  'bordeaux': [2,2,2,2,2,1], 'bordeaux superieur': [2,2,2,2,2,1], 'bordeaux clairet': [1,2,1,1,1,0],
  'cotes de bourg': [2,2,2,2,2,1], 'blaye': [2,2,2,2,2,1], 'castillon': [2,2,2,2,2,1], 'francs': [2,2,2,2,2,1],
  'medoc': [2,2,2,3,2,1], 'haut medoc': [3,2,3,3,2,2], 'margaux': [3,2,3,3,2,2], 'saint julien': [3,2,3,3,2,2],
  'pauillac': [3,2,3,3,2,2], 'saint estephe': [3,2,3,3,2,2], 'moulis': [3,2,3,3,2,2], 'listrac': [3,2,2,3,2,2],
  'pessac leognan': [3,2,3,3,2,2], 'graves': [2,2,2,2,2,1], 'saint emilion': [3,2,3,2,2,2],
  'pomerol': [3,2,3,2,3,2], 'lalande de pomerol': [3,2,3,2,2,2], 'fronsac': [3,2,2,3,2,1],
  // Sud-Ouest
  'bergerac': [2,2,2,2,2,1], 'pecharmant': [3,2,3,3,2,1], 'buzet': [2,2,2,2,2,1], 'cotes de duras': [2,2,2,2,2,0],
  'cotes du marmandais': [2,2,2,2,2,0], 'cahors': [3,2,3,3,2,1], 'madiran': [3,2,3,3,2,2],
  'irouleguy': [3,2,3,3,2,1], 'fronton': [2,2,2,1,2,0], 'gaillac': [2,2,2,2,2,0], 'marcillac': [2,3,2,2,1,0],
  'cotes du brulhois': [3,2,2,3,2,0], 'saint mont': [3,2,2,3,2,1],
  // Loire / Centre
  'chinon': [2,3,2,2,1,0], 'bourgueil': [2,3,2,2,1,0], 'saint nicolas de bourgueil': [1,3,2,2,1,0],
  'saumur champigny': [2,3,2,2,1,0], 'saumur': [2,3,2,2,1,0], 'anjou': [2,3,2,2,1,0], 'touraine': [1,3,2,1,1,0],
  'sancerre': [1,3,2,1,1,0], 'menetou salon': [1,3,2,1,1,0], 'cotes du forez': [1,3,2,1,1,0],
  'cotes d auvergne': [1,3,2,1,1,0], 'saint pourcain': [1,3,2,1,1,0],
  // Rhône
  'cotes du rhone': [2,2,2,2,2,0], 'cotes du rhone villages': [2,2,2,2,2,0], 'cairanne': [3,2,3,2,3,0],
  'rasteau': [3,2,3,2,3,0], 'gigondas': [3,2,3,3,3,1], 'vacqueyras': [3,2,3,3,3,0],
  'chateauneuf du pape': [3,2,3,2,3,1], 'lirac': [3,2,2,2,2,0], 'costieres de nimes': [2,2,2,2,2,0],
  'ventoux': [2,2,2,1,2,0], 'luberon': [2,2,2,1,2,0], 'crozes hermitage': [2,3,2,2,1,0],
  'saint joseph': [2,3,3,2,1,0], 'hermitage': [3,3,3,3,2,2], 'cote rotie': [2,3,3,2,2,1], 'cornas': [3,3,3,3,2,1],
  // Languedoc / Roussillon
  'corbieres': [2,2,2,2,2,0], 'minervois': [2,2,2,2,2,0], 'minervois la liviniere': [3,2,3,2,2,1],
  'fitou': [3,2,2,2,2,0], 'saint chinian': [3,2,3,2,2,0], 'faugeres': [3,2,3,2,2,0],
  'pic saint loup': [3,2,3,2,2,1], 'terrasses du larzac': [3,3,3,2,2,1], 'pezenas': [3,2,3,2,2,0],
  'languedoc': [2,2,2,2,2,0], 'cotes du roussillon': [2,2,2,2,2,0], 'cotes du roussillon villages': [3,2,3,2,3,1],
  'collioure': [3,2,3,2,3,0],
  // Provence / Corse / Alsace / Jura / Savoie
  'bandol': [3,2,3,3,2,1], 'cotes de provence': [2,2,2,2,2,0], 'coteaux d aix': [2,2,2,2,2,0],
  'palette': [2,2,2,2,2,1], 'patrimonio': [2,2,2,2,2,0], 'ajaccio': [2,2,2,1,2,0], 'corse': [2,2,2,2,2,0],
  'alsace pinot noir': [1,3,2,1,1,0], 'arbois': [1,3,2,1,1,0], 'cotes du jura': [1,3,2,1,1,0],
  'savoie': [1,3,2,1,1,0], 'mondeuse': [2,3,2,2,1,0],
  // Vins doux naturels (doux par défaut ; « sec » dans le nom → sec)
  'banyuls': [3,1,3,2,3,0,3], 'maury': [3,2,3,2,3,0,3], 'rivesaltes': [3,1,3,2,3,0,3], 'porto': [3,1,3,2,3,0,3],
};

// ── BLANC : [corps, fraicheur, intensite, texture, aromatique, mineralite, boise, sucrosite?, oxydatif?] ─
const BLANC = {
  // Loire
  'muscadet': [1,3,1,1,1,3,0], 'muscadet sevre et maine cru': [2,3,2,2,1,3,0], 'gros plant': [1,3,1,1,1,2,0],
  'sancerre': [1,3,2,1,2,3,0], 'pouilly fume': [2,3,2,1,2,3,0], 'quincy': [1,3,2,1,2,2,0],
  'reuilly': [1,3,2,1,2,2,0], 'menetou salon': [1,3,2,1,2,2,0], 'coteaux du giennois': [1,3,2,1,2,2,0],
  'touraine': [1,3,2,1,2,1,0], 'vouvray': [2,3,2,2,2,2,0], 'montlouis': [2,3,2,2,2,2,0],
  'savennieres': [2,3,3,2,2,3,0], 'anjou': [2,3,2,2,2,2,0], 'saumur': [2,3,2,2,2,2,0],
  'coteaux du layon': [2,3,3,3,3,1,0,2], 'quarts de chaume': [3,3,3,3,3,2,0,3],
  'bonnezeaux': [3,3,3,3,3,2,0,3], 'coteaux de l aubance': [2,3,2,3,2,1,0,2],
  // Bordeaux / Sud-Ouest
  'entre deux mers': [1,3,1,1,2,1,0], 'bordeaux': [1,3,1,1,2,1,0], 'graves': [2,2,2,2,2,2,1],
  'pessac leognan': [2,3,3,2,2,2,2], 'sauternes': [3,2,3,3,3,1,1,3], 'barsac': [3,2,3,3,3,1,1,3],
  'loupiac': [2,2,2,3,2,1,0,2], 'cadillac': [2,2,2,3,2,1,0,2], 'monbazillac': [3,2,3,3,2,1,0,3],
  'bergerac': [1,2,1,1,2,1,0], 'cotes de gascogne': [1,3,2,1,2,1,0], 'gaillac': [1,2,2,1,2,1,0],
  'jurancon sec': [2,3,3,2,3,1,0], 'jurancon': [2,3,3,3,3,1,0,2], 'pacherenc': [2,3,3,3,3,1,0,2],
  // Bourgogne
  'chablis': [1,3,2,1,1,3,0], 'chablis premier cru': [2,3,3,2,1,3,0], 'chablis 1er cru': [2,3,3,2,1,3,0],
  'chablis grand cru': [2,3,3,2,1,3,1], 'petit chablis': [1,3,1,1,1,2,0], 'aligote': [1,3,1,1,1,2,0],
  'bourgogne aligote': [1,3,1,1,1,2,0], 'bourgogne': [2,2,2,2,2,2,1], 'macon': [2,2,2,2,2,1,0],
  'saint veran': [2,2,2,2,2,2,1], 'pouilly fuisse': [3,2,3,3,2,2,2], 'rully': [2,2,2,2,2,2,1],
  'montagny': [2,2,2,2,2,2,1], 'mercurey': [2,2,2,2,2,2,1], 'saint aubin': [2,3,3,2,2,3,1],
  'auxey duresses': [2,3,2,2,2,2,1], 'pernand vergelesses': [2,3,3,2,2,3,1], 'meursault': [3,2,3,3,2,2,2],
  'puligny montrachet': [3,3,3,2,2,3,2], 'chassagne montrachet': [3,2,3,3,2,2,2],
  'corton charlemagne': [3,3,3,3,2,3,2],
  // Rhône / Sud
  'condrieu': [3,1,3,3,3,1,1], 'cotes du rhone': [2,2,2,2,2,1,0], 'chateauneuf du pape': [3,2,3,3,2,1,1],
  'hermitage': [3,2,3,3,2,2,1], 'crozes hermitage': [2,2,2,2,2,1,0], 'saint peray': [2,2,2,3,2,2,0],
  'saint joseph': [2,2,2,2,2,1,0], 'cassis': [2,2,2,2,2,2,0], 'bandol': [2,2,2,2,2,2,0],
  'palette': [2,2,3,2,2,2,1], 'cotes de provence': [1,2,2,1,2,1,0], 'collioure': [2,2,2,2,2,3,0],
  'cotes du roussillon': [2,2,2,2,2,1,0], 'picpoul': [1,3,1,1,1,2,0], 'limoux': [2,3,2,2,2,2,1],
  // Jura / Savoie
  'chateau chalon': [3,3,3,2,3,2,0,0,1], 'vin jaune': [3,3,3,2,3,2,0,0,1], 'arbois': [2,3,3,2,2,2,0],
  'cotes du jura': [2,3,2,2,2,2,1], 'roussette de savoie': [2,3,2,2,2,2,0], 'apremont': [1,3,1,1,1,2,0],
  'chignin': [1,3,2,1,2,2,0], 'savoie': [1,3,1,1,1,2,0],
};

// ── ROSÉ : [corps, fraicheur, intensite, style, fruit, sucrosite?] ─────────
const ROSE = {
  'tavel': [3,2,3,3,2], 'lirac': [2,2,2,3,2], 'bandol': [2,3,2,2,1], 'cotes de provence': [1,3,1,1,1],
  'coteaux varois': [1,3,1,1,1], 'coteaux d aix': [1,3,1,1,1], 'palette': [2,3,2,2,1],
  'patrimonio': [2,3,2,2,1], 'ajaccio': [2,3,2,2,1], 'corse': [2,3,2,2,1],
  'rose d anjou': [1,2,1,2,2,1], 'cabernet d anjou': [1,2,2,2,2,1], 'rose de loire': [1,3,1,1,1],
  'sancerre': [1,3,2,1,1], 'marsannay': [1,3,2,1,1], 'bourgogne': [1,3,1,1,1],
  'costieres de nimes': [1,2,2,2,2], 'cotes du rhone': [1,2,2,2,2], 'ventoux': [1,2,1,2,2],
  'luberon': [1,2,1,1,1], 'gigondas': [2,2,2,3,2], 'bergerac': [1,2,1,2,2], 'irouleguy': [2,3,2,2,1],
  'alsace pinot noir': [1,3,1,1,1], 'cotes du roussillon': [2,2,2,2,2], 'cotes catalanes': [2,3,2,2,2],
  'languedoc': [1,2,1,2,2],
};

// ── BULLES : [corps, fraicheur, intensite, dosage, vinosite, evolution, aromatique] ─
const BULLES = {
  'champagne': [2,3,2,1,2,2,1], 'cremant': [1,3,2,1,2,1,1], 'blanquette de limoux': [1,3,2,1,1,1,1],
  'clairette de die': [1,2,2,3,1,1,2], 'bugey cerdon': [1,2,2,3,2,1,1], 'cerdon': [1,2,2,3,2,1,1],
  'prosecco': [1,2,1,1,1,1,1], 'asti': [1,2,2,3,1,1,2], 'moscato d asti': [1,2,2,3,1,1,2],
  'cava': [1,3,1,1,1,1,1], 'franciacorta': [2,3,2,1,2,2,1], 'sekt': [1,3,1,1,1,1,1],
  'vouvray': [2,3,2,1,2,1,1], 'montlouis': [2,3,2,1,2,1,1], 'saumur': [1,3,2,1,2,1,1],
  'gaillac': [1,2,2,2,1,1,1], 'petillant naturel': [1,3,2,1,1,1,1],
};

const APPELLATIONS = { rouge: ROUGE, blanc: BLANC, 'rosé': ROSE, bulles: BULLES };
// NB : les appellations trop larges (Alsace, IGP, Vin de France...) ne figurent
// volontairement pas dans les tables : le cépage prend alors le relais.

// ── Cépages (repli) ─────────────────────────────────────────────────────────
// ROUGE : [corps, fraicheur, intensite, tanins, fruit, boise]
const CEPAGES_ROUGE = {
  'gamay': [1,2,2,1,1,0], 'pinot noir': [1,3,2,1,1,0], 'cabernet franc': [2,3,2,2,1,0], 'merlot': [2,2,2,2,2,0],
  'cabernet sauvignon': [3,2,2,3,2,0], 'syrah': [3,2,3,2,2,0], 'grenache': [2,2,2,1,3,0],
  'mourvedre': [3,2,3,3,2,0], 'carignan': [2,2,2,2,2,0], 'cinsault': [1,2,1,1,1,0], 'malbec': [3,2,3,3,2,0],
  'tannat': [3,2,3,3,2,0], 'negrette': [2,2,2,1,2,0], 'nielluccio': [2,2,2,2,2,0], 'sciacarello': [2,2,2,1,1,0],
  'poulsard': [1,3,2,1,1,0], 'trousseau': [1,3,2,1,1,0], 'mondeuse': [2,3,2,2,1,0], 'grolleau': [1,2,1,1,1,0],
  'sangiovese': [2,3,2,2,1,0], 'tempranillo': [2,2,2,2,2,1], 'zinfandel': [3,2,3,2,3,0], 'primitivo': [3,2,3,2,3,0],
};
// BLANC : [corps, fraicheur, intensite, texture, aromatique, mineralite, boise, sucrosite?]
const CEPAGES_BLANC = {
  'chardonnay': [2,2,2,2,2,2,0], 'sauvignon': [1,3,2,1,2,2,0], 'chenin': [2,3,2,2,2,2,0],
  'riesling': [1,3,2,1,2,3,0], 'gewurztraminer': [3,1,3,3,3,1,0,1], 'pinot gris': [3,2,3,3,2,1,0],
  'muscat': [1,2,3,1,3,1,0], 'sylvaner': [1,3,1,1,1,2,0], 'pinot blanc': [1,2,1,2,1,1,0],
  'auxerrois': [1,2,1,2,1,1,0], 'viognier': [2,1,3,3,3,1,0], 'roussanne': [2,2,2,3,2,1,0],
  'marsanne': [2,2,2,3,2,1,0], 'clairette': [2,2,2,2,2,1,0], 'rolle': [1,2,2,1,2,1,0],
  'vermentino': [1,2,2,1,2,1,0], 'picpoul': [1,3,1,1,1,2,0], 'colombard': [1,3,2,1,2,1,0],
  'ugni blanc': [1,3,1,1,1,1,0], 'melon': [1,3,1,1,1,3,0], 'folle blanche': [1,3,1,1,1,2,0],
  'aligote': [1,3,1,1,1,2,0], 'semillon': [2,2,2,3,2,1,0], 'mauzac': [1,2,2,1,2,1,0],
  'petit manseng': [2,3,3,2,3,1,0], 'gros manseng': [2,3,2,2,2,1,0], 'savagnin': [2,3,3,2,2,2,0],
  'altesse': [2,3,2,2,2,2,0], 'jacquere': [1,3,1,1,1,2,0], 'macabeu': [2,2,1,2,1,1,0],
  'grenache blanc': [2,2,2,2,2,1,0], 'glera': [1,2,1,1,2,1,0], 'moscato': [1,2,3,1,3,1,0,2],
};

const PAR_DEFAUT = {
  rouge:  [2,2,2,2,2,0],
  blanc:  [2,2,2,2,2,2,0],
  'rosé': [1,2,1,1,1],
  bulles: [1,3,2,1,2,1,1],
};

const CEPAGES_ROUGES_SUR_BLANC = ['syrah', 'mourvedre', 'cabernet sauvignon', 'cabernet franc', 'merlot',
  'gamay', 'grenache', 'grenache noir', 'tannat', 'malbec', 'carignan', 'cinsault'];

// ── Outils ──────────────────────────────────────────────────────────────────
function norm(s) {
  return ' ' + String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}
function findLongest(table, text) {
  let best = null;
  for (const key of Object.keys(table)) {
    if (text.includes(' ' + key + ' ') && (!best || key.length > best.length)) best = key;
  }
  return best;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const up = v => clamp(v + 1, 1, 3);

function versObjet(type, ligne) {
  const axes = AXES[type];
  const o = {};
  axes.forEach((ax, i) => { o[ax] = ligne[i] != null ? ligne[i] : 0; });
  return o;
}

// Profil de repli par cépage, converti dans la grille de la couleur demandée
function depuisCepage(type, wine) {
  const parts = String(wine.grape || '').split(',').map(norm);
  const tables = type === 'rouge' ? [['r', CEPAGES_ROUGE]]
    : type === 'rosé' ? [['r', CEPAGES_ROUGE], ['b', CEPAGES_BLANC]]
    : [['b', CEPAGES_BLANC]];
  for (const p of parts) {
    for (const [kind, t] of tables) {
      const k = findLongest(t, p);
      if (!k) continue;
      const l = t[k];
      if (type === 'rosé') {
        // rosé de raisins rouges (ou de Pinot Gris) : un cran plus léger, sans tanins
        const corps = Math.max(1, l[0] - 1);
        return { ligne: [corps, l[1], l[2], l[0] >= 3 ? 2 : 1, kind === 'r' ? Math.min(l[4], 2) : 2], ref: k };
      }
      return { ligne: l.slice(), ref: k };
    }
  }
  return null;
}

// ── Fonction principale ─────────────────────────────────────────────────────
function profilerVin(wine) {
  const type = APPELLATIONS[wine.type] ? wine.type : 'rouge';
  const nom = norm(wine.name);
  const app = norm(wine.appellation);
  const prix = Number(wine.price) || 0;
  const remarques = [];
  let ligne = null, source = 'defaut', reference = '';

  // 1. Appellation (dans l'appellation, ou dans le nom si c'est plus précis)
  const table = APPELLATIONS[type];
  let key = findLongest(table, app);
  const keyNom = findLongest(table, nom);
  if (keyNom && (!key || keyNom.length > key.length)) key = keyNom;
  if (key) { ligne = table[key].slice(); source = 'appellation'; reference = key; }

  // 2. Cépage
  if (!ligne) {
    const c = depuisCepage(type, wine);
    if (c) { ligne = c.ligne; source = 'cepage'; reference = c.ref; }
  }

  // 3. Défaut
  if (!ligne) { ligne = PAR_DEFAUT[type].slice(); remarques.push('ni appellation ni cépage reconnus'); }

  const p = versObjet(type, ligne);

  // 4. Ajustements communs par le libellé
  if (/ vieilles vignes /.test(nom)) p.intensite = up(p.intensite);
  if (/ (grand cru|premier cru|1er cru|prestige|grande cuvee|millesime) /.test(nom)) p.intensite = up(p.intensite);
  if (/ (leger|legere) /.test(nom)) p.corps = 1;

  // 5. Ajustements par couleur
  if (type === 'rouge') {
    if (/ (fut|futs|barrique|boise|elevage en fut) /.test(nom)) p.boise = 2;
    if (/ (leger|legere) /.test(nom)) p.tanins = 1;
    if (/ (nouveau|primeur) /.test(nom)) { p.corps = 1; p.tanins = 1; p.intensite = 1; p.fruit = 1; }
    const vdn = (ligne[6] || 0) >= 2;
    p.sucrosite = sucrositeLibelle(nom, p.sucrosite);
    if (p.sucrosite >= 2) p.fruit = 3;
    else if (vdn) p.fruit = 2; // VDN vinifié en sec (Maury sec...) : fruit mûr, pas confit
  }

  if (type === 'blanc') {
    if (/ (fut|futs|barrique|boise|elevage en fut) /.test(nom)) p.boise = 2;
    p.sucrosite = sucrositeLibelle(nom, p.sucrosite);
    // Un moelleux/liquoreux a toujours de la matière
    if (p.sucrosite >= 2) { p.texture = 3; p.corps = Math.max(p.corps, 2); }
    if (/ (vin jaune|chateau chalon) /.test(nom)) p.oxydatif = 1;
    if (/ (grand cru|premier cru|1er cru) /.test(nom)) p.corps = Math.max(p.corps, 2);
  }

  if (type === 'rosé') {
    p.sucrosite = sucrositeLibelle(nom, p.sucrosite);
    // Rosés de gastronomie : au-delà de 25 €, presque toujours plus amples
    // (élevage, Mourvèdre, Tibouren...) que le rosé type de leur appellation.
    if (/ gastronomique /.test(nom) || prix >= 25) {
      p.corps = up(p.corps); p.intensite = up(p.intensite); p.style = 3;
      if (prix >= 25) remarques.push('rosé haut de gamme : vérifier corps et style');
    }
  }

  if (type === 'bulles') {
    if (/ (brut nature|extra brut|dosage zero|non dose|pas dose) /.test(nom)) { p.dosage = 0; p.fraicheur = 3; }
    else if (/ demi sec /.test(nom)) p.dosage = 2;
    else if (/ (doux|dolce) /.test(nom)) p.dosage = 3;
    else if (/ (extra dry|sec) /.test(nom)) { p.dosage = 2; remarques.push('mention « sec » : plus sucré qu\'un brut'); }
    else if (/ brut /.test(nom)) p.dosage = 1;
    if (/ blanc de blancs /.test(nom)) { p.vinosite = 1; p.fraicheur = 3; }
    if (/ (blanc de noirs|saignee) /.test(nom)) { p.vinosite = 3; p.corps = up(p.corps); }
    if (/ (millesime|vieilles vignes|grand cru|r d|recemment degorge|grande cuvee) /.test(nom)) p.evolution = 2;
    // Pour le moteur d'accords : sucrosité commune déduite du dosage
    p.sucrosite = [0, 0, 1, 2][p.dosage];
  }

  // 6. Points à faire vérifier par un humain
  if (type === 'bulles' && (reference === 'vouvray' || reference === 'montlouis') &&
      !/ (brut|sec|demi sec|doux|nature) /.test(nom)) {
    remarques.push('dosage non précisé dans le libellé (brut ou demi-sec ?)');
  }
  if (type === 'blanc' && (reference === 'vouvray' || reference === 'montlouis') &&
      !/ (sec|demi sec|moelleux|doux) /.test(nom)) {
    remarques.push('sucrosité non précisée dans le libellé (sec, demi-sec ou moelleux ?)');
  }
  const cepages = String(wine.grape || '').split(',').map(c => norm(c).trim());
  if (type === 'blanc' && cepages.some(c => CEPAGES_ROUGES_SUR_BLANC.includes(c))) {
    remarques.push('cépage rouge indiqué sur un blanc : fiche à corriger');
  }

  return Object.assign(p, {
    source,                   // 'appellation' | 'cepage' | 'defaut' | 'manuel'
    reference,                // clé de la table utilisée
    aVerifier: source === 'defaut' || remarques.length > 0,
    remarques,
    valide: false,            // passe à true quand un humain a relu/corrigé
  });
}

// Sucrosité (rouge, blanc, rosé) : le libellé fait foi quand il la précise
function sucrositeLibelle(nom, base) {
  if (/ (sgn|selection de grains nobles|liquoreux) /.test(nom)) return 3;
  if (/ (vendanges tardives|vt|moelleux|doux|douce) /.test(nom)) return Math.max(base, 2);
  if (/ demi sec /.test(nom)) return 1;
  if (/ sec /.test(nom)) return 0;
  return base;
}

// ── Libellés lisibles (fiche de relecture, admin, prompt) ───────────────────
function listeLibelles(type, axe) {
  return (LIBELLES_COULEUR[type] && LIBELLES_COULEUR[type][axe]) || LIBELLES[axe] || [];
}
function libelle(type, axe, valeur) {
  return listeLibelles(type, axe)[valeur] || String(valeur);
}
function valeurDepuisLibelle(type, axe, texte) {
  const t = norm(texte).trim();
  const i = listeLibelles(type, axe).findIndex(l => l && norm(l).trim() === t);
  if (i >= 0) return i;
  const n = parseInt(texte, 10);
  return isNaN(n) ? null : n;
}

module.exports = {
  profilerVin, AXES, LIBELLES, libelle, valeurDepuisLibelle, listeLibelles,
  APPELLATIONS, CEPAGES_ROUGE, CEPAGES_BLANC,
};
