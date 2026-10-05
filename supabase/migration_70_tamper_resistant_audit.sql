-- ============================================================================
-- 70. A TAMPER-RESISTANT AUDIT TRAIL FOR SENSITIVE ACTIONS
-- ============================================================================
-- Until now audit_log was (actor, action, target, at), writable by any signed-in
-- user as themselves, readable only by the platform admin, and it knew nothing
-- about WHICH CLINIC an action belonged to. This migration makes it the record
-- of who did what, to which resource, in which clinic, and when.
--
--   70.1 Columns: clinic_id, actor_role, actor_name, resource_type,
--        resource_id, details (jsonb), reason. `target` stays for old rows.
--   70.2 Append-only. Nobody can UPDATE, DELETE or TRUNCATE a row through the
--        app, and direct INSERT is closed too: rows are only written by
--        server-side code via record_audit(), which stamps the actor and the
--        time itself. (Defence in depth: privileges revoked + triggers that
--        raise, so even the service role is refused.)
--   70.3 No secrets. A scrubber drops any details key that looks like an OTP,
--        password, token, secret, pin or code before the row is stored, and
--        the auth logger accepts only the last four digits of a phone.
--   70.4 audit.read. The clinic owner always has it; staff get it per person
--        (clinic_staff_phones.permissions). Reading is tenant-scoped by RLS:
--        a clinic only ever sees rows whose clinic_id is its own. The platform
--        admin keeps the existing platform-wide read.
--   70.5 What is recorded:
--          staff role / permission changes   (old -> new, actor, target)
--          appointment created / status / reschedule
--          health-record open and file download (re-created below)
--          patient data export               (re-created below)
--          document upload
--          admin booking override            (re-created below, with reason)
--          admin decisions (client helper now calls admin_record_decision)
--          logins (database trigger) and OTP outcomes (client-reported)
--
-- Honest limits: a database superuser can still disable the triggers, so this
-- is tamper-RESISTANT against every app role, not tamper-proof against the
-- database owner. OTP failures happen inside Supabase Auth, which has no hook
-- here, so those entries are reported by the login pages and flagged
-- details.source = 'client'. A refused action rolls back with its transaction,
-- so only actions that happened are recorded.
-- ============================================================================

-- 70.1 Columns ------------------------------------------------------------------
alter table audit_log add column if not exists clinic_id uuid;          -- no FK on purpose:
alter table audit_log add column if not exists actor_role text;         -- deleting a clinic
alter table audit_log add column if not exists actor_name text;         -- must not delete
alter table audit_log add column if not exists resource_type text;      -- (or block on) its
alter table audit_log add column if not exists resource_id text;        -- history.
alter table audit_log add column if not exists details jsonb not null default '{}'::jsonb;
alter table audit_log add column if not exists reason text;

create index if not exists audit_log_clinic_at_idx on audit_log (clinic_id, at desc);
create index if not exists audit_log_clinic_action_idx on audit_log (clinic_id, action, at desc);

-- 70.2 Append-only ----------------------------------------------------------------
create or replace function public.audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'The audit trail is append-only.' using errcode = '42501';
end;
$$;

drop trigger if exists audit_log_no_update_delete on audit_log;
create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function public.audit_log_immutable();

drop trigger if exists audit_log_no_truncate on audit_log;
create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function public.audit_log_immutable();

revoke insert, update, delete, truncate on table audit_log from anon, authenticated;

-- The old "any signed-in user may insert their own row" policy is gone: a
-- client could forge entries (as itself) with any action text.
drop policy if exists "audit_insert" on audit_log;

-- 70.3 Scrubber + stamping ---------------------------------------------------------
create or replace function public.audit_scrub(p_details jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    (select jsonb_object_agg(k, v)
       from jsonb_each(case when jsonb_typeof(p_details) = 'object' then p_details else '{}'::jsonb end) as e(k, v)
      where k !~* '(^|_)(otp|password|passwd|secret|token|pin|code)($|_)'),
    '{}'::jsonb
  );
$$;

-- Every row gets its time and actor from the server, never from the caller.
create or replace function public.audit_log_stamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  new.at := now();
  new.actor := coalesce(new.actor, v_uid);
  new.details := public.audit_scrub(new.details);

  if new.actor is not null and new.actor_name is null then
    select coalesce(nullif(p.name, ''), 'user ' || right(coalesce(p.phone, ''), 4))
      into new.actor_name
    from profiles p where p.id = new.actor;
  end if;

  if new.actor_role is null then
    if v_uid is null and new.details->>'source' = 'client' then
      new.actor_role := 'anonymous'; -- reported by a login page before sign-in
    elsif v_uid is null and new.details->>'source' = 'server' then
      new.actor_role := 'user';
    elsif v_uid is null then
      new.actor_role := 'system';
    elsif public.is_admin() then
      new.actor_role := 'admin';
    elsif new.clinic_id is not null then
      new.actor_role := coalesce(public.my_clinic_role(new.clinic_id), 'patient');
    else
      new.actor_role := 'user';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists audit_log_stamp on audit_log;
create trigger audit_log_stamp
  before insert on audit_log
  for each row execute function public.audit_log_stamp();

-- The one writer. Internal only: not callable from the API.
create or replace function public.record_audit(
  p_action text,
  p_clinic_id uuid,
  p_resource_type text,
  p_resource_id text,
  p_details jsonb default '{}'::jsonb,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (action, target, clinic_id, resource_type, resource_id, details, reason)
  values (p_action, p_resource_id, p_clinic_id, p_resource_type, p_resource_id,
          coalesce(p_details, '{}'::jsonb), p_reason);
end;
$$;

revoke all on function public.record_audit(text, uuid, text, text, jsonb, text) from public, anon, authenticated;

-- 70.4 audit.read ---------------------------------------------------------------------
alter table clinic_staff_phones add column if not exists permissions text[] not null default '{}';
alter table clinic_staff_phones drop constraint if exists clinic_staff_phones_permissions_check;
alter table clinic_staff_phones add constraint clinic_staff_phones_permissions_check
  check (permissions <@ array['audit.read']::text[]);

create or replace function public.has_clinic_permission(p_clinic_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and p_clinic_id is not null
    and (
      -- the owner holds every clinic-level permission
      public.is_clinic_owner(p_clinic_id)
      or exists (
        select 1 from clinic_staff_phones csp
        where csp.clinic_id = p_clinic_id
          and public.phone_key(csp.phone) = public.my_verified_phone_key()
          and p_permission = any (csp.permissions)
      )
    );
$$;

revoke all on function public.has_clinic_permission(uuid, text) from public, anon;
grant execute on function public.has_clinic_permission(uuid, text) to authenticated;

-- Tenant-scoped read: a clinic sees only rows stamped with its own clinic_id.
drop policy if exists "audit_select_clinic" on audit_log;
create policy "audit_select_clinic" on audit_log for select
  using (clinic_id is not null and public.has_clinic_permission(clinic_id, 'audit.read'));
-- (the existing "audit_select" policy still gives the platform admin the full trail)

-- 70.5a Staff role / permission changes -------------------------------------------------
create or replace function public.audit_staff_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row clinic_staff_phones;
  v_old clinic_staff_phones;
  v_action text;
begin
  if tg_op = 'DELETE' then
    v_row := old; v_action := 'staff.removed';
  elsif tg_op = 'INSERT' then
    v_row := new; v_action := 'staff.added';
  else
    v_row := new; v_old := old;
    if (old.role, old.doctor_id, old.permissions) is not distinct from (new.role, new.doctor_id, new.permissions) then
      return new; -- a label-only edit is not a permission change
    end if;
    v_action := 'staff.role_changed';
  end if;

  perform public.record_audit(
    v_action, v_row.clinic_id, 'staff', v_row.id::text,
    jsonb_build_object(
      'target_phone_last4', right(v_row.phone, 4),
      'old_role', case when tg_op = 'INSERT' then null else coalesce(v_old.role, v_row.role) end,
      'new_role', case when tg_op = 'DELETE' then null else v_row.role end,
      'old_permissions', case when tg_op = 'INSERT' then null else to_jsonb(coalesce(v_old.permissions, v_row.permissions)) end,
      'new_permissions', case when tg_op = 'DELETE' then null else to_jsonb(v_row.permissions) end,
      'doctor_id', v_row.doctor_id
    )
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists audit_staff_change on clinic_staff_phones;
create trigger audit_staff_change
  after insert or update or delete on clinic_staff_phones
  for each row execute function public.audit_staff_change();

-- The staff-add RPC used to write its own thin audit row; the trigger above
-- now records it (with old -> new role), so drop the duplicate.
create or replace function public.add_clinic_staff_phone(
  p_phone text,
  p_label text,
  p_role text default 'receptionist',
  p_doctor_id uuid default null
)
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
  select id into my_clinic from clinics where owner_id = auth.uid();
  if my_clinic is null then
    raise exception 'Only the clinic owner can add staff.' using errcode = '42501';
  end if;
  if p_role not in ('receptionist', 'doctor') then
    raise exception 'Choose Receptionist or Doctor.';
  end if;
  if p_role = 'doctor' and p_doctor_id is null then
    raise exception 'Choose which doctor this login is for.';
  end if;

  normalized := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(normalized) = 10 then
    normalized := '91' || normalized;
  end if;
  if normalized !~ '^91\d{10}$' then
    raise exception 'Enter a valid 10-digit phone number.';
  end if;

  insert into clinic_staff_phones (clinic_id, phone, label, role, doctor_id)
  values (
    my_clinic, normalized, nullif(trim(coalesce(p_label, '')), ''), p_role,
    case when p_role = 'doctor' then p_doctor_id end
  )
  on conflict (clinic_id, phone) do update
    set label = excluded.label, role = excluded.role, doctor_id = excluded.doctor_id
  returning * into result;

  return result;
end;
$$;

-- 70.5b Appointment actions ------------------------------------------------------------------
-- Replaces migration 69's thin 'appointment.created' row.
drop trigger if exists on_appointment_zz_audit_created on appointments;
drop function if exists public.audit_appointment_created();

create or replace function public.audit_appointment_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.record_audit(
      'appointment.created', new.clinic_id, 'appointment', new.id::text,
      jsonb_build_object('member_id', new.member_id, 'doctor_id', new.doctor_id,
                         'date', new.date, 'slot_time', new.slot_time, 'status', new.status)
    );
    return new;
  end if;

  if new.status is distinct from old.status then
    perform public.record_audit(
      'appointment.status_changed', new.clinic_id, 'appointment', new.id::text,
      jsonb_build_object('member_id', new.member_id, 'from', old.status, 'to', new.status)
    );
  end if;
  if (new.doctor_id, new.date, new.slot_time) is distinct from (old.doctor_id, old.date, old.slot_time) then
    perform public.record_audit(
      'appointment.rescheduled', new.clinic_id, 'appointment', new.id::text,
      jsonb_build_object('member_id', new.member_id,
        'from', jsonb_build_object('doctor_id', old.doctor_id, 'date', old.date, 'slot_time', old.slot_time),
        'to',   jsonb_build_object('doctor_id', new.doctor_id, 'date', new.date, 'slot_time', new.slot_time))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_appointment_zz_audit_insert on appointments;
create trigger on_appointment_zz_audit_insert
  after insert on appointments
  for each row execute function public.audit_appointment_change();

drop trigger if exists on_appointment_zz_audit_update on appointments;
create trigger on_appointment_zz_audit_update
  after update of status, doctor_id, date, slot_time on appointments
  for each row
  when (
    (old.status, old.doctor_id, old.date, old.slot_time)
      is distinct from (new.status, new.doctor_id, new.date, new.slot_time)
  )
  execute function public.audit_appointment_change();

-- 70.5c Document upload -------------------------------------------------------------------------
create or replace function public.audit_file_upload()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic uuid;
begin
  select a.clinic_id into v_clinic from appointments a where a.id = new.appointment_id;
  perform public.record_audit(
    'document.uploaded', v_clinic, 'file', new.id::text,
    jsonb_build_object('type', new.type, 'member_id', new.member_id, 'appointment_id', new.appointment_id)
  );
  return new;
end;
$$;

drop trigger if exists on_file_zz_audit_upload on files;
create trigger on_file_zz_audit_upload
  after insert on files
  for each row execute function public.audit_file_upload();

-- 70.5d Health-record access, download and export (re-created from migration 68
-- with the structured audit call; behaviour and permission checks unchanged).
create or replace function public.open_patient_health_record(p_appointment_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  appt appointments;
  v_expires timestamptz := now() + interval '12 hours';
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  select * into appt from appointments
  where id = p_appointment_id and public.is_own_clinic(clinic_id);
  if appt.id is null then
    raise exception 'Appointment not found.' using errcode = 'P0002';
  end if;
  if not public.has_patient_permission(appt.clinic_id, appt.member_id, 'patient.health.read') then
    raise exception 'Your role can''t open this patient''s clinical record.' using errcode = '42501';
  end if;

  insert into patient_access_grants (user_id, clinic_id, member_id, permission, expires_at)
  values (auth.uid(), appt.clinic_id, appt.member_id, 'patient.health.read', v_expires);

  perform public.record_audit(
    'patient.health.read', appt.clinic_id, 'patient', appt.member_id::text,
    jsonb_build_object('appointment_id', appt.id, 'access_until', v_expires)
  );

  return v_expires;
end;
$$;

create or replace function public.authorize_patient_file_download(p_file_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  f files;
  v_clinic uuid;
  v_member uuid;
  v_by text := 'staff';
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select * into f from files where id = p_file_id;
  if f.id is null then
    raise exception 'File not found.' using errcode = 'P0002';
  end if;
  select a.clinic_id, a.member_id into v_clinic, v_member from appointments a where a.id = f.appointment_id;
  v_member := coalesce(v_member, f.member_id);

  if public.is_own_mrn(v_member) then
    v_by := 'patient'; -- the patient's own file
  elsif v_clinic is not null and public.is_own_clinic(v_clinic) then
    if not public.has_patient_permission(v_clinic, v_member, 'patient.health.download') then
      raise exception 'Your role can''t download patient reports.' using errcode = '42501';
    end if;
    insert into patient_access_grants (user_id, clinic_id, member_id, permission, object_path, expires_at)
    values (auth.uid(), v_clinic, v_member, 'patient.health.download', f.storage_path, now() + interval '5 minutes');
  elsif not public.is_admin() then
    raise exception 'File not found.' using errcode = 'P0002';
  else
    v_by := 'admin';
  end if;

  perform public.record_audit(
    'patient.health.download', v_clinic, 'file', f.id::text,
    jsonb_build_object('member_id', v_member, 'type', f.type, 'downloaded_by', v_by)
  );

  return f.storage_path;
end;
$$;

create or replace function public.export_clinic_patients(p_clinic_id uuid)
returns table (mrn text, name text, phone text, gender text, age integer, last_visit date, visits integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not public.has_patient_permission(p_clinic_id, null, 'patient.export') then
    raise exception 'Exporting patient data needs the patient.export permission for this clinic.' using errcode = '42501';
  end if;

  perform public.record_audit('patient.export', p_clinic_id, 'clinic', p_clinic_id::text, '{}'::jsonb);

  return query
  select fm.mrn, fm.name, fm.phone, fm.gender,
         case when fm.dob is not null then extract(year from age(current_date, fm.dob))::int end,
         max(a.date), count(*)::int
  from appointments a
  join family_members fm on fm.id = a.member_id
  where a.clinic_id = p_clinic_id
  group by fm.id, fm.mrn, fm.name, fm.phone, fm.gender, fm.dob
  order by fm.name;
end;
$$;

-- 70.5e Admin booking override (re-created from migration 69, audited with
-- the rule, the target and the reason).
create or replace function public.admin_override_booking(
  p_member_id uuid,
  p_doctor_id uuid,
  p_clinic_id uuid,
  p_date date,
  p_slot_time time,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.has_admin_permission('booking.override') then
    raise exception 'PERMISSION_DENIED: booking.override is required.' using errcode = '42501';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'A reason of at least 10 characters is required to override a booking restriction.'
      using errcode = '22023';
  end if;

  perform set_config('app.booking_override', 'on', true);

  insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
  values (p_member_id, p_doctor_id, p_clinic_id, p_date, p_slot_time, 'booked', 'pay_at_clinic')
  returning id into v_id;

  perform set_config('app.booking_override', 'off', true);

  perform public.record_audit(
    'booking.override', p_clinic_id, 'appointment', v_id::text,
    jsonb_build_object('rule', 'patient_booking_rules', 'member_id', p_member_id, 'doctor_id', p_doctor_id),
    btrim(p_reason)
  );

  return v_id;
end;
$$;

revoke all on function public.admin_override_booking(uuid, uuid, uuid, date, time, text) from public, anon;
grant execute on function public.admin_override_booking(uuid, uuid, uuid, date, time, text) to authenticated;

-- 70.5f Admin decisions: the client helper used to INSERT straight into
-- audit_log. It now calls this, which only an admin can.
create or replace function public.admin_record_decision(p_action text, p_target text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  perform public.record_audit(p_action, null, 'admin_decision', p_target, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_record_decision(text, text) from public, anon;
grant execute on function public.admin_record_decision(text, text) to authenticated;

-- 70.5g Logins and OTP outcomes ------------------------------------------------------------------
-- Successful sign-in: a trigger on auth.users, so it can't be skipped by a
-- client. Wrapped so a logging problem can never block a login.
create or replace function public.audit_login()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.last_sign_in_at is distinct from old.last_sign_in_at then
      -- Not via record_audit: this runs before the session exists (auth.uid()
      -- is null), so the actor is set explicitly - and only if the profile
      -- row exists yet (it may not on a first-ever sign-in).
      insert into audit_log (actor, action, resource_type, resource_id, details)
      values (
        (select p.id from profiles p where p.id = new.id),
        'auth.login', 'user', new.id::text,
        jsonb_build_object('source', 'server', 'phone_last4', right(coalesce(new.phone, ''), 4))
      );
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

do $$
begin
  drop trigger if exists audit_login on auth.users;
  create trigger audit_login
    after update of last_sign_in_at on auth.users
    for each row execute function public.audit_login();
exception when others then
  raise notice 'Could not attach the login trigger to auth.users (%): login events will not be recorded server-side.', sqlerrm;
end;
$$;

-- OTP outcomes, as reported by the login pages. Callable before sign-in, so it
-- is narrow on purpose: fixed event/outcome lists, last four digits only (the
-- OTP itself is never an argument), and a global throttle so it can't be used
-- to flood the trail.
create or replace function public.log_auth_event(p_event text, p_outcome text, p_phone_last4 text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_event not in ('otp.requested', 'otp.verify') or p_outcome not in ('success', 'failure', 'sent') then
    return;
  end if;
  if (select count(*) from audit_log
      where action like 'auth.otp%' and at > now() - interval '1 minute') >= 60 then
    return;
  end if;
  insert into audit_log (action, resource_type, details)
  values (
    'auth.' || p_event, 'user',
    jsonb_build_object(
      'outcome', p_outcome,
      'phone_last4', case when p_phone_last4 ~ '^\d{4}$' then p_phone_last4 end,
      'source', 'client'
    )
  );
end;
$$;

revoke all on function public.log_auth_event(text, text, text) from public;
grant execute on function public.log_auth_event(text, text, text) to anon, authenticated;
