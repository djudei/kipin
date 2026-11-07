/**
 * KIPIN — google.js
 * Connexion Google par redirection (pas de fenêtre pop-up : fonctionne aussi
 * quand Kipin est ajouté à l'écran d'accueil de l'iPhone) et appels aux API Google.
 * Le jeton d'accès vit 1 heure ; Kipin le renouvelle sans rien demander tant que
 * la session Google du navigateur est ouverte.
 */
import { CONFIG } from './config.js';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.file',      // uniquement les fichiers créés par Kipin
  'https://www.googleapis.com/auth/calendar.events', // événements de relance
  'https://www.googleapis.com/auth/gmail.send'       // partage du rappel par email
];

const CLE_JETON = 'kipin.jeton';
const CLE_EMAIL = 'kipin.email';
const CLE_ETAT = 'kipin.oauthEtat';
const CLE_SILENCIEUX = 'kipin.essaiSilencieux';

/** Erreur levée quand il faut se (re)connecter. */
export class ErreurSession extends Error {
  constructor(message) { super(message || 'Ta session Google a expiré.'); this.name = 'ErreurSession'; }
}

function lire(cle, stockage) {
  try { return JSON.parse((stockage || localStorage).getItem(cle)); } catch (e) { return null; }
}
function ecrire(cle, valeur, stockage) {
  try {
    if (valeur === null) (stockage || localStorage).removeItem(cle);
    else (stockage || localStorage).setItem(cle, JSON.stringify(valeur));
  } catch (e) { /* stockage indisponible (navigation privée) */ }
}

export function urlRetour() {
  return location.origin + location.pathname;
}

/** Envoie vers l'écran de connexion Google. silencieux = sans rien afficher si déjà connecté. */
export function seConnecter(silencieux) {
  const etat = Math.random().toString(36).slice(2) + Date.now().toString(36);
  ecrire(CLE_ETAT, etat, sessionStorage);
  if (silencieux) ecrire(CLE_SILENCIEUX, Date.now(), sessionStorage);
  const p = new URLSearchParams({
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: urlRetour(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state: etat,
    prompt: silencieux ? 'none' : 'select_account'
  });
  const email = lire(CLE_EMAIL);
  if (email) p.set('login_hint', email);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p.toString());
}

/**
 * À appeler au démarrage. Lit la réponse de Google dans l'adresse (#access_token=…).
 * Renvoie { statut: 'connecte' | 'a-connecter' | 'redirige', erreur?, scopesManquants? }.
 */
export function demarrerSession() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('access_token') || fragment.has('error')) {
    history.replaceState(null, '', urlRetour() + location.search);
    const etatAttendu = lire(CLE_ETAT, sessionStorage);
    ecrire(CLE_ETAT, null, sessionStorage);
    if (fragment.get('state') !== etatAttendu) {
      return { statut: 'a-connecter', erreur: 'La connexion a été interrompue. Réessaie.' };
    }
    if (fragment.has('error')) {
      const e = fragment.get('error');
      if (e === 'access_denied') return { statut: 'a-connecter', erreur: 'Connexion annulée.' };
      return { statut: 'a-connecter' }; // login_required, interaction_required… : connexion manuelle
    }
    const jeton = {
      valeur: fragment.get('access_token'),
      expire: Date.now() + (Number(fragment.get('expires_in') || 3600) - 120) * 1000,
      scopes: (fragment.get('scope') || '').split(' ')
    };
    ecrire(CLE_JETON, jeton);
    ecrire(CLE_SILENCIEUX, null, sessionStorage);
    const manquants = SCOPES.filter(s => s.startsWith('https://') && jeton.scopes.indexOf(s) < 0);
    return { statut: 'connecte', scopesManquants: manquants };
  }

  if (jetonValide()) return { statut: 'connecte', scopesManquants: [] };

  // Déjà venu ici : on renouvelle sans rien demander (une seule tentative par minute).
  const dernierEssai = lire(CLE_SILENCIEUX, sessionStorage);
  if (lire(CLE_EMAIL) && (!dernierEssai || Date.now() - dernierEssai > 60000)) {
    seConnecter(true);
    return { statut: 'redirige' };
  }
  return { statut: 'a-connecter' };
}

export function jetonValide() {
  const j = lire(CLE_JETON);
  return !!(j && j.valeur && j.expire > Date.now());
}

/** Minutes restantes avant expiration du jeton. */
export function minutesRestantes() {
  const j = lire(CLE_JETON);
  return j ? Math.floor((j.expire - Date.now()) / 60000) : 0;
}

export function memoriserEmail(email) { ecrire(CLE_EMAIL, email); }
export function emailMemorise() { return lire(CLE_EMAIL); }

export async function seDeconnecter() {
  const j = lire(CLE_JETON);
  ecrire(CLE_JETON, null);
  ecrire(CLE_EMAIL, null);
  if (j && j.valeur) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(j.valeur), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } catch (e) { /* hors ligne : le jeton expirera seul */ }
  }
}

/**
 * Appel à une API Google avec le jeton de l'utilisateur.
 * options : { methode, corps (objet JSON, Blob ou texte), type, brut (renvoie la Response) }
 */
export async function api(url, options) {
  options = options || {};
  const j = lire(CLE_JETON);
  if (!j || !j.valeur || j.expire <= Date.now()) throw new ErreurSession();

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
      throw new Error('Google ' + service(url) + ' ne répond pas (' + (e.message || e.name) + '). Réessaie dans un instant.');
    }
  }
  if (rep.status === 401) {
    ecrire(CLE_JETON, null);
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
