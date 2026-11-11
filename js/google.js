/**
 * KIPIN — google.js
 * Connexion Google par la fenêtre officielle de Google (comme Hours) et appels aux API Google.
 *
 * - Le jeton d'accès vit 1 heure. Il est gardé dans le navigateur pour rouvrir Kipin sans rien redemander.
 * - L'email du compte est retenu : au retour, un seul appui suffit (la fenêtre Google s'ouvre et se referme seule).
 * - Quand le jeton expire pendant une action, l'action n'échoue pas : elle se met en pause,
 *   Kipin affiche « Continuer », puis l'action reprend là où elle en était (rien n'est perdu).
 */
import { CONFIG } from './config.js';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.file',      // uniquement les fichiers créés par Kipin
  'https://www.googleapis.com/auth/calendar.events.owned' // événements de relance, seulement dans les agendas de la personne (et invitations envoyées par Google Agenda)
];

const CLE_JETON = 'kipin.jeton';
const CLE_EMAIL = 'kipin.email';
const MARGE_MS = 2 * 60 * 1000;
const ATTENTE_SCRIPT_MS = 10000;

/** Erreur levée quand la personne annule la reconnexion. */
export class ErreurSession extends Error {
  constructor(message) { super(message || 'Ta connexion Google a expiré.'); this.name = 'ErreurSession'; }
}

function lire(cle) {
  try { return JSON.parse(localStorage.getItem(cle)); } catch (e) { return null; }
}
function ecrire(cle, valeur) {
  try {
    if (valeur === null) localStorage.removeItem(cle);
    else localStorage.setItem(cle, JSON.stringify(valeur));
  } catch (e) { /* stockage indisponible (navigation privée) */ }
}

/* ---------- Fenêtre de connexion Google ---------- */
let client = null;
let enAttente = null;

function attendreScriptGoogle() {
  return new Promise((ok, ko) => {
    const debut = Date.now();
    (function verifier() {
      if (window.google && google.accounts && google.accounts.oauth2) return ok();
      if (Date.now() - debut > ATTENTE_SCRIPT_MS) return ko(new Error('Le module de connexion Google ne se charge pas. Vérifie ta connexion internet.'));
      setTimeout(verifier, 100);
    })();
  });
}

function creerClient() {
  client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES.join(' '),
    include_granted_scopes: true,
    callback: (rep) => {
      const attente = enAttente; enAttente = null;
      if (!attente) return;
      if (rep.error) {
        attente.ko(new Error(rep.error === 'access_denied' ? 'Connexion annulée.' : 'Connexion Google impossible (' + (rep.error_description || rep.error) + ').'));
        return;
      }
      const scopes = String(rep.scope || '').split(' ');
      ecrire(CLE_JETON, {
        valeur: rep.access_token,
        expire: Date.now() + Number(rep.expires_in || 3600) * 1000 - MARGE_MS,
        scopes
      });
      attente.ok(SCOPES.filter(s => s.startsWith('https://') && scopes.indexOf(s) < 0));
    },
    error_callback: (err) => {
      const attente = enAttente; enAttente = null;
      if (!attente) return;
      const t = err && err.type;
      attente.ko(new Error(t === 'popup_closed' ? 'Fenêtre Google fermée avant la fin. Réessaie.'
        : t === 'popup_failed_to_open' ? 'Le téléphone a bloqué la fenêtre Google. Réessaie en touchant le bouton.'
        : 'Connexion Google impossible. Réessaie.'));
    }
  });
}

function demanderJeton(options) {
  if (!client) creerClient();
  return new Promise((ok, ko) => {
    enAttente = { ok, ko };
    client.requestAccessToken(options);
  });
}

/** Le module Google est prêt : la fenêtre peut s'ouvrir sans délai au moment de l'appui (sinon Safari la bloque). */
export function prechargerConnexion() {
  attendreScriptGoogle().then(() => { if (!client) creerClient(); }, () => {});
}

/**
 * Ouvre la fenêtre Google. À appeler directement depuis un appui.
 * Compte retenu : il est proposé d'office (la fenêtre s'ouvre et se referme seule).
 * autreCompte : Google laisse choisir le compte.
 * Renvoie la liste des autorisations refusées (vide si tout est coché).
 */
export async function connecter(autreCompte) {
  if (!(window.google && google.accounts && google.accounts.oauth2)) await attendreScriptGoogle();
  const email = lire(CLE_EMAIL);
  const options = autreCompte || !email ? { prompt: 'select_account' } : { prompt: '', login_hint: email };
  return demanderJeton(options);
}

export function jetonValide() {
  const j = lire(CLE_JETON);
  return !!(j && j.valeur && j.expire > Date.now());
}

/** Autorisations refusées lors de la dernière connexion. */
export function scopesManquants() {
  const j = lire(CLE_JETON);
  if (!j || !j.scopes) return [];
  return SCOPES.filter(s => s.startsWith('https://') && j.scopes.indexOf(s) < 0);
}

export function memoriserEmail(email) { ecrire(CLE_EMAIL, email); }
export function emailMemorise() { return lire(CLE_EMAIL); }

export async function seDeconnecter() {
  const j = lire(CLE_JETON);
  ecrire(CLE_JETON, null);
  ecrire(CLE_EMAIL, null);
  if (j && j.valeur) {
    try {
      if (window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(j.valeur, () => {});
    } catch (e) { /* hors ligne : le jeton expirera seul */ }
  }
}

/* ---------- Reprise après expiration ---------- */
let reprise = null;
let surReprise = function () {};

/** L'interface s'abonne ici : fn(true) = afficher « Continuer », fn(false) = le retirer. */
export function quandRepriseDemandee(fn) { surReprise = fn; }

export function repriseEnCours() { return !!reprise; }

function attendreReprise() {
  if (!reprise) {
    let ok, ko;
    const promesse = new Promise((a, b) => { ok = a; ko = b; });
    reprise = { promesse, ok, ko };
    surReprise(true);
  }
  return reprise.promesse;
}

/** Appui sur « Continuer » : nouveau jeton, puis les actions en pause repartent. En cas d'échec, « Continuer » reste. */
export async function reprendre() {
  await connecter(false);
  const r = reprise; reprise = null;
  surReprise(false);
  if (r) r.ok();
}

/** Appui sur « Annuler » : les actions en pause s'arrêtent sans rien écrire. */
export function abandonnerReprise() {
  const r = reprise; reprise = null;
  surReprise(false);
  if (r) r.ko(new ErreurSession('Action annulée : la connexion Google a expiré.'));
}

/* ---------- Appels aux API ---------- */
/**
 * Appel à une API Google avec le jeton de l'utilisateur.
 * options : { methode, corps (objet JSON, Blob ou texte), type, brut (renvoie la Response) }
 */
export async function api(url, options, dejaRepris) {
  options = options || {};
  if (!jetonValide()) await attendreReprise();
  const j = lire(CLE_JETON);

  const entetes = { Authorization: 'Bearer ' + j.valeur };
  let corps = options.corps;
  if (corps !== undefined && !(corps instanceof Blob) && typeof corps !== 'string') {
    corps = JSON.stringify(corps);
    entetes['Content-Type'] = 'application/json';
  }
  if (options.type) entetes['Content-Type'] = options.type;

  let rep;
  for (let essai = 0; ; essai++) {
    try {
      rep = await fetch(url, { method: options.methode || (corps !== undefined ? 'POST' : 'GET'), headers: entetes, body: corps });
      break;
    } catch (e) {
      // Coupure réseau passagère : une seconde tentative avant d'abandonner.
      if (essai === 0) { await new Promise(r => setTimeout(r, 1500)); continue; }
      const err = new Error('Google ' + service(url) + ' ne répond pas (' + (e.message || e.name) + '). Réessaie dans un instant.');
      err.reseau = true;
      throw err;
    }
  }
  if (rep.status === 401) {
    ecrire(CLE_JETON, null);
    if (!dejaRepris) return api(url, options, true);
    throw new ErreurSession();
  }
  if (options.brut) return rep;
  if (rep.status === 204) return null;
  const texte = await rep.text();
  let json = null;
  try { json = texte ? JSON.parse(texte) : null; } catch (e) { json = null; }
  if (!rep.ok) {
    const msg = (json && json.error && (json.error.message || json.error)) || texte.slice(0, 200);
    const err = new Error(traduireErreur(rep.status, String(msg), url));
    err.status = rep.status;
    throw err;
  }
  return json;
}

function service(url) {
  if (url.indexOf('upload') >= 0 || url.indexOf('/drive/') >= 0) return 'Drive';
  if (url.indexOf('sheets') >= 0) return 'Sheets';
  if (url.indexOf('calendar') >= 0) return 'Agenda';
  if (url.indexOf('gmail') >= 0) return 'Gmail';
  return '';
}

function traduireErreur(statut, message, url) {
  if (statut === 403 && /insufficient|scope|permission/i.test(message)) {
    if (url.indexOf('calendar') >= 0) return "Kipin n'a pas l'autorisation d'utiliser ton Agenda. Déconnecte-toi puis reconnecte-toi en cochant toutes les cases.";
    if (url.indexOf('gmail') >= 0) return "Kipin n'a pas l'autorisation d'envoyer des emails. Déconnecte-toi puis reconnecte-toi en cochant toutes les cases.";
    return "Autorisation Google manquante. Déconnecte-toi puis reconnecte-toi en cochant toutes les cases.";
  }
  if (statut === 403 && /has not been used|disabled/i.test(message)) {
    return "Une API Google n'est pas activée dans le projet Google Cloud de Kipin. (" + message.slice(0, 120) + ')';
  }
  if (statut === 429) return 'Google limite les requêtes. Réessaie dans une minute.';
  if (statut >= 500) return 'Google ne répond pas pour le moment. Réessaie dans un instant.';
  return 'Erreur Google (' + statut + ') : ' + message;
}
