# LinkUp [Vibecoded cuz ts a school proj and i hate my school :D]

> **A structured marketplace and network for brand–event partnerships and collaborations.**

LinkUp connects **brands** with **event organizers** (and, eventually, creators, communities and service providers) so both sides can discover each other, connect, propose partnerships, and manage collaborations — instead of hunting for sponsors or events through scattered channels.

## What LinkUp is trying to solve

| Side | Needs |
| --- | --- |
| **Brands** | Sponsorship opportunities, events to promote products, relevant audiences, product activations, brand partnerships, collaborators |
| **Event Planners** | Sponsors, brands, products, services, promotional support, vendors, collaborators, partnership opportunities |

## Demo flow (the vertical we are building)

```
Landing page
  ↓
Signup  (role selection: Brand / Event Planner)
  ↓
Real authentication (Supabase Auth)
  ↓
Dashboard  (renders based on the logged-in role)
  ↓
Profile
  ↓
Discover
  ↓
Opportunity
  ↓
Connection
  ↓
Proposal      (planned)
  ↓
Partnership   (planned)
```

## Tech stack

- **Frontend:** HTML, CSS, JavaScript (no frameworks)
- **Auth + Database:** Supabase (PostgreSQL, fully serverless-compatible)
- **Future possibility:** Python + Flask only if server-side logic is truly needed

## Project structure

```
LinkUp/
├── index.html            Landing page (public)
├── legal.html            Privacy & Terms (public)
├── auth/
│   ├── login.html             Login page
│   ├── signup.html            Create account / signup (role selection)
│   ├── forgot-password.html   Request a password reset email
│   └── reset-password.html    Set a new password (from the email link)
├── app/
│   ├── dashboard.html    Main private app area (role-based)
│   ├── discover.html     Discover page — live events, opportunities, brands
│   ├── opportunities.html Opportunities list (role-aware)
│   ├── opportunity.html  Opportunity detail + "I'm interested"
│   ├── connections.html  Sent / received interest (accept & decline)
│   ├── profile.html      Profile page (loads the real logged-in user)
│   ├── messages.html     Inbox — threads per accepted connection
│   └── partnerships.html Placeholder (Phase 6)
├── css/
│   └── style.css         Global styles (Butter + Ink design system)
├── js/
│   ├── script.js         Shared UI motion (reveals, tilt, parallax)
│   ├── supabase.js       Shared Supabase client config
│   ├── auth-guard.js     Shared session guard (`requireSession()` / `getInitials()`)
│   └── utils.js          Shared helpers (error text, dates, status labels)
├── scripts/
│   └── serve.mjs         Zero-dependency local static server
├── .vscode/              Shared "serve + open LinkUp" debug config
├── favicon.svg           Site mark
├── supabase-schema.sql   Full schema — for a BRAND NEW database
└── supabase-migrations.sql
                          In-place upgrade — run this on the LIVE database
```

> Public pages live at the project root and under `auth/`; private app pages
> under `app/`. `signup.html` is the SIGNUP page; `login.html` is the LOGIN page.
> All HTML pages load shared assets with relative paths (`css/style.css`,
> `js/script.js`, ... — `../css/*` and `../js/*` from `auth/` and `app/`).

## Design language

Warm editorial marketplace — **butter paper** (`#FFEFB3`) with **deep green ink**
(`#013E37`), hairline rules, script accents (Leckerli One) and Instrument Sans.
No gradients, no glassmorphism. Scroll reveals, gentle pointer tilt and parallax
are driven by `script.js` (`data-reveal`, `data-tilt`, `data-parallax`).

## Current capabilities

- ✅ Real Supabase signup (creates an `auth.users` record; the database
      trigger creates the matching `users` profile, and the browser
      self-heals a profile if the trigger is ever missing)
- ✅ Real Supabase login (redirects to dashboard)
- ✅ Password recovery — `forgot-password.html` emails a link,
      `reset-password.html` sets the new password
- ✅ Role selection stored as `brand` / `event_planner`
- ✅ Dashboard + profile render the real logged-in user's data
- ✅ Event planners can publish events and opportunities from Discover
- ✅ Brands can send interest on an **open** opportunity; planners can
      accept or decline
- ✅ Event planners get a brands directory on Discover
- ✅ Landing page CTAs navigate correctly (no dead links in header/hero/CTA/footer)
- ✅ Row Level Security policies are defined for all tables, with the
      brand → planner direction and the opportunity/organizer link
      enforced in the database, not just in the UI
      *(these live in the SQL files — they must be applied to your
      database before they take effect, see below)*
- ✅ `updated_at` maintained by trigger; duplicate interest blocked by a
      unique index that also covers rows with no `opportunity_id`
- ✅ Messaging — one thread per **accepted** connection, unread badges,
      and mark-as-read. The `messages` table is created by
      `supabase-migrations.sql`, so the Messages page reports that it is
      not set up until that file has been run. RLS limits every thread to
      the two people on that connection, requires the connection to be
      accepted before anything can be sent, and a trigger makes the
      message body immutable after sending (only `read_at` can change)
- ⏳ `partnerships.html` is still a placeholder
- ⏳ Notifications are not implemented; the bell is shown disabled

## Setting up the database

**Already have a database?** Run [`supabase-migrations.sql`](./supabase-migrations.sql)
once in the Supabase **SQL Editor**, as a single block — the statements are
order-dependent. It is safe to run twice.

> ⚠️ **The RLS rules described above are inert until you run this.** They exist
> only as SQL in this repo. On a database that has never had the migration
> applied, `public.users` is still readable by anonymous visitors via the old
> `USING (true)` policy. To check your own database, send a request with just
> the anon key and no login:
>
> ```bash
> curl -i "https://<project-ref>.supabase.co/rest/v1/users?select=id,name"
> ```
>
> A `200` with rows means the migration has not been applied.

It creates the `handle_new_user()` trigger that signup depends on, adds the
missing `connections` and UPDATE/DELETE policies, creates the `messages`
table used by the Messages page, and replaces the old "anyone can read
every profile" policy.

**Starting fresh?** Run [`supabase-schema.sql`](./supabase-schema.sql) instead.

Either way, also check **Authentication → Sign In / Providers → Email** and
untick **Confirm email** so new accounts can sign in immediately.

### Required for password reset

Password recovery only works if the reset page is allow-listed, because
Supabase ignores any `redirectTo` that is not registered. In the Supabase
dashboard go to **Authentication → URL Configuration → Redirect URLs** and add:

| Environment | Value to add |
| --- | --- |
| Local | `http://localhost:8080/auth/reset-password.html` |
| Production | `https://<your-domain>/auth/reset-password.html` |

Set **Site URL** to your production origin as well — it is the fallback used
for email confirmations.

## How to run (Local Development) & Deploy (24/7 Hosting for Vercel)

Because this app uses a static frontend, it is extremely easy to host on platforms like Vercel. However, since Vercel is serverless, we use **Supabase** for our database because it integrates perfectly, is available 24/7, and has a great free tier.

**Please see [`SUPABASE_SETUP_GUIDE.md`](./SUPABASE_SETUP_GUIDE.md) for a step-by-step guide on how to easily set up your free Supabase database (no credit card required), initialize the tables, and connect it to your app.**

Once your `js/supabase.js` file is configured with your Supabase URL and Key,
you can run it locally. The project ships a dependency-free static server, so
nothing needs installing:

```bash
node scripts/serve.mjs        # http://localhost:8080
```

In VS Code you can also just press **F5** and pick "Serve + open LinkUp" — it
starts that same server and opens Chrome for you.

Any other static server works too (e.g. VS Code Live Server). The exact same
setup works instantly in production on Vercel. The dashboard / profile areas
require a logged-in session (sign up first).

## Security rules (always)

- The frontend only talks to Supabase using the `anon` public API key — **never** use your `service_role` key in frontend code.
- Data privacy is enforced securely on the database level via PostgreSQL Row Level Security (RLS) policies.
- The Supabase JS SDK is loaded from a **pinned** CDN version with a
  Subresource Integrity hash, so a compromised or silently-updated CDN copy
  cannot execute in your pages.