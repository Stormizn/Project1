# Supabase 24/7 Hosting Guide

Vercel is fantastic for hosting the frontend (HTML/CSS/JS) of LinkUp. However, because Vercel is "serverless", it cannot host a permanent database like PocketBase natively without paying for expensive 24/7 containers elsewhere.

**Supabase** is an open-source Firebase alternative based on PostgreSQL. It is natively supported by Vercel, perfect for serverless environments, and has a very generous **100% free tier that does NOT require a credit card**.

Follow these steps to set up your free Supabase backend:

## Step 1: Create a Supabase Project
1. Go to [Supabase.com](https://supabase.com/) and click **Start your project**.
2. Sign in with GitHub or your email (no credit card required).
3. Click **New Project** and select a default organization.
4. Name your project (e.g., `linkup-db`), generate a secure password (save it somewhere just in case), and choose a region close to you.
5. Click **Create new project**. It will take about 2-3 minutes to set up your database.

## Step 2: Disable Email Confirmations (Recommended)
By default, Supabase requires users to confirm their email before they can log in.

LinkUp works either way — the `handle_new_user()` database trigger creates the
user's profile regardless of whether a session exists — so this is about demo
convenience rather than correctness. Turning it off means a brand or planner can
sign up and sign in straight away, with no inbox round-trip.

1. Go to **Authentication** in the left sidebar menu of your Supabase dashboard.
2. Under "Configuration", click **Providers**.
3. Click the **Email** provider.
4. **Turn off "Confirm email"** and click **Save**.

## Step 3: Initialize Your Database Schema
Because Supabase uses PostgreSQL, we need to create the tables for our users, events, and opportunities.

**Which file to run depends on your database:**

| Your situation | Run this |
| --- | --- |
| Brand new project, tables do not exist yet | `supabase-schema.sql` |
| Database already exists and has data | `supabase-migrations.sql` |

Running the wrong one will fail — the full schema uses `CREATE TABLE` without
`IF NOT EXISTS`, so it errors on tables that are already there.

1. Once your project is ready, look at the left sidebar menu in the Supabase Dashboard and click on **SQL Editor** (the `{}` icon).
2. Click **New Query**.
3. Open the correct `.sql` file from your LinkUp repository.
4. Copy all the text inside it.
5. Paste it into the Supabase SQL Editor.
6. Click the green **Run** button at the bottom right. You should see a "Success" message.

> If you already have a database, you **must** run `supabase-migrations.sql` at
> least once before testing signup. It creates the `handle_new_user()` trigger
> that builds the `users` profile row. Without it, signup will create the login
> but no profile, and every private page will bounce you back to the login screen.

### What the migration also fixes

Running `supabase-migrations.sql` is not just about the signup trigger. On a
database created from an older version of `supabase-schema.sql`, the live
policies were weaker than the schema file advertises:

- **`users` was readable by anyone**, including signed-out visitors, because of
  a `USING (true)` policy. The migration replaces it with "signed in only".
- **`connections` had no policies at all** in some databases, so nobody could
  read or write a connection.
- **Brands could create events.** Only event planners should be able to publish.
- **Anyone could send "I'm interested"** and pick an arbitrary recipient. The
  migration enforces brand → planner, and requires the recipient to actually be
  the organizer of the opportunity being applied to.
- **`users.role` was nullable**, and a `NULL` role silently behaved like a brand
  everywhere in the app.
- **There was no `messages` table at all.** The migration creates it, keyed to
  a connection, with RLS that limits a thread to the two people on that
  connection and requires the connection to be `accepted` before a message can
  be sent. Until this runs, the Messages page says so instead of erroring.

## Step 3b: Allow the Password Reset Redirect

The "Forgot password?" link on the login page emails a link that lands on
`auth/reset-password.html`. Supabase **silently ignores** any redirect URL that
is not allow-listed, so until you add it, recovery emails will send people to the
wrong place (or appear to do nothing).

1. In the dashboard go to **Authentication → URL Configuration**.
2. Under **Redirect URLs**, add:

   | Environment | Value |
   | --- | --- |
   | Local | `http://localhost:8080/auth/reset-password.html` |
   | Production | `https://<your-domain>/auth/reset-password.html` |

3. Set **Site URL** to your production origin. It is the fallback used for email
   confirmations and for the recovery link if `redirectTo` is not supplied.

## Step 4: Get Your API Keys
We need to connect your frontend code to this new database.

1. In the Supabase Dashboard, click the **Settings** gear icon at the bottom of the left sidebar.
2. Under "Configuration" in the settings menu, click **API**.
3. You will see your **Project URL** (e.g., `https://xyz.supabase.co`). Copy it.
4. Below that, in the "Project API keys" section, you will see your **`anon` / `public`** key. Copy it as well. *(Never copy the `service_role` key).*

## Step 5: Connect LinkUp
1. Open `js/supabase.js` in your code editor.
2. Set `SUPABASE_URL` to the Project URL you copied.
3. Set `SUPABASE_ANON_KEY` to the `anon` / publishable key you copied.
4. Save the file.

The `anon` key is designed to be public — it is safe in frontend code. The
`service_role` key bypasses Row Level Security and must never be committed,
pasted into a public file, or sent to the browser.

## Step 6: Run It Locally

From the project root:

```bash
node scripts/serve.mjs
```

Then open <http://localhost:8080>. No `npm install` is needed — the server uses
only Node built-ins. In VS Code, press **F5** and choose "Serve + open LinkUp"
to start the server and launch Chrome in one step.

## Step 7: Deploy to Vercel
1. Commit your changes.
2. Push your code to GitHub.
3. Vercel will automatically redeploy your site.
4. Add `https://<your-vercel-domain>/auth/reset-password.html` to the Supabase
   **Redirect URLs** list (Step 3b), or password reset will not work in production.
5. Your application is now securely connected to Supabase and will work 24/7!
