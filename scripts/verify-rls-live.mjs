// Live RLS + state-machine checks against the REAL database.
//
//   node scripts/verify-rls-live.mjs            read-only preflight, safe
//   node scripts/verify-rls-live.mjs --full     also writes, then cleans up
//   node scripts/verify-rls-live.mjs --cleanup  remove leftovers from a crash
//
// ============================================================
// WHY THIS EXISTS
// ============================================================
// Every other suite in this project runs the page's own JavaScript
// against a fake DOM and a fake Supabase client. That proves the
// gating and validation logic. It proves NOTHING about RLS.
//
// The reason is structural, and it is worth stating plainly: the UI
// already hides the cases the rules are meant to block. A page looks
// correct whether or not the policy exists in the database. So a
// green browser test and a completely missing row-level security
// setup are indistinguishable from the outside.
//
// The only thing that separates them is a real signed-in session
// against the real database, asserting that a write which SHOULD be
// refused actually is. That is what this file does. It signs up
// throwaway accounts through the real auth API, gets real JWTs, and
// lets PostgREST enforce the policies.
//
// ============================================================
// THIS WRITES TO THE REAL DATABASE IN --full
// ============================================================
// It creates up to three accounts, one event, three opportunities,
// three connections and two proposals, then deletes all three
// accounts with public.delete_account() -- which is itself one of
// the things under test. Emails use the reserved .invalid TLD, so no
// message can ever be delivered to a stranger.
//
// If it crashes, leftovers are named linkzyfy-rls-* and are safe to
// delete from the Supabase dashboard. Preflight writes nothing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv.slice(2).find((a) => !a.startsWith('-')) || '.');
const FULL = process.argv.includes('--full');
const CLEANUP = process.argv.includes('--cleanup');

// ------------------------------------------- config, from the one source
// js/supabase.js is the only place the URL and the anon key live.
// Duplicating the key here would create a second copy to keep in
// sync, and a second copy to accidentally commit.
function readConfig() {
  const src = readFileSync(resolve(root, 'js/supabase.js'), 'utf8');
  const url = src.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const key = src.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
  if (!url || !key) throw new Error('could not read SUPABASE_URL / SUPABASE_ANON_KEY from js/supabase.js');
  if (/service_role|secret/i.test(key)) throw new Error('that is not an anon key. Refusing to run.');
  return { url, key };
}
const { url, key } = readConfig();

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL  ' + m); };
const pass = (m) => console.log('  ok    ' + m);
const info = (m) => console.log('  --    ' + m);

// ------------------------------------------------------------------ http
async function call(path, { method = 'GET', token, body, prefer, raw } = {}) {
  const headers = { apikey: key, Authorization: 'Bearer ' + (token || key) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text, code: json?.code || '' };
}

const rest = (table, opts = {}) =>
  call('/rest/v1/' + table + (opts.query ? '?' + opts.query : ''), {
    prefer: 'return=representation',
    ...opts,
  });

// An RLS UPDATE that is not permitted does NOT return an error. The
// USING clause matches no row, so PostgREST replies 200 with [].
// Asserting on the error code alone would make every one of these
// checks pass vacuously -- which is the exact failure mode this file
// exists to avoid.
const rows = (r) => (Array.isArray(r.json) ? r.json : []);

async function refuses(label, fn) {
  const r = await fn();
  const deniedByRowCount = r.status === 200 && rows(r).length === 0;
  const deniedByError = r.status >= 400;
  if (deniedByRowCount || deniedByError) {
    pass(label);
    return true;
  }
  fail(`${label} -- IT WAS ALLOWED (status ${r.status}, ${rows(r).length} row(s) returned)`);
  return false;
}

async function allows(label, fn, expect = 1) {
  const r = await fn();
  if (r.status < 400 && rows(r).length === expect) { pass(label); return rows(r)[0]; }
  fail(`${label} -- expected ${expect} row(s), got status ${r.status} ${r.text.slice(0, 160)}`);
  return null;
}

// =====================================================================
// PREFLIGHT -- read only, nothing is written
// =====================================================================
console.log('\n=== preflight (read only) ===');

for (const t of ['users', 'events', 'opportunities', 'connections', 'messages', 'proposals']) {
  const r = await call(`/rest/v1/${t}?select=id`);
  const empty = r.status === 200 && Array.isArray(r.json) && r.json.length === 0;
  empty
    ? pass(`anon read ${t} -> 200 []  (RLS is live, table exists)`)
    : fail(`anon read ${t} -> ${r.status} ${r.text.slice(0, 120)}  (expected 200 [])`);
}

const del = await call('/rest/v1/rpc/delete_account', { method: 'POST', body: {} });
del.status === 401
  ? pass('delete_account as anon -> 401  (exists, and not granted to anon)')
  : fail(`delete_account as anon -> ${del.status}  (expected 401; a 404 means the function is missing)`);

const ghost = await call('/rest/v1/rpc/nonexistent_fn_xyz', { method: 'POST', body: {} });
ghost.status === 404
  ? pass('nonexistent_fn_xyz as anon -> 404  (the control: a missing fn is 404, not 401)')
  : fail(`control failed: expected 404, got ${ghost.status}. The 401 above proves nothing without it.`);

if (!FULL && !CLEANUP) {
  console.log('\npreflight only. Nothing was written.');
  console.log('  --full     sign up throwaway accounts and test the policies for real');
  console.log('  --cleanup  remove leftovers from an interrupted run');
  console.log();
  process.exit(failures ? 1 : 0);
}

const FULL_RUN_HEADER = '\n=== live session tests (this writes to the real database) ===';

const stamp = Date.now();
const PASSWORD = 'LinkzyfyRlsProbe-2026';
// The local part is keyed on the LABEL, never on the role. Two of the
// three accounts are brands, and keying on the role handed them the
// same address -- so the "unrelated outsider" was silently the same
// account as the main brand, and every isolation check below it was
// comparing a user against themselves. The label is what makes them
// distinct accounts.
//
// The name is the local part ON PURPOSE. The users table has no email
// column and every signed-in user may read every profile, so a test
// account is findable by name alone, which is what --cleanup needs.
const acct = (label) => ({
  email: `linkzyfy-rls-${label}-${stamp}@linkzyfy-test.invalid`,
  password: PASSWORD,
});

async function signUp(label, role) {
  const a = acct(label);
  const local = a.email.split('@')[0];
  const r = await call('/auth/v1/signup', {
    method: 'POST',
    body: { email: a.email, password: a.password, data: { name: local, role } },
  });
  if (r.status >= 400) {
    fail(`signup ${label} (${role}) -> ${r.status} ${r.text.slice(0, 200)}   [tried ${a.email}]`);
    return null;
  }
  const token = r.json?.access_token;
  if (!token) {
    info(`signup ${label} created the account but returned NO session.`);
    info('That means "Confirm email" is ON in the dashboard. These tests');
    info('need a real session. Turn it off (Auth -> Sign In / Providers ->');
    info('Email -> untick "Confirm email") and run this again.');
    console.log('\nSTOPPING before any writes. Delete the pending account with --cleanup.');
    process.exit(2);
  }
  return { token, id: r.json.user.id, email: a.email, role, label };
}

// =====================================================================
// CLEANUP -- remove leftovers from an interrupted run
// =====================================================================
// A crashed run leaves accounts behind. Because every signed-in user
// may read every profile (that is deliberate -- Discover shows other
// people's names), a leftover test account is visible to real users as
// a fake brand. So it is not harmless junk.
//
// The catch is that delete_account() is scoped to auth.uid(), so this
// cannot delete somebody else's account by id. It has to SIGN IN as
// each leftover, which is only possible because the local part of the
// email is the profile name, set in signUp() above.
if (CLEANUP) {
  console.log('\n=== cleanup of leftover test accounts ===');

  const aud = await signUp('auditor', 'brand');
  if (!aud) { console.log('\ncould not create the auditor account. Stopping.'); process.exit(2); }

  const everyone = await rest('users', { query: 'select=id,name,role', token: aud.token });
  // `linkup-rls-` is matched alongside the current prefix on purpose:
  // this file was renamed, but probe accounts created before the rename
  // are still sitting in the live database under the old name and the
  // old @linkup-test.invalid domain. Dropping the old pattern would
  // strand them permanently.
  const leftovers = rows(everyone).filter((u) => /^(linkzyfy-rls-|linkup-rls-|probe-)/.test(u.name || ''));

  if (!leftovers.length) {
    info('no leftover test accounts found');
  } else {
    for (const u of leftovers) {
      if (u.id === aud.id) continue; // the auditor removes itself below
      let removed = false;
      for (const domain of ['linkzyfy-test.invalid', 'linkup-test.invalid']) {
        if (removed) break;
        const email = `${u.name}@${domain}`;
        const s = await call('/auth/v1/token?grant_type=password', {
          method: 'POST', body: { email, password: PASSWORD },
        });
        if (s.status >= 400) continue; // wrong domain, or gone already
        const d = await call('/rest/v1/rpc/delete_account', { method: 'POST', token: s.json.access_token, body: {} });
        if (d.status < 400) {
          pass(`removed leftover ${email}`);
          removed = true;
        } else {
          fail(`could not delete leftover ${email} -> ${d.status} ${d.text.slice(0, 200)}`);
          removed = true;
        }
      }
      if (!removed) fail(`could not sign in as leftover ${u.name} on either test domain`);
    }
  }

  const self = await call('/rest/v1/rpc/delete_account', { method: 'POST', token: aud.token, body: {} });
  self.status < 400
    ? pass('removed the auditor account')
    : fail(`could not remove the auditor -> ${self.status} ${self.text.slice(0, 160)}`);

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nPASS - no leftover test accounts\n');
  process.exit(failures ? 1 : 0);
}

// =====================================================================
// FULL RUN -- writes, then cleans up
// =====================================================================
console.log(FULL_RUN_HEADER);

const A = await signUp('brand', 'brand');       // the brand making the offer
const P = await signUp('planner', 'event_planner'); // the planner reviewing it
const B = await signUp('outsider', 'brand');   // a second brand, in no connection
if (!A || !P || !B) {
  console.log('\nCould not create the three accounts. Stopping.');
  console.log('Any that were created are named linkzyfy-rls-* and can be removed with --cleanup.');
  process.exit(2);
}
if (A.id === B.id || A.email === B.email) {
  fail('the brand and the outsider are the SAME account -- every isolation check below is void');
  process.exit(2);
}
info(`created ${A.email} / ${P.email} / ${B.email}`);

// -- the trigger made the profiles, with the right roles
for (const who of [A, P, B]) {
  const me = await allows(`trigger created a ${who.role} profile`, () =>
    rest('users', { query: 'id=eq.' + who.id + '&select=id,role', token: who.token }));
  if (me && me.role !== who.role) fail(`  ${who.email} has role "${me.role}", expected "${who.role}"`);
}

// ------------------------------------------------- the positive path
const ev = await allows('planner can publish an event', () =>
  rest('events', {
    method: 'POST', token: P.token,
    body: { name: 'Rls Probe Event ' + stamp, organizer_id: P.id, location: 'Test City' },
  }));

const opp = async (n) => rest('opportunities', {
  method: 'POST', token: P.token,
  body: { title: `Rls Probe Opportunity ${n} ${stamp}`, event_id: ev.id, organizer_id: P.id },
});
const opp1 = await allows('planner can publish an opportunity', () => opp(1));
const opp2 = await allows('planner can publish a second opportunity', () => opp(2));
const opp3 = await allows('planner can publish a third opportunity', () => opp(3));

await allows('a brand can read an open opportunity', () =>
  rest('opportunities', { query: 'id=eq.' + opp1.id + '&select=id', token: A.token }));

const conn = async (brand, oppRow, to = P.id) => rest('connections', {
  method: 'POST', token: brand.token,
  body: { from_user: brand.id, to_user: to, opportunity_id: oppRow.id },
});
const conn1 = await allows('brand can send interest', () => conn(A, opp1));
const conn2 = await allows('brand can send interest on a second opportunity', () => conn(A, opp2));
const conn3 = await allows('brand can send interest on a third opportunity', () => conn(A, opp3));

await allows('planner can accept the interest', () =>
  rest('connections', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + conn1.id,
    body: { status: 'accepted' },
  }));
await allows('planner can accept the second interest', () =>
  rest('connections', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + conn3.id,
    body: { status: 'accepted' },
  }));

// conn2 is left PENDING on purpose -- the proposal-insert policy
// requires an accepted connection.

const prop = await allows('brand can send a proposal on an accepted connection', () =>
  rest('proposals', {
    method: 'POST', token: A.token,
    body: {
      connection_id: conn1.id, brand_id: A.id, planner_id: P.id,
      cash_amount: 50000, product_qty: 200, product_notes: 'Probe units',
      activation_idea: 'Probe activation', promotion_plan: 'Probe plan', deliverables: 'Probe deliverables',
    },
  }));

// ------------------------------------------------- RLS: refused writes
console.log('\n--- must be refused by RLS ---');

await refuses('a brand cannot publish an event', () =>
  rest('events', { method: 'POST', token: A.token, body: { name: 'Should not exist ' + stamp, organizer_id: A.id } }));

await allows('CONTROL: the same insert by a planner succeeds (so the rule is the role, not a broken table)', () =>
  rest('events', { method: 'POST', token: P.token, body: { name: 'Rls Control Event ' + stamp, organizer_id: P.id } }));

await refuses('a brand cannot update another profile', () =>
  rest('users', { method: 'PATCH', token: A.token, query: 'id=eq.' + P.id, body: { name: 'Hijacked' } }));

await refuses('a brand cannot repoint their own event organizer_id', () =>
  rest('events', { method: 'PATCH', token: A.token, query: 'id=eq.' + ev.id + '&organizer_id=eq.' + P.id, body: { organizer_id: A.id } }));

await refuses('an unrelated signed-in user cannot read the proposal', () =>
  rest('proposals', { query: 'id=eq.' + prop.id, token: B.token }));

await refuses('a planner cannot send a proposal', () =>
  rest('proposals', {
    method: 'POST', token: P.token,
    body: { connection_id: conn2.id, brand_id: P.id, planner_id: A.id, cash_amount: 1 },
  }));

await refuses('a proposal cannot be made on a PENDING connection', () =>
  rest('proposals', {
    method: 'POST', token: A.token,
    body: { connection_id: conn2.id, brand_id: A.id, planner_id: P.id, cash_amount: 1 },
  }));

await refuses('a planner cannot send interest (wrong direction)', () =>
  rest('connections', {
    method: 'POST', token: P.token,
    body: { from_user: P.id, to_user: A.id, opportunity_id: opp1.id },
  }));

await refuses('interest cannot name a planner who does not own the opportunity', () =>
  rest('connections', {
    method: 'POST', token: A.token,
    body: { from_user: A.id, to_user: B.id, opportunity_id: opp1.id },
  }));

// ------------------------------------------- connections: forged consent
// "Brands can send proposals" only requires that the connection be
// accepted, so ANY route a brand has to `accepted` is a route to filing
// a proposal the planner never agreed to. There used to be two: the
// INSERT policy never checked `status`, and the UPDATE policy let
// either party write any status on a row they were already party to.
//
// Every refused INSERT below uses a fresh opportunity. `refuses()`
// accepts any 4xx, so hitting the unique index (23505) instead of RLS
// would pass vacuously -- the exact failure this file exists to avoid.
const opp4 = await allows('planner can publish a fourth opportunity', () => opp(4));

await refuses('a brand cannot INSERT a connection already marked accepted', () =>
  rest('connections', {
    method: 'POST', token: A.token,
    body: { from_user: A.id, to_user: P.id, opportunity_id: opp4.id, status: 'accepted' },
  }));

const conn4 = await allows('CONTROL: the same insert with status pending succeeds (so the rule is the status, not a broken table)', () =>
  rest('connections', {
    method: 'POST', token: A.token,
    body: { from_user: A.id, to_user: P.id, opportunity_id: opp4.id, status: 'pending' },
  }));

await refuses('a brand cannot UPDATE their own pending connection to accepted', () =>
  rest('connections', {
    method: 'PATCH', token: A.token, query: 'id=eq.' + conn2.id, body: { status: 'accepted' },
  }));

await refuses('a brand cannot mark their own connection rejected', () =>
  rest('connections', {
    method: 'PATCH', token: A.token, query: 'id=eq.' + conn2.id, body: { status: 'rejected' },
  }));

// The control that makes the two refusals above mean something. This is
// the accept that later tests reuse.
await allows('CONTROL: the planner can accept that same connection', () =>
  rest('connections', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + conn2.id, body: { status: 'accepted' },
  }));

await allows('CONTROL: the planner can reject the fourth interest', () =>
  rest('connections', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + conn4.id, body: { status: 'rejected' },
  }));

await refuses('rejected is final: the planner cannot reopen it as accepted', () =>
  rest('connections', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + conn4.id, body: { status: 'accepted' },
  }));

await refuses('rejected is final: the brand cannot reopen it either', () =>
  rest('connections', {
    method: 'PATCH', token: A.token, query: 'id=eq.' + conn4.id, body: { status: 'accepted' },
  }));

// A brand's one permitted write is withdrawing its own interest. The UI
// does not offer this yet, so nothing would catch this regressing.
await allows('CONTROL: a brand can archive their own interest', () =>
  rest('connections', {
    method: 'PATCH', token: A.token, query: 'id=eq.' + conn4.id, body: { status: 'archived' },
  }));

const dup = await call('/rest/v1/connections', {
  method: 'POST', token: A.token, prefer: 'return=representation',
  body: { from_user: A.id, to_user: P.id, opportunity_id: opp1.id },
});
dup.code === '23505'
  ? pass('duplicate interest is blocked by the unique index (23505)')
  : fail(`duplicate interest returned ${dup.status} ${dup.code || dup.text.slice(0, 120)} (expected 23505)`);

const dupProp = await call('/rest/v1/proposals', {
  method: 'POST', token: A.token, prefer: 'return=representation',
  body: { connection_id: conn1.id, brand_id: A.id, planner_id: P.id, cash_amount: 1 },
});
dupProp.code === '23505'
  ? pass('a second proposal on the same connection is blocked (23505)')
  : fail(`second proposal returned ${dupProp.status} ${dupProp.code || dupProp.text.slice(0, 120)} (expected 23505)`);

// ------------------------------------------------- the state machine
console.log('\n--- must be refused by proposals_state_guard() ---');

await refuses('a planner cannot rewrite the cash amount', () =>
  rest('proposals', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + prop.id,
    body: { cash_amount: 999999 },
  }));

// The planner's WITH CHECK only allows changes_requested / accepted /
// rejected, so a note can only be written as part of a decision. That
// is deliberate: it stops a planner from annotating a proposal while
// leaving it sitting in 'proposed'. app/proposal.html always sends
// { status, planner_note } together, so the app never trips this.
await refuses('a planner cannot write a note alone and leave the status at proposed', () =>
  rest('proposals', {
    method: 'PATCH', token: P.token, query: 'id=eq.' + prop.id,
    body: { planner_note: 'Probe: a note with no decision attached' },
  }));

await refuses('a brand cannot rewrite the planner note', () =>
  rest('proposals', {
    method: 'PATCH', token: A.token, query: 'id=eq.' + prop.id,
    body: { planner_note: 'Probe: forged note' },
  }));

await refuses('a brand cannot accept their own proposal', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop.id, body: { status: 'accepted' } }));

await refuses('a brand cannot mark changes_requested', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop.id, body: { status: 'changes_requested' } }));

await refuses('a brand cannot repoint the two parties', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop.id, body: { brand_id: B.id } }));

await refuses('an outsider cannot change the status', () =>
  rest('proposals', { method: 'PATCH', token: B.token, query: 'id=eq.' + prop.id, body: { status: 'rejected' } }));

await allows('CONTROL: the brand can withdraw their own proposal', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop.id, body: { status: 'withdrawn' } }));

await refuses('withdrawn is final and cannot go back to proposed', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop.id, body: { status: 'proposed' } }));

// a second proposal, to reach `accepted` and prove it is final too
const prop2 = await allows('brand sends a second proposal on another accepted connection', () =>
  rest('proposals', {
    method: 'POST', token: A.token,
    body: { connection_id: conn3.id, brand_id: A.id, planner_id: P.id, cash_amount: 1000 },
  }));

await allows('CONTROL: the planner can accept it', () =>
  rest('proposals', { method: 'PATCH', token: P.token, query: 'id=eq.' + prop2.id, body: { status: 'accepted' } }));

await refuses('accepted is final and cannot be reopened as proposed', () =>
  rest('proposals', { method: 'PATCH', token: P.token, query: 'id=eq.' + prop2.id, body: { status: 'proposed' } }));

await refuses('accepted cannot be changed to changes_requested', () =>
  rest('proposals', { method: 'PATCH', token: P.token, query: 'id=eq.' + prop2.id, body: { status: 'changes_requested' } }));

// changes_requested -> proposed is the one legal way back, for the brand.
// conn2 was already accepted by the CONTROL in the connections section.
const prop3 = await allows('brand sends a third proposal', () =>
  rest('proposals', {
    method: 'POST', token: A.token,
    body: { connection_id: conn2.id, brand_id: A.id, planner_id: P.id, cash_amount: 2000 },
  }));
await allows('CONTROL: the planner can request changes', () =>
  rest('proposals', { method: 'PATCH', token: P.token, query: 'id=eq.' + prop3.id, body: { status: 'changes_requested', planner_note: 'Probe: adjust' } }));
await allows('CONTROL: the brand can then resubmit as proposed', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop3.id, body: { status: 'proposed' } }));
await refuses('a brand cannot skip straight from proposed to accepted', () =>
  rest('proposals', { method: 'PATCH', token: A.token, query: 'id=eq.' + prop3.id, body: { status: 'accepted' } }));

// ------------------------------------------------- account deletion
console.log('\n--- delete_account() with real data attached ---');

for (const who of [A, P, B]) {
  const r = await call('/rest/v1/rpc/delete_account', { method: 'POST', token: who.token, body: {} });
  r.status < 400
    ? pass(`delete_account() succeeded for the ${who.role} (had proposals, connections, profile)`)
    : fail(`delete_account() for the ${who.role} -> ${r.status} ${r.text.slice(0, 200)}`);
}

// The strongest available proof the auth row is gone: if it still
// existed, this sign-in would succeed.
for (const who of [A, P, B]) {
  const r = await call('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: who.email, password: PASSWORD },
  });
  r.status >= 400
    ? pass(`sign-in as the deleted ${who.role} is refused (${r.status}) -- auth.users row is gone`)
    : fail(`sign-in as the deleted ${who.role} STILL SUCCEEDED. The account was not really deleted.`);
}

const after = await call('/rest/v1/proposals?select=id');
Array.isArray(after.json) && after.json.length === 0
  ? pass('no leftover proposals')
  : fail(`${after.json.length} proposal row(s) survived the deletions`);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nPASS - live RLS and state machine behave\n');
process.exit(failures ? 1 : 0);
