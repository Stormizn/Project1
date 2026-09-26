// Behavioural tests for the proposal flow in app/proposal.html and
// app/proposals.html.
//
//   node scripts/verify-proposals.cjs
//
// Each page's inline <script> is extracted and run in a vm sandbox against
// a fake DOM and a fake supabase client, so the real gating, validation
// and error-handling logic is exercised without a browser and without a
// database.
//
// Each scenario gets a FRESH sandbox, because the pages keep module-level
// state (me, proposal, busy) that would otherwise leak between tests.
//
// What this does NOT cover: whether the RLS policies and the
// proposals_state_guard() trigger actually behave as written. Those need
// a real signed-in session against the real database. See ROADMAP.md,
// Tier 1.

const read = (p) => require('node:fs').readFileSync(p, 'utf8');
const { resolve } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert');

const root = resolve(process.argv[2] || '.');
const detailHtml = read(resolve(root, 'app/proposal.html'));
const listHtml = read(resolve(root, 'app/proposals.html'));

const scriptOf = (html) => {
  const s = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  return s[s.length - 1][1];
};

// ------------------------------------------------------------ mini DOM

// Every id in the page gets a node, with `hidden` / `disabled` / `value`
// seeded from the real HTML attribute rather than assumed, so a test that
// asserts "starts hidden" is asserting something about the markup.
function makeNodes(html) {
  const nodes = {};
  const tags = new Map();

  for (const m of html.matchAll(/<(\w+)([^>]*\sid="([^"]+)"[^>]*)>/g)) {
    tags.set(m[3], m[2]);
  }

  for (const [id, attrs] of tags) {
    const valueMatch = attrs.match(/\bvalue="([^"]*)"/);
    const node = {
      id,
      tagName: id,
      textContent: '',
      value: valueMatch ? valueMatch[1] : '',
      hidden: /\bhidden\b/.test(attrs),
      disabled: /\bdisabled\b/.test(attrs),
      className: (attrs.match(/\bclass="([^"]*)"/) || ['', ''])[1],
      style: {},
      attributes: {},
      children: [],
      options: [],
      h: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(k, v) { node.attributes[k] = v; },
      getAttribute(k) { return node.attributes[k]; },
      addEventListener(evt, fn) { node.h[evt] = fn; },
      appendChild(child) { node.children.push(child); return child; },
      append(...kids) { node.children.push(...kids); },
      focus() {},
      click() { return node.h.click && node.h.click(); },
      reload() {},
    };
    nodes[id] = node;
  }

  // <select> needs a real options list, because fillOfferForm() checks
  // whether the stored currency is one the <select> already offers.
  for (const sel of html.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const node = nodes[sel[1]];
    if (!node) continue;
    node.options = [...sel[2].matchAll(/<option value="([^"]*)"/g)].map((o) => ({ value: o[1] }));
  }

  return { nodes, tags };
}

// A chainable stand-in for supabase-js. Records every write so a test can
// assert not just that the UI updated but that the right statement was
// sent with the right values.
function makeDb(page) {
  function run(q, mode) {
    page.calls.push({
      table: q._table, op: q._op || 'select', mode,
      payload: q._payload, filters: q._filters,
    });
    if (q._op) {
      page.writes.push({ table: q._table, op: q._op, payload: q._payload, filters: q._filters });
    }

    const answer = page.data[q._table] || {};
    if (answer[mode] !== undefined) return Promise.resolve(answer[mode]);
    if (answer.any !== undefined) return Promise.resolve(answer.any);

    // PostgREST's insert().select().single() echoes the row back. Doing
    // the same here keeps the tests about the page's logic rather than
    // about the fake's plumbing.
    if (q._op === 'insert') {
      return Promise.resolve({ data: Object.assign({ id: 'prop-new' }, q._payload), error: null });
    }

    return Promise.resolve({ data: null, error: null });
  }

  const builder = (table) => {
    const q = {
      _table: table, _op: null, _payload: null, _filters: {},
      select() { return q; },
      eq(col, val) { q._filters[col] = val; return q; },
      or() { return q; },
      in(col, vals) { q._filters[col] = vals; return q; },
      order() { return q; },
      insert(payload) { q._op = 'insert'; q._payload = payload; return q; },
      update(payload) { q._op = 'update'; q._payload = payload; return q; },
      single() { return run(q, 'single'); },
      maybeSingle() { return run(q, 'maybeSingle'); },
      then(res, rej) { return run(q, 'many').then(res, rej); },
    };
    return q;
  };

  return { from: builder, auth: { signOut: async () => {} } };
}

// ---------------------------------------------------------- page loading

function loadPage(which, opts = {}) {
  const html = which === 'list' ? listHtml : detailHtml;
  const { nodes, tags } = makeNodes(html);

  // proposals.html wires its filter chips through querySelectorAll, so
  // these have to behave like the buttons they stand in for.
  const filterButtons = [...html.matchAll(/<button[^>]*data-filter="([^"]+)"[^>]*>/g)].map((m) => ({
    _filter: m[1],
    attrs: {},
    getAttribute(k) { return k === 'data-filter' ? this._filter : (this.attrs[k] || null); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(evt, fn) { this['on' + evt] = fn; },
  }));

  const page = {
    nodes, calls: [], writes: [], data: {}, redirected: null, reloaded: 0,
    confirmAnswer: true, query: opts.query || '?id=prop-1',
  };

  const sandbox = {
    window: {
      supabaseClient: makeDb(page),
      location: {
        // The pages read the id from window.location.search, so this has
        // to be real or every test silently loads a page with no id.
        search: opts.query || '',
        set href(v) { page.redirected = v; },
        get href() { return page.redirected; },
        replace(v) { page.redirected = v; },
        reload() { page.reloaded++; },
      },
      confirm: () => page.confirmAnswer,
    },
    document: {
      getElementById: (id) => nodes[id] || null,
      createElement: () => ({
        textContent: '', className: '', hidden: false, value: '', href: '', children: [],
        setAttribute(k, v) { this[k] = v; },
        getAttribute: (k) => (this[k] === undefined ? null : this[k]),
        addEventListener(evt, fn) { this['on' + evt] = fn; },
        appendChild(c) { this.children.push(c); return c; },
        append(...c) { this.children.push(...c); },
        classList: { add() {}, remove() {}, toggle() {} },
      }),
      querySelectorAll: (sel) => (sel.indexOf('data-filter') !== -1 ? filterButtons : []),
    },
    setFormMessage: (el, t, isError) => {
      el.textContent = t || '';
      el.style.display = t ? 'block' : 'none';
      if (t) el.className = isError ? 'error' : 'success';
    },
    hideFormMessage: (el) => { el.textContent = ''; el.style.display = 'none'; },
    getErrorMessage: (e) => (e && e.message) || String(e),
    isMissingTable: (e) => !!e && (e.code === '42P01' || e.code === 'PGRST205'
      || e.code === 'PGRST204' || /does not exist/i.test(e.message || '')),
    proposalStatusLabel: (s) => ({
      proposed: 'Awaiting review',
      changes_requested: 'Changes requested',
      accepted: 'Accepted',
      rejected: 'Declined',
      withdrawn: 'Withdrawn',
    }[s] || 'Unknown'),
    isProposalEditable: (s) => s === 'proposed' || s === 'changes_requested',
    isProposalFinal: (s) => ['accepted', 'rejected', 'withdrawn'].indexOf(s) !== -1,
    proposalStatusChip: (s) => ({ className: 'status status--pending', textContent: s }),
    formatMoney: (a) => (a === null || a === undefined || a === '' ? '' : String(a)),
    formatDate: () => 'then',
    formatDateTime: () => 'then',
    plural: (n, s, p) => n + ' ' + (n === 1 ? s : (p || s + 's')),
    // Silenced by default, because the pages log on paths a test drives
    // deliberately. LINKUP_VERBOSE=1 surfaces them when a check fails.
    console: {
      log: (...a) => process.env.LINKUP_VERBOSE && console.log('   [page]', ...a),
      warn: (...a) => process.env.LINKUP_VERBOSE && console.warn('   [page]', ...a),
      error: (...a) => process.env.LINKUP_VERBOSE && console.error('   [page]', ...a),
    },
    URLSearchParams,
    requireSession: async () => ({
      user: { id: 'u1', email: 'a@b.c' },
      profile: opts.profile || { id: 'u1', name: 'A', role: 'brand' },
      error: null,
    }),
    watchSessionExpiry: () => {},
    signOut: () => {},
    getInitials: () => 'A',
    getDisplayName: () => 'A',
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  page.N = nodes;
  page.ready = vm.runInContext(scriptOf(html), sandbox);

  page.submit = async () => {
    nodes.offerForm.h.submit({ preventDefault() {} });
    await new Promise((r) => setImmediate(r));
  };
  page.click = async (id) => {
    nodes[id].h.click();
    await new Promise((r) => setImmediate(r));
  };
  page.setNote = (v) => { nodes.plannerNoteInput.value = v; };
  page.type = (vals) => {
    if ('cashAmount' in vals) nodes.cashAmount.value = vals.cashAmount;
    if ('productQty' in vals) nodes.productQty.value = vals.productQty;
    if ('productNotes' in vals) nodes.productNotes.value = vals.productNotes;
    if ('activationIdea' in vals) nodes.activationIdea.value = vals.activationIdea;
  };
  return page;
}

// ------------------------------------------------------------- fixtures

const BRAND = { id: 'u1', name: 'Acme', role: 'brand' };
const PLANNER = { id: 'u1', name: 'Ash Events', role: 'event_planner' };

const proposalRow = (over = {}) => Object.assign({
  id: 'prop-1',
  connection_id: 'conn-1',
  brand_id: { id: 'brand-1', name: 'Acme' },
  planner_id: { id: 'u1', name: 'Ash Events' },
  cash_amount: '50000',
  currency: 'INR',
  product_qty: 200,
  product_notes: 'tote bags',
  activation_idea: 'booth',
  promotion_plan: 'social',
  deliverables: 'logo on stage',
  status: 'proposed',
  planner_note: null,
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-02T10:00:00Z',
  connections: { id: 'conn-1', opportunity_id: 'opp-1' },
}, over);

const connRow = (over = {}) => Object.assign({
  id: 'conn-1',
  from_user: { id: 'u1', name: 'Acme' },
  to_user: { id: 'planner-1', name: 'Ash Events' },
  status: 'accepted',
  opportunity_id: { id: 'opp-1', title: 'Design Week' },
}, over);

const out = [];
const check = async (name, fn) => {
  try { await fn(); out.push('  PASS  ' + name); }
  catch (e) { out.push('  FAIL  ' + name + ' -> ' + e.message); }
};

// A create-mode page: ?connection=conn-1, brand, accepted connection with
// no existing proposal.
function createPage(over = {}) {
  const p = loadPage('detail', { query: '?connection=conn-1', profile: BRAND, ...over });
  p.data.connections = { maybeSingle: { data: connRow(over.conn), error: null } };
  p.data.proposals = { maybeSingle: { data: over.existing || null, error: null } };
  p.data.opportunities = { maybeSingle: { data: { id: 'opp-1', title: 'Design Week' }, error: null } };
  return p;
}

// A view-mode page: ?id=prop-1, showing the given proposal row.
function viewPage(row, profile = BRAND) {
  const p = loadPage('detail', { query: '?id=prop-1', profile });
  p.data.proposals = { maybeSingle: { data: row, error: null } };
  p.data.opportunities = { maybeSingle: { data: { id: 'opp-1', title: 'Design Week' }, error: null } };
  return p;
}

(async () => {

  // ============================================ create mode: the happy path
  let p = createPage();
  await p.ready;
  await check('create mode: the offer form is shown', () =>
    assert.equal(p.N.editCard.hidden, false));
  await check('create mode: the read-only panels stay hidden', () => {
    assert.equal(p.N.decideCard.hidden, true);
    assert.equal(p.N.settledCard.hidden, true);
  });
  await check('create mode: button says Send, not Save', () =>
    assert.equal(p.N.saveButton.textContent, 'Send proposal'));
  await check('create mode: no Withdraw before it exists', () =>
    assert.equal(p.N.withdrawButton.hidden, true));
  await check('create mode: no Cancel out of a proposal that does not exist', () =>
    assert.equal(p.N.cancelLink.hidden, true));

  p.type({ cashAmount: '50000', productQty: '200', activationIdea: '  ' });
  await p.submit();
  await check('create mode: a valid offer inserts one row', () =>
    assert.equal(p.writes.length, 1));
  await check('create mode: the insert targets proposals', () =>
    assert.equal(p.writes[0].table, 'proposals'));
  await check('create mode: status starts at proposed', () =>
    assert.equal(p.writes[0].payload.status, 'proposed'));
  await check('create mode: the parties come from the session and the connection', () => {
    assert.equal(p.writes[0].payload.brand_id, 'u1');
    assert.equal(p.writes[0].payload.planner_id, 'planner-1');
    assert.equal(p.writes[0].payload.connection_id, 'conn-1');
  });
  await check('create mode: a whitespace-only field is stored as null, not ""', () =>
    assert.equal(p.writes[0].payload.activation_idea, null));
  await check('create mode: it navigates to the proposal the server returned', () =>
    assert.equal(p.redirected, 'proposal.html?id=prop-new'));

  // ==================================================== create mode: validation
  p = createPage();
  await p.ready;
  p.type({ cashAmount: '', productQty: '' });
  await p.submit();
  await check('validation: cash and product both empty is refused', () =>
    assert.match(p.N.offerMessage.textContent, /needs something in it/i));
  await check('validation: nothing was sent to the database', () =>
    assert.equal(p.writes.length, 0));

  p = createPage();
  await p.ready;
  p.type({ cashAmount: '-5', productQty: '' });
  await p.submit();
  await check('validation: a negative cash amount is refused', () =>
    assert.match(p.N.offerMessage.textContent, /negative/i));
  await check('validation: the negative amount was never sent', () =>
    assert.equal(p.writes.length, 0));

  p = createPage();
  await p.ready;
  p.type({ cashAmount: '', productQty: '0' });
  await p.submit();
  await check('validation: zero product units is refused', () =>
    assert.match(p.N.offerMessage.textContent, /1 or more/i));

  p = createPage();
  await p.ready;
  p.type({ cashAmount: '', productQty: '2.5' });
  await p.submit();
  await check('validation: a fractional product count is refused', () =>
    assert.match(p.N.offerMessage.textContent, /whole number/i));

  p = createPage();
  await p.ready;
  p.type({ cashAmount: '', productQty: '  ' });
  await p.submit();
  await check('validation: a blank product field counts as absent', () =>
    assert.equal(p.writes.length, 0));

  p = createPage();
  await p.ready;
  p.type({ cashAmount: '', productQty: '5' });
  await p.submit();
  await check('validation: product alone is a valid offer', () =>
    assert.equal(p.writes.length, 1));
  await check('validation: product alone stores a null cash amount', () =>
    assert.equal(p.writes[0].payload.cash_amount, null));

  // ============================================ create mode: who may write
  p = createPage({ profile: PLANNER });
  await p.ready;
  await check('a planner cannot open the write form', () =>
    assert.equal(p.N.fatalSection.hidden, false));
  await check('a planner is told the brand writes it', () =>
    assert.match(p.N.fatalBody.textContent, /brand/i));
  await check('a planner never reaches the connection query', () =>
    assert.equal(p.calls.filter((c) => c.table === 'connections').length, 0));

  p = createPage({ conn: { status: 'pending' } });
  await p.ready;
  await check('a pending connection cannot be proposed on', () =>
    assert.match(p.N.fatalBody.textContent, /accepted your interest/i));

  p = createPage({ conn: { from_user: { id: 'someone-else', name: 'X' } } });
  await p.ready;
  await check('a connection that is not yours is refused', () =>
    assert.match(p.N.fatalTitle.textContent, /not your connection/i));

  p = createPage({ existing: { id: 'prop-existing' } });
  await p.ready;
  await check('an existing proposal is opened instead of duplicated', () =>
    assert.equal(p.redirected, 'proposal.html?id=prop-existing'));
  await check('the duplicate path never reaches the form', () =>
    assert.equal(p.N.editCard.hidden, true));

  // ================================================== view mode: brand edits
  p = viewPage(proposalRow({ status: 'proposed' }));
  await p.ready;
  await check('brand, proposed: the form is editable', () =>
    assert.equal(p.N.editCard.hidden, false));
  await check('brand, proposed: the button says Save changes', () =>
    assert.equal(p.N.saveButton.textContent, 'Save changes'));
  await check('brand, proposed: Cancel is available', () =>
    assert.equal(p.N.cancelLink.hidden, false));
  await check('brand, proposed: the form is prefilled from the row', () => {
    assert.equal(p.N.cashAmount.value, '50000');
    assert.equal(p.N.productQty.value, '200');
    assert.equal(p.N.activationIdea.value, 'booth');
    assert.equal(p.N.currency.value, 'INR');
  });

  p.type({ cashAmount: '60000' });
  await p.submit();
  await check('brand edit: it is an update, not a second insert', () => {
    assert.equal(p.writes.length, 1);
    assert.equal(p.writes[0].op, 'update');
  });
  await check('brand edit: the new amount is sent', () =>
    assert.equal(p.writes[0].payload.cash_amount, 60000));
  await check('brand edit: a plain edit stays at proposed', () =>
    assert.equal(p.writes[0].payload.status, 'proposed'));
  await check('brand edit: it reloads rather than leaving the page', () =>
    assert.equal(p.reloaded, 1));

  p = viewPage(proposalRow({ status: 'changes_requested', planner_note: 'Halve the cash.' }));
  await p.ready;
  await check('brand, changes requested: the button says Resubmit', () =>
    assert.equal(p.N.saveButton.textContent, 'Resubmit for review'));
  await check('brand, changes requested: the planner note is shown', () => {
    assert.equal(p.N.noteCard.hidden, false);
    assert.equal(p.N.plannerNote.textContent, 'Halve the cash.');
  });
  p.type({ cashAmount: '60000' });
  await p.submit();
  await check('brand resubmit: status goes back to proposed for review', () =>
    assert.equal(p.writes[0].payload.status, 'proposed'));

  p = viewPage(proposalRow({ status: 'proposed' }));
  await p.ready;
  p.confirmAnswer = false;
  await p.click('withdrawButton');
  await check('withdraw: cancelling the confirm writes nothing', () =>
    assert.equal(p.writes.length, 0));

  p.confirmAnswer = true;
  await p.click('withdrawButton');
  await check('withdraw: confirming sets status to withdrawn', () =>
    assert.equal(p.writes[0].payload.status, 'withdrawn'));

  // ================================================ view mode: brand, settled
  for (const [status, heading] of [['accepted', 'Accepted'], ['rejected', 'Declined'], ['withdrawn', 'Withdrawn']]) {
    const s = viewPage(proposalRow({ status }));
    await s.ready;
    await check(`brand, ${status}: the form is locked`, () =>
      assert.equal(s.N.editCard.hidden, true));
    await check(`brand, ${status}: the outcome is stated`, () =>
      assert.equal(s.N.settledHeading.textContent, heading));
  }

  p = viewPage(proposalRow({ status: 'accepted' }));
  await p.ready;
  await check('brand, accepted: a Message link to the thread is offered', () => {
    const link = p.N.settledActions.children[0];
    assert.equal(link.href, 'messages.html?connection=conn-1');
  });

  p = viewPage(proposalRow({ status: 'rejected' }));
  await p.ready;
  await check('brand, rejected: no Message link on a declined proposal', () =>
    assert.equal(p.N.settledActions.children.length, 0));

  p = viewPage(proposalRow({ status: 'proposed' }));
  await p.ready;
  p.setNote('');
  await p.click('changesButton');
  await check('planner: requesting changes without a note is blocked', () =>
    assert.match(p.N.decideMessage.textContent, /brand sees this note/i));
  await check('planner: the blocked request wrote nothing', () =>
    assert.equal(p.writes.length, 0));

  await p.click('rejectButton');
  await check('planner: declining without a note is blocked', () =>
    assert.match(p.N.decideMessage.textContent, /why/i));
  await check('planner: the blocked decline wrote nothing', () =>
    assert.equal(p.writes.length, 0));

  await p.click('acceptButton');
  await check('planner: accepting needs no note', () =>
    assert.equal(p.writes.length, 1));
  await check('planner: accepting writes status accepted', () =>
    assert.equal(p.writes[0].payload.status, 'accepted'));

  p = viewPage(proposalRow({ status: 'proposed' }));
  await p.ready;
  p.setNote('  Please halve the cash and add delivery.  ');
  await p.click('changesButton');
  await check('planner: requesting changes with a note is allowed', () =>
    assert.equal(p.writes[0].payload.status, 'changes_requested'));
  await check('planner: the note is trimmed on the way in', () =>
    assert.equal(p.writes[0].payload.planner_note, 'Please halve the cash and add delivery.'));
  await check('planner: the response is scoped to that one proposal', () =>
    assert.deepEqual(p.writes[0].filters, { id: 'prop-1' }));

  p = viewPage(proposalRow({ status: 'proposed' }), PLANNER);
  await p.ready;
  await check('planner: the decision panel is shown', () =>
    assert.equal(p.N.decideCard.hidden, false));
  await check('planner: the brand never gets the decision buttons', () =>
    assert.equal(p.N.editCard.hidden, true));
  await check('planner: all three decisions are offered', () => {
    assert.equal(p.N.acceptButton.hidden, false);
    assert.equal(p.N.changesButton.hidden, false);
    assert.equal(p.N.rejectButton.hidden, false);
  });

  p = viewPage(proposalRow({ status: 'changes_requested' }), PLANNER);
  await p.ready;
  await check('planner, changes requested: the buttons wait for the brand', () => {
    assert.equal(p.N.acceptButton.hidden, true);
    assert.equal(p.N.changesButton.hidden, true);
    assert.equal(p.N.rejectButton.hidden, true);
  });
  await check('planner, changes requested: the decision panel explains the wait', () => {
    assert.equal(p.N.decideCard.hidden, false);
    assert.match(p.N.decideHint.textContent, /revising/i);
  });
  await check('planner, changes requested: it is not shown as settled', () =>
    assert.equal(p.N.settledCard.hidden, true));

  // ============================================== errors and awkward states
  p = viewPage(null);
  p.data.proposals = { maybeSingle: { data: null, error: null } };
  await p.ready;
  await check('a proposal you cannot see is refused without a raw error', () =>
    assert.match(p.N.fatalBody.textContent, /brand that wrote it/i));

  p = viewPage(proposalRow());
  p.data.proposals = { maybeSingle: { data: null, error: { code: '42P01', message: 'relation "public.proposals" does not exist' } } };
  await p.ready;
  await check('a missing table is explained, not dumped', () =>
    assert.match(p.N.fatalBody.textContent, /supabase-migrations\.sql/));

  p = loadPage('detail', { query: '' });
  await p.ready;
  await check('no id and no connection is a clear dead end', () =>
    assert.match(p.N.fatalBody.textContent, /needs a proposal id/i));

  p = createPage();
  await p.ready;
  p.data.proposals = { any: { data: null, error: { code: '23505', message: 'duplicate key' } } };
  p.type({ cashAmount: '1000' });
  await p.submit();
  await check('a duplicate insert is explained as an existing proposal', () =>
    assert.match(p.N.offerMessage.textContent, /already exists/i));
  await check('a duplicate insert does not navigate away', () =>
    assert.equal(p.redirected, null));

  p = createPage();
  await p.ready;
  p.data.proposals = { any: { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } } };
  p.type({ cashAmount: '1000' });
  await p.submit();
  await check('an RLS refusal does not leak the policy name', () => {
    assert.match(p.N.offerMessage.textContent, /would not allow/i);
    assert.doesNotMatch(p.N.offerMessage.textContent, /row-level security/i);
  });

  p = viewPage(proposalRow({ status: 'proposed' }), PLANNER);
  await p.ready;
  await Promise.all([p.N.acceptButton.click(), p.N.acceptButton.click()]);
  await new Promise((r) => setImmediate(r));
  await check('double-clicking Accept writes once', () =>
    assert.equal(p.writes.length, 1));

  // ================================================== the list page
  let l = loadPage('list', { profile: BRAND });
  l.data.proposals = { many: { data: [proposalRow({ id: 'a' }), proposalRow({ id: 'b', status: 'accepted' })], error: null } };
  l.data.opportunities = { many: { data: [{ id: 'opp-1', title: 'Design Week' }], error: null } };
  await l.ready;
  await new Promise((r) => setImmediate(r));
  await check('list: a brand lists the proposals they sent', () =>
    assert.equal(l.writes.length, 0));
  await check('list: it queries by brand_id, not planner_id', () => {
    const call = l.calls.find((c) => c.table === 'proposals');
    assert.deepEqual(call.filters, { brand_id: 'u1' });
  });
  await check('list: both proposals are rendered', () =>
    assert.equal(l.N.proposalList.children.length, 2));
  await check('list: the count reflects the rows', () =>
    assert.equal(l.N.proposalCount.textContent, '2 proposals'));
  await check('list: the empty state stays hidden', () =>
    assert.equal(l.N.proposalEmpty.hidden, true));

  l = loadPage('list', { profile: PLANNER });
  l.data.proposals = { many: { data: [proposalRow({ id: 'a' })], error: null } };
  await l.ready;
  await new Promise((r) => setImmediate(r));
  await check('list: a planner lists proposals they received', () => {
    const call = l.calls.find((c) => c.table === 'proposals');
    assert.deepEqual(call.filters, { planner_id: 'u1' });
  });

  l = loadPage('list', { profile: BRAND });
  l.data.proposals = { many: { data: [], error: null } };
  await l.ready;
  await new Promise((r) => setImmediate(r));
  await check('list: no proposals shows the empty state, not a blank page', () =>
    assert.equal(l.N.proposalEmpty.hidden, false));
  await check('list: the empty state points at Connections', () =>
    assert.match(l.N.emptyBody.textContent, /accepted connections/i));

  l = loadPage('list', { profile: BRAND });
  l.data.proposals = { many: { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } } };
  await l.ready;
  await new Promise((r) => setImmediate(r));
  await check('list: a missing table names the migration', () =>
    assert.match(l.N.fatalBody.textContent, /supabase-migrations\.sql/));
  await check('list: the empty state is not shown alongside the error', () =>
    assert.equal(l.N.listSection.hidden, true));

  // ------------------------------------------------- entry point (static)
  // app/connections.html is where a brand starts a proposal. It renders two
  // structurally identical row lists, one per role, and they are told apart
  // only by which function they live in -- so a link dropped into the wrong
  // one compiles, passes every other test in this file, and shows a planner a
  // button for a document a planner is forbidden to write. It shipped exactly
  // that way once: the guard was `conn.from_user && conn.from_user.id`, and
  // `from_user` is the *brand* that sent the interest, so it was truthy on
  // every planner row. Assert the two function bodies separately.

  const connectionsHtml = read(resolve(root, 'app/connections.html'));

  // Slice a named top-level function out of the page source, brace-matched.
  const bodyOf = (source, name) => {
    const start = source.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, `connections.html should define ${name}()`);
    return sliceFromBrace(source, start);
  };

  // Slice from `from` up to the end of the block its next `{` opens.
  const sliceFromBrace = (source, from) => {
    let depth = 0;
    for (let i = source.indexOf('{', from); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(from, i + 1);
    }
    throw new Error('unbalanced braces');
  };

  const plannerView = bodyOf(connectionsHtml, 'renderPlannerView');
  const brandView = bodyOf(connectionsHtml, 'renderBrandView');

  await check('connections: the planner view offers no way to write a proposal', () => {
    assert.doesNotMatch(
      plannerView,
      /proposal\.html/,
      'renderPlannerView is the planner side; proposal.html refuses a planner. ' +
        'Use the sidebar for a planner, not a dead button.'
    );
  });
  await check('connections: the brand view links to the proposal form', () =>
    assert.match(brandView, /proposal\.html\?connection=/));
  await check('connections: the brand view offers it on an accepted connection only', () => {
    // The link has to sit inside the accepted branch, or a brand gets a
    // button that the INSERT policy will reject.
    const branch = brandView.match(/if \(conn\.status === "accepted"\)/);
    assert.ok(branch, 'renderBrandView should branch on status === "accepted"');
    const acceptedBody = sliceFromBrace(brandView, branch.index);
    assert.match(acceptedBody, /proposal\.html\?connection=/);
  });
  await check('connections: the page links to the proposal form exactly once', () =>
    assert.equal(
      (connectionsHtml.match(/proposal\.html\?connection=/g) || []).length,
      1,
      'a second entry point means a second copy of this bug'
    ));
  await check('connections: both views can still open the message thread', () => {
    assert.match(plannerView, /messages\.html\?connection=/);
    assert.match(brandView, /messages\.html\?connection=/);
  });

  console.log(out.join('\n'));
  const failed = out.filter((x) => x.startsWith('  FAIL')).length;
  console.log(`\n${failed ? failed + ' FAILED' : 'all ' + out.length + ' checks passed'}`);
  process.exit(failed ? 1 : 0);
})();
