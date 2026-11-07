/**
 * KIPIN — import.js
 * Contacts venus d'ailleurs que la photo d'une carte papier :
 * - le carnet d'adresses du téléphone (Android : sélecteur de contacts du navigateur) ;
 * - un fichier de contact .vcf (carte de visite électronique, contact partagé depuis l'iPhone) ;
 * - un QR code de contact (vCard ou MECARD) sur la photo d'une carte, lu sans Gemini.
 */

/** Le navigateur sait-il ouvrir le carnet d'adresses ? (Chrome Android, pas Safari iPhone) */
export function carnetDisponible() {
  return !!(navigator.contacts && typeof navigator.contacts.select === 'function');
}

/** Ouvre le carnet d'adresses et renvoie les champs du contact choisi, ou null si annulé. */
export async function choisirDansCarnet() {
  const props = ['name', 'email', 'tel', 'address'];
  let dispo = props;
  try { dispo = await navigator.contacts.getProperties(); } catch (e) { /* liste par défaut */ }
  const res = await navigator.contacts.select(props.filter(p => dispo.indexOf(p) >= 0), { multiple: false });
  if (!res || !res.length) return null;
  const c = res[0];
  const nom = ((c.name && c.name[0]) || '').trim();
  const morceaux = nom.split(/\s+/);
  const a = (c.address && c.address[0]) || null;
  return completer({
    prenom: morceaux.length > 1 ? morceaux.slice(0, -1).join(' ') : nom,
    nom: morceaux.length > 1 ? morceaux[morceaux.length - 1] : '',
    email: (c.email && c.email[0]) || '',
    telephone: (c.tel && c.tel[0]) || '',
    adresse: a ? [(a.addressLine || []).join(' '), [a.postalCode, a.city].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ') : ''
  });
}

/* ================= vCard (.vcf) ================= */

function decoderQP(texte) {
  const octets = [];
  texte.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})|([^=])/gi, (m, hexa, car) => {
    if (hexa) octets.push(parseInt(hexa, 16));
    else new TextEncoder().encode(car).forEach(o => octets.push(o));
    return '';
  });
  return new TextDecoder().decode(new Uint8Array(octets));
}

/** Coupe sur les « ; » non échappés, puis retire les échappements. */
function morceaux(valeur) {
  const out = [];
  let courant = '';
  for (let i = 0; i < valeur.length; i++) {
    const ch = valeur[i];
    if (ch === '\\' && i + 1 < valeur.length) { courant += ch + valeur[i + 1]; i++; continue; }
    if (ch === ';') { out.push(courant); courant = ''; continue; }
    courant += ch;
  }
  out.push(courant);
  return out.map(desechapper);
}

function desechapper(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;:\\])/g, '$1').trim();
}

/** Lit un fichier vCard (2.1, 3.0 ou 4.0). Renvoie la liste des contacts trouvés. */
export function lireVcard(texte) {
  const lignes = String(texte).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const cartes = [];
  let c = null;
  for (const ligne of lignes) {
    if (/^BEGIN:VCARD/i.test(ligne)) { c = {}; continue; }
    if (/^END:VCARD/i.test(ligne)) { if (c) cartes.push(versChamps(c)); c = null; continue; }
    if (!c) continue;
    const i = ligne.indexOf(':');
    if (i < 0) continue;
    const tete = ligne.slice(0, i);
    let valeur = ligne.slice(i + 1);
    const parties = tete.split(';');
    const prop = parties[0].replace(/^item\d+\./i, '').toUpperCase();
    const params = parties.slice(1).join(';').toUpperCase();
    if (/QUOTED-PRINTABLE/.test(params)) valeur = decoderQP(valeur);
    (c[prop] = c[prop] || []).push({ valeur, params });
  }
  return cartes.filter(x => x.prenom || x.nom || x.societe || x.email);
}

function versChamps(c) {
  const premier = prop => (c[prop] && c[prop][0]) || null;
  const champs = {};

  const n = premier('N');
  if (n) {
    const m = morceaux(n.valeur);
    champs.nom = m[0] || '';
    champs.prenom = [m[1], m[2]].filter(Boolean).join(' ');
  }
  const fn = premier('FN');
  if ((!champs.prenom && !champs.nom) && fn) {
    const nom = desechapper(fn.valeur).split(/\s+/);
    champs.prenom = nom.length > 1 ? nom.slice(0, -1).join(' ') : nom[0];
    champs.nom = nom.length > 1 ? nom[nom.length - 1] : '';
  }
  const org = premier('ORG');
  if (org) champs.societe = morceaux(org.valeur)[0] || '';
  const titre = premier('TITLE') || premier('ROLE');
  if (titre) champs.poste = desechapper(titre.valeur);

  const email = premier('EMAIL');
  if (email) champs.email = desechapper(email.valeur).replace(/^mailto:/i, '');

  const tels = c.TEL || [];
  const mobile = tels.find(t => /CELL|MOBILE|IPHONE/.test(t.params) || /type=cell/i.test(t.params)) || tels[0];
  if (mobile) champs.telephone = desechapper(mobile.valeur).replace(/^tel:/i, '');

  const liens = (c.URL || []).concat(c['X-SOCIALPROFILE'] || []).map(u => desechapper(u.valeur));
  const linkedin = liens.find(u => /linkedin\.com/i.test(u));
  if (linkedin) champs.linkedin = /^https?:/i.test(linkedin) ? linkedin : 'https://' + linkedin.replace(/^\/+/, '');
  const site = liens.find(u => !/linkedin\.com|facebook|instagram|twitter|x\.com|tiktok/i.test(u));
  if (site) champs.site = site.replace(/^https?:\/\//i, '').replace(/\/$/, '');

  const adr = premier('ADR');
  if (adr) {
    const a = morceaux(adr.valeur); // boîte postale ; complément ; rue ; ville ; région ; code postal ; pays
    champs.adresse = [[a[1], a[2]].filter(Boolean).join(' '), [a[5], a[3]].filter(Boolean).join(' '), a[6]]
      .filter(Boolean).join(', ').replace(/\n/g, ' ');
  }
  const note = premier('NOTE');
  if (note) champs.contexte = desechapper(note.valeur).slice(0, 500);
  return completer(champs);
}

/* ================= QR code de contact ================= */

/** MECARD:N:Nom,Prénom;TEL:…;EMAIL:…;ORG:…;URL:…;ADR:…;; */
function lireMecard(texte) {
  const corps = texte.replace(/^MECARD:/i, '');
  const champs = {};
  const valeur = cle => {
    const m = new RegExp('(?:^|;)' + cle + ':((?:\\\\.|[^;])*)', 'i').exec(corps);
    return m ? m[1].replace(/\\(.)/g, '$1').trim() : '';
  };
  const n = valeur('N').split(',');
  champs.nom = (n[0] || '').trim();
  champs.prenom = (n[1] || '').trim();
  champs.telephone = valeur('TEL');
  champs.email = valeur('EMAIL');
  champs.societe = valeur('ORG');
  champs.poste = valeur('TITLE');
  const url = valeur('URL');
  if (/linkedin\.com/i.test(url)) champs.linkedin = url; else champs.site = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  champs.adresse = valeur('ADR').replace(/,+/g, ', ');
  champs.contexte = valeur('NOTE');
  return completer(champs);
}

let chargementJsQR = null;
function chargerJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!chargementJsQR) {
    chargementJsQR = new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
      s.onload = () => ok(window.jsQR);
      s.onerror = () => { chargementJsQR = null; ko(new Error('Lecteur de QR code indisponible.')); };
      document.head.appendChild(s);
    });
  }
  return chargementJsQR;
}

/**
 * Cherche un QR code dans l'image (data URL JPEG).
 * Renvoie { type: 'contact', champs } , { type: 'lien', url } ou null.
 */
export async function chercherQR(dataUrl) {
  let texte = '';
  try {
    if ('BarcodeDetector' in window) {
      const detecteur = new window.BarcodeDetector({ formats: ['qr_code'] });
      const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const codes = await detecteur.detect(img);
      if (codes.length) texte = codes[0].rawValue || '';
    }
    if (!texte) {
      const jsQR = await chargerJsQR();
      const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = dataUrl; });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const donnees = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const res = jsQR(donnees.data, donnees.width, donnees.height, { inversionAttempts: 'attemptBoth' });
      if (res) texte = res.data || '';
    }
  } catch (e) {
    return null; // pas de QR lisible : on passera par Gemini
  }
  texte = texte.trim();
  if (!texte) return null;
  if (/^BEGIN:VCARD/i.test(texte)) {
    const cartes = lireVcard(texte);
    return cartes.length ? { type: 'contact', champs: cartes[0] } : null;
  }
  if (/^MECARD:/i.test(texte)) return { type: 'contact', champs: lireMecard(texte) };
  if (/^https?:\/\//i.test(texte)) return { type: 'lien', url: texte };
  return null;
}

const CLES = ['prenom', 'nom', 'societe', 'poste', 'email', 'telephone', 'site', 'linkedin', 'adresse', 'contexte'];
function completer(c) {
  const out = {};
  CLES.forEach(k => { out[k] = String((c && c[k]) || '').trim(); });
  out.email = out.email.toLowerCase();
  return out;
}
