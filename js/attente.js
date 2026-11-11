/**
 * KIPIN — attente.js
 * Cartes photographiées mais pas encore lues (réseau absent en salon, Gemini saturé…).
 * Les photos sont gardées dans le téléphone (IndexedDB) jusqu'à ce que le contact soit enregistré :
 * une photo prise n'est jamais perdue.
 */
const BASE = 'kipin';
const TABLE = 'cartes';

function ouvrir() {
  return new Promise((ok, ko) => {
    if (!('indexedDB' in window)) { ko(new Error('Stockage indisponible sur ce navigateur.')); return; }
    const req = indexedDB.open(BASE, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(TABLE, { keyPath: 'id' }); };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => ko(req.error || new Error('Stockage indisponible.'));
  });
}

function transaction(mode, fn) {
  return ouvrir().then(db => new Promise((ok, ko) => {
    const tx = db.transaction(TABLE, mode);
    const table = tx.objectStore(TABLE);
    let resultat;
    Promise.resolve(fn(table)).then(r => { resultat = r; });
    tx.oncomplete = () => { db.close(); ok(resultat); };
    tx.onerror = () => { db.close(); ko(tx.error); };
  }));
}

function demande(req) {
  return new Promise((ok, ko) => { req.onsuccess = () => ok(req.result); req.onerror = () => ko(req.error); });
}

/** Garde une carte (recto, verso facultatif). Renvoie son identifiant. id : pour mettre à jour une carte déjà gardée. */
export function garder(images, raison, id) {
  const carte = {
    id: id || String(Date.now()) + Math.random().toString(16).slice(2, 8),
    ajoute: new Date().toISOString(),
    recto: images.recto ? { url: images.recto.url, mimeType: images.recto.mimeType } : null,
    verso: images.verso ? { url: images.verso.url, mimeType: images.verso.mimeType } : null,
    raison: raison || ''
  };
  return transaction('readwrite', t => { t.put(carte); return carte.id; });
}

/** Toutes les cartes en attente, la plus récente d'abord. */
export function lister() {
  return transaction('readonly', t => demande(t.getAll()))
    .then(l => (l || []).sort((a, b) => (a.ajoute < b.ajoute ? 1 : -1)))
    .catch(() => []);
}

export function retirer(id) {
  if (!id) return Promise.resolve();
  return transaction('readwrite', t => { t.delete(id); }).catch(() => {});
}

/** Image gardée → format utilisé par l'écran photo ({ url, data, mimeType }). */
export function versImage(i) {
  return i ? { url: i.url, data: i.url.split(',')[1], mimeType: i.mimeType || 'image/jpeg' } : null;
}
