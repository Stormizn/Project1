// Behavioural tests for the account-deletion flow in app/profile.html.
//
//   node scripts/verify-delete-account.cjs
//
// The page's inline <script> is extracted and run in a vm sandbox against
// a fake supabase client, so the real gating and error-handling logic is
// exercised without a browser and without a database.
//
// Each scenario gets a FRESH sandbox. deleteInFlight deliberately stays
// true after a successful delete -- that is the double-fire guard -- so
// reusing one instance across scenarios would test nothing.
//
// What this does NOT cover: that delete_account() exists in the database
// and deletes in the right order. That needs a real account. See
// todos.md, "Account deletion - use a throwaway account".

const read = (p) => require('node:fs').readFileSync(p, 'utf8');
const { resolve } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const root = resolve(process.argv[2] || '.');
const html = read(resolve(root, 'app/profile.html'));
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const body = scripts[scripts.length - 1][1];

// Build one isolated "page load" with stubbed DOM + auth.
function loadPage() {
  const nodes = {};
  const attrOf = (id) => (html.match(new RegExp(`id="${id}"[^>]*`)) || [null])[0];

  const mk = (id) => {
    const tag = attrOf(id) || '';
    return (nodes[id] = {
      id, textContent: '', value: '',
      // seeded from the real HTML attribute, not assumed
      disabled: /\bdisabled\b/.test(tag),
      hidden: /\bhidden\b/.test(tag),
      classList: { add() {}, remove() {} },
      style: {}, focus() { page.focused = id; },
      addEventListener(evt, fn) { (this.h ||= {})[evt] = fn; },
      click() { return this.h?.click?.(); },   // return the promise
    });
  };

  ['openDeleteBtn', 'deletePanel', 'deleteConfirmInput', 'confirmDeleteBtn',
   'cancelDeleteBtn', 'deleteMessage'].forEach(mk);

  const page = {
    nodes, focused: null,
    calls: { rpc: [], signOut: [] },
    redirected: null,
    rpcResult: { error: null },
    signOutThrows: false,
  };

  const db = {
    rpc: async (name) => { page.calls.rpc.push(name); return page.rpcResult; },
    auth: {
      signOut: async (opts) => {
        page.calls.signOut.push(opts);
        if (page.signOutThrows) throw new Error('network down');
      },
    },
  };

  const sandbox = {
    window: {
      supabaseClient: db,
      location: { replace: (u) => { page.redirected = u; } },
    },
    document: { getElementById: mk },
    setFormMessage: (el, t) => { el.textContent = t; },
    getErrorMessage: (e) => e?.message || String(e),
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    // the auth layer the page also uses
    requireSession: async () => ({
      user: { id: 'u1', email: 'a@b.c' },
      profile: { name: 'A', role: 'brand' },
      error: null,
    }),
    watchSessionExpiry: () => {},
    signOut: () => {},
    getInitials: () => 'A',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);

  const N = page.nodes;
  page.type = (v) => { N.deleteConfirmInput.value = v; N.deleteConfirmInput.h.input(); };
  page.click = async (el) => { await el.click(); await new Promise((r) => setImmediate(r)); };
  page.open = async () => { await page.click(N.openDeleteBtn); page.type('DELETE'); };
  return page;
}

const out = [];
const check = async (name, fn) => {
  try { await fn(); out.push('  PASS  ' + name); }
  catch (e) { out.push('  FAIL  ' + name + ' -> ' + e.message); }
};

(async () => {
  // ---------------------------------------------------- the typed gate
  let p = loadPage();
  await check('panel starts hidden (from the HTML attribute)', () =>
    assert.equal(p.nodes.deletePanel.hidden, true));
  await check('confirm button starts disabled (from the HTML attribute)', () =>
    assert.equal(p.nodes.confirmDeleteBtn.disabled, true));
  await check('no RPC fires on page load', () => assert.equal(p.calls.rpc.length, 0));
  await check('opening reveals the panel and focuses the input', async () => {
    await p.click(p.nodes.openDeleteBtn);
    assert.equal(p.nodes.deletePanel.hidden, false);
    assert.equal(p.focused, 'deleteConfirmInput');
  });
  await check('lowercase "delete" enables the button', () => {
    p.type('delete'); assert.equal(p.nodes.confirmDeleteBtn.disabled, false);
  });
  await check('partial "DEL" does not enable it', () => {
    p.type('DEL'); assert.equal(p.nodes.confirmDeleteBtn.disabled, true);
  });
  await check('longer "DELETED" does not enable it', () => {
    p.type('DELETED'); assert.equal(p.nodes.confirmDeleteBtn.disabled, true);
  });
  await check('surrounding whitespace is tolerated', () => {
    p.type('  delete  '); assert.equal(p.nodes.confirmDeleteBtn.disabled, false);
  });
  await check('cancel hides the panel and disarms it again', async () => {
    await p.click(p.nodes.cancelDeleteBtn);
    assert.equal(p.nodes.deletePanel.hidden, true);
    assert.equal(p.nodes.confirmDeleteBtn.disabled, true);
  });
  await check('an unconfirmed click never reaches the server', async () => {
    p.type('nope');
    await p.click(p.nodes.confirmDeleteBtn);
    assert.equal(p.calls.rpc.length, 0);
  });

  // ------------------------------------------- failure leaves you signed in
  p = loadPage();
  await p.open();
  p.rpcResult = { error: { message: 'foreign key violation' } };
  await p.click(p.nodes.confirmDeleteBtn);
  await check('error: calls rpc("delete_account") exactly once', () =>
    assert.deepEqual(p.calls.rpc, ['delete_account']));
  await check('error: surfaces the database message', () =>
    assert.match(p.nodes.deleteMessage.textContent, /foreign key/));
  await check('error: re-enables the confirm button', () =>
    assert.equal(p.nodes.confirmDeleteBtn.disabled, false));
  await check('error: restores the button label', () =>
    assert.equal(p.nodes.confirmDeleteBtn.textContent, 'Permanently delete my account'));
  await check('error: re-enables the input', () =>
    assert.equal(p.nodes.deleteConfirmInput.disabled, false));
  await check('error: re-enables cancel', () =>
    assert.equal(p.nodes.cancelDeleteBtn.disabled, false));
  await check('error: does NOT sign the user out', () =>
    assert.equal(p.calls.signOut.length, 0));
  await check('error: does NOT redirect', () => assert.equal(p.redirected, null));
  await check('error: retrying works', async () => {
    p.rpcResult = { error: null };
    await p.click(p.nodes.confirmDeleteBtn);
    assert.equal(p.calls.rpc.length, 2);
  });
  await check('error: retry signs out locally only', () =>
    assert.deepEqual(p.calls.signOut, [{ scope: 'local' }]));
  await check('error: retry redirects to login?deleted=1', () =>
    assert.equal(p.redirected, '../auth/login.html?deleted=1'));

  // ---------------------------- a failed local sign-out must not strand you
  p = loadPage();
  await p.open();
  p.signOutThrows = true;
  await p.click(p.nodes.confirmDeleteBtn);
  await check('signOut failure: the delete still ran', () =>
    assert.equal(p.calls.rpc.length, 1));
  await check('signOut failure: it was actually attempted', () =>
    assert.equal(p.calls.signOut.length, 1));
  await check('signOut failure: still redirects to login', () =>
    assert.equal(p.redirected, '../auth/login.html?deleted=1'));

  // ------------------------------------------- double-click cannot double-fire
  p = loadPage();
  await p.open();
  await Promise.all([p.nodes.confirmDeleteBtn.click(), p.nodes.confirmDeleteBtn.click()]);
  await new Promise((r) => setImmediate(r));
  await check('double-click fires the RPC only once', () =>
    assert.equal(p.calls.rpc.length, 1));

  p = loadPage();
  await p.open();
  const [c1, c2, c3] = [
    p.nodes.confirmDeleteBtn.click(),
    p.nodes.confirmDeleteBtn.click(),
    p.nodes.confirmDeleteBtn.click(),
  ];
  await new Promise((r) => setImmediate(r));
  await check('triple-click while in flight fires the RPC only once', () =>
    assert.equal(p.calls.rpc.length, 1));
  await Promise.all([c1, c2, c3]);

  console.log(out.join('\n'));
  const failed = out.filter((x) => x.startsWith('  FAIL')).length;
  console.log(`\n${failed ? failed + ' FAILED' : 'all ' + out.length + ' checks passed'}`);
  process.exit(failed ? 1 : 0);
})();
