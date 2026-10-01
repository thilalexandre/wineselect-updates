#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  MAJ-LIBELLE.JS
//
//  Fait écrire au sommelier (chat et parcours guidé) les mêmes noms de vins
//  que ceux affichés à l'écran : « Domaine Faiveley — La Framboisière,
//  Mercurey 2021 », « Château Lynch-Bages, Pauillac 2019 »...
//
//  Modifie EN PLACE, sans toucher au reste :
//    serveur.js  1. ajoute libelleVin() — même règle que dans WineSelect.html ;
//                2. recopie domaine / cuvée / millésime / photo / emplacement
//                   importés par l'admin (data/stock-overrides.json) dans le
//                   catalogue du serveur, et calcule le libellé de chaque vin ;
//                3. envoie ce libellé au sommelier dans les listes de candidats.
//    accords.js  4. envoie ce libellé dans les lignes de candidats du moteur.
//
//  Usage : node maj-libelle.js   (dans le dossier Wineselect, à côté de serveur.js)
//  Une sauvegarde .bak-<date> est créée avant toute modification.
//  Peut être relancé sans risque : ce qui est déjà fait est ignoré.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dossier = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let erreurs = 0;

function lire(nom) {
  const p = path.join(dossier, nom);
  if (!fs.existsSync(p)) { console.error('❌ ' + nom + ' introuvable dans ' + dossier); erreurs++; return null; }
  return { p, txt: fs.readFileSync(p, 'utf-8') };
}

function verifierEtEcrire(f, nouveau, nom) {
  if (nouveau === f.txt) { console.log('✓ ' + nom + ' : déjà à jour, rien à faire.'); return; }
  const tmp = f.p + '.tmp-check.js';
  fs.writeFileSync(tmp, nouveau, 'utf-8');
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) {
    console.error('❌ ' + nom + ' : le résultat contiendrait une erreur de syntaxe. AUCUNE modification faite.');
    try { fs.unlinkSync(tmp); } catch (e2) {}
    erreurs++; return;
  }
  fs.unlinkSync(tmp);
  fs.copyFileSync(f.p, f.p + '.bak-' + stamp);
  fs.writeFileSync(f.p, nouveau, 'utf-8');
  console.log('✅ ' + nom + ' mis à jour (sauvegarde : ' + path.basename(f.p) + '.bak-' + stamp + ')');
}

// Remplace toutes les occurrences de « ' | ' + w.name + ' | ' » (nom du vin dans
// une ligne de candidat) par le libellé, avec repli sur le nom s'il manque.
const ANCIEN_NOM = "' | ' + w.name + ' | '";
const NOUVEAU_NOM = "' | ' + (w.libelle || w.name) + ' | '";

// ── serveur.js ──────────────────────────────────────────────────────────────
const serveur = lire('serveur.js');
if (serveur) {
  let s = serveur.txt;

  // 1 + 2. libelleVin() et enrichissement du catalogue
  if (!s.includes('function libelleVin(')) {
    const ancre = 'function applyStockOverrides() {';
    if (!s.includes(ancre)) {
      console.error('❌ serveur.js : repère « ' + ancre + ' » introuvable. Fichier inattendu, aucune modification.');
      erreurs++;
    } else {
      const bloc =
"// ── Identité des vins (libellé) ─────────────────────────────────────────────\n" +
"// Même règle que libelleVin() dans WineSelect.html — les deux doivent rester\n" +
"// identiques pour que le sommelier écrive les noms affichés à l'écran.\n" +
"const CHAMPS_FICHE = ['domaine', 'cuvee', 'millesime', 'photo', 'emplacement'];\n" +
"function libelleVin(w) {\n" +
"  if (!w) return '';\n" +
"  if (!w.domaine && !w.cuvee) return w.millesime ? w.name + ' ' + w.millesime : w.name;\n" +
"  let s = w.domaine && w.cuvee ? w.domaine + ' — ' + w.cuvee : (w.cuvee || w.domaine);\n" +
"  if (w.appellation && s.toLowerCase().indexOf(String(w.appellation).toLowerCase()) < 0) s += ', ' + w.appellation;\n" +
"  if (w.millesime) s += ' ' + w.millesime;\n" +
"  return s;\n" +
"}\n" +
"// Après l'application des stocks/prix : recopie les champs de fiche importés\n" +
"// par l'admin et calcule le libellé de chaque vin du catalogue serveur.\n" +
"function enrichirFiches() {\n" +
"  const overrides = readJSON('stock-overrides', []);\n" +
"  const byId = new Map((Array.isArray(overrides) ? overrides : []).map(o => [o.id, o]));\n" +
"  WINES_CATALOG = WINES_CATALOG.map(w => {\n" +
"    const o = byId.get(w.id);\n" +
"    const x = Object.assign({}, w);\n" +
"    if (o) CHAMPS_FICHE.forEach(k => { if (o[k] != null && String(o[k]).trim()) x[k] = String(o[k]).trim(); });\n" +
"    x.libelle = libelleVin(x);\n" +
"    return x;\n" +
"  });\n" +
"}\n" +
"function applyStockOverrides() {\n" +
"  applyStockOverridesBase();\n" +
"  try { enrichirFiches(); } catch (e) { console.warn('⚠️  Libellés des vins non calculés :', e.message); }\n" +
"}\n" +
"function applyStockOverridesBase() {";
      s = s.replace(ancre, bloc);
    }
  }

  // 3. Libellé dans les listes de candidats envoyées au sommelier
  const n = s.split(ANCIEN_NOM).length - 1;
  s = s.split(ANCIEN_NOM).join(NOUVEAU_NOM);
  if (n) console.log('   serveur.js : libellé utilisé dans ' + n + ' liste(s) de candidats.');

  verifierEtEcrire(serveur, s, 'serveur.js');
}

// ── accords.js ──────────────────────────────────────────────────────────────
const accords = lire('accords.js');
if (accords) {
  const n = accords.txt.split(ANCIEN_NOM).length - 1;
  const a = accords.txt.split(ANCIEN_NOM).join(NOUVEAU_NOM);
  if (n) console.log('   accords.js : libellé utilisé dans ' + n + ' ligne(s) de candidats.');
  verifierEtEcrire(accords, a, 'accords.js');
}

console.log(erreurs
  ? '\n⚠️  Terminé avec ' + erreurs + ' problème(s) : voir les messages ci-dessus.\n'
  : '\n🍷  Terminé. Dépose serveur.js et accords.js sur le dépôt wineselect-updates, puis relance la borne.\n');
