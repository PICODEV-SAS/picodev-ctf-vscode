# Changelog

Picodev CTF for VS Code, newest first. A version is a `vX.Y.Z` tag of this repository.

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
