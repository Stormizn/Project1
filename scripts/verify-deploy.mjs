// Deployment allowlist checks. No dependencies, no test framework.
//
//   node scripts/verify-deploy.mjs
//
// Why this exists:
//
//   .gitignore and .vercelignore do completely different jobs and are
//   NOT interchangeable. Vercel excludes .gitignore itself from the
//   output but does not apply its patterns, so every file git ignores
//   is still published unless .vercelignore also lists it. That is how
//   supabase-migrations.sql — the whole schema, every RLS policy and
//   the SECURITY DEFINER bodies — ends up readable at
//   https://your-domain/supabase-migrations.sql.
//
//   Both failure directions are silent:
//     - a file left out of the allowlist  -> 404 in production only
//     - a file left in the served set      -> published, no error
//
// So this recomputes Vercel's own filter and asserts the result in
// both directions, and proves the matcher is not a no-op.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const root = resolve(process.argv[2] || '.');

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);

// ------------------------------------------------ Vercel's own hard excludes
// From packages/cli/src/util/build/static-builder.ts. These are dropped
// whatever .vercelignore says, so allowlisting one of them is a silent
// no-op rather than a working entry.
const VERCEL_ALWAYS_DROPS = new Set([
  '.git', 'node_modules', 'vercel.json', 'vercel.toml', '.vercelignore',
  'now.json', '.nowignore', '.gitignore', 'package.json', 'package-lock.json',
  'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'README.md',
]);

// -------------------------------------------------------- the matcher
// Implements the gitignore rules Vercel's `ignore` package relies on:
//   - `!` negates
//   - a leading `/` anchors to the repo root
//   - `*` does not cross `/`
//   - a trailing `/` matches directories only
//   - last matching pattern wins
//   - a file inside an ignored directory cannot be re-included
function parsePatterns(text) {
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => ({ neg: l[0] === '!', pat: l[0] === '!' ? l.slice(1) : l }));
}

function compile(pat) {
  let body = '';
  let dirOnly = false;
  let p = pat;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  const anchored = p.startsWith('/');
  for (const ch of (anchored ? p.slice(1) : p)) {
    if (ch === '*') body += '[^/]*';
    else if (ch === '?') body += '[^/]';
    else body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return {
    pat,
    dirOnly,
    re: new RegExp('^' + (anchored ? body : '(?:.*/)?' + body) + '$'),
  };
}

const rules = parsePatterns(readFileSync(join(root, '.vercelignore'), 'utf8'))
  .map((r) => ({ neg: r.neg, ...compile(r.pat) }));

function isIgnored(relPath, isDir) {
  // An ignored parent cannot be undone for its children.
  const parts = relPath.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (matchOne(parts.slice(0, i).join('/'), true)) return true;
  }
  return matchOne(relPath, isDir);
}

function matchOne(p, isDir) {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(p)) ignored = !r.neg;
  }
  return ignored;
}

// ------------------------------------------------- what is actually on disk
const onDisk = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules' || e === '.vercel') continue;
    const abs = join(dir, e);
    const rel = relative(root, abs).split(sep).join('/');
    if (statSync(abs).isDirectory()) { onDisk.push({ rel, isDir: true }); walk(abs); }
    else onDisk.push({ rel, isDir: false });
  }
})(root);

const served = onDisk
  .filter((f) => !f.isDir && !VERCEL_ALWAYS_DROPS.has(f.rel))
  .filter((f) => !isIgnored(f.rel, false))
  .map((f) => f.rel)
  .sort();

console.log(`\nrepo files: ${onDisk.filter((f) => !f.isDir).length}` +
            `   served: ${served.length}`);

// ------------------------------------------- 1. nothing dev-only is served
// The actual leak. Naming the categories so a regression says what it is.
const BANNED = [
  [/\.sql$/, 'a .sql file (the schema and every RLS policy are in it)'],
  [/\.md$/, 'a markdown file (private working notes)'],
  [/^scripts\//, 'a file from scripts/'],
  [/^\.vscode\//, 'a file from .vscode/'],
  [/^ROADMAP\.md$/, 'the private roadmap'],
  [/^todos\.md$/, 'the private todo list'],
  [/^AGENTS\.md$/, 'the agent instructions'],
];
let leaks = 0;
for (const f of served) {
  for (const [re, why] of BANNED) {
    if (re.test(f)) { fail(`${f} would be published — that is ${why}`); leaks++; }
  }
}
if (!leaks) pass('no schema, notes, scripts or editor config in the served set');

// ------------------------------------- 2. every page in the repo is served
// The other silent direction: a new top-level page directory that nobody
// added to the allowlist works locally and 404s in production.
const allHtml = onDisk.filter((f) => !f.isDir && f.rel.endsWith('.html')).map((f) => f.rel).sort();
const unserved = allHtml.filter((f) => !served.includes(f));
unserved.length
  ? unserved.forEach((f) => fail(`${f} is not served — it will 404 in production`))
  : pass(`all ${allHtml.length} html pages are served`);

// assets the pages actually reference must survive the allowlist
for (const need of ['js/supabase.js', 'js/utils.js', 'js/auth-guard.js', 'css/style.css', 'favicon.svg']) {
  existsSync(join(root, need)) && !served.includes(need)
    ? fail(`${need} exists but would not be served`)
    : null;
}
pass('js/, css/ and favicon.svg survive the allowlist');

// ------------------------- 3. no allowed entry that Vercel silently drops
// Allowlisting README.md looks like it works and does not.
const deadEntries = rules.filter((r) => !r.neg)
  .map((r) => r.pat.replace(/^\//, '').replace(/\/$/, ''))
  .filter((p) => VERCEL_ALWAYS_DROPS.has(p));
deadEntries.length
  ? deadEntries.forEach((p) => fail(`allowlists ${p}, which Vercel always drops`))
  : pass('no allowlist entry that Vercel would silently discard');

// --------------------------------- 4. the matcher is not a no-op
// A green check nobody has seen fail is a check nobody can trust.
const selfTest = (label, file, dir, want) => {
  const got = isIgnored(file, dir);
  got === want ? pass(label) : fail(`${label} (got ${got}, want ${want})`);
};
selfTest('matcher: /* ignores a root file', 'random.txt', false, true);
selfTest('matcher: /* ignores a root dir with no negation', 'somedir', true, true);
selfTest('matcher: !/index.html re-includes it', 'index.html', false, false);
selfTest('matcher: a file inside a re-included dir is served', 'app/connections.html', false, false);
selfTest('matcher: /* does not cross into subdirs', 'app/deep/thing.html', false, false);
selfTest('matcher: an unre-included parent still blocks its children', 'scripts', true, true);
selfTest('matcher: children of a blocked parent stay blocked', 'scripts/serve.mjs', false, true);
selfTest('matcher: a dotfile at root is matched by /*', '.vscode', true, true);
selfTest('matcher: a top-level .sql is ignored', 'supabase-schema.sql', false, true);

// ------------------------------------------------------------------ done
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nPASS - deploy allowlist is correct\n');
process.exit(failures ? 1 : 0);
