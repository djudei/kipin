/**
 * KIPIN — configuration
 *
 * CLIENT_ID : l'« ID client OAuth » créé dans Google Cloud Console
 * (Identifiants > ID client OAuth > Application Web).
 * Il n'est pas secret : il identifie l'app auprès de Google, rien de plus.
 */
export const CONFIG = {
  CLIENT_ID: '648065562846-mdlt3snn9al3bi9o4glvpvofoivbs67l.apps.googleusercontent.com',

  VERSION: '11/11/2026',
  EMAIL_AIDE: 'julienm.app@gmail.com', // adresse du lien « Un souci ? »

  NOM_SHEET: 'Kipin – Contacts',
  NOM_RACINE: 'Kipin',                // dossier du Drive qui contient tout : le Sheet, les photos, les notes
  NOM_DOSSIER: 'Photos des cartes',
  NOM_DOSSIER_NOTES: 'Notes vocales',
  TAGS_DEFAUT: ['Client', 'Prospect', 'Partenaire', 'Fournisseur', 'Presse'],

  REGLAGES_DEFAUT: {
    delai: 30,           // jours avant la relance
    heure: 9,            // heure de l'événement Agenda
    duree: 15,           // durée de l'événement, en minutes
    agendaDefaut: true,  // case « Événement Google Agenda » cochée par défaut
    recapDefaut: false,  // case « Récap du lundi » décochée par défaut
    recapActif: true     // rendez-vous « relances de la semaine » chaque lundi 8 h 45
  }
};
