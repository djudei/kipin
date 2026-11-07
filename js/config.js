/**
 * KIPIN — configuration
 *
 * CLIENT_ID : l'« ID client OAuth » créé dans Google Cloud Console
 * (Identifiants > ID client OAuth > Application Web).
 * Il n'est pas secret : il identifie l'app auprès de Google, rien de plus.
 */
export const CONFIG = {
  CLIENT_ID: 'A_REMPLACER.apps.googleusercontent.com',

  NOM_SHEET: 'Kipin – Contacts',
  NOM_DOSSIER: 'Kipin – Photos',
  TAGS_DEFAUT: ['Client', 'Prospect', 'Partenaire', 'Fournisseur', 'Presse'],

  REGLAGES_DEFAUT: {
    delai: 30,           // jours avant la relance
    heure: 9,            // heure de l'événement Agenda
    duree: 15,           // durée de l'événement, en minutes
    agendaDefaut: true,  // case « Événement Google Agenda » cochée par défaut
    recapDefaut: true,   // case « Récap du lundi » cochée par défaut
    recapActif: true     // rendez-vous « relances de la semaine » chaque lundi 9 h
  }
};
