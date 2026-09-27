// Whole-site static checks. No dependencies, no test framework.
//
//   node scripts/verify.mjs
//
// Catches the class of bug that has actually bitten this project:
//   - internal href/srcs pointing at files that do not exist
//   - CSS custom properties used but never defined (and without a fallback)
//   - unbalanced CSS braces
//   - a privileged key leaking into anything the browser loads
//   - inline <script> bodies that do not parse
//   - getElementById("x") where no id="x" exists
//   - duplicate ids, which silently break label/for and aria references
//
// What it CANNOT do: prove any RLS rule works. Those need a signed-in
// session against the real database. See todos.md section 4.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(process.argv[2] || '.');

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);

// ---------------------------------------------------------------- html pages
const htmls = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === '.git' || e === 'node_modules') continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.html')) htmls.push(p);
  }
})(root);

console.log(`\nhtml pages: ${htmls.length}`);

// ------------------------------------------------- 1. internal refs resolve
let refs = 0;
const deadRefs = [];
for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:|\/\/)/.test(u)) continue;
    refs++;
    const target = resolve(dirname(f), u.split('?')[0].split('#')[0]);
    try { statSync(target); } catch { deadRefs.push(`${basename(f)} -> ${u}`); }
  }
}
deadRefs.length ? deadRefs.forEach(fail) : pass(`${refs} local refs all resolve`);

// ------------------------------------------- 2. per-page inline JS + ids
const tmp = mkdtempSync(join(tmpdir(), 'linkzyfy-verify-'));
let inlineScripts = 0;
let inlineParsed = 0;
let inlineBroken = 0;
for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  const rel = basename(f);

  // every inline script body must parse as JS
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => {
    inlineScripts++;
    const p = join(tmp, `s${i}.js`);
    writeFileSync(p, m[1]);
    try {
      execFileSync('node', ['--check', p], { stdio: 'pipe' });
      inlineParsed++;
    } catch (e) {
      inlineBroken++;
      fail(`${rel} inline script ${i} does not parse: ${String(e.stderr || e).split('\n')[0]}`);
    }
  });

  // getElementById targets must exist
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set(
    [...html.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
  );
  const missing = [...used].filter((id) => !ids.has(id));
  missing.length ? fail(`${rel} getElementById with no matching id: ${missing.join(', ')}`)
                 : pass(`${rel}: ${used.size} element refs ok`);

  // ids must be unique
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = [...new Set(all.filter((v, i) => all.indexOf(v) !== i))];
  dupes.length ? fail(`${rel} duplicate ids: ${dupes.join(', ')}`) : null;
}
// Only claim a clean sweep when every script really did parse. An
// unconditional "N inline scripts parse" is a false pass in waiting:
// the individual FAIL lines scroll past and the summary still reads
// like a clean run.
if (inlineBroken === 0) {
  pass(`${inlineParsed} inline scripts parse`);
} else {
  console.log(`  --    ${inlineParsed} of ${inlineScripts} inline scripts parse (${inlineBroken} failed above)`);
}

// ------------------------------------------------------------- 3. the CSS
const cssPath = join(root, 'css/style.css');
if (!exists(cssPath)) {
  fail('css/style.css not found');
} else {
  const css = readFileSync(cssPath, 'utf8');

  const o = (css.match(/\{/g) || []).length;
  const c = (css.match(/\}/g) || []).length;
  o === c ? pass(`css braces balanced (${o})`) : fail(`css braces ${o}/${c}`);

  // a var() with no definition AND no fallback resolves to nothing at
  // computed-value time, which silently drops the declaration
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const usedVars = [...css.matchAll(/var\((--[a-z0-9-]+)([,)]?)/g)];
  const missingVars = [...new Set(
    usedVars.filter(([, n, f]) => !defined.has(n) && f !== ',').map(([, n]) => n)
  )];
  missingVars.length
    ? fail(`CSS vars used with no definition and no fallback: ${missingVars.join(', ')}`)
    : pass(`${defined.size} css vars, all uses resolve`);
}

// --------------------------------------------- 4. no privileged key leaks
// The anon key is public by design and lives in js/supabase.js. A
// service_role key in browser-served code would be a full database bypass.
for (const f of [...htmls, join(root, 'js/supabase.js'), join(root, 'js/auth-guard.js')]) {
  const s = readFileSync(f, 'utf8');
  if (/service_role/i.test(s)) fail(`${basename(f)} mentions service_role`);
}
pass('no service_role in browser-served code');

// ------------------------------------------------------- 5. html tag balance
// An orphaned </div> or </span> is not a parse error -- the browser
// silently drops it -- so nothing else here notices. It still means the
// markup says something other than what was intended, which is how the
// stray closing tags in legal.html survived. Void elements never get a
// closing tag, and anything inside <script>/<style> is not markup.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

function tagBalance(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '');

  const stack = [];
  const problems = [];

  for (const m of stripped.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, name, selfClose] = m;
    const tag = name.toLowerCase();

    if (VOID.has(tag) || selfClose === '/') continue;

    if (closing === '/') {
      const open = stack.pop();
      if (!open) problems.push(`stray </${tag}>`);
      else if (open !== tag) problems.push(`</${tag}> closes <${open}>`);
    } else {
      stack.push(tag);
    }
  }

  for (const unclosed of stack) problems.push(`<${unclosed}> never closed`);
  return problems;
}

let balanceChecked = 0;
for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  const problems = tagBalance(html);
  balanceChecked++;
  problems.length
    ? fail(`${basename(f)} html tags: ${problems.slice(0, 4).join('; ')}`)
    : pass(`${basename(f)}: tags balanced`);
}

// ------------------------------------------- 6. no retired brand in the text
// Every other check here reads the source. That is not enough for a
// name: the wordmark is `Link<em>zyfy</em>`, so a grep for the old
// name finds nothing while the page still renders it. A rename done
// with find-and-replace silently skips every wordmark whose halves are
// separated by a tag -- which is all 17 of them, in the nav and the
// footer of every page. Strip the markup first, then look at the text
// the browser actually paints.
const RETIRED = ['linkup'];

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '');            // the wordmark's split lives here
}

let brandChecked = 0;
let brandStale = 0;
for (const f of htmls) {
  const text = visibleText(readFileSync(f, 'utf8'));
  for (const old of RETIRED) {
    if (new RegExp(old, 'i').test(text)) {
      brandStale++;
      fail(`${basename(f)} still shows the old name "${old}"`);
    }
  }
  brandChecked++;
}
if (!brandStale) pass(`no retired name in the rendered text of ${brandChecked} pages`);

function exists(p) { try { statSync(p); return true; } catch { return false; } }

console.log(
  failures === 0
    ? '\nPASS - site-wide clean'
    : `\nFAIL - ${failures} problem(s)`
);
process.exit(failures ? 1 : 0);
