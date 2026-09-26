// Sanity check for the tag-balance rule in verify.mjs: proves the check
// is not a no-op, and that it does not fire on markup that only looks
// like a tag.
//
//   node scripts/verify-tag-balance.mjs

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(process.argv[2] || '.');
const src = readFileSync(resolve(root, 'scripts/verify.mjs'), 'utf8');
const snippet = src.slice(src.indexOf('const VOID'), src.indexOf('let balanceChecked'));

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(snippet + '\nthis.tagBalance = tagBalance;', sandbox);
const tagBalance = sandbox.tagBalance;

const cases = [
  ['<div><span>x</span></div>', false, 'a clean fragment'],
  ['<div><span>x</span></div>\n</span>\n</div>', true, 'the stray closing tags legal.html had'],
  ['<div><p>x</div>', true, 'a mismatched pair'],
  ['<div><p>x</p>', true, 'an unclosed element'],
  ['<div><br><img src="a.png"><hr></div>', false, 'void elements, which never close'],
  ['<div class="a" />', false, 'a self-closing tag'],
  ['<script>var s = "</div>";</script><div></div>', false, 'markup inside a script'],
  ['<style>.a::after{content:"<b>"}</style><p>ok</p>', false, 'markup inside a style'],
  ['<!-- <div> --><p>ok</p>', false, 'a tag inside a comment'],
  ['<!DOCTYPE html><html><body><p>ok</p></body></html>', false, 'a whole document'],
];

let failed = 0;
for (const [html, shouldFail, name] of cases) {
  const problems = tagBalance(html);
  const caught = problems.length > 0;
  const ok = caught === shouldFail;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`
    + (caught ? ` -> ${problems.join('; ')}` : ''));
}

console.log(`\n${failed ? failed + ' FAILED' : 'all ' + cases.length + ' checks passed'}`);
process.exit(failed ? 1 : 0);
