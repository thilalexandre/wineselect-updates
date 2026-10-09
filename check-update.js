// Vérifie automatiquement si une nouvelle version de WineSelect.html et
// serveur.js est disponible sur GitHub, et les remplace si besoin.
//
// À lancer AVANT de démarrer le serveur (voir instructions d'intégration
// dans INSTALLER.bat, section plus bas).
//
// Usage : node check-update.js

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const FILES = [
  // Bibliothèques et polices de l'écran (octobre 2026), servies par la borne
  // pour qu'elle démarre sans Internet. Fichiers figés : pas de sauvegarde .bak.
  {
    name: 'vendor/react.production.min.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/react.production.min.js',
    minLength: 5000,
    checkSyntax: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/react-dom.production.min.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/react-dom.production.min.js',
    minLength: 50000,
    checkSyntax: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/babel.min.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/babel.min.js',
    minLength: 1000000,
    checkSyntax: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices.css',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices.css',
    minLength: 500,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/cormorant-garamond-latin-400-italic.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/cormorant-garamond-latin-400-italic.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/cormorant-garamond-latin-400-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/cormorant-garamond-latin-400-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/cormorant-garamond-latin-500-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/cormorant-garamond-latin-500-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/cormorant-garamond-latin-600-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/cormorant-garamond-latin-600-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/cormorant-garamond-latin-700-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/cormorant-garamond-latin-700-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/montserrat-latin-400-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/montserrat-latin-400-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/montserrat-latin-500-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/montserrat-latin-500-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/montserrat-latin-600-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/montserrat-latin-600-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/polices/montserrat-latin-700-normal.woff2',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/polices/montserrat-latin-700-normal.woff2',
    minLength: 5000,
    binaire: true,
    sansSauvegarde: true,
  },
  {
    name: 'vendor/LICENCES.txt',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/vendor/LICENCES.txt',
    minLength: 1000,
    sansSauvegarde: true,
  },
  {
    name: 'WineSelect.html',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/WineSelect.html',
    minLength: 50000, // garde-fou : un téléchargement vide/coupé ne doit jamais écraser le fichier local
  },
  // Logique du sommelier (octobre 2026), chargée par serveur.js : placée AVANT
  // lui, pour qu'un serveur.js neuf ne démarre jamais sans elle.
  {
    name: 'sommelier.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/sommelier.js',
    minLength: 5000,
    checkSyntax: true,
  },
  {
    name: 'serveur.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/serveur.js',
    minLength: 1000,
    checkSyntax: true, // fichier exécutable : on vérifie qu'il est syntaxiquement valide avant de l'appliquer
  },
  // Moteur d'accords (septembre 2026) : chargés par serveur.js. S'ils manquent,
  // le serveur fonctionne quand même, avec l'ancien tri par catégorie.
  {
    name: 'accords.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/accords.js',
    minLength: 5000,
    checkSyntax: true,
  },
  {
    name: 'profils-reference.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/profils-reference.js',
    minLength: 5000,
    checkSyntax: true,
  },
  // Ce script se met à jour lui-même (la nouvelle version sert au prochain démarrage).
  {
    name: 'check-update.js',
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/check-update.js',
    minLength: 3000,
    checkSyntax: true,
  },
  // Catalogue de démonstration : installé comme wines-data.js UNIQUEMENT si la
  // borne tourne déjà sur la démo (ou n'a pas encore de catalogue). Le catalogue
  // d'un magasin (sans la mention de démonstration) n'est jamais écrasé.
  {
    name: 'wines-data-demo.js',
    cible: 'wines-data.js',
    seulementDemo: true,
    url: 'https://raw.githubusercontent.com/thilalexandre/wineselect-updates/refs/heads/main/wines-data-demo.js',
    minLength: 100000,
    checkSyntax: true,
  },
];

// Note : le catalogue d'un magasin (wines-data.js) n'est jamais publié ni écrasé
// par une mise à jour générique poussée à toutes les bornes. Seul le catalogue
// de démonstration circule, et seulement vers les bornes en démo.
const MARQUE_DEMO = 'Catalogue de DÉMONSTRATION';

function fetchUrl(url, redirectsLeft = 5, binaire = false) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WineSelect-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        fetchUrl(res.headers.location, redirectsLeft - 1, binaire).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      // Polices (binaires) : octets bruts. Textes : UTF-8, sans couper un accent entre deux paquets.
      if (binaire) {
        const morceaux = [];
        res.on('data', (chunk) => { morceaux.push(chunk); });
        res.on('end', () => resolve(Buffer.concat(morceaux)));
        return;
      }
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function checkAndUpdate(file) {
  const localPath = path.join(__dirname, file.cible || file.name);

  if (file.seulementDemo && fs.existsSync(localPath) &&
      !fs.readFileSync(localPath, 'utf-8').slice(0, 300).includes(MARQUE_DEMO)) {
    console.log('✓ ' + path.basename(localPath) + ' : catalogue du magasin, jamais remplacé automatiquement.');
    return;
  }

  let remoteContent;
  try {
    remoteContent = await fetchUrl(file.url, 5, !!file.binaire);
  } catch (e) {
    console.log('⚠️  ' + file.name + ' : vérification impossible (' + e.message + '). On garde la version locale.');
    return;
  }

  if (!remoteContent || remoteContent.length < file.minLength) {
    console.log('⚠️  ' + file.name + ' : le fichier distant semble incomplet. On garde la version locale par sécurité.');
    return;
  }
  if (file.seulementDemo && !remoteContent.slice(0, 300).includes(MARQUE_DEMO)) {
    console.log('⚠️  ' + file.name + ' : le fichier distant n\'est pas un catalogue de démonstration. Ignoré par sécurité.');
    return;
  }

  let localContent = null;
  try {
    localContent = file.binaire ? fs.readFileSync(localPath) : fs.readFileSync(localPath, 'utf-8');
  } catch (e) {
    // Pas de fichier local — première installation, on écrit directement plus bas.
  }

  if (localContent !== null && hash(localContent) === hash(remoteContent)) {
    console.log('✓ ' + file.name + ' déjà à jour.');
    return;
  }

  fs.mkdirSync(path.dirname(localPath), { recursive: true }); // ex. vendor/ : avant la vérification de syntaxe
  if (file.checkSyntax) {
    // Le fichier de vérification doit finir par .js : depuis Node 22/24,
    // « node --check » refuse une extension inconnue (ex. .tmp-check).
    const tmpPath = localPath + '.tmp-check.js';
    try {
      fs.writeFileSync(tmpPath, remoteContent, 'utf-8');
      execFileSync(process.execPath, ['--check', tmpPath]);
    } catch (e) {
      console.log('⚠️  ' + file.name + ' : le fichier téléchargé contient une erreur de syntaxe (' + e.message.split('\n')[0] + ').');
      console.log('   Mise à jour ANNULÉE par sécurité — on garde la version locale actuelle.');
      try { fs.unlinkSync(tmpPath); } catch (e2) {}
      return;
    }
    try { fs.unlinkSync(tmpPath); } catch (e2) {}
  }

  if (localContent !== null && !file.sansSauvegarde) {
    const backupPath = localPath + '.bak-' + Date.now();
    fs.copyFileSync(localPath, backupPath);
    cleanOldBackups(file.name, 5);
  }
  fs.mkdirSync(path.dirname(localPath), { recursive: true }); // ex. vendor/polices/
  // Écriture atomique : un fichier à moitié écrit (borne éteinte) ne casse jamais l'écran.
  fs.writeFileSync(localPath + '.tmp', remoteContent, file.binaire ? undefined : 'utf-8');
  fs.renameSync(localPath + '.tmp', localPath);
  console.log('⬆️  ' + file.name + ' mis à jour depuis GitHub.');
}

// Ne garde que les N sauvegardes .bak-<timestamp> les plus récentes pour ce
// fichier, pour éviter qu'elles s'accumulent indéfiniment au fil des mises
// à jour (des mois de démarrages quotidiens = des dizaines de fichiers).
function cleanOldBackups(fileName, keep) {
  try {
    const prefix = fileName + '.bak-';
    const backups = fs.readdirSync(__dirname)
      .filter(f => f.startsWith(prefix))
      .sort(); // le timestamp dans le nom trie déjà du plus ancien au plus récent
    const toDelete = backups.slice(0, Math.max(0, backups.length - keep));
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(__dirname, f)); } catch (e) {}
    }
  } catch (e) {}
}

async function main() {
  console.log('🔍 Vérification des mises à jour Wine Select...');
  for (const file of FILES) {
    await checkAndUpdate(file);
  }
  checkWinesDataPresent();
  console.log('✓ Vérification terminée.\n');
}

// wines-data.js est le catalogue de CE magasin — il n'est jamais téléchargé
// automatiquement (voir commentaire sur FILES plus haut). S'il manque, la
// borne démarrera avec un catalogue vide sans que ce soit évident : on
// avertit clairement ici pour éviter une découverte en pleine démo.
function checkWinesDataPresent() {
  // Borne connectée au serveur central : le catalogue vient de lui, pas de ce fichier.
  if (fs.existsSync(path.join(__dirname, 'borne-jeton.txt'))) return;
  const p = path.join(__dirname, 'wines-data.js');
  if (!fs.existsSync(p)) {
    console.log('');
    console.log('❌ wines-data.js est introuvable dans ce dossier !');
    console.log('   Sans ce fichier, la borne démarrera avec un catalogue VIDE.');
    console.log('   Copie le fichier wines-data.js de ce magasin à côté de serveur.js avant de continuer.');
    console.log('');
  }
}

main().catch((e) => {
  console.error('⚠️  Erreur inattendue lors de la vérification des mises à jour:', e.message);
  console.error('   Démarrage avec la version locale actuelle.');
});
