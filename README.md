# LinkUp

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
Real authentication (PocketBase)
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
Proposal
  ↓
Partnership
```

## Tech stack

- **Frontend:** HTML, CSS, JavaScript (no frameworks)
- **Auth + Database:** Supabase (PostgreSQL, fully serverless-compatible)
- **Future possibility:** Python + Flask only if server-side logic is truly needed

## Project structure

```
LinkUp/
├── index.html            Landing page (public)
├── auth/
│   ├── login.html        Login page
│   └── signup.html       Create account / signup (role selection)
├── app/
│   ├── dashboard.html    Main private app area (role-based)
│   ├── profile.html      Profile page (loads the real logged-in user)
│   ├── discover.html     Discover page — live events (Phase 5 MVP)
│   ├── opportunities.html Opportunities list (role-aware)
│   ├── connections.html  Placeholder (Phase 6)
│   ├── messages.html     Placeholder (Phase 6)
│   └── partnerships.html Placeholder (Phase 6)
├── css/
│   └── style.css         Global styles (Butter + Ink design system)
├── js/
│   ├── script.js         Shared UI motion (reveals, tilt, parallax)
│   ├── supabase.js       Shared Supabase client config
│   └── auth-guard.js     Shared session guard (`requireSession()` / `getInitials()`)
├── supabase-schema.sql   SQL file to initialize the Supabase database
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

- ✅ Real Supabase signup (creates an `auth.users` record and a public `users` profile)
- ✅ Real Supabase login (redirects to dashboard)
- ✅ Role selection stored as `brand` / `event_planner`
- ✅ Dashboard + profile render the real logged-in user's data
- ✅ Landing page CTAs navigate correctly (no dead links in header/hero/CTA/footer)
- ✅ Row Level Security applied to all database tables
- ✅ Marketplace tables created and live (`events`, `opportunities`, `connections`)

## How to run (Local Development) & Deploy (24/7 Hosting for Vercel)

Because this app uses a static frontend, it is extremely easy to host on platforms like Vercel. However, since Vercel is serverless, we use **Supabase** for our database because it integrates perfectly, is available 24/7, and has a great free tier.

**Please see [`SUPABASE_SETUP_GUIDE.md`](./SUPABASE_SETUP_GUIDE.md) for a step-by-step guide on how to easily set up your free Supabase database (no credit card required), initialize the tables, and connect it to your app.**

Once your `js/supabase.js` file is configured with your Supabase URL and Key, you can run the app locally using any static server (e.g., VS Code Live Server) and open `index.html`.
The exact same setup works instantly in production on Vercel!

The dashboard / profile areas require a logged-in session (sign up first).

## Security rules (always)

- The frontend only talks to Supabase using the `anon` public API key — **never** use your `service_role` key in frontend code.
- Data privacy is enforced securely on the database level via PostgreSQL Row Level Security (RLS) policies.