// Publish the production build to the `gh-pages` branch.
//
//   npm run deploy
//
// 1. `npm run build` (typecheck + vite build; `base: './'` so the bundle works
//    from the project subpath).
// 2. Mirror `dist/` into a scratch repo and force-push it to `gh-pages` on the
//    origin push URL (SSH by default — HTTPS needs a stored token).
//
// `.nojekyll` is part of the published tree: GitHub Pages' Jekyll pass would
// otherwise skip every `_*.png` texture (the game's `_flare*`, `_aim`,
// `_over`, ... files; the cloud sprites are generated at runtime).
//
// GitHub Pages must be set to "Deploy from a branch: gh-pages / (root)" once in
// the repository settings; later deploys just replace the branch.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim();
if (dirty) {
  console.warn('[deploy] working tree is dirty; publishing the built output anyway:\n' + dirty);
}

console.log('[deploy] building…');
run('npm', ['run', 'build']);

const dist = join(root, 'dist');
const pushUrl = execFileSync('git', ['remote', 'get-url', '--push', 'origin'], { cwd: root })
  .toString()
  .trim();
const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim();

const stage = join(tmpdir(), 'ie3d-gh-pages');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
console.log('[deploy] staging dist/ -> ' + stage);
cpSync(dist, stage, { recursive: true });
writeFileSync(join(stage, '.nojekyll'), '');

run('git', ['init', '-q', '-b', 'gh-pages', stage]);
run('git', ['add', '-A'], stage);
run(
  'git',
  ['-c', 'user.name=' + (process.env.GIT_AUTHOR_NAME ?? 'deploy'),
    '-c', 'user.email=' + (process.env.GIT_AUTHOR_EMAIL ?? 'deploy@localhost'),
    'commit', '-q', '-m', `publish: Infinity Edge web build (source ${sha})`],
  stage,
);
console.log(`[deploy] pushing to ${pushUrl} (gh-pages)`);
run('git', ['push', '-q', '--force', pushUrl, 'gh-pages:gh-pages'], stage);
rmSync(stage, { recursive: true, force: true });
console.log('[deploy] done — https://hdlopesrocha.github.io/infinity-edge-web/');
