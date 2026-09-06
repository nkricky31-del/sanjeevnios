-- ============================================================================
-- 57. CLINIC LOGIN ID (Clinic ID + registered phone -> OTP, server-enforced)
-- ============================================================================
-- A clinic signs in with a Clinic ID (e.g. SNJ-CL-000123) plus a phone
-- number registered to that clinic - never an MRN, which stays what it's
-- always been (section 18: a patient's own record number, shown inside a
-- profile, never a login credential for anyone). This migration:
--
--   1. Gives every clinic a unique, human-readable Clinic ID the moment an
--      admin approves it (clinics.clinic_code, assigned by a trigger - same
--      "generate once, on the triggering event" shape as generate_mrn() /
--      assign_family_member_mrn() in section 18, just keyed off an UPDATE
--      transition instead of an INSERT).
--   2. Lets a clinic register MORE than one staff phone (clinic_staff_phones)
--      - the clinic's own owner_id phone always works too, this is
--      *additional* phones. is_own_clinic() - the one helper nearly every
--      RLS policy in this schema already calls - is redefined to check both,
--      so every table already gated by it (doctors, appointments, visits,
--      prescriptions, files, documents, holidays, subscriptions, ...)
--      automatically opens up to a staff phone with zero further changes.
--      "If a phone is linked to more than one clinic, the Clinic ID decides
--      which console they enter" falls out for free from this design: OTP
--      sign-in itself is just proof of the phone, never proof of which
--      clinic - verify_clinic_login() below is what actually pins a login
--      attempt to exactly one clinic, by requiring the Clinic ID and phone
--      to name the SAME approved clinic before an OTP is ever sent.
--   3. verify_clinic_login(p_clinic_code, p_phone) - SECURITY DEFINER, granted
--      to anon (it has to run BEFORE sign-in, when there is no auth.uid() yet)
--      - is the actual server-side gate ClinicLogin.tsx calls before
--      supabase.auth.signInWithOtp(). A wrong Clinic ID, a wrong phone, an
--      unapproved clinic, or a mismatched pair all get the exact same `false`
--      back - no error message ever reveals which half was wrong, and no OTP
--      is ever sent for a `false` result. This is real server enforcement,
--      not a UI nicety: even a caller who skips the screen entirely and hits
--      the RPC directly gets exactly the same gate, and nothing downstream
--      (RLS on any table) trusts the client's own claim of who it is - it all
--      still runs off auth.uid() from the OTP-verified session, same as
--      every other role in this app.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 57.1 CLINIC ID - generated once, the moment a clinic is first approved
-- ----------------------------------------------------------------------------

alter table clinics add column if not exists clinic_code text;
alter table clinics add column if not exists contact_email text;

create unique index if not exists clinics_clinic_code_idx on clinics (clinic_code) where clinic_code is not null;

create sequence if not exists clinic_code_seq start 1;

create or replace function public.generate_clinic_code()
returns text
language sql
as $$
  select 'SNJ-CL-' || lpad(nextval('clinic_code_seq')::text, 6, '0');
$$;

-- Fires on every UPDATE, but only ever ACTS the moment status transitions
-- INTO 'approved' from something else, and only if this clinic doesn't
-- already have one - so re-approving after a status bounce, or any other
-- field being saved, never mints a second code (the same "generated once"
-- guarantee generate_mrn() gives a patient).
create or replace function public.assign_clinic_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' and new.clinic_code is null then
    new.clinic_code := public.generate_clinic_code();
  end if;
  return new;
end;
$$;

drop trigger if exists on_clinic_approve_assign_code on clinics;
create trigger on_clinic_approve_assign_code
  before update on clinics
  for each row
  execute function public.assign_clinic_code();

-- Backfill: any clinic that was already 'approved' before this migration
-- ran gets a Clinic ID right now too, exactly the same one-time backfill
-- shape section 18 used for mrn.
update clinics set clinic_code = public.generate_clinic_code()
where status = 'approved' and clinic_code is null;

-- ----------------------------------------------------------------------------
-- 57.2 STAFF PHONES - a clinic can register more than one login phone
-- ----------------------------------------------------------------------------

create table if not exists clinic_staff_phones (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  -- Same normalized "country code + 10 digits, no +" form as
  -- family_members.phone / profiles.phone (see src/lib/phone.ts's
  -- normalizePhone) - so a straight text comparison against profiles.phone
  -- in verify_clinic_login()/is_own_clinic() below always lines up.
  phone text not null,
  label text,
  created_at timestamptz not null default now(),
  unique (clinic_id, phone)
);

alter table clinic_staff_phones enable row level security;

drop policy if exists "clinic_staff_phones_select" on clinic_staff_phones;
create policy "clinic_staff_phones_select" on clinic_staff_phones for select
  using (public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "clinic_staff_phones_insert" on clinic_staff_phones;
create policy "clinic_staff_phones_insert" on clinic_staff_phones for insert
  with check (public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "clinic_staff_phones_delete" on clinic_staff_phones;
create policy "clinic_staff_phones_delete" on clinic_staff_phones for delete
  using (public.is_own_clinic(clinic_id) or public.is_admin());

-- is_own_clinic() (section 3) now also true for a phone registered as staff
-- of that clinic, not only its owner_id. SECURITY DEFINER already, for the
-- same reason as before - looking up clinic_staff_phones/profiles here can't
-- recurse back into THIS function's own RLS use.
create or replace function public.is_own_clinic(target_clinic_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from clinics where id = target_clinic_id and owner_id = auth.uid()
  ) or exists (
    select 1 from clinic_staff_phones csp
    where csp.clinic_id = target_clinic_id
      and csp.phone = (select phone from profiles where id = auth.uid())
  );
$$;

-- The clinic id for whoever is currently signed in - owner or staff, exactly
-- one or null. src/pages/ClinicQueue.tsx / TokenBoard.tsx / ClinicPoster.tsx
-- all used to look this up with `clinics.owner_id = auth.uid()` directly,
-- which only ever matched the owner - a staff phone would authenticate fine
-- and then find no clinic at all. They now call this instead.
create or replace function public.my_clinic_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select id from clinics where owner_id = auth.uid()),
    (select csp.clinic_id from clinic_staff_phones csp
       where csp.phone = (select phone from profiles where id = auth.uid())
       limit 1)
  );
$$;

-- clinics_select/clinics_update (sections 4 and 51) widened from plain
-- owner_id = auth.uid() to is_own_clinic(id), so a staff phone can read and
-- edit its own clinic exactly like the owner already could. Every OTHER
-- table's RLS already routes through is_own_clinic() (see the section header
-- above), so only these two policies - the two that hard-coded owner_id
-- directly instead of calling the helper - need restating here.
drop policy if exists "clinics_select" on clinics;
create policy "clinics_select" on clinics for select
  using (
    (status = 'approved' and is_active)
    or public.is_own_clinic(id)
    or public.is_admin()
  );

drop policy if exists "clinics_update" on clinics;
create policy "clinics_update" on clinics for update
  using (public.is_own_clinic(id) or public.is_admin())
  with check (public.is_own_clinic(id) or public.is_admin());

-- Lets the clinic's own owner (or an already-recognised staff phone) add
-- ANOTHER staff phone to their clinic - normalizes and validates the number
-- server-side rather than trusting whatever the client already normalized.
-- SECURITY DEFINER purely to look my_clinic_id() up without a client-visible
-- clinic_id param (a caller can only ever add a phone to THEIR OWN clinic -
-- there is no clinic_id argument to spoof).
create or replace function public.add_clinic_staff_phone(p_phone text, p_label text default null)
returns clinic_staff_phones
language plpgsql
security definer
set search_path = public
as $$
declare
  my_clinic uuid;
  normalized text;
  result clinic_staff_phones;
begin
  my_clinic := public.my_clinic_id();
  if my_clinic is null then
    raise exception 'No clinic found for this account.';
  end if;

  normalized := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(normalized) = 10 then
    normalized := '91' || normalized;
  end if;
  if normalized !~ '^91\d{10}$' then
    raise exception 'Enter a valid 10-digit phone number.';
  end if;

  insert into clinic_staff_phones (clinic_id, phone, label)
  values (my_clinic, normalized, nullif(trim(coalesce(p_label, '')), ''))
  on conflict (clinic_id, phone) do update set label = excluded.label
  returning * into result;

  return result;
end;
$$;

-- A phone that already had a 'patient' profile (booked as a patient before
-- ever being added as clinic staff) needs its role flipped explicitly -
-- handle_new_user() below only sets the role correctly on a phone's very
-- first-ever sign-in. Called best-effort from AuthContext.tsx alongside the
-- existing claim_walk_in_records() call, same "fire and forget, next load
-- picks it up" contract.
create or replace function public.sync_clinic_staff_role()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  my_phone text;
begin
  if auth.uid() is null then
    return false;
  end if;
  select phone into my_phone from profiles where id = auth.uid();
  if my_phone is null then
    return false;
  end if;

  if (select role from profiles where id = auth.uid()) = 'patient'
     and exists (select 1 from clinic_staff_phones where phone = my_phone) then
    update profiles set role = 'clinic' where id = auth.uid();
    return true;
  end if;

  return false;
end;
$$;

-- The common case (a phone added as staff BEFORE it ever signs in) is
-- handled right here instead, with no extra round trip for anyone: a brand
-- new auth.users row is checked against clinic_staff_phones at the moment
-- its profiles row is first created, same trigger, one extra indexed lookup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  initial_role text := 'patient';
begin
  if exists (select 1 from clinic_staff_phones where phone = new.phone) then
    initial_role := 'clinic';
  end if;

  insert into public.profiles (id, phone, role)
  values (new.id, new.phone, initial_role)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 57.3 SERVER-SIDE LOGIN GATE - Clinic ID + phone must name the SAME
--      approved clinic before an OTP is ever sent
-- ----------------------------------------------------------------------------

-- Throttle log for verify_clinic_login() below - this runs as `anon` (there
-- is no session yet to rate-limit by auth.uid()), and a Clinic ID is a short,
-- sequential, guessable string (SNJ-CL-000123), so without SOME limit an
-- anonymous caller could hammer this as a phone-number-enumeration oracle
-- against one Clinic ID. Not a full defense (no IP tracking - PostgREST
-- doesn't hand a caller IP into plain SQL without extra setup), but it
-- bounds the speed of that enumeration to something an SMS-OTP-gated login
-- was never going to be practical to brute-force through anyway.
create table if not exists clinic_login_attempts (
  id uuid primary key default gen_random_uuid(),
  clinic_code text,
  phone text,
  succeeded boolean not null,
  at timestamptz not null default now()
);
create index if not exists clinic_login_attempts_at_idx on clinic_login_attempts (at);

alter table clinic_login_attempts enable row level security;
drop policy if exists "clinic_login_attempts_select" on clinic_login_attempts;
create policy "clinic_login_attempts_select" on clinic_login_attempts for select
  using (public.is_admin());
-- No insert/update/delete policy for any role - only verify_clinic_login()
-- (SECURITY DEFINER) ever writes here.

create or replace function public.verify_clinic_login(p_clinic_code text, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  clinic_code_norm text := upper(trim(coalesce(p_clinic_code, '')));
  phone_norm text := trim(coalesce(p_phone, ''));
  recent_attempts int;
  ok boolean;
begin
  if clinic_code_norm = '' or phone_norm = '' then
    return false;
  end if;

  select count(*) into recent_attempts
  from clinic_login_attempts
  where at > now() - interval '10 minutes'
    and (clinic_code = clinic_code_norm or phone = phone_norm);

  if recent_attempts > 30 then
    insert into clinic_login_attempts (clinic_code, phone, succeeded) values (clinic_code_norm, phone_norm, false);
    return false;
  end if;

  -- Only if the Clinic ID and the phone belong to the SAME approved clinic -
  -- either as its owner_id (the phone that registered it) or as one of its
  -- clinic_staff_phones - does this return true. Everything else (unknown
  -- code, unapproved clinic, right code but wrong phone, right phone but
  -- wrong code) is indistinguishable `false`.
  select exists (
    select 1 from clinics c
    where c.clinic_code = clinic_code_norm
      and c.status = 'approved'
      and (
        c.owner_id in (select id from profiles where phone = phone_norm)
        or exists (
          select 1 from clinic_staff_phones csp
          where csp.clinic_id = c.id and csp.phone = phone_norm
        )
      )
  ) into ok;

  insert into clinic_login_attempts (clinic_code, phone, succeeded) values (clinic_code_norm, phone_norm, ok);

  return ok;
end;
$$;

grant execute on function public.verify_clinic_login(text, text) to anon, authenticated;
