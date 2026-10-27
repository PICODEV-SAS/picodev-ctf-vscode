# Changelog

Picodev CTF for VS Code, newest first. A version is a `vX.Y.Z` tag of this repository.

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
