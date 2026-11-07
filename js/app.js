/**
 * KIPIN — app.js
 * Interface de l'application (écrans, navigation, actions).
 */
import { CONFIG } from './config.js';
import * as G from './google.js';
import * as D from './donnees.js';
import * as IA from './gemini.js';

  /* ================= État ================= */
  var S = {
    ecran: null,
    onglet: 'contacts',
    configure: false,
    reglages: JSON.parse(JSON.stringify(CONFIG.REGLAGES_DEFAUT)),
    tags: [],
    carnet: [],
    contacts: [],
    sheetUrl: '',
    cleGemini: '',
    email: '',
    filtre: 'tous',
    recherche: '',
    images: { recto: null, verso: null },
    photoIds: [],
    erreurLecture: '',
    form: null,
    incertains: [],
    edition: false,
    saisieManuelle: false,
    doublonVu: false,
    courantId: null,
    reporter: false,
    confirmSuppr: false,
    nouveauTag: false,
    tagEdition: null,
    erreurConnexion: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function messageErreur(e) {
    return String((e && e.message) || e || 'Erreur inconnue')
      .replace(/^(Uncaught\s+)?(\w*Error|Exception|Erreur)\s*:\s*/i, '');
  }

  /* ================= Appels ================= */
  /**
   * fn : fonction qui renvoie une promesse (appel à Google ou à Gemini).
   * options.annulable : bouton « Annuler » après 5 s ; la réponse tardive est ignorée
   * puis passée à options.apresAnnulation.
   * options.ko : gestion d'erreur personnalisée (sinon un message en bas d'écran).
   * Session Google expirée : le travail en cours est mis de côté, Kipin se reconnecte
   * puis le remet à l'écran.
   */
  var appelEnCours = null;
  function appel(fn, message, ok, options) {
    options = options || {};
    var jeton = { annule: false };
    appelEnCours = jeton;
    occupe(message, !!options.annulable);
    Promise.resolve().then(fn).then(function (v) {
      if (jeton.annule) { if (options.apresAnnulation) options.apresAnnulation(v); return; }
      libre(); if (ok) ok(v);
    }, function (e) {
      if (jeton.annule) return;
      if (e && e.name === 'ErreurSession') { reconnecter(); return; }
      libre();
      if (options.ko) options.ko(messageErreur(e));
      else toast(messageErreur(e), true);
    });
  }

  function appelDiscret(fn) {
    Promise.resolve().then(fn).catch(function () {});
  }

  /** Met de côté l'écran en cours, puis renouvelle la connexion Google. */
  function reconnecter() {
    try {
      sessionStorage.setItem('kipin.brouillon', JSON.stringify({
        ecran: S.ecran, onglet: S.onglet, form: S.form, edition: S.edition, saisieManuelle: S.saisieManuelle,
        incertains: S.incertains, images: S.images, photoIds: S.photoIds, courantId: S.courantId
      }));
    } catch (e) { /* trop gros ou indisponible : on repartira de l'accueil */ }
    occupe('Reconnexion à Google…');
    G.seConnecter(true);
  }

  function restaurerBrouillon() {
    var b = null;
    try { b = JSON.parse(sessionStorage.getItem('kipin.brouillon')); sessionStorage.removeItem('kipin.brouillon'); } catch (e) { b = null; }
    if (!b || !b.ecran) return false;
    S.onglet = b.onglet || 'contacts';
    S.courantId = b.courantId || null;
    S.images = b.images || { recto: null, verso: null };
    S.photoIds = b.photoIds || [];
    if (b.ecran === 'verif' && b.form) {
      S.form = b.form; S.edition = !!b.edition; S.saisieManuelle = !!b.saisieManuelle; S.incertains = b.incertains || [];
      montrer('verif', 'replace');
      toast('Reconnecté. Tu peux reprendre où tu en étais.');
      return true;
    }
    if (b.ecran === 'capture' && S.images.recto) { montrer('capture', 'replace'); return true; }
    if (b.ecran === 'fiche' && contact(S.courantId)) { aller('fiche', 'replace'); return true; }
    if (['contacts', 'rappels', 'reglages'].indexOf(b.ecran) >= 0) { aller(b.ecran, 'replace'); return true; }
    return false;
  }

  var minuteurAnnuler = null;
  function occupe(message, annulable) {
    $('occupe-texte').textContent = message || 'Un instant…';
    $('occupe-aide').hidden = true;
    $('occupe-annuler').hidden = true;
    clearTimeout(minuteurAnnuler);
    if (annulable) {
      minuteurAnnuler = setTimeout(function () {
        $('occupe-aide').hidden = false;
        $('occupe-annuler').hidden = false;
      }, 5000);
    }
    $('occupe').hidden = false;
  }
  function libre() {
    clearTimeout(minuteurAnnuler);
    $('occupe').hidden = true;
  }

  var minuteurToast = null;
  function toast(texte, erreur) {
    var t = $('toast');
    t.textContent = texte;
    t.className = 'toast' + (erreur ? ' erreur' : '');
    t.hidden = false;
    clearTimeout(minuteurToast);
    minuteurToast = setTimeout(function () { t.hidden = true; }, erreur ? 6000 : 3000);
  }

  /* ================= Dates ================= */
  var JOURS = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];
  var JOURS_LONG = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  var MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  var MOIS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function auj() { return iso(new Date()); }
  function versDate(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function plusJours(s, n) { var d = versDate(s); d.setDate(d.getDate() + Number(n)); return iso(d); }
  function ecartJours(s) { return Math.round((versDate(s) - versDate(auj())) / 86400000); }

  function dateCourte(s) {
    var e = ecartJours(s);
    if (e === 0) return "Aujourd'hui";
    if (e === 1) return 'Demain';
    var d = versDate(s);
    if (e > 1 && e < 7) return JOURS[d.getDay()] + ' ' + d.getDate();
    return d.getDate() + ' ' + MOIS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function dateLongue(s) {
    var d = versDate(s);
    return JOURS_LONG[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS_LONG[d.getMonth()] + ' ' + d.getFullYear();
  }
  function heureTxt() { return S.reglages.heure + ' h 00'; }

  /* ================= Icônes (couleur = celle du texte) ================= */
  function svg(taille, chemins, epais) {
    return '<svg width="' + taille + '" height="' + taille + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (epais || 1.8) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + chemins + '</svg>';
  }
  var ICO = {
    retour: svg(22, '<path d="M15 5l-7 7 7 7"/>', 2),
    photo: svg(26, '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>'),
    plus: svg(20, '<path d="M12 5v14"/><path d="M5 12h14"/>', 2),
    info: svg(20, '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>', 2),
    ok: svg(16, '<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.4),
    loupe: svg(18, '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>', 2),
    mail: svg(20, '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>'),
    tel: svg(20, '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>'),
    web: svg(20, '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3.5 3 14.5 0 18"/><path d="M12 3c-3 3.5-3 14.5 0 18"/>'),
    linkedin: svg(20, '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10.5V17"/><path d="M8 7.2v.1"/><path d="M12 17v-3.8a2.2 2.2 0 0 1 4.4 0V17"/><path d="M12 10.5V17"/>'),
    externe: svg(18, '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>', 2),
    alerte: svg(20, '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>', 2),
    contacts: svg(24, '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6"/><path d="M18 14.8c1.8.6 3 2.1 3.5 4.7"/>'),
    rappels: svg(24, '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2 2 0 0 0 4 0"/>'),
    reglages: svg(24, '<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/>'),
    crayon: svg(18, '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
    croix: svg(18, '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>', 2)
  };

  /* ================= Navigation et historique ================= */
  var ECRANS = ['connexion', 'cle', 'contacts', 'capture', 'verif', 'fiche', 'rappels', 'reglages'];
  var ONGLETS = ['contacts', 'rappels', 'reglages'];
  var RENDUS = {};

  /** Affiche un écran sans toucher au formulaire en cours. mode : 'push' | 'replace' | 'none'. */
  function montrer(nom, mode) {
    if (ONGLETS.indexOf(nom) >= 0) S.onglet = nom;
    ECRANS.forEach(function (e) { $('e-' + e).hidden = e !== nom; });
    S.ecran = nom;
    RENDUS[nom]();
    renderOnglets();
    window.scrollTo(0, 0);
    var etat = { ecran: nom, id: S.courantId || '' };
    try {
      if (mode === 'replace') history.replaceState(etat, '');
      else if (mode !== 'none') history.pushState(etat, '');
    } catch (e) { /* historique indisponible */ }
  }

  /**
   * Va sur un écran. Quitter le scan jette les photos non enregistrées.
   * Le geste retour de l'iPhone ramène à l'écran précédent de Kipin.
   */
  function aller(nom, mode) {
    var quitteScan = nom !== 'capture' && nom !== 'verif';
    if (quitteScan && !S.edition) {
      oublierPhotos();
      S.images = { recto: null, verso: null };
      S.erreurLecture = '';
    }
    if (nom !== 'verif') { S.form = null; S.edition = false; }
    if (nom !== 'fiche') { S.reporter = false; S.confirmSuppr = false; }
    montrer(nom, mode);
  }

  window.addEventListener('popstate', function (e) {
    var st = e.state || {};
    var nom = st.ecran || 'contacts';
    if (!S.configure) return;
    if (nom === 'connexion' || nom === 'cle') nom = 'contacts';
    if (nom === 'fiche') {
      if (st.id && contact(st.id)) S.courantId = st.id; else nom = S.onglet;
    }
    if (nom === 'verif' && !S.form) nom = S.onglet;
    if (nom === 'capture' && !S.images.recto && S.ecran !== 'verif') nom = S.onglet;
    aller(nom, 'none');
  });

  function renderOnglets() {
    var nav = $('onglets');
    var visible = S.configure && (ONGLETS.indexOf(S.ecran) >= 0 || S.ecran === 'fiche');
    nav.hidden = !visible;
    document.body.classList.toggle('avec-onglets', visible);
    if (!visible) return;
    var urgents = S.contacts.filter(function (c) {
      return c.statut === 'À relancer' && c.dateRelance && c.dateRelance <= auj();
    }).length;
    var onglet = function (v, libelle, ico, compte) {
      var actif = S.onglet === v;
      return '<button class="onglet' + (actif ? ' actif' : '') + '" data-a="onglet" data-v="' + v + '"' + (actif ? ' aria-current="page"' : '') + '>' +
        ico + '<span>' + libelle + '</span>' +
        (compte ? '<span class="pastille-compte" aria-label="' + compte + ' à faire">' + compte + '</span>' : '') + '</button>';
    };
    nav.innerHTML = onglet('contacts', 'Contacts', ICO.contacts) + onglet('rappels', 'Rappels', ICO.rappels, urgents) + onglet('reglages', 'Réglages', ICO.reglages);
  }

  function appliquerEtat(e) {
    S.reglages = e.reglages || S.reglages;
    S.tags = e.tags || [];
    S.carnet = e.carnet || [];
    S.contacts = e.contacts || [];
    S.sheetUrl = e.sheetUrl || '';
    S.cleGemini = e.cleGemini || '';
    S.email = e.email || '';
    S.configure = !!S.cleGemini;
  }

  /** Met à jour le rendez-vous « relances de la semaine » de l'Agenda, sans bloquer l'écran. */
  var minuteurRecap = null;
  function majRecap() {
    clearTimeout(minuteurRecap);
    minuteurRecap = setTimeout(function () {
      appelDiscret(function () { return D.syncRecap(S.contacts, S.reglages); });
    }, 1500);
  }

  function masquer(cle) { return cle ? cle.slice(0, 4) + '••••••••' + cle.slice(-3) : ''; }

  /* ================= Écran : connexion ================= */
  RENDUS.connexion = function () {
    var point = function (ico, texte) { return '<li>' + ico + '<span>' + texte + '</span></li>'; };
    $('e-connexion').innerHTML =
      '<div class="connexion">' +
        '<div class="pile" style="gap:1.75rem">' +
          '<div class="marque"><span class="logo">Kipin</span><span class="sous">keep in touch</span></div>' +
          '<h1 class="accroche">Une carte de visite, un rappel.<br><span>Plus aucun contact oublié.</span></h1>' +
          '<ul class="points">' +
            point(ICO.photo, '<strong>Photographie une carte</strong> : Gemini remplit la fiche pour toi.') +
            point(ICO.rappels, '<strong>Relance au bon moment</strong> : un rappel dans ton Google Agenda.') +
            point(ICO.contacts, '<strong>Tes contacts chez toi</strong> : tout est rangé dans ton propre Google Drive.') +
          '</ul>' +
        '</div>' +
        '<div class="pile">' +
          (S.erreurConnexion ? '<div class="alerte" role="alert"><span class="ico">' + ICO.alerte + '</span><span>' + esc(S.erreurConnexion) + '</span></div>' : '') +
          '<button class="btn google" data-a="connexion">Se connecter avec Google</button>' +
          '<p class="note" style="text-align:center">Avec ton adresse Gmail. Kipin ne voit que les fichiers qu\'il crée dans ton Drive.</p>' +
        '</div>' +
      '</div>';
  };

  /* ================= Écran : clé Gemini (premier lancement) ================= */
  RENDUS.cle = function () {
    $('e-cle').innerHTML =
      '<header class="barre barre-titre"><div class="marque"><span class="logo">Kipin</span><span class="sous">keep in touch</span></div></header>' +
      '<div class="contenu pile">' +
        '<div class="carte pile">' +
          '<h1 class="t1">Bienvenue</h1>' +
          '<p class="texte">Ton Sheet <strong>« ' + esc(CONFIG.NOM_SHEET) + ' »</strong> est prêt dans ton Google Drive. Il reste une étape pour que Kipin sache lire les cartes.</p>' +
        '</div>' +
        '<div class="carte pile">' +
          '<h2 class="eyebrow">Ta clé Gemini gratuite</h2>' +
          '<ol class="etapes">' +
            '<li>Ouvre Google AI Studio avec ton compte Google.</li>' +
            '<li>Touche « Create API key », puis copie la clé.</li>' +
            '<li>Reviens ici et colle-la ci-dessous.</li>' +
          '</ol>' +
          '<a class="btn sec" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Ouvrir Google AI Studio</a>' +
          '<label class="champ">Clé Gemini<input id="in-cle" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="AIza…" enterkeyhint="done"></label>' +
          '<p class="note">Gratuit, sans carte bancaire : n\'active pas la facturation. Sur l\'offre gratuite, Google peut utiliser les images envoyées pour améliorer ses services.</p>' +
        '</div>' +
      '</div>' +
      '<div class="pied"><button class="btn pri" data-a="enregistrer-cle">Commencer</button></div>';
  };

  /* ================= Outils contacts ================= */
  function contact(id) {
    for (var i = 0; i < S.contacts.length; i++) if (S.contacts[i].id === id) return S.contacts[i];
    return null;
  }
  function remplacer(c) {
    for (var i = 0; i < S.contacts.length; i++) {
      if (S.contacts[i].id === c.id) { S.contacts[i] = c; return; }
    }
    S.contacts.push(c);
  }
  function nomComplet(c) { return [c.prenom, c.nom].join(' ').trim() || c.societe || c.email || 'Contact'; }
  function initiales(c) {
    var a = (c.prenom || '').charAt(0) + (c.nom || '').charAt(0);
    return (a || (c.societe || c.email || '?').slice(0, 2)).toUpperCase();
  }
  function sousTitre(c) {
    var nom = nomComplet(c);
    return [c.poste, c.societe !== nom ? c.societe : ''].filter(Boolean).join(' · ');
  }
  function enRetard(c) { return c.statut === 'À relancer' && c.dateRelance && c.dateRelance < auj(); }
  function listeEmails(texte) {
    return String(texte || '').split(/[\s,;]+/).map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);
  }

  /* ================= Doublons ================= */
  function normTxt(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function chiffresTel(s) {
    var d = String(s || '').replace(/\D/g, '');
    return d.length >= 9 ? d.slice(-9) : '';
  }
  function trouverDoublon(f) {
    var email = normTxt(f.email);
    var tel = chiffresTel(f.telephone);
    var nom = f.prenom && f.nom ? normTxt(f.prenom + ' ' + f.nom) : '';
    var trouve = null;
    S.contacts.forEach(function (c) {
      if (f.id && c.id === f.id) return;
      var raison = '';
      if (email && normTxt(c.email) === email) raison = 'même email';
      else if (tel && chiffresTel(c.telephone) === tel) raison = 'même téléphone';
      else if (nom && c.prenom && c.nom && normTxt(c.prenom + ' ' + c.nom) === nom) raison = 'même nom';
      if (raison && (!trouve || (c.ajoute || '') > (trouve.c.ajoute || ''))) trouve = { c: c, raison: raison };
    });
    return trouve;
  }
  function bandeauDoublon(d) {
    var quand = d.c.ajoute ? 'Déjà scanné le ' + dateLongue(d.c.ajoute).toLowerCase() : 'Déjà enregistré';
    var qui = nomComplet(d.c) + (d.c.societe && d.c.societe !== nomComplet(d.c) ? ' (' + d.c.societe + ')' : '');
    return '<div class="alerte"><span class="ico">' + ICO.alerte + '</span>' +
      '<div class="pile" style="gap:0.25rem"><span><strong>' + esc(quand) + '</strong> : ' + esc(qui) + ', ' + esc(d.raison) + '.</span>' +
      '<button class="lien" data-a="voir-doublon" data-v="' + esc(d.c.id) + '">Voir la fiche existante</button></div></div>';
  }

  /* ================= Onglet : Contacts ================= */
  RENDUS.contacts = function () {
    var n = function (statut) { return S.contacts.filter(function (c) { return !statut || c.statut === statut; }).length; };
    $('e-contacts').innerHTML =
      '<header class="barre barre-titre"><div class="marque"><span class="logo">Kipin</span><span class="sous">keep in touch</span></div></header>' +
      '<div class="contenu pile">' +
        '<button class="scan" data-a="nouveau-scan">' +
          '<span class="scan-ico">' + ICO.photo + '</span>' +
          '<span class="scan-txt"><b>Scanner une carte</b>' + (S.contacts.length ? '' : '<span>Photo ou album, champs remplis tout seuls</span>') + '</span>' +
        '</button>' +
        (S.contacts.length
          ? '<input type="search" id="in-recherche" class="recherche" placeholder="Rechercher un nom, une société, un tag…" value="' + esc(S.recherche) + '" aria-label="Rechercher un contact">' +
            '<div class="puces">' +
              filtre('tous', 'Tous · ' + n()) +
              filtre('À relancer', 'À relancer · ' + n('À relancer')) +
              filtre('Relancé', 'Relancés · ' + n('Relancé')) +
              filtre('Sans suite', 'Sans suite · ' + n('Sans suite')) +
            '</div>'
          : '') +
        '<div id="liste-contacts"></div>' +
      '</div>';
    renderListeContacts();
  };

  function filtre(v, libelle) {
    return '<button class="puce' + (S.filtre === v ? ' plein' : '') + '" data-a="filtre" data-v="' + esc(v) + '"' + (S.filtre === v ? ' aria-pressed="true"' : '') + '>' + esc(libelle) + '</button>';
  }

  function renderListeContacts() {
    var zone = $('liste-contacts');
    if (!zone) return;
    if (!S.contacts.length) { zone.innerHTML = vide('Aucun contact pour l\'instant. Scanne ta première carte.'); return; }
    var q = normTxt(S.recherche);
    var liste = S.contacts.filter(function (c) {
      if (S.filtre !== 'tous' && c.statut !== S.filtre) return false;
      if (!q) return true;
      return normTxt([c.prenom, c.nom, c.societe, c.poste, c.email, c.tag].join(' ')).indexOf(q) >= 0;
    }).sort(function (x, y) { return (x.ajoute || '') < (y.ajoute || '') ? 1 : -1; });
    zone.innerHTML = liste.length ? '<div class="liste">' + liste.map(ligneContact).join('') + '</div>' : vide('Aucun contact ne correspond.');
  }

  function vide(texte) { return '<div class="vide">' + esc(texte) + '</div>'; }

  function ligneContact(c) {
    var classeAvatar = '', badge = '';
    if (c.statut === 'Relancé') { classeAvatar = ' ok'; badge = '<span class="badge ok">Relancé</span>'; }
    else if (c.statut === 'Sans suite') { classeAvatar = ' gris'; badge = '<span class="badge">Sans suite</span>'; }
    else if (enRetard(c)) { classeAvatar = ' retard'; badge = '<span class="badge retard">En retard</span>'; }
    else if (c.dateRelance) { badge = '<span class="badge">' + esc(dateCourte(c.dateRelance)) + '</span>'; }
    return '<button class="ligne" data-a="ouvrir" data-v="' + esc(c.id) + '">' +
      '<span class="avatar' + classeAvatar + '" aria-hidden="true">' + esc(initiales(c)) + '</span>' +
      '<span class="ligne-txt"><b>' + esc(nomComplet(c)) + '</b><span>' + esc(sousTitre(c) || c.email || '') + '</span></span>' +
      badge + '</button>';
  }

  /* ================= Onglet : Rappels ================= */
  function groupeRappel(s) {
    var e = ecartJours(s);
    if (e < 0) return 'En retard';
    if (e === 0) return "Aujourd'hui";
    if (e === 1) return 'Demain';
    if (e < 7) return 'Cette semaine';
    var d = versDate(s);
    var m = MOIS_LONG[d.getMonth()];
    return m.charAt(0).toUpperCase() + m.slice(1) + ' ' + d.getFullYear();
  }

  RENDUS.rappels = function () {
    var aFaire = S.contacts.filter(function (c) { return c.statut === 'À relancer' && c.dateRelance; })
      .sort(function (x, y) { return (x.dateRelance || '9999') < (y.dateRelance || '9999') ? -1 : 1; });
    var corps = '';
    var courant = null;
    aFaire.forEach(function (c) {
      var g = c.dateRelance ? groupeRappel(c.dateRelance) : 'Sans date';
      if (g !== courant) {
        if (courant !== null) corps += '</div>';
        corps += '<h2 class="eyebrow groupe">' + esc(g) + '</h2><div class="liste">';
        courant = g;
      }
      corps += ligneRappel(c);
    });
    if (courant !== null) corps += '</div>';
    var retard = aFaire.filter(enRetard).length;

    $('e-rappels').innerHTML =
      '<header class="barre barre-titre"><h1 class="t1">Rappels</h1></header>' +
      '<div class="contenu pile">' +
        (aFaire.length
          ? '<p class="note">' + aFaire.length + (aFaire.length > 1 ? ' relances à faire' : ' relance à faire') +
            (retard ? ', dont ' + retard + ' en retard' : '') + '.</p>' + corps
          : vide('Aucune relance prévue. Les contacts à relancer apparaîtront ici, dans l\'ordre chronologique.')) +
      '</div>';
  };

  function ligneRappel(c) {
    var d = c.dateRelance ? versDate(c.dateRelance) : null;
    var bloc = d
      ? '<span class="date-bloc' + (enRetard(c) ? ' retard' : '') + '" aria-hidden="true"><b>' + d.getDate() + '</b><span>' + esc(MOIS[d.getMonth()]) + '</span></span>'
      : '<span class="date-bloc" aria-hidden="true"><b>–</b></span>';
    var details = [sousTitre(c), c.tag].filter(Boolean).join(' · ');
    return '<button class="ligne" data-a="ouvrir" data-v="' + esc(c.id) + '"' +
      (d ? ' aria-label="' + esc(nomComplet(c) + ', ' + dateLongue(c.dateRelance) + (enRetard(c) ? ', en retard' : '')) + '"' : '') + '>' +
      bloc +
      '<span class="ligne-txt"><b>' + esc(nomComplet(c)) + '</b>' +
        (details ? '<span>' + esc(details) + '</span>' : '') +
        (c.contexte ? '<span class="extrait">' + esc(c.contexte) + '</span>' : '') +
      '</span>' +
      (enRetard(c) ? '<span class="badge retard">En retard</span>' : '') +
      '</button>';
  }

  /* ================= Écran : photo ================= */
  RENDUS.capture = function () {
    var r = S.images.recto, v = S.images.verso;
    $('e-capture').innerHTML =
      '<header class="barre"><button class="icone" data-a="retour" data-v="onglet" aria-label="Retour">' + ICO.retour + '</button><h1 class="t2">Nouvelle carte</h1></header>' +
      '<div class="contenu pile">' +
        (S.erreurLecture
          ? '<div class="alerte" role="alert"><span class="ico">' + ICO.alerte + '</span><div class="pile" style="gap:0.5rem"><span><strong>Lecture impossible.</strong> ' + esc(S.erreurLecture) + '</span>' +
            '<div class="ligne-ajout"><button class="btn sec mini" data-a="lire">Réessayer</button><button class="btn sec mini" data-a="manuel">Saisir à la main</button></div></div></div>'
          : '') +
        '<h2 class="eyebrow">Recto</h2>' +
        (r
          ? '<div class="apercu"><img src="' + r.url + '" alt="Recto de la carte"><label class="pastille" for="in-recto">Reprendre</label></div>'
          : '<label class="depot grand" for="in-recto">' + ICO.photo + '<span>Prendre ou choisir la photo</span></label>') +
        '<h2 class="eyebrow">Verso <em>(facultatif)</em></h2>' +
        (v
          ? '<div class="apercu"><img src="' + v.url + '" alt="Verso de la carte"><button class="pastille gauche" data-a="retirer-verso">Retirer</button><label class="pastille" for="in-verso">Reprendre</label></div>'
          : '<label class="depot" for="in-verso">' + ICO.plus + '<span>Ajouter le verso</span></label>') +
        '<div class="astuce"><span class="ico-bleu">' + ICO.info + '</span><span><strong>Recule un peu et zoome (×2 à ×3)</strong> : la carte doit remplir presque toute la photo et être bien nette. Trop près, l\'iPhone ne fait pas la mise au point. Carte à plat, sans reflet.</span></div>' +
        (S.erreurLecture ? '' : '<button class="lien" data-a="manuel">Saisir le contact à la main</button>') +
      '</div>' +
      '<div class="pied"><button class="btn pri" data-a="lire"' + (r ? '' : ' disabled') + '>Lire la carte</button></div>' +
      '<input type="file" accept="image/*" id="in-recto" class="cache" tabindex="-1">' +
      '<input type="file" accept="image/*" id="in-verso" class="cache" tabindex="-1">';
  };

  function preparerImage(fichier, fin) {
    var url = URL.createObjectURL(fichier);
    var img = new Image();
    img.onload = function () {
      var max = 1280; // largement assez pour lire une carte, et 2 fois plus léger à envoyer
      var k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      fin({ url: dataUrl, data: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      toast("Impossible d'ouvrir cette image. Essaie avec une autre photo.", true);
    };
    img.src = url;
  }

  function oublierPhotos() {
    if (S.photoIds.length) {
      var ids = S.photoIds.slice();
      appelDiscret(function () { return D.jeterPhotos(ids); });
    }
    S.photoIds = [];
  }

  /* ================= Écran : vérification ================= */
  var CHAMPS = [
    ['societe', 'Société', 'text'],
    ['poste', 'Poste', 'text'],
    ['email', 'Email', 'email'],
    ['telephone', 'Téléphone', 'tel'],
    ['site', 'Site web', 'url']
  ];

  function nouveauFormulaire(champs) {
    champs = champs || {};
    return {
      prenom: champs.prenom || '', nom: champs.nom || '', societe: champs.societe || '', poste: champs.poste || '',
      email: champs.email || '', telephone: champs.telephone || '', site: champs.site || '',
      linkedin: champs.linkedin || '', adresse: champs.adresse || '',
      contexte: '', priorite: 'Moyenne', tag: '', invites: '',
      dateRelance: plusJours(auj(), S.reglages.delai || 30),
      agenda: S.reglages.agendaDefaut !== false,
      recap: S.reglages.recapDefaut !== false
    };
  }

  function champ(cle, libelle, type) {
    var doute = S.incertains.indexOf(cle) >= 0;
    var mode = type === 'email' ? ' inputmode="email" autocapitalize="off"' : type === 'tel' ? ' inputmode="tel"' : type === 'url' ? ' inputmode="url" autocapitalize="off"' : '';
    return '<label class="champ' + (doute ? ' doute' : '') + '">' + esc(libelle) + (doute ? ' · à vérifier' : '') +
      '<input data-f="' + cle + '" type="text"' + mode + ' autocorrect="off" enterkeyhint="next" value="' + esc(S.form[cle]) + '"></label>';
  }

  function urlRechercheLinkedin(f) {
    var q = [f.prenom, f.nom, f.societe].filter(Boolean).join(' ');
    return 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(q);
  }
  function lienLinkedin(f) {
    var q = [f.prenom, f.nom, f.societe].filter(Boolean).join(' ');
    if (!q) return '';
    return '<a class="lien" href="' + esc(urlRechercheLinkedin(f)) + '" target="_blank" rel="noopener">' + ICO.loupe +
      '<span>Chercher « ' + esc(q) + ' » sur LinkedIn</span></a>';
  }

  RENDUS.verif = function () {
    var f = S.form;
    var nbDoutes = S.incertains.length;
    var doublon = trouverDoublon(f);
    if (doublon) S.doublonVu = true;
    var sansRelance = !f.dateRelance;
    var raccourcis = [7, 15, 30].map(function (n) {
      var actif = f.dateRelance === plusJours(auj(), n);
      return '<button class="puce' + (actif ? ' plein' : '') + '" data-a="delai" data-v="' + n + '">J+' + n + '</button>';
    }).join('') +
      '<button class="puce' + (sansRelance ? ' plein' : '') + '" data-a="sans-relance" aria-label="Aucune relance"' + (sansRelance ? ' aria-pressed="true"' : '') + '>Ø Aucune</button>';
    var tags = S.tags.map(function (t) {
      return '<button class="puce' + (f.tag === t ? ' actif' : '') + '" data-a="tag" data-v="' + esc(t) + '"' + (f.tag === t ? ' aria-pressed="true"' : '') + '>' + esc(t) + '</button>';
    }).join('');
    var ajoutTag = S.nouveauTag
      ? '<div class="ligne-ajout"><input id="in-tag" placeholder="Nom du tag" autocomplete="off" enterkeyhint="done"><button class="btn pri mini" data-a="valider-tag">Ajouter</button><button class="btn sec mini" data-a="annuler-tag">Annuler</button></div>'
      : '';
    var invites = listeEmails(f.invites);
    var carnet = S.carnet.length
      ? '<div class="puces">' + S.carnet.map(function (e) {
          var actif = invites.indexOf(e) >= 0;
          return '<button class="puce' + (actif ? ' actif' : '') + '" data-a="carnet-toggle" data-v="' + esc(e) + '"' + (actif ? ' aria-pressed="true"' : '') + '>' + esc(e) + '</button>';
        }).join('') + '</div>'
      : '';

    $('e-verif').innerHTML =
      '<header class="barre"><button class="icone" data-a="retour-verif" aria-label="Retour">' + ICO.retour + '</button>' +
        '<h1 class="t2">' + (S.edition ? 'Modifier le contact' : 'Vérifie et complète') + '</h1></header>' +
      '<div class="contenu pile">' +
        (doublon ? bandeauDoublon(doublon) : '') +
        (S.edition || S.saisieManuelle ? '' : '<div class="bandeau-ok">' + ICO.ok + '<span><strong>Carte lue.</strong> ' +
          (nbDoutes ? nbDoutes + (nbDoutes > 1 ? ' champs à vérifier, signalés' : ' champ à vérifier, signalé') + ' en orange.' : 'Vérifie les champs avant d\'enregistrer.') +
          '</span></div>') +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Contact</h2>' +
          '<div class="grille2">' + champ('prenom', 'Prénom', 'text') + champ('nom', 'Nom', 'text') + '</div>' +
          CHAMPS.map(function (c) { return champ(c[0], c[1], c[2]); }).join('') +
          '<div class="pile" style="gap:0.25rem">' + champ('linkedin', 'Profil LinkedIn', 'url') + '<div id="zone-linkedin">' + lienLinkedin(f) + '</div></div>' +
          champ('adresse', 'Adresse', 'text') +
        '</section>' +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Contexte</h2>' +
          '<label class="champ">Où et pourquoi<textarea data-f="contexte" placeholder="Ex. : rencontrée au salon, cherche un traiteur pour ses séminaires">' + esc(f.contexte) + '</textarea></label>' +
          '<div class="pile" style="gap:0.5rem"><span class="champ">Priorité</span><div class="seg c3" role="group" aria-label="Priorité">' +
            ['Haute', 'Moyenne', 'Basse'].map(function (p) {
              return '<button class="' + (f.priorite === p ? 'actif' : '') + '" data-a="prio" data-v="' + p + '" aria-pressed="' + (f.priorite === p) + '">' + p + '</button>';
            }).join('') +
          '</div></div>' +
          '<div class="pile" style="gap:0.5rem"><span class="champ">Tag</span><div class="puces">' + tags +
            (S.nouveauTag ? '' : '<button class="puce ajout" data-a="nouveau-tag">+ Nouveau tag</button>') +
          '</div>' + ajoutTag + '</div>' +
        '</section>' +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Relance</h2>' +
          (sansRelance
            ? '<input type="hidden" data-f="dateRelance" value="">' +
              '<div class="puces">' + raccourcis + '</div>' +
              '<p class="note">Aucune relance : le contact est simplement enregistré, sans rappel ni événement Agenda.</p>'
            : '<label class="champ">Date · ' + esc(heureTxt()) + ', ' + esc(S.reglages.duree) + ' min<input type="date" data-f="dateRelance" value="' + esc(f.dateRelance) + '"></label>' +
          '<div class="puces">' + raccourcis + '</div>' +
          '<label class="case"><input type="checkbox" data-f="agenda"' + (f.agenda ? ' checked' : '') + '><span>Événement Google Agenda<small>Notification sur le téléphone le jour J</small></span></label>' +
          '<label class="case"><input type="checkbox" data-f="recap"' + (f.recap ? ' checked' : '') + '><span>Récap du lundi<small>Dans le rendez-vous « relances de la semaine » de ton Agenda</small></span></label>' +
          '<div class="pile" style="gap:0.5rem;border-top:1px solid var(--trait);padding-top:0.85rem">' +
            '<label class="champ">Partager le rappel par email (facultatif)' +
              '<input data-f="invites" type="text" inputmode="email" autocapitalize="off" autocorrect="off" placeholder="adresse@exemple.fr" value="' + esc(f.invites || '') + '"></label>' +
            carnet +
            '<p class="note">Envoie un email avec le rendez-vous en pièce jointe, à ajouter à n\'importe quel agenda. Plusieurs adresses : sépare-les par une virgule.</p>' +
          '</div>') +
        '</section>' +
      '</div>' +
      '<div class="espace"></div>' +
      '<div class="pied"><button class="btn pri" data-a="enregistrer">' +
        (S.edition ? 'Enregistrer les modifications' : doublon ? 'Enregistrer quand même' : 'Enregistrer le contact') +
      '</button></div>';
  };

  function lireForm() {
    if (!S.form) return;
    var champs = document.querySelectorAll('#e-verif [data-f]');
    for (var i = 0; i < champs.length; i++) {
      var el = champs[i];
      S.form[el.getAttribute('data-f')] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
  }

  /* ================= Écran : fiche ================= */
  RENDUS.fiche = function () {
    var c = contact(S.courantId);
    if (!c) { aller(S.onglet, 'replace'); return; }
    var site = c.site ? (/^https?:\/\//i.test(c.site) ? c.site : 'https://' + c.site) : '';
    var tel = c.telephone ? c.telephone.replace(/[^\d+]/g, '') : '';
    var action = function (href, ico, libelle) {
      return href
        ? '<a class="action" href="' + esc(href) + '" target="_blank" rel="noopener">' + ico + esc(libelle) + '</a>'
        : '<span class="action off" aria-hidden="true">' + ico + esc(libelle) + '</span>';
    };
    var coord = [['Site web', c.site], ['Adresse', c.adresse], ['LinkedIn', c.linkedin ? c.linkedin.replace(/^https?:\/\/(www\.)?/, '') : '']]
      .filter(function (x) { return x[1]; })
      .map(function (x) { return '<div class="coord"><span>' + x[0] + '</span>' + esc(x[1]) + '</div>'; }).join('');
    var reporter = S.reporter
      ? '<div class="pile" style="gap:0.6rem">' +
          '<label class="champ">Nouvelle date<input type="date" id="in-report" value="' + esc(c.dateRelance || plusJours(auj(), 7)) + '"></label>' +
          '<div class="puces">' + [7, 15, 30].map(function (n) { return '<button class="puce" data-a="report-rapide" data-v="' + n + '">Dans ' + n + ' j</button>'; }).join('') + '</div>' +
          '<div class="grille2"><button class="btn sec" data-a="annuler-report">Annuler</button><button class="btn pri mini" style="width:100%" data-a="valider-report">Valider</button></div>' +
        '</div>'
      : '<button class="btn sec" data-a="ouvrir-report">' + (c.dateRelance ? 'Reporter la relance' : 'Programmer une relance') + '</button>';
    var coordCarte = [c.email, c.telephone].filter(Boolean).map(esc).join('<br>');

    $('e-fiche').innerHTML =
      '<header class="barre" style="justify-content:space-between"><button class="icone" data-a="retour" data-v="onglet" aria-label="Retour">' + ICO.retour + '</button>' +
        '<button class="lien" style="padding:0 0.75rem;font-size:0.94rem" data-a="modifier">Modifier</button></header>' +
      '<div class="carte-visite" role="img" aria-label="' + esc(['Carte de visite', nomComplet(c), c.poste, c.societe].filter(Boolean).join(', ')) + '">' +
        '<div><span class="cv-nom">' + esc(nomComplet(c)) + '</span>' + (c.poste ? '<span class="cv-poste">' + esc(c.poste) + '</span>' : '') + '</div>' +
        '<div class="cv-bas"><span class="cv-coord">' + coordCarte + '</span>' +
          (c.societe && c.societe !== nomComplet(c) ? '<span class="cv-soc">' + esc(c.societe) + '</span>' : '') + '</div>' +
      '</div>' +
      '<div class="badges-fiche">' +
        (c.tag ? '<span class="badge bleu">' + esc(c.tag) + '</span>' : '') +
        '<span class="badge plein">Priorité ' + esc((c.priorite || 'Moyenne').toLowerCase()) + '</span>' +
      '</div>' +
      '<div class="actions">' +
        action(c.email ? 'mailto:' + c.email : '', ICO.mail, 'Email') +
        action(tel ? 'tel:' + tel : '', ICO.tel, 'Appeler') +
        action(site, ICO.web, 'Site') +
        action(c.linkedin, ICO.linkedin, 'LinkedIn') +
      '</div>' +
      '<div class="contenu pile" style="padding-top:0.85rem">' +
        '<section class="carte pile">' +
          '<div class="entete-carte"><h2 class="eyebrow">Relance</h2>' +
            (c.eventId ? '<span class="agenda-ok">' + ICO.ok + 'Dans l\'agenda</span>' : '') + '</div>' +
          '<span class="grosse-date">' + (c.dateRelance ? esc(dateLongue(c.dateRelance)) + ' · ' + esc(heureTxt()) : 'Aucune relance prévue') +
            (enRetard(c) ? ' <span class="badge retard">En retard</span>' : '') + '</span>' +
          (c.invites ? '<span class="note">Rappel partagé avec ' + esc(c.invites) + '</span>' : '') +
          '<div class="seg c3" role="group" aria-label="Statut">' +
            ['À relancer', 'Relancé', 'Sans suite'].map(function (s) {
              return '<button class="' + (c.statut === s ? 'actif' : '') + '" data-a="statut" data-v="' + s + '" aria-pressed="' + (c.statut === s) + '">' + s + '</button>';
            }).join('') +
          '</div>' +
          reporter +
        '</section>' +
        (c.contexte ? '<section class="carte pile" style="gap:0.6rem"><h2 class="eyebrow">Contexte</h2><p class="texte">' + esc(c.contexte) + '</p>' +
          (c.ajoute ? '<span class="note">Ajouté le ' + esc(dateLongue(c.ajoute).toLowerCase()) + '</span>' : '') + '</section>' : '') +
        (coord ? '<section class="carte pile" style="gap:0.6rem"><h2 class="eyebrow">Autres coordonnées</h2>' + coord + '</section>' : '') +
        (c.photo ? '<a class="carte lien large" href="' + esc(c.photo) + '" target="_blank" rel="noopener">Voir la photo de la carte' + ICO.externe + '</a>' : '') +
        (S.confirmSuppr
          ? '<div class="alerte" role="alert"><span class="ico">' + ICO.alerte + '</span>' +
              '<div class="pile" style="gap:0.6rem;flex:1"><span><strong>Supprimer ' + esc(nomComplet(c)) + ' ?</strong> La ligne du Sheet, l\'événement Agenda et la photo seront supprimés.</span>' +
              '<div class="grille2"><button class="btn sec" data-a="annuler-suppr">Annuler</button><button class="btn danger-plein" data-a="valider-suppr">Supprimer</button></div></div></div>'
          : '<button class="btn danger" data-a="demander-suppr">Supprimer le contact</button>') +
      '</div>';
  };

  /* ================= Onglet : Réglages ================= */
  RENDUS.reglages = function () {
    var r = S.reglages;
    var heures = '';
    for (var h = 6; h <= 21; h++) heures += '<option value="' + h + '"' + (Number(r.heure) === h ? ' selected' : '') + '>' + h + ' h 00</option>';
    var durees = [15, 30, 45, 60].map(function (d) {
      return '<option value="' + d + '"' + (Number(r.duree) === d ? ' selected' : '') + '>' + d + ' min</option>';
    }).join('');

    var tags = S.tags.map(function (t) {
      var nb = S.contacts.filter(function (c) { return c.tag === t; }).length;
      if (S.tagEdition === t) {
        return '<div class="ligne-edit"><div class="ligne-ajout" style="flex:1"><input id="in-renommer" value="' + esc(t) + '" autocomplete="off" enterkeyhint="done" aria-label="Nouveau nom du tag">' +
          '<button class="btn pri mini" data-a="valider-renommer" data-v="' + esc(t) + '">OK</button>' +
          '<button class="btn sec mini" data-a="annuler-renommer">Annuler</button></div></div>';
      }
      return '<div class="ligne-edit"><span class="nom">' + esc(t) + ' <span class="compte">· ' + nb + (nb > 1 ? ' fiches' : ' fiche') + '</span></span>' +
        '<button class="icone" data-a="renommer-tag" data-v="' + esc(t) + '" aria-label="Renommer ' + esc(t) + '">' + ICO.crayon + '</button>' +
        '<button class="icone" data-a="suppr-tag" data-v="' + esc(t) + '" aria-label="Supprimer ' + esc(t) + '">' + ICO.croix + '</button></div>';
    }).join('');

    var carnet = S.carnet.map(function (e) {
      return '<div class="ligne-edit"><span class="nom">' + esc(e) + '</span>' +
        '<button class="icone" data-a="suppr-carnet" data-v="' + esc(e) + '" aria-label="Retirer ' + esc(e) + '">' + ICO.croix + '</button></div>';
    }).join('');

    $('e-reglages').innerHTML =
      '<header class="barre barre-titre"><h1 class="t1">Réglages</h1></header>' +
      '<div class="contenu pile">' +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Relance par défaut</h2>' +
          '<label class="reglage"><span>Délai (jours)</span><input type="number" inputmode="numeric" min="1" max="365" data-r="delai" value="' + esc(r.delai) + '"></label>' +
          '<label class="reglage"><span>Heure Agenda</span><select data-r="heure">' + heures + '</select></label>' +
          '<label class="reglage"><span>Durée</span><select data-r="duree">' + durees + '</select></label>' +
          '<div class="pile" style="gap:0.1rem;border-top:1px solid var(--trait);padding-top:0.6rem">' +
            '<span class="champ">Cochées par défaut sur chaque carte</span>' +
            '<label class="case"><input type="checkbox" data-r="agendaDefaut"' + (r.agendaDefaut ? ' checked' : '') + '>Événement Google Agenda</label>' +
            '<label class="case"><input type="checkbox" data-r="recapDefaut"' + (r.recapDefaut ? ' checked' : '') + '>Récap du lundi</label>' +
          '</div>' +
        '</section>' +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Récap du lundi</h2>' +
          '<label class="case"><input type="checkbox" data-r="recapActif"' + (r.recapActif ? ' checked' : '') + '><span>Rendez-vous « relances de la semaine »<small>Chaque lundi à 9 h dans ton Agenda, avec la liste à jour de tes prochaines relances.</small></span></label>' +
        '</section>' +
        '<button class="btn pri" data-a="sauver-reglages">Enregistrer les réglages</button>' +
        '<section class="carte pile" style="gap:0.4rem">' +
          '<h2 class="eyebrow">Emails d\'invitation</h2>' +
          '<p class="note">Proposés en un geste quand tu partages un rappel. Les adresses saisies dans une fiche s\'ajoutent ici toutes seules.</p>' +
          (carnet || '<p class="note">Aucune adresse pour l\'instant.</p>') +
          '<div class="ligne-ajout" style="padding-top:0.4rem"><input id="in-carnet" inputmode="email" autocapitalize="off" autocorrect="off" placeholder="adresse@exemple.fr" enterkeyhint="done" aria-label="Nouvelle adresse"><button class="btn pri mini" data-a="ajout-carnet">Ajouter</button></div>' +
        '</section>' +
        '<section class="carte pile" style="gap:0.4rem">' +
          '<h2 class="eyebrow">Tags</h2>' +
          '<p class="note">Renommer un tag le change sur toutes les fiches qui le portent.</p>' +
          tags +
          '<div class="ligne-ajout" style="padding-top:0.4rem"><input id="in-tag-reglages" placeholder="Nouveau tag" autocomplete="off" enterkeyhint="done" aria-label="Nouveau tag"><button class="btn pri mini" data-a="ajout-tag-reglages">Ajouter</button></div>' +
        '</section>' +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Connexions</h2>' +
          '<div class="reglage"><span>Clé Gemini<br><span class="note">' + esc(masquer(S.cleGemini)) + '</span></span><span class="badge ok">Active</span></div>' +
          '<div class="ligne-ajout"><input id="in-nouvelle-cle" placeholder="Coller une nouvelle clé" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Nouvelle clé Gemini"><button class="btn sec mini" data-a="changer-cle">Changer</button></div>' +
          (S.sheetUrl ? '<a class="lien large" style="border-top:1px solid var(--trait);padding-top:0.6rem" href="' + esc(S.sheetUrl) + '" target="_blank" rel="noopener">Ouvrir mon Google Sheet' + ICO.externe + '</a>' : '') +
        '</section>' +
        '<section class="carte pile">' +
          '<h2 class="eyebrow">Compte</h2>' +
          '<p class="texte">Connecté avec <strong>' + esc(S.email) + '</strong></p>' +
          '<button class="btn sec" data-a="deconnexion">Se déconnecter</button>' +
        '</section>' +
      '</div>';
  };

  function lireReglagesForm() {
    var r = {};
    var champs = document.querySelectorAll('#e-reglages [data-r]');
    for (var i = 0; i < champs.length; i++) {
      var el = champs[i];
      r[el.getAttribute('data-r')] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    return r;
  }

  /* ================= Actions ================= */
  var ACTIONS = {
    'connexion': function () {
      S.erreurConnexion = '';
      occupe('Ouverture de Google…');
      G.seConnecter(false);
    },
    'enregistrer-cle': function () {
      var cle = ($('in-cle').value || '').trim();
      if (!cle) { toast('Colle ta clé Gemini pour commencer.', true); return; }
      appel(function () { return IA.testerCle(cle).then(function () { return D.enregistrerCle(cle); }); }, 'Vérification de la clé…', function () {
        S.cleGemini = cle;
        S.configure = true;
        aller('contacts', 'replace');
        majRecap();
        toast('Kipin est prêt. Scanne ta première carte.');
      });
    },
    'deconnexion': function () {
      appel(function () { return G.seDeconnecter(); }, 'Déconnexion…', function () {
        S.configure = false;
        S.contacts = [];
        montrer('connexion', 'replace');
      });
    },
    'onglet': function (v) { aller(v, 'replace'); },
    'retour': function () { aller(S.onglet, 'replace'); },
    'filtre': function (v) { S.filtre = v; RENDUS.contacts(); },
    'ouvrir': function (v) { S.courantId = v; aller('fiche'); },

    'nouveau-scan': function () {
      S.images = { recto: null, verso: null };
      S.photoIds = [];
      S.erreurLecture = '';
      aller('capture');
    },
    'retirer-verso': function () { S.images.verso = null; RENDUS.capture(); },
    'manuel': function () {
      oublierPhotos();
      S.form = nouveauFormulaire({});
      S.incertains = [];
      S.edition = false;
      S.nouveauTag = false;
      S.saisieManuelle = true;
      S.doublonVu = false;
      S.erreurLecture = '';
      montrer('verif');
    },
    'lire': function () {
      if (!S.images.recto) return;
      oublierPhotos();
      S.erreurLecture = '';
      var imgs = [S.images.recto];
      if (S.images.verso) imgs.push(S.images.verso);
      var envoi = imgs.map(function (i) { return { data: i.data, mimeType: i.mimeType }; });
      appel(function () {
        // Lecture par Gemini et rangement de la photo dans le Drive en même temps.
        // La photo est un plus : si son envoi échoue, on garde la fiche quand même.
        var photos = D.sauverPhotos(envoi).then(function (ids) { return { ids: ids }; }, function (e) {
          if (e && e.name === 'ErreurSession') throw e;
          return { ids: [], erreur: e.message };
        });
        var lecture = IA.lireCarte(S.cleGemini, envoi);
        lecture.catch(function () {
          photos.then(function (p) { if (p.ids.length) D.jeterPhotos(p.ids).catch(function () {}); }, function () {});
        });
        return Promise.all([lecture, photos]).then(function (r) {
          var lu = r[0];
          lu.photoIds = r[1].ids;
          lu.photoErreur = r[1].erreur;
          return lu;
        });
      }, 'Lecture de la carte…', function (res) {
        S.photoIds = res.photoIds || [];
        S.incertains = res.incertains || [];
        S.form = nouveauFormulaire(res.champs);
        S.edition = false;
        S.nouveauTag = false;
        S.saisieManuelle = false;
        S.doublonVu = false;
        montrer('verif');
        if (res.photoErreur) toast('Carte lue, mais la photo n\'a pas pu être rangée dans ton Drive : ' + res.photoErreur, true);
      }, {
        annulable: true,
        apresAnnulation: function (res) {
          if (res && res.photoIds && res.photoIds.length) appelDiscret(function () { return D.jeterPhotos(res.photoIds); });
        },
        ko: function (message) {
          S.erreurLecture = message;
          RENDUS.capture();
          window.scrollTo(0, 0);
        }
      });
    },
    'annuler-attente': function () {
      if (appelEnCours) appelEnCours.annule = true;
      libre();
      toast('Lecture annulée. Tu peux reprendre la photo ou réessayer.');
    },
    'voir-doublon': function (v) {
      S.edition = false;
      S.courantId = v;
      aller('fiche');
    },

    'retour-verif': function () {
      if (S.edition) { S.edition = false; aller('fiche', 'replace'); return; }
      if (S.images.recto) aller('capture', 'replace'); else aller(S.onglet, 'replace');
    },
    'prio': function (v) { lireForm(); S.form.priorite = v; RENDUS.verif(); },
    'tag': function (v) { lireForm(); S.form.tag = S.form.tag === v ? '' : v; RENDUS.verif(); },
    'delai': function (v) {
      lireForm();
      if (!S.form.dateRelance) { S.form.agenda = S.reglages.agendaDefaut !== false; S.form.recap = S.reglages.recapDefaut !== false; }
      S.form.dateRelance = plusJours(auj(), v);
      RENDUS.verif();
    },
    'sans-relance': function () {
      lireForm();
      S.form.dateRelance = '';
      S.form.agenda = false;
      S.form.recap = false;
      S.form.invites = '';
      RENDUS.verif();
    },
    'carnet-toggle': function (v) {
      lireForm();
      var l = listeEmails(S.form.invites);
      var i = l.indexOf(v);
      if (i >= 0) l.splice(i, 1); else l.push(v);
      S.form.invites = l.join(', ');
      RENDUS.verif();
    },
    'nouveau-tag': function () {
      lireForm(); S.nouveauTag = true; RENDUS.verif();
      var champTag = $('in-tag'); if (champTag) champTag.focus();
    },
    'annuler-tag': function () { lireForm(); S.nouveauTag = false; RENDUS.verif(); },
    'valider-tag': function () {
      lireForm();
      var t = ($('in-tag').value || '').trim();
      if (!t) { toast('Écris le nom du tag.', true); return; }
      appel(function () { return D.ajouterTag(t); }, 'Ajout du tag…', function (tags) {
        S.tags = tags; S.form.tag = t; S.nouveauTag = false; RENDUS.verif();
      });
    },
    'enregistrer': function () {
      lireForm();
      var f = S.form;
      if (!f.prenom && !f.nom && !f.societe && !f.email) { toast('Renseigne au moins un nom, une société ou un email.', true); return; }
      if (!S.doublonVu && trouverDoublon(f)) {
        RENDUS.verif();
        window.scrollTo(0, 0);
        toast('Ce contact existe déjà. Appuie à nouveau pour l\'enregistrer quand même.', true);
        return;
      }
      var finir = function (c, message) {
        if (c.invites) {
          listeEmails(c.invites).forEach(function (e) { if (S.carnet.indexOf(e) < 0) S.carnet.push(e); });
          appelDiscret(function () { return D.ajouterAuCarnet(c.invites); });
        }
        remplacer(c);
        S.courantId = c.id;
        S.photoIds = [];
        S.images = { recto: null, verso: null };
        S.edition = false;
        aller('fiche', 'replace');
        majRecap();
        if (c.partageErreur) toast('Enregistré, mais le rappel n\'a pas pu être envoyé : ' + c.partageErreur, true);
        else toast(message);
      };
      if (S.edition) {
        appel(function () { return D.majContact(f, S.reglages); }, 'Enregistrement…', function (c) { finir(c, 'Modifications enregistrées.'); });
      } else {
        var ids = S.photoIds.slice();
        appel(function () { return D.enregistrerContact(f, ids, S.reglages); }, 'Enregistrement…', function (c) {
          finir(c, 'Contact enregistré' + (c.eventId ? ', relance ajoutée à l\'agenda' : '') + (c.invites ? ', rappel envoyé à ' + c.invites : '') + '.');
        });
      }
    },

    'modifier': function () {
      var c = contact(S.courantId);
      if (!c) return;
      S.form = JSON.parse(JSON.stringify(c));
      S.incertains = [];
      S.edition = true;
      S.saisieManuelle = true;
      S.nouveauTag = false;
      S.doublonVu = false;
      montrer('verif');
    },
    'statut': function (v) {
      var c = contact(S.courantId);
      if (!c || c.statut === v) return;
      appel(function () { return D.changerStatut(c.id, v, S.reglages); }, 'Mise à jour…', function (nc) {
        remplacer(nc); RENDUS.fiche(); renderOnglets(); majRecap();
        toast(v === 'Relancé' ? 'Bien joué. Contact marqué comme relancé.' : v === 'Sans suite' ? 'Contact classé sans suite.' : 'Relance réactivée.');
      });
    },
    'ouvrir-report': function () { S.reporter = true; RENDUS.fiche(); },
    'annuler-report': function () { S.reporter = false; RENDUS.fiche(); },
    'report-rapide': function (v) { $('in-report').value = plusJours(auj(), v); },
    'valider-report': function () {
      var d = $('in-report').value;
      if (!d) { toast('Choisis une date.', true); return; }
      var id = S.courantId;
      appel(function () { return D.reporterRelance(id, d, S.reglages); }, 'Report de la relance…', function (nc) {
        remplacer(nc); S.reporter = false; RENDUS.fiche(); renderOnglets(); majRecap();
        toast('Relance reportée au ' + dateLongue(d).toLowerCase() + (nc.invites && !nc.partageErreur ? ', rappel renvoyé à ' + nc.invites : '') + '.');
      });
    },
    'demander-suppr': function () {
      S.confirmSuppr = true; RENDUS.fiche();
      window.scrollTo(0, document.body.scrollHeight);
    },
    'annuler-suppr': function () { S.confirmSuppr = false; RENDUS.fiche(); },
    'valider-suppr': function () {
      var c = contact(S.courantId);
      if (!c) return;
      appel(function () { return D.supprimerContact(c.id); }, 'Suppression…', function () {
        S.contacts = S.contacts.filter(function (x) { return x.id !== c.id; });
        S.courantId = null;
        aller(S.onglet, 'replace');
        majRecap();
        toast(nomComplet(c) + ' a été supprimé.');
      });
    },

    'sauver-reglages': function () {
      var saisis = lireReglagesForm();
      appel(function () { return D.sauverReglages(saisis); }, 'Enregistrement…', function (r) {
        S.reglages = r; RENDUS.reglages(); majRecap(); toast('Réglages enregistrés.');
      });
    },
    'renommer-tag': function (v) {
      S.tagEdition = v; RENDUS.reglages();
      var champ = $('in-renommer'); if (champ) { champ.focus(); champ.select(); }
    },
    'annuler-renommer': function () { S.tagEdition = null; RENDUS.reglages(); },
    'valider-renommer': function (v) {
      var nouveau = ($('in-renommer').value || '').trim();
      if (!nouveau) { toast('Écris le nouveau nom du tag.', true); return; }
      if (nouveau === v) { S.tagEdition = null; RENDUS.reglages(); return; }
      appel(function () { return D.renommerTag(v, nouveau); }, 'Renommage du tag…', function (res) {
        S.tags = res.tags;
        S.contacts.forEach(function (c) { if (c.tag === v) c.tag = nouveau; });
        S.tagEdition = null;
        RENDUS.reglages();
        toast('Tag renommé' + (res.modifies ? ' sur ' + res.modifies + (res.modifies > 1 ? ' fiches.' : ' fiche.') : '.'));
      });
    },
    'suppr-tag': function (v) {
      appel(function () { return D.supprimerTag(v); }, 'Suppression…', function (tags) {
        S.tags = tags; RENDUS.reglages();
        toast('Tag retiré de la liste. Les fiches qui le portent le gardent.');
      });
    },
    'ajout-tag-reglages': function () {
      var t = ($('in-tag-reglages').value || '').trim();
      if (!t) { toast('Écris le nom du tag.', true); return; }
      appel(function () { return D.ajouterTag(t); }, 'Ajout du tag…', function (tags) { S.tags = tags; RENDUS.reglages(); });
    },
    'ajout-carnet': function () {
      var e = ($('in-carnet').value || '').trim();
      if (!e) { toast('Écris une adresse email.', true); return; }
      appel(function () { return D.ajouterAuCarnet(e); }, 'Ajout…', function (carnet) { S.carnet = carnet; RENDUS.reglages(); });
    },
    'suppr-carnet': function (v) {
      appel(function () { return D.supprimerDuCarnet(v); }, 'Suppression…', function (carnet) { S.carnet = carnet; RENDUS.reglages(); });
    },
    'changer-cle': function () {
      var cle = ($('in-nouvelle-cle').value || '').trim();
      if (!cle) { toast('Colle la nouvelle clé.', true); return; }
      appel(function () { return IA.testerCle(cle).then(function () { return D.enregistrerCle(cle); }); }, 'Vérification de la clé…', function () {
        S.cleGemini = cle; RENDUS.reglages(); toast('Nouvelle clé enregistrée.');
      });
    }
  };

  /* ================= Écouteurs ================= */
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-a]');
    if (!el || el.disabled) return;
    var fn = ACTIONS[el.getAttribute('data-a')];
    if (fn) { ev.preventDefault(); fn(el.getAttribute('data-v'), el); }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.id === 'in-recto' || el.id === 'in-verso') {
      var fichier = el.files && el.files[0];
      if (!fichier) return;
      var face = el.id === 'in-recto' ? 'recto' : 'verso';
      preparerImage(fichier, function (img) {
        S.images[face] = img;
        S.erreurLecture = '';
        RENDUS.capture();
      });
    }
  });

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t.id === 'in-recherche') { S.recherche = t.value; renderListeContacts(); return; }
    var k = t.getAttribute && t.getAttribute('data-f');
    if (k === 'prenom' || k === 'nom' || k === 'societe') {
      lireForm();
      var zone = $('zone-linkedin');
      if (zone) zone.innerHTML = lienLinkedin(S.form);
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var correspondances = {
      'in-cle': 'enregistrer-cle', 'in-tag': 'valider-tag', 'in-tag-reglages': 'ajout-tag-reglages',
      'in-nouvelle-cle': 'changer-cle', 'in-carnet': 'ajout-carnet'
    };
    var id = ev.target.id;
    if (id === 'in-renommer') { ev.preventDefault(); ACTIONS['valider-renommer'](S.tagEdition); return; }
    if (correspondances[id]) { ev.preventDefault(); ACTIONS[correspondances[id]](); }
  });

  /* Retour sur l'app après une pause : renouvelle la connexion si elle a expiré. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !S.configure) return;
    if (!G.jetonValide() && ['contacts', 'rappels', 'reglages', 'fiche'].indexOf(S.ecran) >= 0) reconnecter();
  });

  /* ================= Démarrage ================= */
  function demarrer() {
    if (CONFIG.CLIENT_ID.indexOf('A_REMPLACER') === 0) {
      S.erreurConnexion = "Kipin n'est pas encore relié à Google : l'ID client OAuth manque dans js/config.js.";
      montrer('connexion', 'replace');
      return;
    }
    var session = G.demarrerSession();
    if (session.statut === 'redirige') { occupe('Connexion à Google…'); return; }
    if (session.statut === 'a-connecter') {
      S.erreurConnexion = session.erreur || '';
      montrer('connexion', 'replace');
      return;
    }
    appel(function () { return D.charger(); }, 'Chargement de Kipin…', function (e) {
      appliquerEtat(e);
      if (!S.configure) { montrer('cle', 'replace'); return; }
      if (!restaurerBrouillon()) aller('contacts', 'replace');
      if (session.scopesManquants && session.scopesManquants.length) {
        toast('Certaines autorisations ont été refusées : Agenda ou partage par email peuvent ne pas fonctionner.', true);
      }
      majRecap();
    }, {
      ko: function (message) {
        S.erreurConnexion = message;
        montrer('connexion', 'replace');
      }
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  demarrer();
