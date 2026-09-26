-- =========================================================
-- LINKUP — FULL SCHEMA (fresh install)
-- =========================================================
-- Run this once in the Supabase SQL Editor for a NEW project.
--
-- If you already have a database, do NOT run this file.
-- Run `supabase-migrations.sql` instead — it upgrades an
-- existing database in place.
--
-- How the profile row gets created
-- -------------------------------
-- `handle_new_user()` is a trigger on `auth.users`. Whenever
-- Supabase Auth creates an account, the database itself inserts
-- the matching public.users row.
--
-- This is deliberate: the OLD code created the profile from the
-- browser with a plain `insert`. That only works when the user
-- already has a session, so signup broke whenever "Confirm
-- email" was switched on in the Supabase dashboard (no session
-- yet -> Row Level Security rejected the insert). Creating the
-- row from a trigger works in BOTH cases.
-- =========================================================


-- =========================================================
-- 1. TABLES
-- =========================================================

-- Profiles for auth.users
--
-- `role` is NOT NULL with a default of 'brand'. It used to be a bare
-- nullable TEXT, and because every `role === "event_planner"` test in
-- the app is false for NULL, an account with a NULL role was silently
-- treated as a brand.
CREATE TABLE public.users (
  id UUID REFERENCES auth.users NOT NULL PRIMARY KEY,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'brand' CHECK (role IN ('brand', 'event_planner')),
  organization_name TEXT,
  location TEXT,
  category TEXT,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  location TEXT,
  event_date DATE,
  capacity INTEGER,
  description TEXT,
  organizer_id UUID REFERENCES public.users(id) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.opportunities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT,
  budget TEXT,
  audience TEXT,
  description TEXT,
  status TEXT CHECK (status IN ('open', 'closed')) NOT NULL DEFAULT 'open',
  event_id UUID REFERENCES public.events(id) ON DELETE CASCADE NOT NULL,
  organizer_id UUID REFERENCES public.users(id) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.connections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user UUID REFERENCES public.users(id) NOT NULL,
  to_user UUID REFERENCES public.users(id) NOT NULL,
  opportunity_id UUID REFERENCES public.opportunities(id),
  status TEXT CHECK (status IN ('pending', 'accepted', 'rejected', 'archived')) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,

  -- A brand must not be able to send interest to itself.
  CONSTRAINT connections_no_self_contact CHECK (from_user <> to_user)
);

-- Messages hang off a connection, so a thread can only exist where
-- there is already a real brand -> planner relationship. The
-- INSERT policy additionally requires status = 'accepted'.
CREATE TABLE public.messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  connection_id UUID REFERENCES public.connections(id) ON DELETE CASCADE NOT NULL,
  sender_id UUID REFERENCES public.users(id) NOT NULL,
  -- Reject empty and whitespace-only messages.
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  -- NULL means unread. Only the recipient ever sets this.
  read_at TIMESTAMP WITH TIME ZONE
);


-- =========================================================
-- 2. TRIGGERS
-- =========================================================

-- Keep updated_at honest on every UPDATE.
-- Without this, updated_at was frozen at the row's creation time.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER opportunities_set_updated_at
  BEFORE UPDATE ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER connections_set_updated_at
  BEFORE UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- `read_at` is the only column the client may change. RLS cannot
-- restrict an UPDATE to a single column, so this trigger is what
-- stops a party rewriting the body of a message and impersonating
-- the other side by editing their own past messages.
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

CREATE TRIGGER messages_lock_content
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_lock_content();


-- Create the public.users profile automatically on signup.
--
-- Reads the values the signup form passes in
-- `options.data` (Supabase stores these in raw_user_meta_data).
-- `set search_path = ''` rather than `public`: SECURITY DEFINER, and a
-- non-empty search path lets a caller shadow a name used below with an
-- object of their own. Table refs are schema-qualified and pg_catalog
-- is always reachable, so nothing depends on the path.
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
    id,
    name,
    role,
    organization_name,
    location,
    category
  )
  VALUES (
    NEW.id,
    -- Fall back to the email username if no name was sent.
    COALESCE(NULLIF(TRIM(meta ->> 'name'), ''), SPLIT_PART(NEW.email, '@', 1)),
    -- Only ever store a role the CHECK constraint allows,
    -- otherwise the whole signup would fail.
    CASE WHEN wanted_role = 'event_planner' THEN 'event_planner' ELSE 'brand' END,
    NULLIF(TRIM(meta ->> 'organization_name'), ''),
    NULLIF(TRIM(meta ->> 'location'), ''),
    NULLIF(TRIM(meta ->> 'category'), '')
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- =========================================================
-- 3. ROW LEVEL SECURITY
-- =========================================================
-- Every table is private by default: RLS is enabled and no
-- policy means no access.
-- =========================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

-- ---------- users ----------

-- Signed-in users can read profiles.
--
-- This stays open on purpose: LinkUp is a public marketplace
-- directory, and Discover / Connections / Opportunity pages all
-- join in OTHER users' profiles (organizer name, brand name) to
-- render a card. The table deliberately holds no email, phone or
-- any other private field — the sign-in email lives in
-- Supabase Auth (auth.users), which the anon key can never read.
--
-- The change from the old `USING (true)` is that anonymous
-- visitors can no longer scrape the whole member table; they must
-- be signed in.
CREATE POLICY "Signed-in users can view profiles"
  ON public.users FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Users can insert their own profile"
  ON public.users FOR INSERT
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.users FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ---------- events ----------

CREATE POLICY "Signed-in users can view events"
  ON public.events FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only event planners may publish events.
CREATE POLICY "Event planners can insert events"
  ON public.events FOR INSERT
  WITH CHECK (
    auth.uid() = organizer_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'event_planner'
    )
  );

CREATE POLICY "Users can update own events"
  ON public.events FOR UPDATE
  USING (auth.uid() = organizer_id)
  WITH CHECK (auth.uid() = organizer_id);

CREATE POLICY "Users can delete own events"
  ON public.events FOR DELETE
  USING (auth.uid() = organizer_id);

-- ---------- opportunities ----------

CREATE POLICY "Signed-in users can view opportunities"
  ON public.opportunities FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only event planners may publish opportunities.
CREATE POLICY "Event planners can insert opportunities"
  ON public.opportunities FOR INSERT
  WITH CHECK (
    auth.uid() = organizer_id
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.role = 'event_planner'
    )
  );

CREATE POLICY "Users can update own opportunities"
  ON public.opportunities FOR UPDATE
  USING (auth.uid() = organizer_id)
  WITH CHECK (auth.uid() = organizer_id);

CREATE POLICY "Users can delete own opportunities"
  ON public.opportunities FOR DELETE
  USING (auth.uid() = organizer_id);

-- ---------- connections ----------

CREATE POLICY "Users can view their own connections"
  ON public.connections FOR SELECT
  USING (auth.uid() = from_user OR auth.uid() = to_user);

-- Interest flows brand -> planner. The old policy only checked
-- `auth.uid() = from_user`, so a planner could send interest and a
-- user could point interest at any opportunity while naming a
-- different planner as to_user.
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
    AND EXISTS (
      SELECT 1 FROM public.opportunities o
      WHERE o.id = opportunity_id
        AND o.organizer_id = to_user
        AND o.status = 'open'
    )
  );

CREATE POLICY "Users can update their own connections"
  ON public.connections FOR UPDATE
  USING (auth.uid() = from_user OR auth.uid() = to_user)
  WITH CHECK (auth.uid() = from_user OR auth.uid() = to_user);

CREATE POLICY "Users can delete their own connections"
  ON public.connections FOR DELETE
  USING (auth.uid() = from_user OR auth.uid() = to_user);


-- ---------- messages ----------
-- Every policy below re-checks `connections` rather than trusting a
-- sender_id supplied by the client, so the connection is the single
-- source of truth for "may these two talk".
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Connection parties can read messages"
  ON public.messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.id = connection_id
        AND (c.from_user = auth.uid() OR c.to_user = auth.uid())
    )
  );

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

-- Mark-as-read only, and never by the person who sent the message.
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

CREATE POLICY "Senders can delete their own messages"
  ON public.messages FOR DELETE
  USING (auth.uid() = sender_id);


-- ---------- account deletion ----------
-- Called from the profile page. The browser cannot delete an auth user
-- directly -- auth.users is owned by supabase_auth_admin and the
-- `authenticated` role has no DELETE on it -- so this SECURITY DEFINER
-- function is the only route. It is scoped to auth.uid(), so a caller
-- can only delete their own account.
--
-- Order matters: no foreign key onto public.users has ON DELETE CASCADE,
-- so children have to go before the profile. `set search_path = ''`
-- follows Supabase's guidance for SECURITY DEFINER functions; every
-- reference is schema-qualified so nothing is shadowable.
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

  DELETE FROM public.messages      WHERE sender_id = target;
  DELETE FROM public.connections   WHERE from_user = target OR to_user = target;
  DELETE FROM public.opportunities WHERE organizer_id = target;
  DELETE FROM public.events        WHERE organizer_id = target;
  DELETE FROM public.users         WHERE id = target;
  DELETE FROM auth.users           WHERE id = target;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_account() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;


-- =========================================================
-- 4. CONSTRAINTS & INDEXES
-- =========================================================

-- Stop the same brand sending "I'm interested" twice for the
-- same opportunity. NULLS NOT DISTINCT is required: in a plain
-- unique index Postgres considers every NULL different from every
-- other NULL, so rows without an opportunity_id would still be
-- allowed to repeat.
CREATE UNIQUE INDEX connections_no_duplicate_interest
  ON public.connections (from_user, to_user, opportunity_id)
  NULLS NOT DISTINCT;

-- Foreign keys are not indexed automatically in Postgres, and
-- every Discover / Dashboard query filters or joins on these.
CREATE INDEX events_organizer_id_idx        ON public.events (organizer_id);
CREATE INDEX events_event_date_idx          ON public.events (event_date);
CREATE INDEX opportunities_event_id_idx      ON public.opportunities (event_id);
CREATE INDEX opportunities_organizer_id_idx  ON public.opportunities (organizer_id);
CREATE INDEX opportunities_status_idx        ON public.opportunities (status);
CREATE INDEX connections_from_user_idx       ON public.connections (from_user);
CREATE INDEX connections_to_user_idx         ON public.connections (to_user);
CREATE INDEX connections_opportunity_id_idx  ON public.connections (opportunity_id);

-- Messages are always read as "one thread, oldest first", so the
-- composite index matches the query instead of forcing a sort.
CREATE INDEX messages_connection_created_idx    ON public.messages (connection_id, created_at);
CREATE INDEX messages_sender_id_idx            ON public.messages (sender_id);
-- Partial: the unread badge only ever counts read_at IS NULL.
CREATE INDEX messages_unread_idx
  ON public.messages (connection_id)
  WHERE read_at IS NULL;
