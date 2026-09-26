# AGENTS.md — working on LinkUp

Read this first, then [`ROADMAP.md`](./ROADMAP.md) for current state and
[`todos.md`](./todos.md) for the outstanding checklist.

> Both of those are **gitignored** — they are private working notes, not
> project documentation. If you are on a fresh clone and they are missing,
> ask for them; do not assume the project has no notes.

## What this is

A marketplace connecting **brands** with **event planners** so they can
discover each other and propose partnerships. Two account types, stored
in `users.role`: `brand` and `event_planner`.

Backend is Supabase (PostgreSQL + Auth + RLS). The frontend is plain
HTML, CSS and JavaScript with **no framework and no build step**.

## Run it

```bash
node scripts/serve.mjs      # http://localhost:8080
```

Pressing F5 in VS Code does the same thing. There is no `npm install`
and there is no `package.json` — that is intentional.

## Verify before you claim something works

```bash
node scripts/verify.mjs                    # site-wide static checks
node scripts/verify-delete-account.cjs      # deletion flow behaviour
```

`verify.mjs` checks that internal links resolve, inline scripts parse,
`getElementById` targets exist, ids are unique, CSS variables all
resolve, and no privileged key is in browser-served code.

**Neither script can prove an RLS rule works.** The UI already hides the
cases the rules are supposed to block, so a green browser test looks
identical whether or not the policy exists in the database. Only a real
signed-in session against the real database proves that.

## Hard rules

1. **Never commit `service_role`, a secret key, or the database password.**
   The anon key in `js/supabase.js` is public *by design* — that is what
   it is for. Anything else must never reach the browser.
2. **Never disable RLS** to make something easier.
3. **No frameworks** unless explicitly asked. No build step, no
   dependencies.
4. **No fake data presented as real.** No invented match percentages, no
   fake testimonials, no dead CTAs. A visible "Coming soon" is better
   than a button that lies. A `disabled` bell with a tooltip is better
   than one that silently does nothing.
5. **A few fully working features beat many fake buttons.**
6. **Smallest logical change.** Do not rewrite working files to make room
   for a new one.
7. **Explain before changing anything structural.**

## Things that will bite you

**No foreign key onto `public.users` has `ON DELETE CASCADE`** — not
`events.organizer_id`, `opportunities.organizer_id`,
`connections.from_user` / `to_user`, or `messages.sender_id`. Any code
that removes a user must delete children first, in this order:

```
messages -> connections -> opportunities -> events -> users -> auth.users
```

(`opportunities.event_id` and `messages.connection_id` *do* cascade.)

**`auth.users` cannot be deleted from the browser.** It is owned by
`supabase_auth_admin` and the `authenticated` role has no `DELETE` on it.
The only route is `public.delete_account()`, a `SECURITY DEFINER`
function scoped to `auth.uid()`. That function is the entire security
boundary, so keep it that way — never accept a user id as a parameter.

**Every `SECURITY DEFINER` function needs `set search_path = ''`** and
fully-qualified names. With a non-empty path, anyone who can create
objects in a schema on that path can shadow a name used inside the
function body and run code as the owner. Postgres grants `EXECUTE` to
`PUBLIC` by default, so every such function also needs an explicit
`REVOKE ... FROM public, anon` and a `GRANT` to `authenticated`.

**SQL and JS drift apart silently, and that is how the login-loop bug
happened.** When you change a table, a column, or a policy name, grep
for it in the HTML too. The two files `supabase-schema.sql` (fresh
installs) and `supabase-migrations.sql` (in-place upgrade) must stay in
sync — change one, change the other.

**The Supabase SDK is pinned to an exact version with a sha384 SRI
hash.** Do not un-pin it to `@2`. A floating version means a silent CDN
update can change what runs in these pages, and a stale hash silently
blocks the script from loading entirely.

**`legal.html` documents what the code actually does**, including the
tables and the RLS rules. Re-read it if the schema changes.

## Database changes

`supabase-migrations.sql` is written to be re-runnable: every statement
drops and recreates itself, or uses `IF EXISTS` / `IF NOT NULL` /
`OR REPLACE`. It must be pasted into the Supabase SQL Editor **as a
single block** — the statements are order-dependent, and the
`SET NOT NULL` depends on the backfill that runs before it.

A failure partway through still leaves the earlier statements applied,
which is safe: fix the error and run the whole file again.

`supabase-schema.sql` is only for brand-new projects. Running it against
a database that already has the tables will fail.
