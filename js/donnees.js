/**
 * KIPIN — donnees.js
 * Tout ce qui touche au compte Google de l'utilisateur :
 * son Sheet « Kipin – Contacts », ses photos, ses événements Agenda,
 * le partage d'un rappel par email et le rendez-vous « relances de la semaine ».
 */
import { CONFIG } from './config.js';
import { api, memoriserEmail } from './google.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const AGENDA = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export const COLONNES = [
  ['id', 'ID'], ['ajoute', 'Ajouté le'], ['prenom', 'Prénom'], ['nom', 'Nom'],
  ['societe', 'Société'], ['poste', 'Poste'], ['email', 'Email'], ['telephone', 'Mobile'],
  ['fixe', 'Fixe'], ['standard', 'Standard'], ['site', 'Site web'], ['linkedin', 'LinkedIn'], ['adresse', 'Adresse'], ['contexte', 'Contexte'],
  ['priorite', 'Priorité'], ['tag', 'Tag'], ['dateRelance', 'Date de relance'], ['agenda', 'Agenda'],
  ['recap', 'Récap du lundi'], ['statut', 'Statut'], ['eventId', 'ID événement'], ['photo', 'Photo'],
  ['photoIds', 'ID photos'], ['invites', 'Rappel partagé avec']
];
const DERNIERE_COL = String.fromCharCode(64 + COLONNES.length); // 24 colonnes → « X »
export const STATUTS = ['À relancer', 'Relancé', 'Sans suite'];
export const PRIORITES = ['Haute', 'Moyenne', 'Basse'];
const CHAMPS_CARTE = ['prenom', 'nom', 'societe', 'poste', 'email', 'telephone', 'fixe', 'standard', 'site', 'linkedin', 'adresse'];

/* Espace de l'utilisateur, rempli par charger() */
const E = { sheetId: '', gidContacts: null, dossierId: '', config: {}, email: '' };

const fuseau = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris';
const enc = encodeURIComponent;

/* ================= Chargement et création de l'espace ================= */

/** Charge (ou crée au premier lancement) l'espace Kipin de l'utilisateur. */
export async function charger() {
  const moi = await api('https://openidconnect.googleapis.com/v1/userinfo');
  E.email = moi.email || '';
  memoriserEmail(E.email);

  const trouves = await api(DRIVE + '?spaces=drive&fields=files(id,name)&q=' +
    enc("appProperties has { key='kipin' and value='contacts' } and trashed=false"));
  if (trouves.files && trouves.files.length) {
    E.sheetId = trouves.files[0].id;
  } else {
    await creerSheet();
  }
  const meta = await api(SHEETS + '/' + E.sheetId + '?fields=sheets.properties');
  meta.sheets.forEach(s => { if (s.properties.title === 'Contacts') E.gidContacts = s.properties.sheetId; });
  await ajouterColonnesTelephone();

  const lots = await api(SHEETS + '/' + E.sheetId + '/values:batchGet?majorDimension=ROWS&ranges=' +
    enc('Contacts!A2:' + DERNIERE_COL) + '&ranges=' + enc('Réglages!A2:B') + '&ranges=' + enc('Config!A2:B'));
  const [contactsBrut, reglagesBrut, configBrut] = lots.valueRanges.map(v => v.values || []);

  E.config = {};
  configBrut.forEach(l => { if (l[0]) E.config[l[0]] = l[1] || ''; });
  E.dossierId = E.config.dossierPhotos || '';
  if (E.config.format !== '2' && E.gidContacts !== null) {
    try { await reparerFormat(); } catch (e) { /* esthétique seulement : on continue */ }
  }

  return {
    email: E.email,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + E.sheetId + '/edit',
    contacts: contactsBrut.filter(l => l[0]).map(ligneVersContact),
    tags: reglagesBrut.map(l => (l[0] || '').trim()).filter(Boolean),
    carnet: reglagesBrut.map(l => (l[1] || '').trim().toLowerCase()).filter(Boolean),
    reglages: lireReglages(),
    cleGemini: E.config.gemini || ''
  };
}

/**
 * Sheets créés avant les trois numéros : on insère « Fixe » et « Standard » juste après
 * l'ancienne colonne « Téléphone » (renommée « Mobile »). Les numéros déjà saisis restent en place.
 * Vérifié sur l'en-tête : ne s'applique jamais deux fois.
 */
async function ajouterColonnesTelephone() {
  if (E.gidContacts === null) return;
  const r = await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Contacts!A1:X1'));
  const entete = (r.values && r.values[0]) || [];
  if (entete[8] === 'Fixe' || entete[7] !== 'Téléphone') return;
  await api(SHEETS + '/' + E.sheetId + ':batchUpdate', {
    corps: { requests: [{ insertDimension: { range: { sheetId: E.gidContacts, dimension: 'COLUMNS', startIndex: 8, endIndex: 10 }, inheritFromBefore: true } }] }
  });
  await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Contacts!A1') + '?valueInputOption=RAW', {
    methode: 'PUT', corps: { values: [COLONNES.map(c => c[1])] }
  });
}

/** Texte noir sans fond sur tout l'onglet Contacts, en-tête en gras. */
async function reparerFormat() {
  const noir = { red: 0, green: 0, blue: 0 };
  await api(SHEETS + '/' + E.sheetId + ':batchUpdate', {
    corps: {
      requests: [
        { repeatCell: { range: { sheetId: E.gidContacts }, cell: { userEnteredFormat: { textFormat: { bold: false, foregroundColor: noir } } }, fields: 'userEnteredFormat(backgroundColor,textFormat.bold,textFormat.foregroundColor)' } },
        { repeatCell: { range: { sheetId: E.gidContacts, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } }
      ]
    }
  });
  await ecrireConfig('format', '2');
}

async function creerSheet() {
  const ss = await api(SHEETS, {
    corps: {
      properties: { title: CONFIG.NOM_SHEET, locale: 'fr_FR' },
      sheets: [
        { properties: { title: 'Contacts', gridProperties: { frozenRowCount: 1 } } },
        { properties: { title: 'Réglages' } },
        { properties: { title: 'Config', hidden: true } }
      ]
    }
  });
  E.sheetId = ss.spreadsheetId;
  const gid = ss.sheets[0].properties.sheetId;
  await api(SHEETS + '/' + E.sheetId + '/values:batchUpdate', {
    corps: {
      valueInputOption: 'RAW',
      data: [
        { range: 'Contacts!A1', values: [COLONNES.map(c => c[1])] },
        { range: 'Réglages!A1', values: [['Tags', "Emails d'invitation"]].concat(CONFIG.TAGS_DEFAUT.map(t => [t, ''])) },
        { range: 'Config!A1', values: [['Clé', 'Valeur'], ['version', '1'], ['format', '2']] }
      ]
    }
  });
  await api(SHEETS + '/' + E.sheetId + ':batchUpdate', {
    corps: {
      requests: [{
        repeatCell: {
          range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold'
        }
      }]
    }
  });
  await api(DRIVE + '/' + E.sheetId, { methode: 'PATCH', corps: { appProperties: { kipin: 'contacts' } } });
}

/* ================= Config (onglet caché) ================= */

async function ecrireConfig(cle, valeur) {
  E.config[cle] = valeur;
  const lignes = Object.keys(E.config).map(k => [k, String(E.config[k])]);
  await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Config!A2:B') + ':clear', { corps: {} });
  await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Config!A2') + '?valueInputOption=RAW', {
    methode: 'PUT', corps: { values: lignes }
  });
}

function lireReglages() {
  const r = JSON.parse(JSON.stringify(CONFIG.REGLAGES_DEFAUT));
  try {
    const lu = JSON.parse(E.config.reglages || '{}');
    Object.keys(r).forEach(k => { if (lu[k] !== undefined) r[k] = lu[k]; });
  } catch (e) { /* valeurs par défaut */ }
  return r;
}

export async function sauverReglages(r) {
  const borne = (n, min, max, d) => (isNaN(n) ? d : Math.min(max, Math.max(min, n)));
  const D = CONFIG.REGLAGES_DEFAUT;
  const propre = {
    delai: borne(parseInt(r.delai, 10), 1, 365, D.delai),
    heure: borne(parseInt(r.heure, 10), 0, 23, D.heure),
    duree: borne(parseInt(r.duree, 10), 5, 240, D.duree),
    agendaDefaut: r.agendaDefaut === true,
    recapDefaut: r.recapDefaut === true,
    recapActif: r.recapActif === true
  };
  await ecrireConfig('reglages', JSON.stringify(propre));
  return propre;
}

export async function enregistrerCle(cle) {
  await ecrireConfig('gemini', cle);
}

/* ================= Contacts ================= */

function ligneVersContact(l) {
  const c = {};
  COLONNES.forEach((col, i) => {
    const v = l[i] === undefined || l[i] === null ? '' : String(l[i]);
    if (col[0] === 'agenda' || col[0] === 'recap') c[col[0]] = v.toLowerCase() === 'oui';
    else c[col[0]] = v;
  });
  return c;
}

function contactVersLigne(c) {
  return COLONNES.map(col => {
    const k = col[0];
    if (k === 'agenda' || k === 'recap') return c[k] ? 'oui' : 'non';
    return c[k] === undefined || c[k] === null ? '' : String(c[k]);
  });
}

function nettoyerEmails(texte) {
  const liste = String(texte || '').split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
  liste.forEach(e => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Adresse email invalide pour le partage : ' + e);
  });
  if (liste.length > 5) throw new Error('Partage limité à 5 adresses.');
  return liste.filter((e, i) => liste.indexOf(e) === i).join(', ');
}

function normaliser(c, reglages) {
  const p = {};
  CHAMPS_CARTE.concat(['contexte', 'tag', 'id', 'ajoute', 'statut', 'eventId', 'photo', 'photoIds']).forEach(k => {
    p[k] = String(c[k] || '').trim();
  });
  p.invites = nettoyerEmails(c.invites);
  p.priorite = PRIORITES.indexOf(c.priorite) >= 0 ? c.priorite : 'Moyenne';
  p.agenda = c.agenda === true;
  p.recap = c.recap === true;
  // Date vide = « Aucune relance » choisie : ni événement, ni récap, ni partage.
  if (c.dateRelance === '') {
    p.dateRelance = '';
    p.agenda = false;
    p.recap = false;
    p.invites = '';
  } else {
    p.dateRelance = /^\d{4}-\d{2}-\d{2}$/.test(String(c.dateRelance)) ? c.dateRelance : isoPlusJours(isoAuj(), reglages.delai);
  }
  if (!p.prenom && !p.nom && !p.societe && !p.email) throw new Error('Renseigne au moins un nom, une société ou un email.');
  return p;
}

async function trouverLigne(id) {
  const col = await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Contacts!A:A'));
  const i = (col.values || []).findIndex(l => l[0] === id);
  if (i < 1) throw new Error('Contact introuvable dans le Sheet (supprimé à la main ?).');
  return i + 1;
}

async function lireLigne(ligne) {
  const r = await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Contacts!A' + ligne + ':' + DERNIERE_COL + ligne));
  return ligneVersContact((r.values || [[]])[0]);
}

async function ecrireLigne(ligne, c) {
  await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Contacts!A' + ligne + ':' + DERNIERE_COL + ligne) + '?valueInputOption=RAW', {
    methode: 'PUT', corps: { values: [contactVersLigne(c)] }
  });
}

export async function enregistrerContact(c, photoIds, reglages) {
  c = normaliser(c, reglages);
  c.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  c.ajoute = isoAuj();
  c.statut = c.dateRelance ? 'À relancer' : 'Sans suite'; // « Aucune relance » = rien à relancer
  c.eventId = '';
  c.photoIds = (photoIds || []).join(',');
  c.photo = photoIds && photoIds.length ? await renommerPhotos(photoIds, c) : '';
  await syncEvenement(c, reglages);
  await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Contacts!A1') + ':append?valueInputOption=RAW&insertDataOption=OVERWRITE', {
    corps: { values: [contactVersLigne(c)] }
  });
  await partagerSiBesoin(c, reglages);
  return c;
}

export async function majContact(c, reglages) {
  const ligne = await trouverLigne(c.id);
  const ancien = await lireLigne(ligne);
  const nouveau = normaliser(c, reglages);
  ['id', 'ajoute', 'statut', 'eventId', 'photo', 'photoIds'].forEach(k => { nouveau[k] = ancien[k]; });
  if (!nouveau.dateRelance && nouveau.statut === 'À relancer') nouveau.statut = 'Sans suite';
  if (nouveau.dateRelance && !ancien.dateRelance && nouveau.statut === 'Sans suite') nouveau.statut = 'À relancer';
  await syncEvenement(nouveau, reglages);
  await ecrireLigne(ligne, nouveau);
  if (nouveau.invites && (nouveau.invites !== ancien.invites || nouveau.dateRelance !== ancien.dateRelance)) {
    await partagerSiBesoin(nouveau, reglages);
  }
  return nouveau;
}

export async function changerStatut(id, statut, reglages) {
  if (STATUTS.indexOf(statut) < 0) throw new Error('Statut inconnu.');
  const ligne = await trouverLigne(id);
  const c = await lireLigne(ligne);
  c.statut = statut;
  await syncEvenement(c, reglages);
  await ecrireLigne(ligne, c);
  return c;
}

export async function reporterRelance(id, dateIso, reglages) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateIso))) throw new Error('Choisis une date de relance.');
  const ligne = await trouverLigne(id);
  const c = await lireLigne(ligne);
  c.dateRelance = dateIso;
  c.statut = 'À relancer';
  await syncEvenement(c, reglages);
  await ecrireLigne(ligne, c);
  await partagerSiBesoin(c, reglages);
  return c;
}

export async function supprimerContact(id) {
  const ligne = await trouverLigne(id);
  const c = await lireLigne(ligne);
  if (c.eventId) await supprimerEvenement(c.eventId);
  for (const pid of String(c.photoIds || '').split(',').filter(Boolean)) {
    try { await api(DRIVE + '/' + pid, { methode: 'PATCH', corps: { trashed: true } }); } catch (e) { /* déjà supprimée */ }
  }
  await api(SHEETS + '/' + E.sheetId + ':batchUpdate', {
    corps: { requests: [{ deleteDimension: { range: { sheetId: E.gidContacts, dimension: 'ROWS', startIndex: ligne - 1, endIndex: ligne } } }] }
  });
  return id;
}

/* ================= Tags et carnet d'emails (onglet Réglages) ================= */

async function lireReglagesOnglet() {
  const r = await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Réglages!A2:B'));
  const l = r.values || [];
  return {
    tags: l.map(x => (x[0] || '').trim()).filter(Boolean),
    carnet: l.map(x => (x[1] || '').trim().toLowerCase()).filter(Boolean)
  };
}

async function ecrireReglagesOnglet(tags, carnet) {
  const n = Math.max(tags.length, carnet.length);
  const lignes = [];
  for (let i = 0; i < n; i++) lignes.push([tags[i] || '', carnet[i] || '']);
  await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Réglages!A2:B') + ':clear', { corps: {} });
  if (lignes.length) {
    await api(SHEETS + '/' + E.sheetId + '/values/' + enc('Réglages!A2') + '?valueInputOption=RAW', { methode: 'PUT', corps: { values: lignes } });
  }
}

export async function ajouterTag(tag) {
  tag = String(tag || '').trim();
  if (!tag) throw new Error('Écris le nom du tag.');
  const o = await lireReglagesOnglet();
  if (!o.tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
    o.tags.push(tag);
    await ecrireReglagesOnglet(o.tags, o.carnet);
  }
  return o.tags;
}

export async function supprimerTag(tag) {
  const o = await lireReglagesOnglet();
  o.tags = o.tags.filter(t => t !== tag);
  await ecrireReglagesOnglet(o.tags, o.carnet);
  return o.tags;
}

/** Renomme un tag dans la liste ET sur toutes les fiches qui le portent. */
export async function renommerTag(ancien, nouveau) {
  nouveau = String(nouveau || '').trim();
  if (!nouveau) throw new Error('Écris le nouveau nom du tag.');
  const o = await lireReglagesOnglet();
  let tags = o.tags.map(t => (t === ancien ? nouveau : t));
  tags = tags.filter((t, i) => tags.map(x => x.toLowerCase()).indexOf(t.toLowerCase()) === i);
  await ecrireReglagesOnglet(tags, o.carnet);

  const colTag = String.fromCharCode(65 + COLONNES.findIndex(c => c[0] === 'tag'));
  const plage = 'Contacts!' + colTag + '2:' + colTag;
  const r = await api(SHEETS + '/' + E.sheetId + '/values/' + enc(plage));
  let modifies = 0;
  const valeurs = (r.values || []).map(l => {
    if ((l[0] || '') === ancien) { modifies++; return [nouveau]; }
    return [l[0] || ''];
  });
  if (modifies) {
    await api(SHEETS + '/' + E.sheetId + '/values/' + enc(plage) + '?valueInputOption=RAW', { methode: 'PUT', corps: { values: valeurs } });
  }
  return { tags, modifies };
}

export async function ajouterAuCarnet(texte) {
  const nouveaux = nettoyerEmails(texte).split(/,\s*/).filter(Boolean);
  const o = await lireReglagesOnglet();
  const ajout = nouveaux.filter(e => o.carnet.indexOf(e) < 0);
  if (ajout.length) {
    o.carnet = o.carnet.concat(ajout);
    await ecrireReglagesOnglet(o.tags, o.carnet);
  }
  return o.carnet;
}

export async function supprimerDuCarnet(email) {
  const o = await lireReglagesOnglet();
  o.carnet = o.carnet.filter(e => e !== email);
  await ecrireReglagesOnglet(o.tags, o.carnet);
  return o.carnet;
}

/* ================= Photos (Drive) ================= */

async function dossierPhotos() {
  if (E.dossierId) {
    try {
      const f = await api(DRIVE + '/' + E.dossierId + '?fields=id,trashed');
      if (!f.trashed) return E.dossierId;
    } catch (e) { /* dossier supprimé : on le recrée */ }
  }
  const d = await api(DRIVE + '?fields=id', {
    corps: { name: CONFIG.NOM_DOSSIER, mimeType: 'application/vnd.google-apps.folder', appProperties: { kipin: 'photos' } }
  });
  E.dossierId = d.id;
  await ecrireConfig('dossierPhotos', d.id);
  return d.id;
}

/** images = [{data: base64, mimeType}] → identifiants Drive. */
export async function sauverPhotos(images) {
  const dossier = await dossierPhotos();
  const horodatage = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const ids = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const octets = Uint8Array.from(atob(img.data), ch => ch.charCodeAt(0));
    const limite = 'kipin' + Math.random().toString(16).slice(2);
    const meta = { name: 'carte_' + horodatage + (i === 0 ? '_recto' : '_verso') + '.jpg', parents: [dossier] };
    const corps = new Blob([
      '--' + limite + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
      '--' + limite + '\r\nContent-Type: ' + (img.mimeType || 'image/jpeg') + '\r\n\r\n',
      octets,
      '\r\n--' + limite + '--'
    ]);
    const f = await api(UPLOAD + '?uploadType=multipart&fields=id', { corps, type: 'multipart/related; boundary=' + limite });
    ids.push(f.id);
  }
  return ids;
}

export async function jeterPhotos(ids) {
  for (const id of ids || []) {
    try { await api(DRIVE + '/' + id, { methode: 'PATCH', corps: { trashed: true } }); } catch (e) { /* ignorée */ }
  }
}

async function renommerPhotos(ids, c) {
  const nom = [c.prenom, c.nom].join(' ').trim() || c.societe || 'Contact';
  let lien = '';
  for (let i = 0; i < ids.length; i++) {
    try {
      const f = await api(DRIVE + '/' + ids[i] + '?fields=webViewLink', {
        methode: 'PATCH', corps: { name: nom + (i === 0 ? ' – recto' : ' – verso') + '.jpg' }
      });
      if (i === 0) lien = f.webViewLink || '';
    } catch (e) { /* on continue sans renommer */ }
  }
  return lien;
}

/* ================= Agenda ================= */

function nomComplet(c) { return [c.prenom, c.nom].join(' ').trim() || c.societe || c.email || 'Contact'; }

function descriptionEvenement(c) {
  const l = [];
  if (c.poste || c.societe) l.push([c.poste, c.societe].filter(Boolean).join(' · '));
  if (c.email) l.push('Email : ' + c.email);
  if (c.telephone) l.push('Mobile : ' + c.telephone);
  if (c.fixe) l.push('Fixe : ' + c.fixe);
  if (c.standard) l.push('Standard : ' + c.standard);
  if (c.linkedin) l.push('LinkedIn : ' + c.linkedin);
  if (c.contexte) l.push('', 'Contexte : ' + c.contexte);
  l.push('', 'Ajouté avec Kipin : ' + urlApp());
  return l.join('\n');
}

function horaire(iso, heure, duree, minute) {
  minute = minute || 0;
  const debut = iso + 'T' + String(heure).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00';
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), heure, minute, 0);
  const f = new Date(d.getTime() + duree * 60000);
  const fin = isoDe(f) + 'T' + String(f.getHours()).padStart(2, '0') + ':' + String(f.getMinutes()).padStart(2, '0') + ':00';
  return { start: { dateTime: debut, timeZone: fuseau() }, end: { dateTime: fin, timeZone: fuseau() } };
}

async function supprimerEvenement(id) {
  try { await api(AGENDA + '/' + enc(id), { methode: 'DELETE' }); } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
}

/** Crée, déplace ou supprime l'événement de relance pour qu'il corresponde au contact. */
async function syncEvenement(c, r) {
  const voulu = c.agenda && c.statut === 'À relancer' && c.dateRelance;
  if (!voulu) {
    if (c.eventId) await supprimerEvenement(c.eventId);
    c.eventId = '';
    return c;
  }
  const qui = nomComplet(c);
  const corps = Object.assign({
    summary: 'Relancer ' + qui + (c.societe && qui !== c.societe ? ' (' + c.societe + ')' : ''),
    description: descriptionEvenement(c),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
  }, horaire(c.dateRelance, r.heure, r.duree));
  if (c.eventId) {
    try {
      await api(AGENDA + '/' + enc(c.eventId), { methode: 'PATCH', corps: Object.assign({ status: 'confirmed' }, corps) });
      return c;
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  const ev = await api(AGENDA, { corps });
  c.eventId = ev.id;
  return c;
}

/**
 * Récap du lundi : un rendez-vous par semaine (lundi 8 h 45) qui ne liste QUE les relances
 * de cette semaine-là, plus celles à rattraper pour le prochain lundi.
 * Les rendez-vous sont créés jusqu'à 12 semaines à l'avance, mis à jour quand la liste change
 * et supprimés quand une semaine n'a plus de relance. Les lundis passés ne sont plus modifiés.
 */
export async function syncRecap(contacts, r) {
  let carte = {};
  try { carte = JSON.parse(E.config.recapEvents || '{}'); } catch (e) { carte = {}; }
  const avant = JSON.stringify(carte);

  // Ancienne version : un seul rendez-vous récurrent, remplacé par un rendez-vous par semaine.
  if (E.config.recapEventId) {
    await supprimerEvenement(E.config.recapEventId);
    await ecrireConfig('recapEventId', '');
  }

  const premier = lundiRecap();
  const limite = isoPlusJours(premier, 7 * 12);
  const semaines = {};
  if (r.recapActif) {
    contacts
      .filter(c => c.statut === 'À relancer' && c.recap && c.dateRelance)
      .sort((a, b) => (a.dateRelance < b.dateRelance ? -1 : 1))
      .forEach(c => {
        let lundi = lundiDe(c.dateRelance);
        const groupe = lundi < premier ? 'rattraper' : 'semaine';
        if (lundi < premier) lundi = premier;
        if (lundi > limite) return;
        (semaines[lundi] = semaines[lundi] || { rattraper: [], semaine: [] })[groupe].push(c);
      });
  }

  const ligne = c => '• ' + dateFr(c.dateRelance) + ' — ' + nomComplet(c) +
    (c.societe && nomComplet(c) !== c.societe ? ' (' + c.societe + ')' : '') +
    (c.contexte ? '\n   ' + c.contexte.slice(0, 120) : '');

  for (const lundi of Object.keys(semaines)) {
    const s = semaines[lundi];
    const total = s.rattraper.length + s.semaine.length;
    const description =
      (s.rattraper.length ? 'À RATTRAPER (prévues avant ce lundi)\n' + s.rattraper.map(ligne).join('\n') + '\n\n' : '') +
      (s.semaine.length ? 'CETTE SEMAINE (du ' + dateFr(lundi) + ' au ' + dateFr(isoPlusJours(lundi, 6)) + ')\n' + s.semaine.map(ligne).join('\n') + '\n\n' : '') +
      'Ouvrir Kipin : ' + urlApp();
    const summary = 'Kipin · relances de la semaine (' + total + ')';
    const signature = HEURE_RECAP + '|' + summary + '|' + description;
    const deja = carte[lundi];
    if (deja && deja.sig === signature) continue; // rien n'a changé : aucun appel

    const corps = Object.assign({
      summary, description,
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }
    }, horaire(lundi, 8, 15, 45));

    let id = deja && deja.id;
    if (id) {
      try {
        await api(AGENDA + '/' + enc(id), { methode: 'PATCH', corps: Object.assign({ status: 'confirmed' }, corps) });
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e;
        id = '';
      }
    }
    if (!id) id = (await api(AGENDA, { corps })).id;
    carte[lundi] = { id, sig: signature };
  }

  // Semaines à venir devenues vides : on retire leur rendez-vous. Les lundis passés sont oubliés.
  for (const lundi of Object.keys(carte)) {
    if (lundi < premier) { delete carte[lundi]; continue; }
    if (!semaines[lundi]) {
      await supprimerEvenement(carte[lundi].id);
      delete carte[lundi];
    }
  }

  if (JSON.stringify(carte) !== avant) await ecrireConfig('recapEvents', JSON.stringify(carte));
}

/** Heure du récap : 8 h 45, juste avant les relances du jour (9 h par défaut). */
const HEURE_RECAP = '08:45';

/** Lundi de la semaine d'une date (AAAA-MM-JJ). */
function lundiDe(iso) {
  const p = iso.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDe(d);
}

/** Prochain récap : aujourd'hui si on est lundi avant 8 h 45, sinon lundi prochain. */
function lundiRecap() {
  const maintenant = new Date();
  if (maintenant.getDay() === 1 && maintenant.getHours() * 60 + maintenant.getMinutes() < 8 * 60 + 45) return isoDe(maintenant);
  return isoPlusJours(lundiDe(isoDe(maintenant)), 7);
}

/* ================= Partage du rappel par email (Gmail + .ics) ================= */

function b64(texte) {
  const octets = new TextEncoder().encode(texte);
  let bin = '';
  octets.forEach(o => { bin += String.fromCharCode(o); });
  return btoa(bin);
}
function b64Lignes(texte) { return b64(texte).replace(/.{76}/g, '$&\r\n'); }
function b64url(texte) { return b64(texte).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function echapper(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** Envoie le rappel aux adresses de c.invites. N'empêche jamais l'enregistrement. */
async function partagerSiBesoin(c, r) {
  if (!c.invites || !c.dateRelance) return c;
  try {
    const qui = [c.prenom, c.nom].join(' ').trim();
    const cible = (qui || c.societe || c.email || 'ce contact') + (qui && c.societe ? ' - ' + c.societe : '');
    const quand = dateFr(c.dateRelance) + ' à ' + r.heure + ' h';
    const texte = 'Bonjour,\n\nRappel de reprendre contact avec ' + cible + '.\n\nTrès bonne journée,';
    const html = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0E1726">' +
      '<p>Bonjour,</p><p>Rappel de reprendre contact avec <strong>' + echapper(cible) + '</strong>.</p><p>Très bonne journée,</p>' +
      '<p style="font-size:12px;color:#556070">Rendez-vous du ' + echapper(quand) + ' en pièce jointe : ouvre-la pour l\'ajouter à ton agenda.</p></div>';
    const ics = construireIcs(c, r, 'Reprendre contact avec ' + cible, 'Rappel de reprendre contact avec ' + cible + '.');
    const sujet = 'Rappel : reprendre contact avec ' + cible + ' (' + quand + ')';

    const m = 'kipinM' + Date.now(), a = 'kipinA' + Date.now();
    const mime = [
      'To: ' + c.invites,
      'Subject: =?UTF-8?B?' + b64(sujet) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="' + m + '"',
      '',
      '--' + m,
      'Content-Type: multipart/alternative; boundary="' + a + '"',
      '',
      '--' + a,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lignes(texte),
      '--' + a,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lignes(html),
      '--' + a + '--',
      '--' + m,
      'Content-Type: text/calendar; charset=UTF-8; method=REQUEST; name="rappel.ics"',
      'Content-Disposition: attachment; filename="rappel.ics"',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lignes(ics),
      '--' + m + '--'
    ].join('\r\n');
    await api(GMAIL, { corps: { raw: b64url(mime) } });
  } catch (e) {
    if (e.name === 'ErreurSession') throw e;
    c.partageErreur = e.message;
  }
  return c;
}

function construireIcs(c, r, titre, description) {
  const pad = n => String(n).padStart(2, '0');
  const utc = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + '00Z';
  const ech = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const p = c.dateRelance.split('-').map(Number);
  const debut = new Date(p[0], p[1] - 1, p[2], r.heure, 0, 0);
  const fin = new Date(debut.getTime() + r.duree * 60000);
  const lignes = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kipin//Relances//FR', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:' + c.id + '@kipin',
    'SEQUENCE:' + Math.floor(Date.now() / 60000),
    'DTSTAMP:' + utc(new Date()),
    'DTSTART:' + utc(debut),
    'DTEND:' + utc(fin),
    'SUMMARY:' + ech(titre),
    'DESCRIPTION:' + ech(description + (c.contexte ? '\n\nContexte : ' + c.contexte : '')),
    'ORGANIZER;CN=Kipin:mailto:' + E.email
  ];
  c.invites.split(/,\s*/).forEach(e => lignes.push('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:' + e));
  lignes.push('STATUS:CONFIRMED', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + ech(titre), 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  return lignes.map(plier).join('\r\n');
}

/** Le format iCalendar impose des lignes de 75 octets au plus. */
function plier(ligne) {
  const morceaux = [];
  let courant = '', taille = 0;
  for (const ch of ligne) {
    const octets = new TextEncoder().encode(ch).length;
    if (taille + octets > (morceaux.length ? 74 : 75)) { morceaux.push(courant); courant = ''; taille = 0; }
    courant += ch; taille += octets;
  }
  morceaux.push(courant);
  return morceaux.join('\r\n ');
}

/* ================= Dates ================= */

const JOURS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function isoDe(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function isoAuj() { return isoDe(new Date()); }
function isoPlusJours(iso, n) { const p = iso.split('-').map(Number); return isoDe(new Date(p[0], p[1] - 1, p[2] + Number(n || 0))); }
function dateFr(iso) { const p = iso.split('-').map(Number); const d = new Date(p[0], p[1] - 1, p[2]); return JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()]; }
function urlApp() { return location.origin + location.pathname; }
