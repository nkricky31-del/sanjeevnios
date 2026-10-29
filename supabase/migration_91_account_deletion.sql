-- ============================================================================
-- 91. DELETING YOUR ACCOUNT
-- ============================================================================
-- Google Play and the App Store require that anyone who can create an
-- account can also delete it, from the app (and, for Google, from a web
-- page: /delete-account on the website, which is this same screen).
--
-- A PATIENT deletes their own account (Profile > Delete account), through the
-- delete-account edge function, which calls delete_account() below and then
-- removes their files from Storage. What happens:
--   * The login is deleted. The phone number can't sign in to it again; a new
--     sign-up with the same number starts a new, empty account.
--   * Deleted with it: the profile, notifications, reviews, declarations,
--     name-change requests (and their ID documents), coupon redemptions,
--     booking restrictions, profile photos, reports they uploaded outside a
--     visit, and family members who never had a clinic visit.
--   * Kept, because clinics must keep medical records (and bills and payments
--     for tax law): every clinic visit - the appointment, notes,
--     prescriptions, reports, bills, payments. Those patient records stay
--     with the clinic but lose the link to the login and every contact and
--     ID detail: phone, email, address, emergency contact, Aadhaar (and its
--     hash), photo. Name, date of birth, gender, MRN and the medical details
--     remain. (The phone and Aadhaar must go: a new family member is given
--     an existing MRN when either matches, and phone numbers get reassigned
--     to new people.)
--   * Not while an appointment is still coming up: cancel it first, so any
--     refund goes through the normal flow.
--
-- CLINIC OWNERS, clinic staff numbers and SanjeevniOS staff send a request
-- instead (account_deletion_requests); the admins are notified. Closing a
-- clinic needs a person: its records, payouts and staff go with it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 91.1 Records that outlive a login
-- ----------------------------------------------------------------------------
-- Drops every foreign key on one column (whatever name it has).
create or replace function pg_temp.drop_fks_on(p_table regclass, p_column text)
returns void
language plpgsql
as $$
declare
  r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.contype = 'f' and con.conrelid = p_table and att.attname = p_column
  loop
    execute format('alter table %s drop constraint %I', p_table, r.conname);
  end loop;
end;
$$;

-- A patient record the clinics keep can lose its login.
select pg_temp.drop_fks_on('public.family_members', 'account_id');
alter table family_members alter column account_id drop not null;
alter table family_members
  add constraint family_members_account_id_fkey
  foreign key (account_id) references profiles (id) on delete set null;

-- A patient who checked themselves in is recorded here; the visit stays.
select pg_temp.drop_fks_on('public.appointments', 'checked_in_by');
alter table appointments
  add constraint appointments_checked_in_by_fkey
  foreign key (checked_in_by) references profiles (id) on delete set null;

select pg_temp.drop_fks_on('public.appointments', 'marked_paid_by');
alter table appointments
  add constraint appointments_marked_paid_by_fkey
  foreign key (marked_paid_by) references profiles (id) on delete set null;

-- The audit trail is append-only (migration 70), so it can neither block a
-- deletion nor be updated by one: no link to the login, like its clinic_id.
-- Each row keeps the actor's id, name and role as they were.
select pg_temp.drop_fks_on('public.audit_log', 'actor');

-- ----------------------------------------------------------------------------
-- 91.2 Notifications for nobody are skipped
-- ----------------------------------------------------------------------------
-- Many notifications are addressed to a patient record's login
-- (family_members.account_id). A record whose patient deleted their account
-- has none; rather than fail whatever the clinic was doing, its notification
-- just isn't written.
create or replace function public.skip_unaddressed_notification()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is null then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists aa_skip_unaddressed on notifications;
create trigger aa_skip_unaddressed
  before insert on notifications
  for each row execute function public.skip_unaddressed_notification();

-- ----------------------------------------------------------------------------
-- 91.3 Who deletes, and who asks
-- ----------------------------------------------------------------------------
-- Clinic owners, clinic staff numbers (migration 57) and SanjeevniOS staff
-- (migration 78) ask; everyone else can delete their own account.
create or replace function public.account_closes_by_request(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((select role from profiles where id = p_user), 'patient') <> 'patient'
    or exists (select 1 from clinics where owner_id = p_user)
    or exists (select 1 from staff_roles where user_id = p_user)
    or exists (
      select 1 from clinic_staff_phones s, auth.users u
      where u.id = p_user
        and public.phone_key(u.phone) is not null
        and public.phone_key(s.phone) = public.phone_key(u.phone)
    );
$$;

revoke all on function public.account_closes_by_request(uuid) from public, anon, authenticated;

-- Appointments still to come, on any of the account's family members.
create or replace function public.account_upcoming_appointments(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from appointments a
  join family_members f on f.id = a.member_id
  where f.account_id = p_user
    and a.status in ('booked', 'accepted', 'checked_in', 'called', 'in_consultation')
    and a.date >= (now() at time zone 'Asia/Kolkata')::date;
$$;

revoke all on function public.account_upcoming_appointments(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 91.4 Deleting a patient's account
-- ----------------------------------------------------------------------------
-- Called only by the delete-account edge function (service role), with the
-- caller it has authenticated. One transaction: everything below happens, or
-- (on any error) nothing does. Returns the Storage files that went with the
-- account, for the function to remove.
create or replace function public.delete_account(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_storage jsonb;
  v_removed integer;
  v_kept integer;
  v_files integer;
begin
  if p_user is null or not exists (select 1 from profiles where id = p_user) then
    raise exception 'ACCOUNT_NOT_FOUND: This account no longer exists.';
  end if;
  if public.account_closes_by_request(p_user) then
    raise exception 'ACCOUNT_CLOSES_BY_REQUEST: Clinic and staff accounts are closed on request.';
  end if;
  if public.account_upcoming_appointments(p_user) > 0 then
    raise exception 'ACCOUNT_HAS_UPCOMING: Cancel your upcoming appointments first.';
  end if;

  -- Files in Storage that go with the account: every family member's photo,
  -- reports uploaded outside a visit (or by a member who never had one), and
  -- the ID documents sent with name-change requests.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_storage
  from (
    select jsonb_build_object('bucket', 'patient-photos', 'path', f.photo_path) as x
    from family_members f
    where f.account_id = p_user and f.photo_path is not null
    union all
    select jsonb_build_object('bucket', 'appointment-files', 'path', fl.storage_path)
    from files fl
    join family_members f on f.id = fl.member_id
    where f.account_id = p_user
      and (fl.appointment_id is null or not exists (select 1 from appointments a where a.member_id = f.id))
    union all
    select jsonb_build_object('bucket', 'id-documents', 'path', n.id_document_path)
    from name_change_requests n
    where n.account_id = p_user and n.id_document_path is not null
  ) s;

  -- Family members no clinic has ever seen: gone, with everything on them.
  delete from family_members f
  where f.account_id = p_user
    and not exists (select 1 from appointments a where a.member_id = f.id);
  get diagnostics v_removed = row_count;

  -- Reports uploaded outside a visit.
  delete from files fl
  using family_members f
  where f.id = fl.member_id and f.account_id = p_user and fl.appointment_id is null;
  get diagnostics v_files = row_count;

  -- What clinics keep: the visit history, without the login or any contact
  -- or ID details.
  update family_members
  set account_id = null,
      phone = null,
      email = null,
      address = null,
      city = null,
      pincode = null,
      emergency_contact_name = null,
      emergency_contact_phone = null,
      govt_id = null,
      govt_id_hash = null,
      photo_path = null
  where account_id = p_user;
  get diagnostics v_kept = row_count;

  -- Recorded while the account still has its name (the audit row keeps it).
  insert into audit_log (actor, action, target, resource_type, resource_id, details)
  values (
    p_user, 'account_deleted', p_user::text, 'account', p_user::text,
    jsonb_build_object('source', 'server', 'patient_records_kept', v_kept,
                       'family_members_removed', v_removed, 'files_removed', v_files)
  );

  -- The login itself; the profile, notifications, reviews, declarations,
  -- name-change requests, redemptions and restrictions go with it.
  delete from auth.users where id = p_user;

  return jsonb_build_object('deleted', true, 'patient_records_kept', v_kept, 'storage', v_storage);
exception
  when foreign_key_violation then
    raise exception 'ACCOUNT_DELETE_BLOCKED: %', sqlerrm;
end;
$$;

revoke all on function public.delete_account(uuid) from public, anon, authenticated;
grant execute on function public.delete_account(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 91.5 Asking to close an account (clinics and staff)
-- ----------------------------------------------------------------------------
create table if not exists account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,      -- no link: the request outlives the account it closes
  phone text,
  role text not null,
  clinic_id uuid,
  reason text check (char_length(reason) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'completed', 'withdrawn')),
  created_at timestamptz not null default now(),
  handled_by uuid,
  handled_at timestamptz,
  note text check (char_length(note) <= 1000)
);

create index if not exists account_deletion_requests_user_idx on account_deletion_requests (user_id, status);
create index if not exists account_deletion_requests_status_idx on account_deletion_requests (status, created_at desc);

alter table account_deletion_requests enable row level security;
drop policy if exists "account_deletion_requests_select" on account_deletion_requests;
create policy "account_deletion_requests_select" on account_deletion_requests
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- Written only through the functions below.
revoke insert, update, delete, truncate on table account_deletion_requests from anon, authenticated;

create or replace function public.request_account_deletion(p_reason text default null)
returns account_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles;
  v_clinic_id uuid;
  v_clinic_name text;
  v_row account_deletion_requests;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select * into v_row from account_deletion_requests
  where user_id = v_uid and status = 'pending'
  order by created_at desc limit 1;
  if found then
    return v_row;  -- already asked
  end if;

  select * into v_profile from profiles where id = v_uid;
  select c.id, c.name into v_clinic_id, v_clinic_name
  from clinics c where c.owner_id = v_uid order by c.created_at limit 1;

  insert into account_deletion_requests (user_id, phone, role, clinic_id, reason)
  values (v_uid, v_profile.phone, coalesce(v_profile.role, 'patient'), v_clinic_id,
          nullif(left(btrim(coalesce(p_reason, '')), 1000), ''))
  returning * into v_row;

  -- Every admin hears about it.
  insert into notifications (user_id, type, message)
  select a.id, 'account_deletion_request',
         case when v_clinic_id is not null
           then format('%s asked to close its clinic account.', coalesce(nullif(v_clinic_name, ''), 'A clinic'))
           else format('%s asked to close their account.', coalesce(nullif(v_profile.name, ''), 'Someone'))
         end
  from profiles a
  where a.role = 'admin';

  perform public.record_audit('account_deletion_requested', v_clinic_id, 'account', v_uid::text, '{}'::jsonb, null);
  return v_row;
end;
$$;

revoke all on function public.request_account_deletion(text) from public, anon;
grant execute on function public.request_account_deletion(text) to authenticated;

create or replace function public.withdraw_account_deletion_request()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  update account_deletion_requests
  set status = 'withdrawn', handled_at = now()
  where user_id = auth.uid() and status = 'pending';
end;
$$;

revoke all on function public.withdraw_account_deletion_request() from public, anon;
grant execute on function public.withdraw_account_deletion_request() to authenticated;

-- An admin marks a request done once the account is closed.
create or replace function public.complete_account_deletion_request(p_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can close an account.' using errcode = '42501';
  end if;
  update account_deletion_requests
  set status = 'completed', handled_by = auth.uid(), handled_at = now(),
      note = nullif(left(btrim(coalesce(p_note, '')), 1000), '')
  where id = p_id and status = 'pending';
  if not found then
    raise exception 'That request is not pending.';
  end if;
end;
$$;

revoke all on function public.complete_account_deletion_request(uuid, text) from public, anon;
grant execute on function public.complete_account_deletion_request(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 91.6 What the Delete account screen shows
-- ----------------------------------------------------------------------------
-- mode 'self' (delete now) or 'request' (ask), how many appointments are
-- still to come, and any request already sent.
create or replace function public.account_deletion_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_req account_deletion_requests;
begin
  if v_uid is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select * into v_req from account_deletion_requests
  where user_id = v_uid and status = 'pending'
  order by created_at desc limit 1;
  return jsonb_build_object(
    'mode', case when public.account_closes_by_request(v_uid) then 'request' else 'self' end,
    'upcoming', public.account_upcoming_appointments(v_uid),
    'pending_request', case when v_req.id is null then null
                            else jsonb_build_object('id', v_req.id, 'created_at', v_req.created_at) end
  );
end;
$$;

revoke all on function public.account_deletion_status() from public, anon;
grant execute on function public.account_deletion_status() to authenticated;
