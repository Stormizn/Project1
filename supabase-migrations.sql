-- =========================================================
-- LINKZYFY — MIGRATION 001 (existing databases)
-- =========================================================
-- Run this in the Supabase SQL Editor for the project that is
-- ALREADY live (project ref: grqeacirsyyzqbycvssn).
--
-- It is safe to run more than once: every statement either
-- checks for its own existence first or replaces itself.
--
-- It fixes:
--   1. Signup broke when "Confirm email" was ON (no session ->
--      RLS rejected the browser's profile insert). Profiles are
--      now created by a database trigger instead.
--   2. updated_at never changed after a row was created.
--   3. Anyone (even signed out) could read the whole users table.
--   4. A brand could send "I'm interested" unlimited times.
--   5. Missing indexes on every foreign key.
--   6. Brands could create events even though only planners
--      should.
--   7. users.role was nullable with no default, so a NULL role
--      silently fell through every `role = 'event_planner'` check
--      in the app and was treated as a brand.
--   8. Nothing stopped a planner (or any signed-in user) from
--      inserting a connection, or from picking an arbitrary
--      to_user. The "brands only" rule lived purely in the UI.
--   9. The `connections` policies and the events/opportunities
--      UPDATE + DELETE policies were missing entirely, so a
--      database that only ever ran this file had no DELETE
--      policies at all and a weaker policy set than
--      supabase-schema.sql advertises.
--  10. There was no `messages` table at all, so the Messages page
--      had nothing to read. It is keyed to a connection and gated
--      on that connection being 'accepted'.
--  11. There was no `proposals` table, so a partnership could be
--      discussed in messages but never actually put on paper. It is
--      keyed to a connection for the same reason, and its state
--      machine is enforced by a trigger rather than by the UI.
--  12. A brand could forge a planner's consent. `Brands can send
--      interest` never checked `status`, and the connections UPDATE
--      policy let either party write any status, so a brand could
--      create a connection already marked `accepted` — or UPDATE its
--      own pending row to `accepted`. Since sending a proposal only
--      requires an accepted connection, that skipped the handshake
--      entirely. A new connection must now start `pending`, and only
--      the recipient planner may reach `accepted` / `rejected`.
-- =========================================================


-- =========================================================
-- 1. updated_at TRIGGER
-- =========================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS events_set_updated_at ON public.events;
CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS opportunities_set_updated_at ON public.opportunities;
CREATE TRIGGER opportunities_set_updated_at
  BEFORE UPDATE ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS connections_set_updated_at ON public.connections;
CREATE TRIGGER connections_set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- =========================================================
-- 2. PROFILE CREATION TRIGGER
-- =========================================================

-- `set search_path = ''` rather than `public`: this is SECURITY
-- DEFINER, and with a non-empty search path a caller who can create
-- objects in a schema on that path can shadow a name used below and run
-- code as the owner. Every table reference is schema-qualified, and
-- pg_catalog (COALESCE / TRIM / NULLIF / SPLIT_PART) is always
-- reachable, so nothing here depends on the path.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  meta jsonb := NEW.raw_user_meta_data;
  wanted_role TEXT := meta ->> 'role';
BEGIN
  INSERT INTO public.users (
    id, name, role, organization_name, location, category
  )
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(meta ->> 'name'), ''), SPLIT_PART(NEW.email, '@', 1)),
    CASE WHEN wanted_role = 'event_planner' THEN 'event_planner' ELSE 'brand' END,
    NULLIF(TRIM(meta ->> 'organization_name'), ''),
    NULLIF(TRIM(meta ->> 'location'), ''),
    NULLIF(TRIM(meta ->> 'category'), '')
  )
ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- Backfill: any account that signed up before this trigger
-- existed has an auth.users row with no matching profile.
-- This copies the details out of the signup metadata.
INSERT INTO public.users (id, name, role, organization_name, location, category)
SELECT
  au.id,
  COALESCE(
    NULLIF(TRIM(au.raw_user_meta_data ->> 'name'), ''),
    NULLIF(TRIM(au.raw_user_meta_data ->> 'full_name'), ''),
    SPLIT_PART(au.email, '@', 1)
  ),
  CASE
    WHEN au.raw_user_meta_data ->> 'role' = 'event_planner' THEN 'event_planner'
    ELSE 'brand'
  END,
  NULLIF(TRIM(au.raw_user_meta_data ->> 'organization_name'), ''),
  NULLIF(TRIM(au.raw_user_meta_data ->> 'location'), ''),
  NULLIF(TRIM(au.raw_user_meta_data ->> 'category'), '')
FROM auth.users au
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = au.id)
ON CONFLICT (id) DO NOTHING;


-- =========================================================
-- 2b. users.role IS NOT NULL
-- =========================================================
--
-- role used to be a bare nullable TEXT with no default. A NULL role
-- passes the CHECK constraint, and every `role === "event_planner"`
-- test in the app is false for NULL — so a NULL-role account was
-- silently treated as a brand everywhere, and could not be corrected
-- by simply setting a role later.

-- Backfill first: SET NOT NULL fails outright if any row is still NULL.
UPDATE public.users SET role = 'brand' WHERE role IS NULL;

ALTER TABLE public.users ALTER COLUMN role SET DEFAULT 'brand';
ALTER TABLE public.users ALTER COLUMN role SET NOT NULL;


-- =========================================================
-- 3. ROW LEVEL SECURITY
-- =========================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

-- users: replace "anyone can read everyone" with
-- "signed-in users can read profiles".
DROP POLICY IF EXISTS "Anyone can view users" ON public.users;
DROP POLICY IF EXISTS "Users can view all users" ON public.users;

DROP POLICY IF EXISTS "Signed-in users can view profiles" ON public.users;

CREATE POLICY "Signed-in users can view profiles"
  ON public.users FOR SELECT
  USING (auth.role() = 'authenticated');

-- The browser self-heals a profile the trigger never created (see
-- requireSession() in js/auth-guard.js), so a user must be able to
-- insert their own row.
DROP POLICY IF EXISTS "Anyone can insert users" ON public.users;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.users;

CREATE POLICY "Users can insert their own profile"
  ON public.users FOR INSERT
  WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- events / opportunities: signed-in users can read.
DROP POLICY IF EXISTS "Anyone can view events" ON public.events;
DROP POLICY IF EXISTS "Signed-in users can view events" ON public.events;

CREATE POLICY "Signed-in users can view events"
  ON public.events FOR SELECT
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Anyone can view opportunities" ON public.opportunities;
DROP POLICY IF EXISTS "Signed-in users can view opportunities" ON public.opportunities;

CREATE POLICY "Signed-in users can view opportunities"
  ON public.opportunities FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only event planners may publish. The old policy allowed any
-- signed-in user to insert an event as themselves.
DROP POLICY IF EXISTS "Users can insert events" ON public.events;
DROP POLICY IF EXISTS "Event planners can insert events" ON public.events;

CREATE POLICY "Event planners can insert events"
  ON public.events FOR INSERT
  WITH CHECK (
    auth.uid() = organizer_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'event_planner'
    )
  );

DROP POLICY IF EXISTS "Users can insert opportunities" ON public.opportunities;
DROP POLICY IF EXISTS "Event planners can insert opportunities" ON public.opportunities;

CREATE POLICY "Event planners can insert opportunities"
  ON public.opportunities FOR INSERT
  WITH CHECK (
    auth.uid() = organizer_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'event_planner'
    )
  );

-- UPDATE / DELETE on events and opportunities. These were never
-- created by this migration file, so a database that only ever ran
-- the migration had no way to edit or remove its own listings.
DROP POLICY IF EXISTS "Users can update own events" ON public.events;
CREATE POLICY "Users can update own events"
  ON public.events FOR UPDATE
  USING (auth.uid() = organizer_id)
  WITH CHECK (auth.uid() = organizer_id);

DROP POLICY IF EXISTS "Users can delete own events" ON public.events;
CREATE POLICY "Users can delete own events"
  ON public.events FOR DELETE
  USING (auth.uid() = organizer_id);

DROP POLICY IF EXISTS "Users can update own opportunities" ON public.opportunities;
CREATE POLICY "Users can update own opportunities"
  ON public.opportunities FOR UPDATE
  USING (auth.uid() = organizer_id)
  WITH CHECK (auth.uid() = organizer_id);

DROP POLICY IF EXISTS "Users can delete own opportunities" ON public.opportunities;
CREATE POLICY "Users can delete own opportunities"
  ON public.opportunities FOR DELETE
  USING (auth.uid() = organizer_id);

-- ---------- connections ----------
-- Also never created by this migration file.
DROP POLICY IF EXISTS "Users can view their own connections" ON public.connections;
CREATE POLICY "Users can view their own connections"
  ON public.connections FOR SELECT
  USING (auth.uid() = from_user OR auth.uid() = to_user);

-- Interest flows brand -> planner, so the INSERT has to say so in the
-- database. Previously the only check was `auth.uid() = from_user`,
-- which meant a planner could send interest and anyone could pick an
-- arbitrary to_user. This is the same rule the UI enforces, now
-- actually enforced.
DROP POLICY IF EXISTS "Users can insert connections" ON public.connections;
DROP POLICY IF EXISTS "Brands can send interest" ON public.connections;

CREATE POLICY "Brands can send interest"
  ON public.connections FOR INSERT
  WITH CHECK (
    auth.uid() = from_user
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'brand'
    )
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = to_user AND u.role = 'event_planner'
    )
    -- The recipient has to be the organizer of the opportunity that is
    -- being expressed interest in. Without this, a brand could point
    -- interest at any opportunity while naming a different planner as
    -- to_user, and the two halves of the row would disagree.
    AND EXISTS (
      SELECT 1 FROM public.opportunities o
      WHERE o.id = opportunity_id
        AND o.organizer_id = to_user
        AND o.status = 'open'
    )
    -- A new connection always starts pending. Without this a brand
    -- could INSERT the row already marked `accepted` and skip the
    -- handshake the whole feature depends on. See the UPDATE policies
    -- below for the other route to the same place.
    AND status = 'pending'
  );

-- Who may move a connection to which status.
--
-- The old policy was `auth.uid() = from_user OR auth.uid() = to_user`
-- with no mention of `status`, which meant a brand could UPDATE its
-- own pending row straight to `accepted`. Since `Brands can send
-- proposals` only requires that the connection be accepted, that let a
-- brand manufacture consent and file a proposal the planner had never
-- agreed to. RLS decides *who* may touch a row; these two policies are
-- where *which statuses* gets decided, mirroring `proposals`.
--
-- RLS cannot compare the new row against the old one, so it cannot stop
-- a party repointing `from_user` / `opportunity_id` on a row it is
-- already party to. That is a much smaller problem than forged
-- consent, and it is noted rather than papered over.
DROP POLICY IF EXISTS "Users can update their own connections" ON public.connections;
DROP POLICY IF EXISTS "Recipients can respond to interest" ON public.connections;
DROP POLICY IF EXISTS "Senders can archive their own interest" ON public.connections;

CREATE POLICY "Recipients can respond to interest"
  ON public.connections FOR UPDATE
  USING (
    auth.uid() = to_user
    AND status IN ('pending', 'accepted')
  )
  WITH CHECK (
    auth.uid() = to_user
    AND status IN ('accepted', 'rejected', 'archived')
  );

-- A brand may withdraw its own interest, and nothing else. It cannot
-- reach `accepted` or `rejected`: only the planner's decision does that.
CREATE POLICY "Senders can archive their own interest"
  ON public.connections FOR UPDATE
  USING (auth.uid() = from_user)
  WITH CHECK (auth.uid() = from_user AND status = 'archived');

DROP POLICY IF EXISTS "Users can delete their own connections" ON public.connections;
CREATE POLICY "Users can delete their own connections"
  ON public.connections FOR DELETE
  USING (auth.uid() = from_user OR auth.uid() = to_user);


-- =========================================================
-- 3b. MESSAGES
-- =========================================================
-- A message belongs to a connection, not to a user pair that was
-- invented on the spot. That is deliberate: a thread can only exist
-- where there is already a real brand -> planner relationship, and
-- the RLS below reuses `connections` as the single source of truth
-- for "are these two people allowed to talk".
--
-- IF NOT EXISTS on purpose. This file is re-runnable, and a DROP +
-- CREATE would throw away every message already sent.

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID REFERENCES public.connections(id) ON DELETE CASCADE NOT NULL,
  sender_id UUID REFERENCES public.users(id) NOT NULL,
  -- An empty message is not a message. Without this the CHECK below
  -- would accept a row of whitespace and the UI would render a blank
  -- bubble that can never be replied to sensibly.
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  -- NULL means unread. Only the recipient ever sets this.
  read_at TIMESTAMP WITH TIME ZONE
);

-- `read_at` is the only column the client may ever change. RLS alone
-- cannot restrict an UPDATE to a single column, so without this
-- trigger a party could rewrite the body of any message in the thread
-- and impersonate the other side by editing their own past messages.
CREATE OR REPLACE FUNCTION public.messages_lock_content()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'messages: content columns are immutable (only read_at may change)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_lock_content ON public.messages;
CREATE TRIGGER messages_lock_content
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_lock_content();

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Read: both parties of the connection. Same test the connections
-- policies use, so there is one rule and not two that can drift.
DROP POLICY IF EXISTS "Connection parties can read messages" ON public.messages;
CREATE POLICY "Connection parties can read messages"
  ON public.messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.id = connection_id
        AND (c.from_user = auth.uid() OR c.to_user = auth.uid())
    )
  );

-- Write: the sender must be a party, and the connection must be
-- ACCEPTED. A pending or rejected connection has no thread, which is
-- the whole point of keying messages to connections.
DROP POLICY IF EXISTS "Connection parties can send messages" ON public.messages;
CREATE POLICY "Connection parties can send messages"
  ON public.messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.id = connection_id
        AND c.status = 'accepted'
        AND (c.from_user = auth.uid() OR c.to_user = auth.uid())
    )
  );

-- Mark-as-read only, and only for the party that did NOT send the
-- message. A sender marking their own message read is meaningless,
-- and allowing it would let the unread badge be cleared dishonestly.
DROP POLICY IF EXISTS "Recipients can mark messages read" ON public.messages;
CREATE POLICY "Recipients can mark messages read"
  ON public.messages FOR UPDATE
  USING (
    sender_id <> auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.id = connection_id
        AND (c.from_user = auth.uid() OR c.to_user = auth.uid())
    )
  )
  WITH CHECK (
    sender_id <> auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.id = connection_id
        AND (c.from_user = auth.uid() OR c.to_user = auth.uid())
    )
  );

-- A sender may retract their own message. Neither party can delete
-- the other side's.
DROP POLICY IF EXISTS "Senders can delete their own messages" ON public.messages;
CREATE POLICY "Senders can delete their own messages"
  ON public.messages FOR DELETE
  USING (auth.uid() = sender_id);


-- =========================================================
-- 3c. ACCOUNT DELETION
-- =========================================================
-- Called from the profile page's "Delete account" button. The browser
-- cannot do this itself: auth.users is owned by supabase_auth_admin and
-- the `authenticated` role has no DELETE on it, so the only route from a
-- frontend is a SECURITY DEFINER function.
--
-- SECURITY DEFINER runs with the privileges of the function owner
-- (postgres), which is also what bypasses RLS on the tables below. The
-- function is therefore the whole security boundary, and it is scoped to
-- auth.uid() -- a caller can only ever delete their own account.
--
-- The order below is not arbitrary. NOT ONE of the foreign keys onto
-- public.users has ON DELETE CASCADE (events.organizer_id,
-- opportunities.organizer_id, connections.from_user / to_user,
-- messages.sender_id), and public.users itself references auth.users
-- without a cascade. Deleting the profile first therefore fails with an
-- FK violation for any account that has ever created or joined
-- anything. Children go first, then the profile, then the login.
--
-- `set search_path = ''` is required by Supabase's own guidance for any
-- SECURITY DEFINER function: with a non-empty path, a caller who can
-- create objects in a schema on that path can shadow a name used inside
-- the function body and run code as the owner. Every reference below is
-- schema-qualified instead.
--
-- ONE THING THAT LOOKS WRONG BUT IS NOT: this function deletes from
-- public.proposals, and the proposals table is not created until section
-- 4, further down this same file. That is safe only because plpgsql stores
-- the body as source text and does not resolve table references until the
-- function first runs -- so the CREATE succeeds. Do not "fix" it by
-- reordering, and do not be surprised if a paste fails between here and
-- section 4: delete_account() will then exist and be reachable from the
-- Profile page, and calling it raises "relation public.proposals does not
-- exist". Re-run the whole file to finish applying it.

CREATE OR REPLACE FUNCTION public.delete_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target uuid := auth.uid();
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.';
  END IF;

  -- Messages the user sent. Messages on connections they were part of
  -- go with those connections on the next statement.
  DELETE FROM public.messages WHERE sender_id = target;

  -- Proposals the user wrote or received. This one is belt and braces:
  -- proposals.connection_id cascades from connections, so the next
  -- statement would take them anyway. Naming them explicitly means the
  -- delete order does not silently depend on a cascade someone could
  -- remove later.
  DELETE FROM public.proposals WHERE brand_id = target OR planner_id = target;

  -- Both directions: interest they sent, and interest sent to them.
  -- Must precede opportunities/events, because connections.opportunity_id
  -- points at opportunities with no cascade either.
  DELETE FROM public.connections WHERE from_user = target OR to_user = target;

  DELETE FROM public.opportunities WHERE organizer_id = target;
  DELETE FROM public.events        WHERE organizer_id = target;

  DELETE FROM public.users WHERE id = target;

  -- Last, and the whole point: this removes the login itself, so the
  -- account cannot be signed into again.
  DELETE FROM auth.users WHERE id = target;
END;
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, which
-- would include `anon`. Lock it down to signed-in callers only.
REVOKE ALL ON FUNCTION public.delete_account() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;


-- =========================================================
-- 3d. PROPOSALS
-- =========================================================
-- The brand's actual offer on a connection the planner has already
-- accepted: cash, product, the activation idea, the promotion plan,
-- the deliverables. Keyed to the connection for the same reason
-- `messages` is — the offer is only meaningful between two people who
-- have already agreed to talk, and the RLS below re-uses `connections`
-- as the single source of truth for that instead of trusting the ids
-- the browser sent.
--
-- IF NOT EXISTS on purpose, like `messages`: this file is re-runnable,
-- and a DROP + CREATE would throw away every proposal already made.
--
-- This section comes AFTER delete_account() in section 3c, which already
-- deletes from this table. That is deliberate and safe -- see the note
-- above delete_account() for why, and do not reorder the two.
--
-- The CHECK on status is the state machine's vocabulary. The legal
-- moves between those values are enforced by proposals_state_guard()
-- below, not by this constraint, because a CHECK cannot see the OLD row.
--
--   proposed -----------> changes_requested | accepted | rejected | withdrawn
--   changes_requested -> proposed | rejected | withdrawn
--   accepted / rejected / withdrawn  -> final
--
-- There is no 'draft'. A draft exists only in the browser form until
-- the brand presses Send, so a stored one could never be resumed.

CREATE TABLE IF NOT EXISTS public.proposals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- UNIQUE is what makes "one live offer per connection" a fact about
  -- the data rather than a promise about the UI. A double-click, or two
  -- tabs open on the same connection, cannot produce two competing
  -- offers: the second insert fails on the unique constraint.
  connection_id UUID REFERENCES public.connections(id) ON DELETE CASCADE NOT NULL UNIQUE,
  brand_id UUID REFERENCES public.users(id) NOT NULL,
  planner_id UUID REFERENCES public.users(id) NOT NULL,

  -- Either money or product, but not neither. An offer row with an
  -- empty cash_amount AND a NULL product_qty is not an offer, and
  -- letting one exist means the planner sees a "proposal" with nothing
  -- in it and has to ask what the brand actually wants.
  cash_amount NUMERIC(12,2) CHECK (cash_amount IS NULL OR cash_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  product_qty INTEGER CHECK (product_qty IS NULL OR product_qty > 0),
  product_notes TEXT,
  activation_idea TEXT,
  promotion_plan TEXT,
  deliverables TEXT,

  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'changes_requested', 'accepted', 'rejected', 'withdrawn')),
  planner_note TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,

  CONSTRAINT proposals_no_self_deal CHECK (brand_id <> planner_id),
  CONSTRAINT proposals_not_empty CHECK (cash_amount IS NOT NULL OR product_qty IS NOT NULL)
);

-- See supabase-schema.sql section 2 for the full reasoning. Short
-- version: RLS says WHO may update; it cannot say WHICH COLUMNS, so a
-- planner could otherwise rewrite the cash amount, and a brand could
-- rewrite the planner's verdict. The same trigger owns the transitions.
CREATE OR REPLACE FUNCTION public.proposals_state_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.planner_id IS DISTINCT FROM OLD.planner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'proposals: the connection and the two parties cannot be changed';
  END IF;

  IF auth.uid() = OLD.brand_id THEN
    IF NEW.planner_note IS DISTINCT FROM OLD.planner_note THEN
      RAISE EXCEPTION 'proposals: only the planner can write the planner note';
    END IF;
  ELSIF auth.uid() = OLD.planner_id THEN
    IF NEW.cash_amount IS DISTINCT FROM OLD.cash_amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.product_qty IS DISTINCT FROM OLD.product_qty
       OR NEW.product_notes IS DISTINCT FROM OLD.product_notes
       OR NEW.activation_idea IS DISTINCT FROM OLD.activation_idea
       OR NEW.promotion_plan IS DISTINCT FROM OLD.promotion_plan
       OR NEW.deliverables IS DISTINCT FROM OLD.deliverables THEN
      RAISE EXCEPTION 'proposals: only the brand can change what is being offered';
    END IF;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'proposed' THEN
    IF NEW.status NOT IN ('changes_requested', 'accepted', 'rejected', 'withdrawn') THEN
      RAISE EXCEPTION 'proposals: cannot change a proposal from proposed to %', NEW.status;
    END IF;
  ELSIF OLD.status = 'changes_requested' THEN
    IF NEW.status NOT IN ('proposed', 'rejected', 'withdrawn') THEN
      RAISE EXCEPTION 'proposals: cannot change a proposal from changes_requested to %', NEW.status;
    END IF;
  ELSE
    RAISE EXCEPTION 'proposals: a % proposal is final and cannot be changed', OLD.status;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS proposals_set_updated_at ON public.proposals;
CREATE TRIGGER proposals_set_updated_at
  BEFORE UPDATE ON public.proposals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS proposals_state_guard ON public.proposals;
CREATE TRIGGER proposals_state_guard
  BEFORE UPDATE ON public.proposals
  FOR EACH ROW EXECUTE FUNCTION public.proposals_state_guard();

ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;

-- Stricter than `messages` on purpose: not every signed-in user can
-- discover that a proposal exists. Only the brand that wrote it and the
-- planner who received it.
DROP POLICY IF EXISTS "Proposal parties can read proposals" ON public.proposals;
CREATE POLICY "Proposal parties can read proposals"
  ON public.proposals FOR SELECT
  USING (auth.uid() = brand_id OR auth.uid() = planner_id);

DROP POLICY IF EXISTS "Brands can send proposals" ON public.proposals;
CREATE POLICY "Brands can send proposals"
  ON public.proposals FOR INSERT
  WITH CHECK (
    auth.uid() = brand_id
    AND status = 'proposed'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'brand'
    )
    -- The connection is the source of truth. It has to be accepted, and
    -- it has to run in the direction the row claims: the brand is
    -- from_user, the planner is to_user. Without the last two tests a
    -- brand could file an offer naming a planner it is not connected to.
    AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.id = connection_id
        AND c.status = 'accepted'
        AND c.from_user = brand_id
        AND c.to_user = planner_id
    )
  );

-- USING names the statuses as well as the user, so a brand cannot
-- reopen an accepted proposal by moving it back to 'proposed'.
DROP POLICY IF EXISTS "Brands can revise or withdraw their own proposals" ON public.proposals;
CREATE POLICY "Brands can revise or withdraw their own proposals"
  ON public.proposals FOR UPDATE
  USING (
    auth.uid() = brand_id
    AND status IN ('proposed', 'changes_requested')
  )
  WITH CHECK (
    auth.uid() = brand_id
    AND status IN ('proposed', 'withdrawn')
  );

-- WITH CHECK is the load-bearing half here: it is the only thing
-- stopping a planner from self-accepting, or from editing the cash
-- amount while they are answering.
DROP POLICY IF EXISTS "Planners can respond to proposals" ON public.proposals;
CREATE POLICY "Planners can respond to proposals"
  ON public.proposals FOR UPDATE
  USING (
    auth.uid() = planner_id
    AND status IN ('proposed', 'changes_requested')
  )
  WITH CHECK (
    auth.uid() = planner_id
    AND status IN ('changes_requested', 'accepted', 'rejected')
  );

-- No DELETE policy, on purpose. Withdrawing is a status, which keeps
-- the record of what was offered. The only thing that removes a
-- proposal is public.delete_account() above, which is SECURITY DEFINER
-- and bypasses RLS entirely.


-- =========================================================
-- 4. CONSTRAINTS & INDEXES
-- =========================================================

-- Remove duplicate interests before adding the constraint,
-- otherwise the index creation below would fail.
DELETE FROM public.connections a
USING public.connections b
WHERE a.id > b.id
  AND a.from_user = b.from_user
  AND a.to_user = b.to_user
  AND a.opportunity_id IS NOT DISTINCT FROM b.opportunity_id;

-- NULLS NOT DISTINCT matters here: in a plain unique index, NULLs are
-- always considered different from each other, so every repeat
-- "I'm interested" that left opportunity_id empty would slip past
-- this constraint and the old bug would survive.
DROP INDEX IF EXISTS public.connections_no_duplicate_interest;

CREATE UNIQUE INDEX connections_no_duplicate_interest
  ON public.connections (from_user, to_user, opportunity_id)
  NULLS NOT DISTINCT;

ALTER TABLE public.connections
  DROP CONSTRAINT IF EXISTS connections_no_self_contact;
ALTER TABLE public.connections
  ADD CONSTRAINT connections_no_self_contact
  CHECK (from_user <> to_user);

CREATE INDEX IF NOT EXISTS events_organizer_id_idx        ON public.events (organizer_id);
CREATE INDEX IF NOT EXISTS events_event_date_idx          ON public.events (event_date);
CREATE INDEX IF NOT EXISTS opportunities_event_id_idx      ON public.opportunities (event_id);
CREATE INDEX IF NOT EXISTS opportunities_organizer_id_idx  ON public.opportunities (organizer_id);
CREATE INDEX IF NOT EXISTS opportunities_status_idx        ON public.opportunities (status);
CREATE INDEX IF NOT EXISTS connections_from_user_idx       ON public.connections (from_user);
CREATE INDEX IF NOT EXISTS connections_to_user_idx         ON public.connections (to_user);
CREATE INDEX IF NOT EXISTS connections_opportunity_id_idx  ON public.connections (opportunity_id);

-- messages are always read as "one thread, oldest first", so the
-- composite index matches the query instead of forcing a sort.
CREATE INDEX IF NOT EXISTS messages_connection_created_idx    ON public.messages (connection_id, created_at);
CREATE INDEX IF NOT EXISTS messages_sender_id_idx            ON public.messages (sender_id);
-- Partial: the unread badge only ever counts read_at IS NULL.
CREATE INDEX IF NOT EXISTS messages_unread_idx
  ON public.messages (connection_id)
  WHERE read_at IS NULL;

-- proposals.connection_id is already unique, which is the index the
-- detail page reads. These two cover the two list views.
CREATE INDEX IF NOT EXISTS proposals_brand_id_idx   ON public.proposals (brand_id);
CREATE INDEX IF NOT EXISTS proposals_planner_id_idx ON public.proposals (planner_id);


-- =========================================================
-- 5. DONE
-- =========================================================
-- Re-run the signup flow in the browser, then open Proposals from the
-- sidebar. If the page says "Proposals are not set up on this database
-- yet", PostgREST has not reloaded its schema cache yet — wait a few
-- seconds and reload. If it persists, check that this whole file ran
-- without a red error partway through.
-- =========================================================
