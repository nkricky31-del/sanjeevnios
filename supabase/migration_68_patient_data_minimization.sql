-- ============================================================================
-- 68. RETURN ONLY THE PATIENT DATA A ROLE NEEDS (works with Part 40's
--     MRN/encounter model and migration 67's server-side authorization)
-- ============================================================================
-- Before this, every login attached to a clinic (its owner, or any phone in
-- clinic_staff_phones) passed the same is_own_clinic() check, so anyone at
-- the front desk could read every visit note, diagnosis, prescription,
-- report and condition of every patient who had ever booked there - and the
-- whole patient row (govt_id, address, known conditions...) with it. Doctors
-- had no logins at all.
--
--   68.1 Roles inside a clinic. clinic_staff_phones gains role
--        ('receptionist' | 'doctor') and doctor_id (which doctor profile a
--        doctor login is). The clinic OWNER keeps full clinical access to
--        their own clinic's patients (decided: today every owner runs their
--        own consultations). Only the owner (or an admin) manages staff.
--   68.2 Permissions, checked on the server for a given clinic + patient:
--          patient.health.read      owner; doctor with an appointment or
--                                   encounter with this patient here
--          patient.health.download  same as read
--          patient.export           owner, only if an admin has enabled
--                                   clinics.patient_export_enabled
--        Receptionists hold none of them.
--   68.3 Audited access grants. Postgres can't audit a SELECT (no read
--        triggers; API reads run read-only), so clinical tables only show a
--        patient's records to clinic staff who hold a live grant for that
--        patient - created by open_patient_health_record(), which checks
--        patient.health.read and writes the audit entry. A raw API read
--        without opening the record first returns nothing, and reading many
--        patients means one audited open per patient (no silent bulk read).
--        Downloads work the same way with a 5-minute, per-file grant.
--   68.4 Field-level minimization for the front desk: patient_contact (a
--        view) exposes only name, relation, phone, gender and AGE (never the
--        date of birth, govt_id, address, blood group or conditions) for
--        patients with a recent or upcoming visit at the caller's clinic.
--        get_clinic_queue() and the new visit_rx_status()/clinic_rx_worklist()
--        return only what their screens show. Staff can no longer read
--        family_members rows directly without a health grant.
--   68.5 Bulk export only through export_clinic_patients(), which requires
--        patient.export and is audited.
--
-- Admins keep their existing platform-wide access (is_admin() branches are
-- untouched) for support and moderation. Patients keep full access to their
-- own records (is_own_mrn(), migration 67).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 68.1 Staff roles
-- ----------------------------------------------------------------------------

alter table clinic_staff_phones add column if not exists role text not null default 'receptionist';
alter table clinic_staff_phones add column if not exists doctor_id uuid references doctors (id) on delete set null;
alter table clinic_staff_phones drop constraint if exists clinic_staff_phones_role_check;
alter table clinic_staff_phones add constraint clinic_staff_phones_role_check
  check (role in ('receptionist', 'doctor'));
alter table clinic_staff_phones drop constraint if exists clinic_staff_phones_doctor_check;
alter table clinic_staff_phones add constraint clinic_staff_phones_doctor_check
  check ((role = 'doctor') = (doctor_id is not null));

-- A doctor login can only be one of THIS clinic's own doctors.
create or replace function public.check_staff_doctor_clinic()
returns trigger
language plpgsql
as $$
begin
  if new.doctor_id is not null
     and not exists (select 1 from doctors d where d.id = new.doctor_id and d.clinic_id = new.clinic_id) then
    raise exception 'That doctor doesn''t belong to this clinic.';
  end if;
  return new;
end;
$$;

drop trigger if exists check_staff_doctor_clinic on clinic_staff_phones;
create trigger check_staff_doctor_clinic
  before insert or update on clinic_staff_phones
  for each row
  execute function public.check_staff_doctor_clinic();

-- Only the clinic OWNER (or an admin) manages staff - a receptionist could
-- otherwise add a phone as 'doctor' and hand themselves clinical access.
create or replace function public.is_clinic_owner(p_clinic_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from clinics where id = p_clinic_id and owner_id = auth.uid());
$$;

drop policy if exists "clinic_staff_phones_insert" on clinic_staff_phones;
create policy "clinic_staff_phones_insert" on clinic_staff_phones for insert
  with check (public.is_clinic_owner(clinic_id) or public.is_admin());
drop policy if exists "clinic_staff_phones_update" on clinic_staff_phones;
create policy "clinic_staff_phones_update" on clinic_staff_phones for update
  using (public.is_clinic_owner(clinic_id) or public.is_admin())
  with check (public.is_clinic_owner(clinic_id) or public.is_admin());
drop policy if exists "clinic_staff_phones_delete" on clinic_staff_phones;
create policy "clinic_staff_phones_delete" on clinic_staff_phones for delete
  using (public.is_clinic_owner(clinic_id) or public.is_admin());

-- Replaces the 2-argument version (migration 57): owner-only now, and takes
-- the role (+ which doctor, for a doctor login).
drop function if exists public.add_clinic_staff_phone(text, text);
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

  insert into audit_log (actor, action, target)
  values (auth.uid(), 'clinic_staff_' || p_role || '_added', my_clinic::text || ':' || normalized);

  return result;
end;
$$;

-- ----------------------------------------------------------------------------
-- 68.2 Permissions
-- ----------------------------------------------------------------------------

-- Export is off for every clinic until an admin turns it on for that clinic.
alter table clinics add column if not exists patient_export_enabled boolean not null default false;

create or replace function public.guard_clinic_patient_export()
returns trigger
language plpgsql
as $$
begin
  if new.patient_export_enabled is distinct from old.patient_export_enabled
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only an admin can allow patient data export.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_clinic_patient_export on clinics;
create trigger guard_clinic_patient_export
  before update of patient_export_enabled on clinics
  for each row
  execute function public.guard_clinic_patient_export();

-- The doctor profile a staff login is, at this clinic (null otherwise).
create or replace function public.my_staff_doctor_id(p_clinic_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select csp.doctor_id
  from clinic_staff_phones csp
  where csp.clinic_id = p_clinic_id
    and csp.role = 'doctor'
    and public.phone_key(csp.phone) = public.my_verified_phone_key()
  limit 1;
$$;

-- 'owner' | 'doctor' | 'receptionist' | null for the caller at this clinic.
create or replace function public.my_clinic_role(p_clinic_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when public.is_clinic_owner(p_clinic_id) then 'owner'
    else (
      select csp.role from clinic_staff_phones csp
      where csp.clinic_id = p_clinic_id
        and public.phone_key(csp.phone) = public.my_verified_phone_key()
      order by (csp.role = 'doctor') desc
      limit 1
    )
  end;
$$;

-- The single place the permission matrix lives (see the header).
create or replace function public.has_patient_permission(p_clinic_id uuid, p_member_id uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
  v_doctor uuid;
begin
  if auth.uid() is null or p_clinic_id is null then
    return false;
  end if;
  v_role := public.my_clinic_role(p_clinic_id);

  if p_permission = 'patient.export' then
    return v_role = 'owner'
      and exists (select 1 from clinics where id = p_clinic_id and patient_export_enabled);
  end if;

  if p_permission not in ('patient.health.read', 'patient.health.download') then
    return false;
  end if;
  if v_role = 'owner' then
    -- Only for patients who have actually been seen/booked here.
    return exists (select 1 from appointments where clinic_id = p_clinic_id and member_id = p_member_id);
  end if;
  if v_role = 'doctor' then
    v_doctor := public.my_staff_doctor_id(p_clinic_id);
    return exists (
      select 1 from appointments
      where clinic_id = p_clinic_id and member_id = p_member_id and doctor_id = v_doctor
    ) or exists (
      select 1 from encounters
      where clinic_id = p_clinic_id and patient_id = p_member_id and doctor_id = v_doctor
    );
  end if;
  return false; -- receptionist, or no role at this clinic
end;
$$;

-- ----------------------------------------------------------------------------
-- 68.3 Audited access grants
-- ----------------------------------------------------------------------------

create table if not exists patient_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  clinic_id uuid not null references clinics (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete cascade,
  permission text not null check (permission in ('patient.health.read', 'patient.health.download')),
  object_path text, -- the one storage object a download grant is for
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists patient_access_grants_lookup
  on patient_access_grants (user_id, member_id, permission, expires_at);
-- No policies: nobody reads or writes this table through the API; only the
-- SECURITY DEFINER functions below do.
alter table patient_access_grants enable row level security;
revoke all on table patient_access_grants from anon, authenticated;

-- Does the caller hold a live health-read grant for this patient at this
-- clinic (and still the permission behind it)?
create or replace function public.has_health_access(p_clinic_id uuid, p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
    and exists (
      select 1 from patient_access_grants g
      where g.user_id = auth.uid()
        and g.clinic_id = p_clinic_id
        and g.member_id = p_member_id
        and g.permission = 'patient.health.read'
        and g.expires_at > now()
    )
    and public.has_patient_permission(p_clinic_id, p_member_id, 'patient.health.read');
$$;

-- What a doctor's/owner's screen calls when it opens a patient's clinical
-- record for an appointment. Checks the permission, writes the audit entry,
-- and grants this user 12 hours of read access to this one patient here.
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
  -- Only an appointment at a clinic the caller belongs to is even visible;
  -- anything else is "not found", never "exists but forbidden".
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

  insert into audit_log (actor, action, target)
  values (auth.uid(), 'patient.health.read', appt.member_id::text || ' via appointment ' || appt.id::text);

  return v_expires;
end;
$$;

-- Same, for the directly-addressable /encounters/:id page (EncounterDetail.tsx),
-- which only knows the encounter. Returns null (rather than an error) when
-- the encounter isn't at one of the caller's clinics - e.g. a patient
-- viewing their own encounter, who needs no grant at all.
create or replace function public.open_encounter_health_record(p_encounter_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_appointment uuid;
begin
  select a.id into v_appointment
  from appointments a
  where a.encounter_id = p_encounter_id and public.is_own_clinic(a.clinic_id)
  limit 1;
  if v_appointment is null then
    return null;
  end if;
  return public.open_patient_health_record(v_appointment);
end;
$$;

-- What every appointment-file download calls first. A patient may always
-- download their own files; clinic staff need patient.health.download. Either
-- way it's audited and returns the storage path, which the storage rule
-- below only serves to staff holding a live 5-minute grant for it.
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
    null; -- the patient's own file
  elsif v_clinic is not null and public.is_own_clinic(v_clinic) then
    if not public.has_patient_permission(v_clinic, v_member, 'patient.health.download') then
      raise exception 'Your role can''t download patient reports.' using errcode = '42501';
    end if;
    insert into patient_access_grants (user_id, clinic_id, member_id, permission, object_path, expires_at)
    values (auth.uid(), v_clinic, v_member, 'patient.health.download', f.storage_path, now() + interval '5 minutes');
  elsif not public.is_admin() then
    raise exception 'File not found.' using errcode = 'P0002';
  end if;

  insert into audit_log (actor, action, target)
  values (auth.uid(), 'patient.health.download', f.id::text || ' (' || v_member::text || ')');

  return f.storage_path;
end;
$$;

-- Front-desk screens need to know whether a visit can be completed - only
-- these two booleans, never the visit itself.
create or replace function public.visit_rx_status(p_appointment_id uuid)
returns table (has_visit boolean, rx_complete boolean)
language sql
stable
security definer
set search_path = public
as $$
  select v.id is not null,
         coalesce(v.no_prescription or exists (
           select 1 from prescriptions p where p.visit_id = v.id and p.status = 'attached'
         ), false)
  from (select 1) one
  left join lateral (
    select vv.* from visits vv
    join appointments a on a.id = vv.appointment_id
    where vv.appointment_id = p_appointment_id
      and (public.is_own_clinic(a.clinic_id) or public.is_admin())
    order by vv.created_at desc
    limit 1
  ) v on true;
$$;

-- RxPendingWorklist.tsx: visits still waiting on a prescription - patient
-- name, token and slot only.
create or replace function public.clinic_rx_worklist(p_since date)
returns table (
  visit_id uuid, appointment_id uuid, patient_name text, token_number int,
  date date, slot_time time, doctor_id uuid, created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select v.id, a.id, fm.name, a.token_number, a.date, a.slot_time, a.doctor_id, v.created_at
  from visits v
  join appointments a on a.id = v.appointment_id
  join family_members fm on fm.id = a.member_id
  where a.clinic_id = public.my_clinic_id()
    and a.date >= p_since
    and not v.no_prescription
    and not exists (select 1 from prescriptions p where p.visit_id = v.id and p.status = 'attached')
  order by v.created_at desc;
$$;

-- Clinical tables: the clinic branch now needs a live, audited grant.
drop policy if exists "visits_select" on visits;
create policy "visits_select" on visits for select
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a
      where a.id = visits.appointment_id
        and (public.is_own_mrn(a.member_id) or public.has_health_access(a.clinic_id, a.member_id))
    )
  );
drop policy if exists "visits_write" on visits;
create policy "visits_write" on visits for all
  using (
    public.is_admin()
    or exists (select 1 from appointments a where a.id = visits.appointment_id and public.has_health_access(a.clinic_id, a.member_id))
  )
  with check (
    public.is_admin()
    or exists (select 1 from appointments a where a.id = visits.appointment_id and public.has_health_access(a.clinic_id, a.member_id))
  );

drop policy if exists "prescriptions_select" on prescriptions;
create policy "prescriptions_select" on prescriptions for select
  using (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id
        and (public.is_own_mrn(a.member_id) or public.has_health_access(a.clinic_id, a.member_id))
    )
  );
drop policy if exists "prescriptions_write" on prescriptions;
create policy "prescriptions_write" on prescriptions for all
  using (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

-- Files: anyone at the clinic may still ATTACH a document to an appointment
-- (files_insert unchanged - e.g. the desk scanning a referral letter), but
-- only a grant holder may see that it exists.
drop policy if exists "files_select" on files;
create policy "files_select" on files for select
  using (
    public.is_admin()
    or public.is_own_mrn(member_id)
    or exists (
      select 1 from appointments a
      where a.id = files.appointment_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

drop policy if exists "patient_conditions_select" on patient_conditions;
create policy "patient_conditions_select" on patient_conditions for select
  using (
    public.is_admin()
    or public.is_own_mrn(patient_id)
    or exists (
      select 1 from appointments a
      where a.member_id = patient_conditions.patient_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

drop policy if exists "encounters_select_clinic" on encounters;
create policy "encounters_select_clinic" on encounters for select
  using (public.has_health_access(clinic_id, patient_id));

-- The full patient row (govt_id, address, blood group, conditions...) is
-- clinical-grade too: clinic staff need a grant; the desk uses
-- patient_contact instead.
drop policy if exists "family_select" on family_members;
create policy "family_select" on family_members for select
  using (
    account_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from appointments a
      where a.member_id = family_members.id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

create or replace function public.has_download_grant(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (
    select 1 from patient_access_grants g
    where g.user_id = auth.uid()
      and g.permission = 'patient.health.download'
      and g.object_path = p_object_name
      and g.expires_at > now()
  );
$$;

revoke execute on function public.has_download_grant(text) from public, anon;

-- Storage: clinic staff download a report only with a live per-file grant
-- (created, and audited, by authorize_patient_file_download()).
drop policy if exists "appointment_files_select" on storage.objects;
create policy "appointment_files_select" on storage.objects for select
  using (
    bucket_id = 'appointment-files'
    and exists (
      select 1 from appointments a
      where (a.id)::text = (storage.foldername(objects.name))[1]
        and (
          public.is_own_mrn(a.member_id)
          or public.is_admin()
          or public.has_download_grant(objects.name)
        )
    )
  );

-- ----------------------------------------------------------------------------
-- 68.4 Field-level minimization for the front desk
-- ----------------------------------------------------------------------------

-- Only these columns, only for patients with a visit at the caller's clinic
-- from 30 days ago onward. Owned by the migration role (not security
-- invoker), so it reads family_members past its row rules - its own WHERE is
-- the access rule. Embeddable from appointments as
--   appointments?select=...,family_members:patient_contact(name, phone, age)
create or replace view public.patient_contact as
select
  fm.id,
  fm.name,
  fm.relation,
  fm.account_id,
  fm.phone,
  fm.gender,
  case when fm.dob is not null then extract(year from age(current_date, fm.dob))::int end as age,
  fm.mrn
from family_members fm
where auth.uid() is not null
  and (
    fm.account_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from appointments a
      where a.member_id = fm.id
        and a.date >= current_date - 30
        and public.is_own_clinic(a.clinic_id)
    )
    or exists (
      select 1 from waitlist w
      where w.member_id = fm.id
        and w.date >= current_date - 30
        and public.is_own_clinic(w.clinic_id)
    )
  );

revoke all on public.patient_contact from anon, public;
grant select on public.patient_contact to authenticated;

-- get_clinic_queue() (migration 26) ran as the caller and joined the full
-- patient row. Now: membership-checked, and age instead of date of birth.
drop function if exists public.get_clinic_queue(uuid, date);
create function public.get_clinic_queue(p_doctor_id uuid, p_date date)
returns table (
  queue_position integer, id uuid, token_number integer, status text, slot_time time,
  checked_in_at timestamptz, effective_order_time timestamptz, was_late boolean,
  reminder_count integer, skip_count integer, payment_status text,
  patient_name text, account_id uuid, phone text, gender text, age integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    row_number() over (order by a.effective_order_time asc, a.checked_in_at asc)::int,
    a.id, a.token_number, a.status, a.slot_time, a.checked_in_at, a.effective_order_time,
    a.was_late, a.reminder_count, a.skip_count, a.payment_status,
    f.name, f.account_id, f.phone, f.gender,
    case when f.dob is not null then extract(year from age(current_date, f.dob))::int end
  from appointments a
  join family_members f on f.id = a.member_id
  join doctors d on d.id = a.doctor_id
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
    and (public.is_own_clinic(d.clinic_id) or public.is_admin())
  order by a.effective_order_time asc, a.checked_in_at asc;
$$;

revoke execute on function public.get_clinic_queue(uuid, date) from public, anon;
grant execute on function public.get_clinic_queue(uuid, date) to authenticated;

-- lookup_checkin() (migration 35) - the desk's QR/MRN check-in preview -
-- returned the full date of birth to show an age. Same function, age only.
-- (A changed return row shape needs drop + create.)
drop function if exists public.lookup_checkin(uuid, text, text);
create function public.lookup_checkin(p_clinic_id uuid, p_qr_code text DEFAULT NULL::text, p_mrn text DEFAULT NULL::text)
 RETURNS TABLE(appointment_id uuid, member_id uuid, patient_name text, photo_path text, mrn text, age integer, gender text, status text, already_checked_in boolean, token_number integer, sequence_no integer, estimated_time time without time zone, slot_time time without time zone, doctor_name text, payment_status text, amount_due numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c clinics;
  v_today date;
  v_appt_id uuid;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  if p_qr_code is not null and trim(p_qr_code) <> '' then
    v_appt_id := public.verify_booking_qr(p_qr_code);
    if v_appt_id is null then
      raise exception 'This code is not valid or has expired. Ask the patient to refresh their screen.';
    end if;
  elsif p_mrn is not null and trim(p_mrn) <> '' then
    select a.id into v_appt_id
    from appointments a
    join family_members fm on fm.id = a.member_id
    where fm.mrn = trim(p_mrn)
      and a.clinic_id = p_clinic_id
      and a.date = v_today
      and a.status in ('accepted', 'no_show', 'checked_in', 'called', 'in_consultation')
    order by (a.status = 'accepted') desc, a.slot_time
    limit 1;
    if v_appt_id is null then
      raise exception 'No appointment found for patient ID "%" today at this clinic.', trim(p_mrn);
    end if;
  else
    raise exception 'Scan a QR code or enter a patient ID.';
  end if;

  if not exists (select 1 from appointments a where a.id = v_appt_id and a.clinic_id = p_clinic_id) then
    raise exception 'This booking is not at your clinic.';
  end if;

  return query
  select
    a.id, fm.id, fm.name, fm.photo_path, fm.mrn, case when fm.dob is not null then extract(year from age(current_date, fm.dob))::int end, fm.gender,
    a.status, (a.checked_in_at is not null), a.token_number,
    a.sequence_no, a.estimated_time, a.slot_time, d.name,
    a.payment_status, p.amount
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  left join payments p on p.appointment_id = a.id
  where a.id = v_appt_id;
end;
$function$;

revoke execute on function public.lookup_checkin(uuid, text, text) from public, anon;
grant execute on function public.lookup_checkin(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 68.5 Bulk export - only with patient.export, always audited
-- ----------------------------------------------------------------------------

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

  insert into audit_log (actor, action, target) values (auth.uid(), 'patient.export', p_clinic_id::text);

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

-- ----------------------------------------------------------------------------
-- Grants for everything new
-- ----------------------------------------------------------------------------

revoke execute on function public.has_patient_permission(uuid, uuid, text) from public, anon;
revoke execute on function public.has_health_access(uuid, uuid) from public, anon;
revoke execute on function public.my_clinic_role(uuid) from public, anon;
revoke execute on function public.my_staff_doctor_id(uuid) from public, anon;
revoke execute on function public.is_clinic_owner(uuid) from public, anon;
revoke execute on function public.open_patient_health_record(uuid) from public, anon;
revoke execute on function public.open_encounter_health_record(uuid) from public, anon;
revoke execute on function public.authorize_patient_file_download(uuid) from public, anon;
revoke execute on function public.visit_rx_status(uuid) from public, anon;
revoke execute on function public.clinic_rx_worklist(date) from public, anon;
revoke execute on function public.export_clinic_patients(uuid) from public, anon;
revoke execute on function public.add_clinic_staff_phone(text, text, text, uuid) from public, anon;
grant execute on function public.my_clinic_role(uuid) to authenticated;
grant execute on function public.open_patient_health_record(uuid) to authenticated;
grant execute on function public.open_encounter_health_record(uuid) to authenticated;
grant execute on function public.authorize_patient_file_download(uuid) to authenticated;
grant execute on function public.visit_rx_status(uuid) to authenticated;
grant execute on function public.clinic_rx_worklist(date) to authenticated;
grant execute on function public.export_clinic_patients(uuid) to authenticated;
grant execute on function public.add_clinic_staff_phone(text, text, text, uuid) to authenticated;
