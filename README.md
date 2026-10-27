# Picodev CTF pour VS Code

Extension VS Code du [Picodev CTF](https://ctf.picodev.fr) : écrire un défi de la communauté depuis
l'éditeur (auteurs), et envoyer son programme au banc de sa partie depuis le conteneur du défi
(joueurs). Aucune télémétrie, aucune vue web.

*English:* the VS Code extension of the [Picodev CTF](https://ctf.picodev.fr), an embedded-systems
capture-the-flag. Players join their game with its code and send their program to the game's bench
from the challenge's dev container; authors write, check, try and submit community challenges from
the editor, and give VS Code's agent the CTF's author MCP server. No telemetry, no webview. The
interface is in English and French.

## Réglage

- `picodevCtf.url` : adresse du CTF, `https://ctf.picodev.fr` par défaut, `https` seulement.

Le jeton d'auteur et, pour un site protégé par mot de passe, ce mot de passe sont gardés dans le stockage secret
de VS Code, par adresse : jamais dans un fichier, un réglage ni le journal.

## Auteurs

Il faut le rôle d'auteur et un jeton `ctfa_…`, créé dans son profil sur le site (montré une seule fois).

| Commande | Ce qu'elle fait |
|---|---|
| *Picodev CTF : Enregistrer le jeton d'auteur* | Colle le jeton, le vérifie (`draft_list`) et le garde. Demande aussi le mot de passe du site quand il est fermé (`utilisateur:mot de passe`). |
| *Picodev CTF : Oublier le jeton d'auteur* | Efface le jeton et le mot de passe de l'adresse. |
| *Picodev CTF : Nouveau défi* | Plateforme et nom `c-<nom>`, brouillon créé depuis le gabarit de la famille, écrit dans `<dossier>/<nom>/`. |
| *Picodev CTF : Ouvrir un brouillon* | Un de ses brouillons, écrit de même. |
| *Picodev CTF : Envoyer le brouillon* | Envoie les fichiers texte du dossier (sauf `.picodev-draft.json`, les entrées cachées, `build*` et les liens symboliques). Rien n'est envoyé si le serveur a déjà ce contenu. |
| *Vérifier*, *Essayer sur son banc*, *Résoudre*, *Envoyer en relecture* | Envoi, puis contrôles automatiques, essai du programme de départ, solution de référence, ou envoi en relecture. Un essai long est relu toutes les 5 s. |
| *Remarques des relecteurs* | Les remarques, sans envoi (un envoi repasserait un brouillon en relecture à l'état de brouillon). |

Les résultats s'affichent en texte brut dans le canal de sortie *Picodev CTF*. Rien n'est lancé à
l'enregistrement d'un fichier.

Le dossier d'un brouillon porte `.picodev-draft.json` (`{url, id, revision, with_agent}`, jamais de
jeton). Si le brouillon a changé sur le serveur (atelier web, autre poste), l'extension demande :
*écraser* le serveur avec votre dossier, ou *reprendre* celui du serveur (vos changements locaux
sont alors perdus).

**La partie cachée est sur votre disque.** Cible, drapeau et solution de référence sont dans
`private/`. Gardez ce dossier hors de tout dépôt partagé ou public ; l'extension ne crée aucun
dépôt git.

Un envoi depuis l'extension déclare le défi écrit sans agent, sauf s'il l'était déjà avec un agent.

### Agent

Une fois le jeton enregistré, le MCP d'auteur (`<adresse>/mcp/author`) est déclaré à VS Code :
l'agent de VS Code (Copilot, mode agent) y a accès, avec le jeton dans l'en-tête
`X-CTF-Author-Token`, ajouté seulement au démarrage du serveur.

## Joueurs

Dans le conteneur d'un défi (images `ghcr.io/picodev-sas/dev-<famille>`), l'extension lance la
commande `picodev` du conteneur, sans shell :

| Commande | Ce qu'elle fait |
|---|---|
| *Picodev CTF : Rejoindre une partie* | `picodev login <code>` avec le code de 8 caractères de l'écran de jeu (« utiliser ma machine »). |
| *Picodev CTF : Envoyer au banc* | `picodev send` : compile et envoie au banc de la partie. |
| *Picodev CTF : Rafraîchir l'état de la partie* | `picodev status`, aussi toutes les 60 s dans la barre d'état. |
| *Picodev CTF : Ouvrir un projet de départ* | Ouvre `PICODEV-SAS/picodev-starter-<famille>` dans un conteneur. |

Sans `picodev` (VS Code hors du conteneur), l'extension propose d'ouvrir le projet de départ de la
famille dans VS Code.

## Développement

```bash
npm ci
xvfb-run -a npm test   # bundle français, pas de shell, puis la suite dans un VS Code jetable
```

La suite tourne contre un faux MCP d'auteur (`test/mock-mcp.js`) et un faux `picodev`
(`test/run.js`), puis cherche le jeton dans l'espace de travail, les réglages et les journaux.

Licence Apache 2.0 (`LICENSE`).
