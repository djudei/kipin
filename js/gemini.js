/**
 * KIPIN — gemini.js
 * Lecture de la carte par l'API Gemini, directement depuis le téléphone,
 * avec la clé gratuite de l'utilisateur. Le modèle n'est pas figé :
 * Kipin prend le « Flash » le plus récent et bascule sur un autre s'il est saturé.
 */
const URL_GEMINI = 'https://generativelanguage.googleapis.com/v1beta/';
const CLES_CARTE = ['prenom', 'nom', 'societe', 'poste', 'email', 'telephone', 'fixe', 'standard', 'site', 'linkedin', 'adresse'];
const CLE_CACHE = 'kipin.modeles';
const CLE_MEMO = 'kipin.modele';
const CLE_NIVEAUX = 'kipin.niveaux';

const PROMPT = [
  'Tu lis une carte de visite. La première image est le recto, la seconde (si elle existe) le verso.',
  'Extrais les informations de la personne. Règles :',
  "- N'invente jamais rien. Si une information n'est pas sur la carte, laisse le champ vide.",
  '- prenom et nom séparés, avec majuscule initiale (pas tout en capitales).',
  "- societe : le nom de l'entreprise ou de la marque.",
  "- Numéros écrits tels qu'imprimés, un par champ : telephone = le mobile (en France 06 / 07, +33 6 / +33 7, ou marqué M., Mob., Portable) ;",
  "  fixe = la ligne directe fixe (marquée T., Tél., Ligne directe, ou un fixe non marqué) ; standard = le numéro marqué Standard, Accueil, Switchboard ou Main.",
  "  S'il n'y a qu'un fixe non marqué, mets-le dans fixe. Un fax ne va dans aucun champ.",
  '- site : le domaine sans https:// (ex. maison-exemple.fr).',
  "- linkedin : l'adresse complète du profil seulement si elle est imprimée sur la carte.",
  '- adresse : sur une seule ligne.',
  '- champsIncertains : les noms des champs que tu as lus avec un doute (texte flou, police difficile, plusieurs possibilités).',
  "Réponds uniquement avec l'objet JSON demandé."
].join('\n');

const SCHEMA = {
  type: 'OBJECT',
  properties: Object.assign(
    Object.fromEntries(CLES_CARTE.map(k => [k, { type: 'STRING' }])),
    { champsIncertains: { type: 'ARRAY', items: { type: 'STRING' } } }
  ),
  required: CLES_CARTE.concat(['champsIncertains'])
};

function stock(cle, valeur) {
  try {
    if (valeur === undefined) return JSON.parse(localStorage.getItem(cle));
    localStorage.setItem(cle, JSON.stringify(valeur));
  } catch (e) { return null; }
  return null;
}

/**
 * Appel à Gemini avec une limite de temps. En cas d'échec réseau, renvoie une
 * réponse factice de statut 0 pour que l'appelant puisse réessayer ou changer de modèle.
 */
async function requete(url, cle, corps, delaiMs) {
  const arret = new AbortController();
  const minuteur = setTimeout(() => arret.abort(), delaiMs || 60000);
  try {
    return await fetch(url, {
      method: corps ? 'POST' : 'GET',
      headers: Object.assign({ 'x-goog-api-key': cle }, corps ? { 'Content-Type': 'application/json' } : {}),
      body: corps ? JSON.stringify(corps) : undefined,
      signal: arret.signal
    });
  } catch (e) {
    const cause = e.name === 'AbortError' ? 'pas de réponse en 60 s' : (e.message || e.name);
    return { status: 0, cause, text: async () => '' };
  } finally {
    clearTimeout(minuteur);
  }
}

function message(texte) {
  try { const j = JSON.parse(texte); return (j.error && j.error.message) || texte.slice(0, 200); } catch (e) { return texte.slice(0, 200); }
}

/** Vérifie qu'une clé est acceptée par Gemini. */
export async function testerCle(cle) {
  const rep = await requete(URL_GEMINI + 'models?pageSize=1', cle, null, 20000);
  if (rep.status === 0) throw new Error('Gemini injoignable depuis ce téléphone (' + rep.cause + ').');
  if (rep.status !== 200) throw new Error("Cette clé est refusée par Gemini. Vérifier qu'elle a été copiée en entier.");
}

/** Modèles Flash disponibles pour la clé, du plus récent au moins récent (cache 6 h). */
async function modelesFlash(cle) {
  const cache = stock(CLE_CACHE);
  if (cache && cache.expire > Date.now() && cache.liste.length) return cache.liste;
  const rep = await requete(URL_GEMINI + 'models?pageSize=1000', cle, null, 20000);
  if (rep.status === 0) throw new Error('Gemini injoignable depuis ce téléphone (' + rep.cause + ').');
  const texte = await rep.text();
  if (rep.status !== 200) throw new Error('Impossible de lister les modèles Gemini (' + rep.status + ') : ' + message(texte));
  const noms = (JSON.parse(texte).models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => String(m.name).replace(/^models\//, ''));
  const version = n => { const v = /^gemini-(\d+)(?:\.(\d+))?/.exec(n); return v ? [Number(v[1]), Number(v[2] || 0)] : [0, 0]; };
  const tri = (a, b) => { const va = version(a), vb = version(b); return (vb[0] - va[0]) || (vb[1] - va[1]); };
  const liste = noms.filter(n => /^gemini-\d+(\.\d+)?-flash$/.test(n)).sort(tri)
    .concat(noms.filter(n => n === 'gemini-flash-latest'))
    .concat(noms.filter(n => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)).sort(tri));
  stock(CLE_CACHE, { expire: Date.now() + 6 * 3600 * 1000, liste });
  return liste;
}

/** images = [{data: base64, mimeType}] → { champs, incertains } */
export async function lireCarte(cle, images) {
  if (!cle) throw new Error('Clé Gemini manquante : l\'ajouter dans Réglages.');
  const contenu = [{ role: 'user', parts: [{ text: PROMPT }].concat(images.map(i => ({ inlineData: { mimeType: i.mimeType || 'image/jpeg', data: i.data } }))) }];
  // Recopier une carte ne demande pas de « réflexion » : on prend le niveau le plus bas
  // que le modèle accepte (minimal, sinon low), sinon son réglage par défaut.
  const corpsPour = niveau => ({
    contents: contenu,
    generationConfig: Object.assign(
      { responseMimeType: 'application/json', responseSchema: SCHEMA },
      niveau ? { thinkingConfig: { thinkingLevel: niveau } } : {}
    )
  });
  const niveaux = stock(CLE_NIVEAUX) || {};

  const memorise = stock(CLE_MEMO);
  let candidats = await modelesFlash(cle);
  if (memorise && candidats.indexOf(memorise) >= 0) candidats = [memorise].concat(candidats.filter(m => m !== memorise));
  candidats = candidats.slice(0, 4);
  if (!candidats.length) throw new Error("Aucun modèle Gemini Flash n'est disponible pour cette clé.");

  const journal = [];
  let quotaPartout = true;
  for (const modele of candidats) {
    const aEssayer = niveaux[modele] !== undefined ? [niveaux[modele]] : ['minimal', 'low', ''];
    let niveau = aEssayer.shift();
    for (let essai = 0; essai < 2; essai++) {
      const rep = await requete(URL_GEMINI + 'models/' + modele + ':generateContent', cle, corpsPour(niveau));
      const texte = await rep.text();
      if (rep.status === 200) {
        stock(CLE_MEMO, modele);
        niveaux[modele] = niveau;
        stock(CLE_NIVEAUX, niveaux);
        return nettoyer(lireReponse(texte));
      }
      // Niveau de réflexion refusé par ce modèle : on essaie le suivant, sans compter d'échec.
      if (rep.status === 400 && /think/i.test(texte) && aEssayer.length) {
        niveau = aEssayer.shift();
        essai--;
        continue;
      }
      journal.push(modele + ' ' + (rep.status || 'réseau : ' + rep.cause));
      if (rep.status === 0) {
        quotaPartout = false;
        if (essai === 0) { await new Promise(r => setTimeout(r, 1500)); continue; }
        break;
      }
      if (rep.status === 401 || (rep.status === 400 && /API key/i.test(texte))) {
        throw new Error('La clé Gemini est refusée. La changer dans Réglages.');
      }
      if (rep.status === 404 || rep.status === 403 || (rep.status === 400 && /model|not supported|not found|unsupported/i.test(texte))) {
        quotaPartout = false;
        localStorage.removeItem(CLE_CACHE);
        break;
      }
      if (rep.status === 429 || rep.status >= 500) {
        if (rep.status >= 500) quotaPartout = false;
        if (essai === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }
        break;
      }
      throw new Error('Erreur Gemini (' + rep.status + ', ' + modele + ') : ' + message(texte));
    }
  }
  if (quotaPartout) throw new Error('Quota gratuit Gemini atteint. Réessayer dans une minute, ou demain si la limite du jour est atteinte.');
  if (journal.every(j => j.indexOf('réseau') >= 0)) {
    throw new Error('Gemini ne répond pas depuis ce téléphone (' + journal[journal.length - 1] + '). Vérifier qu\'aucun bloqueur de contenu ou VPN ne filtre Google, puis réessayer.');
  }
  throw new Error('Gemini est saturé ou injoignable en ce moment (' + journal.join(', ') + '). Réessayer dans une minute.');
}

function lireReponse(texte) {
  const illisible = "Gemini n'a pas réussi à lire la carte. Reprendre la photo, bien à plat et sans reflet.";
  const json = JSON.parse(texte);
  const parts = (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  let txt = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
  if (!txt) throw new Error(illisible);
  txt = txt.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(txt); } catch (e) { throw new Error(illisible); }
}

function nettoyer(lu) {
  const c = {};
  CLES_CARTE.forEach(k => { c[k] = String((lu && lu[k]) || '').trim(); });
  c.email = c.email.toLowerCase().replace(/\s/g, '');
  c.site = c.site.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (c.linkedin && !/^https?:\/\//i.test(c.linkedin)) c.linkedin = 'https://' + c.linkedin;
  // Garde-fou : un 06 / 07 français est un mobile, un autre numéro rangé en mobile passe en fixe.
  const mobile = n => /^0[67]/.test(String(n).replace(/[^\d+]/g, '').replace(/^\+33|^0033/, '0'));
  if (c.telephone && !mobile(c.telephone) && /^(\+33|0033|0)/.test(c.telephone.replace(/[^\d+]/g, '')) && !c.fixe) { c.fixe = c.telephone; c.telephone = ''; }
  if (c.fixe && mobile(c.fixe) && !c.telephone) { c.telephone = c.fixe; c.fixe = ''; }
  const incertains = ((lu && lu.champsIncertains) || []).filter(k => CLES_CARTE.indexOf(k) >= 0);
  return { champs: c, incertains };
}
