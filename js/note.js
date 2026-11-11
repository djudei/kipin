/**
 * KIPIN — note.js
 * Note vocale : enregistrement au micro du téléphone (2 minutes au plus) et lecture.
 * Le fichier part ensuite dans le Drive de l'utilisateur (donnees.js).
 */
export const DUREE_MAX = 120; // secondes

/** Formats essayés dans l'ordre : AAC (lu partout, iPhone compris), puis Opus. */
const FORMATS = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function possible() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export function extension(mime) {
  return /mp4|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
}

export function duree(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ---------- Enregistrement ---------- */
let rec = null;

export function enCours() { return !!rec; }
export function secondes() { return rec ? (Date.now() - rec.debut) / 1000 : 0; }

/**
 * Démarre le micro. surTick(secondes) chaque demi-seconde ; surFin({ blob, mime, duree })
 * à l'arrêt (bouton ou 2 minutes atteintes) ; surFin(null) si l'enregistrement est vide.
 */
export async function demarrer(surTick, surFin) {
  if (rec) return;
  let flux;
  try {
    flux = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new Error("Le micro n'est pas autorisé. L'autoriser pour ce site dans les réglages du navigateur, puis réessayer.");
    }
    throw new Error('Micro indisponible sur ce téléphone (' + ((e && e.name) || 'erreur') + ').');
  }
  const mime = FORMATS.find(f => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(f)) || '';
  const mr = mime ? new MediaRecorder(flux, { mimeType: mime, audioBitsPerSecond: 48000 }) : new MediaRecorder(flux);
  const morceaux = [];
  const r = { mr, flux, debut: Date.now(), minuteur: null };
  mr.ondataavailable = ev => { if (ev.data && ev.data.size) morceaux.push(ev.data); };
  mr.onstop = () => {
    clearInterval(r.minuteur);
    flux.getTracks().forEach(t => t.stop());
    const d = (Date.now() - r.debut) / 1000;
    rec = null;
    const type = (mr.mimeType || mime || 'audio/mp4').split(';')[0];
    const blob = new Blob(morceaux, { type });
    surFin(blob.size && d >= 0.8 ? { blob, mime: type, duree: Math.min(d, DUREE_MAX) } : null);
  };
  rec = r;
  mr.start(1000);
  r.minuteur = setInterval(() => {
    const s = secondes();
    if (s >= DUREE_MAX) { arreter(); return; }
    surTick(s);
  }, 500);
}

export function arreter() {
  if (rec && rec.mr.state !== 'inactive') rec.mr.stop();
}

/** Abandon sans garder le son (on quitte l'écran). */
export function abandonner() {
  if (!rec) return;
  const r = rec;
  r.mr.onstop = () => { clearInterval(r.minuteur); r.flux.getTracks().forEach(t => t.stop()); };
  rec = null;
  try { r.mr.stop(); } catch (e) { /* déjà arrêté */ }
}

/* ---------- Lecture ---------- */
const audio = new Audio();
audio.preload = 'auto';
const cache = {};

/** Court silence (WAV) joué pendant l'appui : l'iPhone autorise ensuite la lecture une fois le fichier téléchargé. */
let urlSilence = '';
function silence() {
  if (urlSilence) return urlSilence;
  const n = 800, b = new DataView(new ArrayBuffer(44 + n * 2));
  const ecrire = (o, t) => { for (let i = 0; i < t.length; i++) b.setUint8(o + i, t.charCodeAt(i)); };
  ecrire(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); ecrire(8, 'WAVE'); ecrire(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 16000, true);
  b.setUint32(28, 32000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); ecrire(36, 'data'); b.setUint32(40, n * 2, true);
  urlSilence = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
  return urlSilence;
}
let cleLue = null;
let surEtat = function () {};

/** L'interface s'abonne ici pour redessiner le bouton lecture : fn(cle, enLecture, position, longueur). */
export function quandLecture(fn) { surEtat = fn; }

function signaler() {
  if (cleLue && !cache[cleLue]) { surEtat(cleLue, false, 0, 0); return; }
  const longueur = isFinite(audio.duration) ? audio.duration : 0;
  surEtat(cleLue, !audio.paused && !audio.ended, audio.currentTime, longueur);
}
['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata'].forEach(ev => audio.addEventListener(ev, signaler));

export function chargement(cle) { return cleLue === cle && !cache[cle]; }

export function oublier(cle) {
  if (cache[cle] && cache[cle].indexOf('blob:') === 0) URL.revokeObjectURL(cache[cle]);
  delete cache[cle];
  if (cleLue === cle) stopperLecture();
}

export function enLecture(cle) { return cleLue === cle && !audio.paused && !audio.ended; }

/** Lit (ou met en pause) le son « cle ». source() renvoie une promesse d'URL (blob local ou fichier Drive). */
export async function basculer(cle, source) {
  if (cleLue === cle && !audio.paused) { audio.pause(); return; }
  if (cleLue !== cle) {
    audio.pause();
    cleLue = cle;
    if (!cache[cle]) {
      // Pendant l'appui : déverrouille la lecture (iPhone), puis télécharge le son.
      audio.src = silence();
      audio.play().catch(() => {});
      signaler();
      cache[cle] = await source();
      if (cleLue !== cle) return;
    }
    audio.src = cache[cle];
  }
  if (audio.ended) audio.currentTime = 0;
  await audio.play();
}

export function stopperLecture() {
  audio.pause();
  cleLue = null;
  signaler();
}
