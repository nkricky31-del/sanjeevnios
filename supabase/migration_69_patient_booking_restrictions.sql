-- ============================================================================
-- 69. PATIENT-CENTRIC BOOKING RESTRICTIONS, ENFORCED IN THE INSERT TRANSACTION
--     (refines migration 47 / the multi-member booking fix)
-- ============================================================================
-- Rules, applied to the PATIENT (family_members row), never to the account:
--
--   R1  Same patient, same doctor: refused while any earlier appointment of
--       that patient with that doctor is still ACTIVE (any date).
--   R2  Same patient, different doctor: refused when the new slot is less
--       than 4 hours before or after any ACTIVE appointment of that patient
--       (any doctor, any clinic). Exactly 4 hours apart is allowed.
--   R3  A different family member is judged only on their own appointments.
--
-- ACTIVE = booked, accepted, checked_in, called, in_consultation.
-- cancelled / rejected / no_show release the patient; completed no longer
-- blocks. Walk-ins (patient_type = 'walk_in') are physically present and are
-- not subject to these rules.
--
-- Timezone: every appointment's date + slot_time is read in ITS OWN clinic's
-- timezone (clinics.timezone, default Asia/Kolkata) and compared as an
-- absolute instant, so two clinics in different zones still compare correctly.
--
-- Transaction: the check is a BEFORE INSERT/UPDATE trigger, i.e. it runs
-- inside the very statement that creates the appointment (one transaction):
--   lock the patient -> re-read their active appointments -> R1 -> R2 ->
--   (next trigger, on_appointment_ab_slot_capacity: slot availability) ->
--   row is created -> commit -> AFTER trigger writes the audit event.
-- The lock is pg_advisory_xact_lock keyed on the PATIENT, so two simultaneous
-- requests for the same patient are serialised and the second sees the first.
-- Different patients never wait on each other.
--
-- Override: only an admin holding the explicit 'booking.override' permission,
-- only through admin_override_booking(), always with a reason, always audited.
-- ============================================================================

-- 69.1 What counts as active -------------------------------------------------
create or replace function public.is_active_appointment_status(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in ('booked', 'accepted', 'checked_in', 'called', 'in_consultation');
$$;

-- 69.2 Admin permissions -----------------------------------------------------
-- Being an admin is not enough to bypass booking rules; it must be granted.
create table if not exists admin_permissions (
  user_id uuid not null references profiles (id) on delete cascade,
  permission text not null,
  granted_by uuid references profiles (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

alter table admin_permissions enable row level security;
revoke all on table admin_permissions from anon, authenticated;
-- No policies and no grants: managed from the SQL editor / service role only.
-- To grant:  insert into admin_permissions (user_id, permission)
--            values ('<admin profile id>', 'booking.override');

create or replace function public.has_admin_permission(p_permission text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.is_admin()
    and exists (
      select 1 from admin_permissions
      where user_id = auth.uid() and permission = p_permission
    );
$$;

-- 69.3 The old per-day index conflicts with the new rules ---------------------
-- It forbade ANY second open booking for a member at a clinic on one day. The
-- new rules allow a different doctor 4+ hours apart on the same day, and
-- enforce the same-doctor rule across all dates, so it is replaced.
drop index if exists appointments_member_clinic_day_active_unique;

-- 69.4 The rule trigger ------------------------------------------------------
create or replace function public.enforce_patient_booking_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_new_ts timestamptz;
  v_conflict record;
begin
  if new.patient_type = 'walk_in' or not public.is_active_appointment_status(new.status) then
    return new;
  end if;

  -- Admin override: transaction-local flag set by admin_override_booking(),
  -- honoured only if the caller still passes the permission check here, so a
  -- stray flag from anywhere else does nothing.
  if coalesce(current_setting('app.booking_override', true), '') = 'on'
     and public.has_admin_permission('booking.override') then
    return new;
  end if;

  -- 1. Lock this patient (and only this patient) until commit.
  perform pg_advisory_xact_lock(hashtextextended('patient-booking:' || new.member_id::text, 0));

  select coalesce(c.timezone, 'Asia/Kolkata') into v_tz from clinics c where c.id = new.clinic_id;
  v_new_ts := (new.date + new.slot_time) at time zone coalesce(v_tz, 'Asia/Kolkata');

  -- 2. Same patient, same doctor, still active (any date).
  select a.id, a.date, a.slot_time into v_conflict
  from appointments a
  where a.member_id = new.member_id
    and a.doctor_id = new.doctor_id
    and a.id is distinct from new.id
    and a.patient_type <> 'walk_in'
    and public.is_active_appointment_status(a.status)
  limit 1;

  if found then
    raise exception 'PATIENT_SAME_DOCTOR_ACTIVE: this patient already has an active appointment with this doctor on % at %.',
      to_char(v_conflict.date, 'DD Mon YYYY'), to_char(v_conflict.slot_time, 'HH12:MI AM')
      using errcode = 'P0001';
  end if;

  -- 3. Same patient, any other doctor, within 4 hours either side.
  select a.id, a.date, a.slot_time into v_conflict
  from appointments a
  join clinics c on c.id = a.clinic_id
  where a.member_id = new.member_id
    and a.doctor_id <> new.doctor_id
    and a.id is distinct from new.id
    and a.patient_type <> 'walk_in'
    and public.is_active_appointment_status(a.status)
    and abs(extract(epoch from (
          ((a.date + a.slot_time) at time zone coalesce(c.timezone, 'Asia/Kolkata')) - v_new_ts
        ))) < 4 * 3600
  limit 1;

  if found then
    raise exception 'PATIENT_WITHIN_4H: this patient already has an appointment on % at %. Pick a time at least 4 hours before or after it.',
      to_char(v_conflict.date, 'DD Mon YYYY'), to_char(v_conflict.slot_time, 'HH12:MI AM')
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- Trigger names sort alphabetically and Postgres fires them in that order:
-- 'aa0_' sorts before 'aa_booking_policy' and 'ab_slot_capacity', so the
-- patient rules run BEFORE slot availability, as the spec requires.
drop trigger if exists on_appointment_aa0_patient_rules on appointments;
create trigger on_appointment_aa0_patient_rules
  before insert on appointments
  for each row execute function public.enforce_patient_booking_rules();

-- A move to another doctor / day / slot / patient is re-checked the same way.
drop trigger if exists on_appointment_aa0_patient_rules_update on appointments;
create trigger on_appointment_aa0_patient_rules_update
  before update of member_id, doctor_id, date, slot_time, status on appointments
  for each row
  when (
    (old.member_id, old.doctor_id, old.date, old.slot_time, old.status)
      is distinct from (new.member_id, new.doctor_id, new.date, new.slot_time, new.status)
  )
  execute function public.enforce_patient_booking_rules();

-- 69.5 Audit event on success --------------------------------------------------
create or replace function public.audit_appointment_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (actor, action, target)
  values (
    auth.uid(),
    'appointment.created',
    new.id::text || ' member=' || new.member_id::text || ' doctor=' || new.doctor_id::text
      || ' at=' || new.date::text || ' ' || new.slot_time::text
  );
  return new;
end;
$$;

drop trigger if exists on_appointment_zz_audit_created on appointments;
create trigger on_appointment_zz_audit_created
  after insert on appointments
  for each row execute function public.audit_appointment_created();

-- 69.6 Admin override ------------------------------------------------------------
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

  perform set_config('app.booking_override', 'on', true); -- this transaction only

  insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
  values (p_member_id, p_doctor_id, p_clinic_id, p_date, p_slot_time, 'booked', 'pay_at_clinic')
  returning id into v_id;

  perform set_config('app.booking_override', 'off', true);

  insert into audit_log (actor, action, target)
  values (auth.uid(), 'booking.override', v_id::text || ' reason: ' || btrim(p_reason));

  return v_id;
end;
$$;

revoke all on function public.admin_override_booking(uuid, uuid, uuid, date, time, text) from public, anon;
grant execute on function public.admin_override_booking(uuid, uuid, uuid, date, time, text) to authenticated;
