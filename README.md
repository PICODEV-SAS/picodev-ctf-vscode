# Picodev CTF pour VS Code

Extension VS Code du [Picodev CTF](https://ctf.picodev.fr) : jouer un défi depuis le conteneur du
défi (rejoindre la partie, compiler, envoyer au banc, regarder la partie), et écrire un défi de la
communauté depuis l'éditeur (auteurs). Aucune télémétrie. Une seule vue web : l'onglet *Voir la
partie*, dont le seul contenu est la page « Regarder » du site, dans un cadre ; tout le reste est en
vues natives de VS Code et en texte brut.

*English:* the VS Code extension of the [Picodev CTF](https://ctf.picodev.fr), an embedded-systems
capture-the-flag. Players find a challenge in the catalogue, join their game with its code, build and
send their program to the game's bench from the challenge's dev container, follow the board's console
and watch the game; authors write, check, try and submit community challenges from the editor, and
give VS Code's agent the CTF's author MCP server. No telemetry. One webview only, *Watch the game*,
whose sole content is the site's "Regarder" page in a frame; everything else is native VS Code views
and plain text. The interface is in English and French.

## Réglage

- `picodevCtf.url` : adresse du CTF, `https://ctf.picodev.fr` par défaut, `https` seulement (`http`
  pour `localhost` et `127.0.0.1`). Réglage de la machine : le `.vscode/settings.json` d'un dossier
  ouvert ne peut pas le changer. Aucune requête ne suit une redirection.

Le jeton d'auteur, la connexion de VS Code (jeton `ctfp_…`) et, pour un site protégé par mot de passe, ce
mot de passe sont gardés dans le stockage secret de VS Code, par adresse : jamais dans un fichier, un
réglage ni le journal.

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

Le conteneur *Picodev CTF* de la barre d'activité a quatre vues : *Actions*, *Partie*, *Cours* et
*Auteur*. Chacune dit quoi faire quand elle est vide, et met en avant une seule ligne « Suivant : … ».
Le parcours guidé *Jouer un défi depuis VS Code* (page d'accueil de VS Code) reprend les étapes.

Dans le conteneur d'un défi (images `ghcr.io/picodev-sas/dev-<famille>`), l'extension lance la
commande `picodev` du conteneur, sans shell et avec des arguments vérifiés :

| Action | Ce qu'elle fait |
|---|---|
| *Lancer une partie* | Cherche dans le catalogue du site (défis et cours ensemble ; tapez `défi`, `cours`, une plateforme ou des points pour filtrer). VS Code connecté, dans le conteneur : « Lancer <défi> ? » (gratuit ou payant), puis la partie s'ouvre en mode « ma machine » et `picodev login` la rejoint aussitôt, sans code à recopier. Sans connexion, ou pour un cours : le site, où l'on ouvre la partie avec « utiliser ma machine ». |
| *Rejoindre une partie* | `picodev login <code>` avec le code de 8 caractères de l'écran de jeu. |
| *Compiler* | `picodev build` ; les lignes `fichier:ligne:col: error:` vont dans le panneau Problèmes, effacées à la compilation réussie suivante. |
| *Envoyer au banc* | `picodev send` : compile et envoie au banc de la partie (aussi en bouton dans le titre de l'éditeur). |
| *Voir la partie* | Ouvre dans un onglet la page « Regarder » du site (console, montage, chronogramme, radio, réseau) avec le lien spectateur de `picodev watch`. |
| *Console de la carte* | `picodev events --follow` dans un terminal à part (lancé sans shell). |
| *Écran de jeu* | Ouvre `<adresse>/defis/<défi>` dans le navigateur. Le drapeau s'y rend, jamais depuis l'extension. |
| *État* | `picodev status`, aussi toutes les 60 s et après chaque envoi. |
| *Demander un indice*, *Abandonner la partie* | VS Code connecté : la partie du défi de `picodev status` sur le site, ses indices et leur coût, une confirmation qui rappelle le coût, puis le texte de l'indice en texte brut ; ou une confirmation, puis la partie fermée. Sans connexion : l'écran de jeu, qui montre le coût ou demande confirmation. |
| *Ouvrir un projet de départ* | Ouvre `PICODEV-SAS/picodev-starter-<famille>` dans un conteneur. |

La barre d'état montre la partie (défi, niveau, minutes restantes ; clic : la vue *Partie*) ou
« aucune partie » (clic : rejoindre). Une notification annonce un nouveau niveau, les 5 dernières
minutes et la fin de la partie.

**Revenir dans VS Code.** Un défi ouvert depuis l'extension montre sur son écran de jeu le lien
`vscode://picodev.picodev-ctf/join?code=<code>`. L'extension n'en prend que le code (8 caractères ;
tout autre paramètre est ignoré, l'adresse reste celle du réglage `picodevCtf.url`). Si `picodev`
répond dans la fenêtre, elle rejoint la partie ; sinon elle propose d'ouvrir le projet de départ dans
son conteneur et garde le code en mémoire 15 minutes au plus, sans l'écrire nulle part. Le conteneur
ouvre une nouvelle fenêtre : y cliquer de nouveau « Revenir dans VS Code » sur l'écran de jeu.

**Voir la partie** est la seule vue web de l'extension : un cadre de la page `/regarder` du site, à
l'adresse `picodevCtf.url`, et rien d'autre (aucun script de l'extension, politique de sécurité
stricte). Elle s'ouvre d'elle-même à côté dès qu'un `picodev login` a réussi (code saisi, lien
« Revenir dans VS Code » ou *Lancer une partie*). Avec une image plus ancienne sans `picodev watch`,
une notification le dit.

Sans `picodev` (VS Code hors du conteneur), l'extension propose d'ouvrir le projet de départ de la
famille dans VS Code.

**Connecter VS Code.** *Se connecter* (vues *Actions* et *Cours*) ouvre la page de profil du site :
la carte « VS Code » y donne un code de 8 caractères, valable 10 minutes, à coller dans VS Code ou à
suivre par « Revenir dans VS Code » (`vscode://picodev.picodev-ctf/connect?code=<code>`). Le lien ne
connecte jamais tout seul : VS Code demande « Se connecter à <adresse> ? », puis montre le pseudonyme
du compte, à comparer avec celui de la carte ; la connexion n'est gardée (et ne remplace la
précédente) qu'après cette confirmation. VS Code ne voit ni le mot de passe ni la clé d'accès : il
garde un jeton `ctfp_…` qui ne sert qu'aux cours (avancement), à l'ouverture d'une partie, aux
indices et à l'abandon de ses parties, envoyé dans l'en-tête `X-CTF-Player-Token` à ces seules routes. *Se déconnecter* le révoque
sur le site, puis l'efface. Un jeton expiré ou révoqué sur le site est effacé à la première requête
refusée, et VS Code propose de se reconnecter.

**Lancer depuis VS Code.** Le code de la partie ne passe que de la réponse du site à `picodev login`
(processus enfant, sans shell) : jamais affiché, gardé ni journalisé, pas plus que la sortie de ce
`picodev login`. S'il échoue, la partie reste ouverte : *Reprendre sur l'écran de jeu* ou
*Abandonner*. Le site répond aussi « Plus assez de crédits » (*Acheter des crédits* ouvre la page
d'achat), « une partie est déjà ouverte » (la reprendre ou l'abandonner), les plafonds (5 parties
par heure depuis VS Code, dont 2 payantes ; tours du jour), ou « ce défi se joue sur le site ».

**Cours.** La vue *Cours* liste les cours du catalogue, ceux déjà lus cochés quand VS Code est
connecté. Un cours s'ouvre dans l'aperçu Markdown de VS Code (document `picodev-course:`), tenu
serré : aucun HTML (montré comme texte), liens vers le site de `picodevCtf.url` seulement, images du
cours seulement (`img/<nom>`, chargées depuis le site) ; tout le reste est rendu comme texte, les
autres aperçus Markdown ne changent pas. *Marquer comme lu* note le cours (le dernier ouvert, ou celui
de la ligne) dans l'avancement du site.

## Développement

```bash
npm ci
xvfb-run -a npm test   # bundle français, pas de shell, puis la suite dans un VS Code jetable
```

La suite tourne contre un faux MCP d'auteur et un faux catalogue (`test/mock-mcp.js`) et un faux
`picodev` (`test/run.js`), puis cherche le jeton, les codes de partie et le lien spectateur dans
l'espace de travail, les réglages, les journaux et les vues.

L'icône de la boutique, `media/logo.png`, est rendue depuis `media/logo.svg` par `npm run logo`
(`@resvg/resvg-js`, dépendance de développement seulement) ; l'icône de la barre d'activité est
`media/activity.svg`.

Licence Apache 2.0 (`LICENSE`).
