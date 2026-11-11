# Kipin · keep in touch

Web app iPhone : on photographie une carte de visite, Gemini remplit la fiche, Kipin la range dans un Google Sheet et programme la relance dans Google Agenda.

- **Connexion avec un compte Gmail**, rien d'autre à créer.
- **Chaque utilisateur a ses propres données** : un Sheet « Kipin – Contacts » et un dossier « Kipin – Photos » créés dans *son* Google Drive au premier lancement. Kipin ne voit que les fichiers qu'il a créés (autorisation `drive.file`).
- **Gratuit** : hébergé sur GitHub Pages, lecture des cartes avec la clé Gemini gratuite de chaque utilisateur.
- **Aucun serveur** : tout se passe entre le téléphone et Google. Le récap du lundi est un rendez-vous récurrent « Kipin · relances de la semaine » dans l'Agenda, dont la liste se met à jour à chaque utilisation de l'app.

## Fonctionnalités

| Écran | Ce qu'on y fait |
| --- | --- |
| Contacts | Scanner une carte, rechercher, filtrer par statut |
| Rappels | Toutes les relances à faire, dans l'ordre chronologique |
| Fiche | Carte de visite, actions (email, appel, site, LinkedIn), statut, report, suppression |
| Réglages | Délai et heure des relances, récap du lundi, tags (renommables), carnet d'emails d'invitation, clé Gemini, déconnexion |

## Mise en place (une seule fois, par le propriétaire)

### 1. GitHub Pages
*Settings > Pages* : *Deploy from a branch*, branche `main`, dossier `/ (root)`. L'app est alors à l'adresse `https://djudei.github.io/Kipin/`.

### 2. Google Cloud (ID client OAuth)
1. [console.cloud.google.com](https://console.cloud.google.com) : créer un projet « Kipin ».
2. *API et services > Bibliothèque* : activer **Google Drive API**, **Google Sheets API** et **Google Calendar API**.
3. *Google Auth Platform > Branding* : nom « Kipin », email d'assistance, domaine autorisé `djudei.github.io`.
4. *Audience* : type **Externe**, puis **Publier l'application** (statut « En production ») pour que tout compte Gmail puisse se connecter. Sans validation par Google, un écran « Application non validée » s'affiche et le nombre d'utilisateurs est limité à 100.
5. *Accès aux données* : ajouter les champs d'application `openid`, `email`, `drive.file`, `calendar.events.owned`.
6. *Clients > Créer un client* : type **Application Web**.
   - Origines JavaScript autorisées : `https://djudei.github.io`
   - URI de redirection autorisés : `https://djudei.github.io/Kipin/`
7. Copier l'**ID client** dans `js/config.js` (`CLIENT_ID`).

## Fichiers

```
index.html            page unique
css/styles.css        styles (clair et sombre, taille de texte de l'iPhone)
js/config.js          ID client OAuth et réglages par défaut
js/google.js          connexion Google (par redirection) et appels aux API
js/donnees.js         Sheet, photos Drive, Agenda, partage par email (.ics)
js/gemini.js          lecture de la carte
js/app.js             interface
sw.js                 cache hors ligne de l'app
manifest.webmanifest  installation sur l'écran d'accueil
```
