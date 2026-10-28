# Changelog

Picodev CTF for VS Code, newest first. A version is a `vX.Y.Z` tag of this repository.

## 0.4.0

- VS Code's sign-in (J8b L3): *Sign in* opens the site's profile page, whose "VS Code" card gives a
  short code, pasted here or brought back by `vscode://picodev.picodev-ctf/connect?code=<code>`. A
  link never signs in on its own: "Sign in to <address>?", then the claimed account's pseudonym to
  confirm; only then is the `ctfp_…` token kept (in secret storage, `player:<origin>`), replacing
  the one before. It goes in `X-CTF-Player-Token` to the contract's routes only (course progress,
  the player's games, hints, close, `DELETE /api/device`), never to the catalogue, courses or
  images. *Sign out* revokes it on the site, then erases it; a `player_token_required` refusal
  erases it and offers to sign in again, any other error keeps it.
- *Ask for a hint* and *Abandon the game*, signed in: the game of `picodev status`'s challenge on the
  site, its hints and their cost, a confirmation with the cost, the hint as plain text in a modal;
  or a confirmation, then the game closed. Not signed in: the game screen, as before.
- *Courses* view: the catalogue's courses, the read ones checked. A course opens in VS Code's
  Markdown preview (`picodev-course:` documents) through a markdown-it plugin active for that scheme
  only: no HTML, links to `picodevCtf.url`'s origin only, the course's own `img/<name>` images only
  (loaded from the site), everything else as text. *Mark the course as read*.
- `picodevCtf.url` is a machine setting (an open folder's settings cannot change it), `http` is
  accepted for `localhost` and `127.0.0.1`, and no request follows a redirect.

## 0.3.0

- *Author* view: *My drafts* (`draft_list`; a click opens the draft, no picker), and the open draft
  folder with its revision, the revision its reference solution passed at (`solved_revision`), this
  window's last check (errors in the tooltip) and its parts (sheet, starting program, target,
  reference solution, course) done, in progress or to do, from the folder and the check's errors.
  One "Next: …" line: send, check, fix the errors, try, solve, send to review, wait for or read the
  remarks. The view is read again after every author command.
- Walkthrough *Play a challenge from VS Code*: each step shows its own illustration instead of the
  pixelated logo. It is a VS Code window in the theme's colours, with the action to take ringed and
  numbered and a cursor that clicks it, then the result (an SVG animated in a loop,
  `media/walkthrough/<en|fr>/<step>.svg`, made by `scripts/walkthrough.js`). The illustration and its
  alternative text follow VS Code's display language (`package.nls.json`, `package.nls.fr.json`).

## 0.2.0

- A *Picodev CTF* container in the activity bar (new icon: the Picodev card cut into a flag), with
  native tree views *Actions*, *Game*, *Courses* and *Author*: an empty state that says what to do,
  and one highlighted "Next: …" line. A discreet link to picodev.fr at the bottom.
- Players: *Start a game* searches the site's catalogue (challenges and courses) and opens the
  challenge on the site; *Build* (`picodev build`), compiler errors and warnings in the Problems
  panel; *Board console* (`picodev events --follow` in a terminal of its own, no shell); *Game
  screen*; *Ask for a hint* and *Abandon the game* open the game screen.
- *Watch the game*: one webview, whose only content is the site's Regarder page in a frame, from
  `picodev watch`'s spectator link. The extension used to promise no webview at all; this is the
  one exception, with a strict content security policy and no script of its own.
- The status bar shows the game or "no game" as soon as `picodev` is there; notifications for a new
  level, the last 5 minutes and the end of the game.
- `vscode://picodev.picodev-ctf/join?code=<code>` (the game screen's "Back to VS Code"): only the
  game code is taken from the link; without `picodev`, the code is kept in memory for 15 minutes at
  most while the starter project opens.
- Walkthrough *Play a challenge from VS Code*.

## 0.1.0

First public release.

- Players, in a challenge's dev container: *Join a game* (`picodev login` with the 8-character game
  code), *Send to the bench* (`picodev send`), *Refresh the game status* (`picodev status`, also every
  60 s in the status bar), *Open a starter project in VS Code*. Outside the container, the extension offers the
  family's starter project instead. `picodev` is always run without a shell.
- Authors, with an author token (`ctfa_…`, kept in VS Code's secret storage per address): save or
  forget the token, new challenge from the family's template, open a draft, send the draft folder,
  check, try on one's bench, solve with the reference solution, submit for review, read the
  reviewers' comments. A draft changed on the server asks whether to overwrite it or take the
  server's version.
- The CTF's author MCP server (`/mcp/author`) is declared to VS Code's agent once a token is saved.
- Setting `picodevCtf.url` (https only), English and French interface, no telemetry.
