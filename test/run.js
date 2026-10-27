// npm test: checks the French bundle and that no process is ever run through a shell, then runs test/suite.js in a
// throwaway VS Code (under xvfb-run on a headless Linux), on a temporary workspace, with a fake `picodev` first in PATH.
// Once VS Code has exited, the token is looked for in its user settings and logs (the output channel's file).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runTests } = require('@vscode/test-electron');
const { TOKEN } = require('./mock-mcp');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
const fr = require('../l10n/bundle.l10n.fr.json');
const keys = [...src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
assert.deepStrictEqual(keys.filter((k) => !(k in fr)), [], 'strings missing from l10n/bundle.l10n.fr.json');
assert.deepStrictEqual(Object.keys(fr).filter((k) => !keys.includes(k)), [], 'unused strings in l10n/bundle.l10n.fr.json');
const nls = (f) => Object.keys(require(path.join(root, f))).sort();
assert.deepStrictEqual(nls('package.nls.fr.json'), nls('package.nls.json'), 'package.nls.fr.json out of step');

// picodev runs by execFile only: no shell, no terminal
for (const f of fs.readdirSync(path.join(root, 'src'))) {
  const code = fs.readFileSync(path.join(root, 'src', f), 'utf8');
  assert.doesNotMatch(code, /\b(exec|execSync|spawn|spawnSync)\s*\(|shell\s*:|sendText|createTerminal/, `${f}: a shell or a terminal`);
}
assert.match(fs.readFileSync(path.join(root, 'src/player.ts'), 'utf8'), /execFile\('picodev', args,/);

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picodev-ctf-test-'));
  const ws = path.join(tmp, 'ws');
  const udd = path.join(tmp, 'user-data');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(ws);
  fs.mkdirSync(bin);
  // the fake picodev: records its arguments one per line, answers status like the real one
  fs.writeFileSync(path.join(bin, 'picodev'), `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done >> "$PICODEV_FAKE_LOG"; echo -- >> "$PICODEV_FAKE_LOG"
if [ "$1" = status ]; then echo "{\\"challenge\\": \\"blink-1\\", \\"expires_at\\": $(( $(date +%s) + 600 )), \\"level\\": 0, \\"levels\\": 3}"; fi
`, { mode: 0o755 });
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      extensionTestsEnv: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PICODEV_FAKE_LOG: path.join(tmp, 'picodev.log') },
      cachePath: process.env.VSCODE_TEST_CACHE, // an already downloaded VS Code, if any
      launchArgs: [ws, '--disable-extensions', '--password-store=basic', '--user-data-dir', udd],
    });
    const leaks = [...walk(ws), path.join(udd, 'User', 'settings.json'), ...walk(path.join(udd, 'logs'))]
      .filter((f) => fs.existsSync(f) && fs.readFileSync(f).includes(TOKEN));
    assert.deepStrictEqual(leaks, [], 'the author token was written to disk');
    assert.ok(walk(path.join(udd, 'logs')).some((f) => fs.readFileSync(f, 'utf8').includes('Check: no error.')), 'the output channel log was not found');
    console.log('token scan: workspace, user settings and logs clean');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
