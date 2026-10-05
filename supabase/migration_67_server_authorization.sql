-- ============================================================================
-- 67. AUTHORIZE EVERY SENSITIVE REQUEST ON THE SERVER (hardens Part 50)
-- ============================================================================
-- This app has no server of its own: the browser calls Supabase directly, so
-- "the server" is (a) row-level security + grants on every table, (b) the
-- database functions the app calls as RPCs, and (c) the edge functions.
-- An audit of all three against WHO / WHICH CLINIC / ALLOWED / THIS
-- RESOURCE / RULES found these gaps, each closed below:
--
--   67.1 THIS RESOURCE - another patient's records via a shared MRN.
--        is_own_mrn() (migration 21) treats any family_members row the
--        caller owns as proof of identity for EVERY row sharing its MRN. But
--        a patient can add a family member with any phone number (and
--        assign_family_member_mrn() reuses the MRN of whoever already has
--        that phone), or simply type in an MRN (sequential, MRN-00000001...)
--        - and was then let into that stranger's appointments, visits,
--        prescriptions, files, conditions and encounters. The same path let
--        a clinic staff account read its walk-in patients' records at OTHER
--        clinics (walk-in rows are stored under the staff account). Now a
--        shared MRN only grants access through a row whose phone is the
--        caller's OWN verified login phone - i.e. the caller really is that
--        person - and an MRN can no longer be chosen or changed by a user.
--   67.2 ALLOWED - a clinic could upload its own documents already marked
--        "verified", which flips doctors/clinics.is_verified (the patient-
--        facing VERIFIED badge) without an admin ever looking.
--   67.3 ALLOWED - a suspended user could un-suspend themselves, and a
--        clinic hidden for an unpaid subscription could switch itself back
--        on (profiles.suspended / clinics.is_active had no write guard).
--   67.4 WHO - qr_secret() (the check-in QR signing key) and
--        sign_qr_payload() were callable by anyone, even signed out, so
--        anyone could forge a check-in QR. Internal helpers are no longer
--        callable from the API at all.
--   67.5 THIS RESOURCE - a clinic could send an in-app notification to ANY
--        user, as long as it quoted one of its own appointment ids. It can
--        now only notify that appointment's own patient.
--   67.6 WHO - a request with no session got an empty 200 from most tables
--        (RLS filtered everything out). Signed-out callers no longer have
--        any privilege on tables that aren't public by design, so they get
--        401 instead - the public search/profile pages keep working.
--
-- Unchanged on purpose (already correct, verified by test): every table has
-- RLS; every write policy re-checks the row it produces (so a row can't be
-- moved into another clinic); clinic-scoped reads/writes are keyed on
-- is_own_clinic(), which is derived from the caller's own membership
-- (clinics.owner_id / clinic_staff_phones), never from a client value.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 67.1 MRN-based access only through the caller's own verified identity
-- ----------------------------------------------------------------------------

-- Last 10 digits only: auth.users.phone, family_members.phone and
-- clinic_staff_phones all store Indian numbers in slightly different shapes
-- ('91XXXXXXXXXX', '+91...', bare 10 digits).
create or replace function public.phone_key(p_phone text)
returns text
language sql
immutable
as $$
  select nullif(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10), '');
$$;

-- The phone the caller proved they own by logging in with an OTP.
create or replace function public.my_verified_phone_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.phone_key(phone) from auth.users where id = auth.uid();
$$;

-- True when this MRN belongs to the caller: either one of the caller's own
-- rows with this MRN carries their own verified phone (it's them), or the MRN
-- isn't shared with any other account at all (e.g. a child the caller added).
create or replace function public.mrn_is_mine(p_mrn text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_mrn is not null
    and auth.uid() is not null
    and exists (select 1 from family_members m where m.account_id = auth.uid() and m.mrn = p_mrn)
    and (
      exists (
        select 1 from family_members m
        where m.account_id = auth.uid()
          and m.mrn = p_mrn
          and public.phone_key(m.phone) is not null
          and public.phone_key(m.phone) = public.my_verified_phone_key()
      )
      or not exists (select 1 from family_members o where o.mrn = p_mrn and o.account_id <> auth.uid())
    );
$$;

create or replace function public.is_own_mrn(target_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_own_member(target_member_id)
      or public.mrn_is_mine((select mrn from family_members where id = target_member_id));
$$;

drop policy if exists "encounters_select_patient" on encounters;
create policy "encounters_select_patient" on encounters for select
  using (public.mrn_is_mine(mrn));

-- An MRN is assigned by the database, never chosen by a user: a value sent
-- with an insert is discarded (assign_family_member_mrn() then mints or
-- reuses one as before), and it can't be changed afterwards. Admins and
-- server-side jobs (no auth.uid()) are exempt, e.g. for record merges.
create or replace function public.guard_family_member_mrn()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.mrn := null;
  elsif new.mrn is distinct from old.mrn then
    raise exception 'A patient''s MRN can''t be changed.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Fires before on_family_member_assign_mrn (triggers run in name order:
-- "guard_..." < "on_..."), so the discarded MRN is re-assigned properly.
drop trigger if exists guard_family_member_mrn on family_members;
create trigger guard_family_member_mrn
  before insert or update of mrn on family_members
  for each row
  execute function public.guard_family_member_mrn();

-- ----------------------------------------------------------------------------
-- 67.2 Documents start as pending - only an admin verifies them
-- ----------------------------------------------------------------------------

drop policy if exists "documents_insert" on documents;
create policy "documents_insert" on documents for insert
  with check (
    public.is_admin()
    or (
      public.owns_document_owner(owner_type, owner_id)
      and status = 'pending'
      and reviewed_by is null
      and reviewed_at is null
    )
  );

-- ----------------------------------------------------------------------------
-- 67.3 Suspension and clinic activation are admin decisions
-- ----------------------------------------------------------------------------

create or replace function public.guard_profile_suspension()
returns trigger
language plpgsql
as $$
begin
  if new.suspended is distinct from old.suspended
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only an admin can suspend or restore an account.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profile_suspension on profiles;
create trigger guard_profile_suspension
  before update of suspended on profiles
  for each row
  execute function public.guard_profile_suspension();

-- clinics.is_active is only ever switched by an admin (AdminSubscriptions)
-- or by razorpay-webhook (service role, no auth.uid()) - a clinic switching
-- itself back on would undo Part 47's auto-suspend for non-payment.
create or replace function public.guard_clinic_activation()
returns trigger
language plpgsql
as $$
begin
  if new.is_active is distinct from old.is_active
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only an admin can activate or deactivate a clinic.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_clinic_activation on clinics;
create trigger guard_clinic_activation
  before update of is_active on clinics
  for each row
  execute function public.guard_clinic_activation();

-- ----------------------------------------------------------------------------
-- 67.4 Internal helpers aren't part of the API
-- ----------------------------------------------------------------------------
-- Every caller of these is itself a SECURITY DEFINER function (runs as the
-- owner), so revoking them from API roles changes nothing for the app.
-- The QR signing key was readable by anyone until now: rotate it with
--   delete from app_secrets where name = 'qr_signing_key';
-- (a new one is generated on next use; previously issued QR codes stop
-- working, so do it when printed clinic check-in codes can be re-issued).

revoke execute on function public.qr_secret() from public, anon, authenticated;
revoke execute on function public.sign_qr_payload(text) from public, anon, authenticated;
revoke execute on function public.sync_verification_status(text, uuid) from public, anon, authenticated;
revoke execute on function public.my_verified_phone_key() from public, anon;
-- Called from the signed-in app (AdminConsole / MyBookings), never signed out.
revoke execute on function public.sweep_expired_verifications() from public, anon;
revoke execute on function public.sweep_follow_up_reminders() from public, anon;

-- ----------------------------------------------------------------------------
-- 67.5 A clinic can only notify the patient of its own appointment
-- ----------------------------------------------------------------------------

drop policy if exists "notifications_insert" on notifications;
create policy "notifications_insert" on notifications for insert
  with check (
    public.is_admin()
    or user_id = auth.uid()
    or (
      appointment_id is not null
      and exists (
        select 1 from appointments a
        join family_members fm on fm.id = a.member_id
        where a.id = notifications.appointment_id
          and public.is_own_clinic(a.clinic_id)
          and fm.account_id = notifications.user_id
      )
    )
  );

create or replace function public.log_notification(
  p_user_id uuid,
  p_appointment_id uuid,
  p_type text,
  p_channel text,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not (
    public.is_admin()
    or p_user_id = auth.uid()
    or (
      p_appointment_id is not null
      and exists (
        select 1 from appointments a
        join family_members fm on fm.id = a.member_id
        where a.id = p_appointment_id
          and public.is_own_clinic(a.clinic_id)
          and fm.account_id = p_user_id
      )
    )
  ) then
    raise exception 'Not allowed to notify this user.' using errcode = '42501';
  end if;

  insert into notifications (user_id, appointment_id, type, channel, message)
  values (p_user_id, p_appointment_id, p_type, p_channel, p_message)
  on conflict (appointment_id, type, channel)
    where appointment_id is not null
      and type in (
        'booking_received', 'appointment_confirmed', 'appointment_rejected', 'reporting_time_reminder'
      )
  do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ----------------------------------------------------------------------------
-- 67.6 No session, no access (401) outside the public pages
-- ----------------------------------------------------------------------------
-- Signed-out pages (/, /search, /doctors/:id) only read clinics, doctors,
-- their availability/holidays, visible reviews, active plans and reference
-- data. Every other table is closed to the anon role entirely, so the API
-- answers a request without a session with 401 instead of an empty list.
-- Signed-out callers keep read-only access to the public tables and can't
-- write anywhere.

do $$
declare
  t text;
  public_read text[] := array[
    'clinics', 'doctors', 'doctor_availability', 'clinic_holidays', 'reviews', 'plans',
    'conditions_ref', 'verification_requirements', 'public_stats_cache'
  ];
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')
  loop
    execute format('revoke insert, update, delete, truncate on table public.%I from anon', t);
    if not (t = any (public_read)) then
      execute format('revoke select on table public.%I from anon', t);
    end if;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 67.7 Permission failures map to 401/403, not 400
-- ----------------------------------------------------------------------------
-- PostgREST turns SQLSTATE 42501 into 401 for a caller with no session and
-- 403 for a signed-in caller - the same status a row-level-security refusal
-- already gets. admin_save_plans() (migration 66) is restated with only its
-- permission check changed; the triggers and log_notification() above use
-- the same code.

create or replace function public.admin_save_plans(p_plans jsonb)
returns setof plans
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  prev_max int;
  seen int := 0;
  active_count int;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception 'Only an admin can edit plans.' using errcode = '42501';
  end if;
  if p_plans is null or jsonb_typeof(p_plans) <> 'array' then
    raise exception 'Send the plans as a list.';
  end if;

  select count(*) into active_count from plans where active;

  for rec in
    select
      (e ->> 'id')::uuid as id,
      (e ->> 'monthly_price')::numeric as monthly_price,
      (e ->> 'min_doctors')::int as min_doctors,
      nullif(e ->> 'max_doctors', '')::int as max_doctors,
      p.name,
      p.active
    from jsonb_array_elements(p_plans) e
    left join plans p on p.id = (e ->> 'id')::uuid
    order by (e ->> 'min_doctors')::int
  loop
    seen := seen + 1;
    if rec.name is null or not rec.active then
      raise exception 'One of these plans no longer exists or has been retired - refresh and try again.';
    end if;
    if rec.monthly_price is null or rec.monthly_price < 0 then
      raise exception '%: the monthly price must be 0 or more.', rec.name;
    end if;
    if rec.min_doctors is null or rec.min_doctors < 1 then
      raise exception '%: the minimum must be at least 1 doctor.', rec.name;
    end if;
    if rec.max_doctors is not null and rec.max_doctors < rec.min_doctors then
      raise exception '%: the maximum (%) can''t be below the minimum (%).', rec.name, rec.max_doctors, rec.min_doctors;
    end if;

    if seen = 1 then
      if rec.min_doctors <> 1 then
        raise exception 'The smallest plan (%) must start at 1 doctor, otherwise a 1-doctor clinic has no plan.', rec.name;
      end if;
    elsif prev_max is null then
      raise exception 'Only the largest plan can have no maximum - % starts after an unlimited plan.', rec.name;
    elsif rec.min_doctors <> prev_max + 1 then
      raise exception '% must start at % doctors, right after the previous plan ends at % (no gaps or overlaps).',
        rec.name, prev_max + 1, prev_max;
    end if;

    prev_max := rec.max_doctors;
  end loop;

  if seen <> active_count then
    raise exception 'Send every active plan together (expected %, got %).', active_count, seen;
  end if;
  if prev_max is not null then
    raise exception 'The largest plan must have no maximum, otherwise clinics above % doctors have no plan.', prev_max;
  end if;

  update plans p
  set monthly_price = (e ->> 'monthly_price')::numeric,
      min_doctors = (e ->> 'min_doctors')::int,
      max_doctors = nullif(e ->> 'max_doctors', '')::int
  from jsonb_array_elements(p_plans) e
  where p.id = (e ->> 'id')::uuid;

  insert into audit_log (actor, action, target)
  values (auth.uid(), 'plans_updated', p_plans::text);

  return query select * from plans where active order by min_doctors;
end;
$$;

