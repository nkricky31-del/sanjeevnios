-- ============================================================================
-- 84. PRINTED (STATIC) CLINIC QR + CONFIGURABLE CHECK-IN OPENING
-- ============================================================================
-- The patient arrives, opens their booking, scans the QR printed at the
-- counter, and is checked in with a token - no staff involved.
--
--   1. clinics.checkin_open_before_minutes - how long before the slot
--      check-in opens. Default 60, which is exactly the old hardcoded rule,
--      so nothing changes for a clinic until it edits the setting.
--   2. A permanent, printable clinic code:
--        sanjeevni:clinic:v2:<clinic id>:<version>:<signature>
--      Signed like every other code (sign_qr_payload), so it can't be made up
--      for another clinic. It never expires; clinics.static_checkin_version
--      is part of what's signed, so "Replace printed QR" (bumping it) kills
--      every old copy at once if a poster is misused.
--      Because the code is permanent, a photo of it works from anywhere - so
--      for v2 codes the phone's location is ALWAYS checked, whatever the
--      clinic's self_checkin_require_location says. The rotating screen code
--      (v1, section 28) is unchanged and keeps following that setting.
--   3. self_check_in() takes the booking the patient scanned from
--      (p_appointment_id) and checks THAT booking: yours, this clinic, today.
--      Previously it picked the earliest booking on the whole account, so a
--      mother scanning from her son's booking checked herself in instead.
--      Called without it (an app version from before this migration), it
--      falls back to the old behaviour.
--   4. check_in_appointment() and get_checkin_options() use the new setting
--      in place of the hardcoded 60 minutes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 84.1 Settings
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists checkin_open_before_minutes int not null default 60;
alter table clinics drop constraint if exists clinics_checkin_open_before_minutes_check;
alter table clinics add constraint clinics_checkin_open_before_minutes_check
  check (checkin_open_before_minutes between 5 and 180);

alter table clinics add column if not exists static_checkin_version int not null default 1;

-- ----------------------------------------------------------------------------
-- 84.2 The printed code
-- ----------------------------------------------------------------------------
create or replace function public.issue_clinic_static_code(p_clinic_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_version int;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  select static_checkin_version into v_version from clinics where id = p_clinic_id;
  if v_version is null then
    raise exception 'Clinic not found.';
  end if;
  return 'sanjeevni:clinic:v2:' || p_clinic_id::text || ':' || v_version::text || ':'
    || public.sign_qr_payload('static|' || p_clinic_id::text || '|' || v_version::text);
end;
$$;

-- Invalidates every printed copy of the old code and returns the new one.
create or replace function public.rotate_clinic_static_code(p_clinic_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  update clinics set static_checkin_version = static_checkin_version + 1 where id = p_clinic_id;
  return public.issue_clinic_static_code(p_clinic_id);
end;
$$;

revoke execute on function public.issue_clinic_static_code(uuid) from public, anon;
revoke execute on function public.rotate_clinic_static_code(uuid) from public, anon;
grant execute on function public.issue_clinic_static_code(uuid) to authenticated;
grant execute on function public.rotate_clinic_static_code(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 84.3 check_in_appointment() - opening time from the clinic setting
-- ----------------------------------------------------------------------------
-- Identical to section 31's version except for the "too early" rule and the
-- wording of the two timing messages.
create or replace function public.check_in_appointment(
  p_appointment_id uuid,
  p_method text default 'manual',
  p_allow_late boolean default false
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_tz text;
  v_grace int;
  v_open int;
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
  v_late boolean := false;
  v_is_desk boolean;
  v_now timestamptz := now();
begin
  if p_method is null or p_method not in ('clinic_scan', 'patient_scan', 'manual') then
    raise exception 'Unknown check-in method: %', p_method;
  end if;

  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  v_is_desk := public.is_admin() or public.is_own_clinic(a.clinic_id);

  if not (v_is_desk or public.is_own_mrn(a.member_id)) then
    raise exception 'You are not allowed to check in this appointment.';
  end if;

  if p_allow_late and not v_is_desk then
    raise exception 'Only the clinic can admit a late or no-show patient.';
  end if;

  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true, a.was_late;
    return;
  end if;

  if a.status = 'no_show' and not p_allow_late then
    raise exception 'This patient was marked as a no-show. Use "Check in anyway" to admit them.';
  end if;

  if a.status not in ('accepted', 'no_show') then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata'), coalesce(c.checkin_open_before_minutes, 60)
    into v_tz, v_open
  from clinics c where c.id = a.clinic_id;
  v_grace := public.effective_grace_minutes(a.id);

  v_now_local := v_now at time zone v_tz;
  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  v_late := v_now_local > v_slot_end;

  if not p_allow_late then
    if a.date <> v_now_local::date then
      raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
    end if;
    if v_now_local < v_slot_start - make_interval(mins => v_open) then
      raise exception 'Too early - check-in for the % slot opens at %.',
        to_char(v_slot_start, 'HH12:MI AM'),
        to_char(v_slot_start - make_interval(mins => v_open), 'HH12:MI AM');
    end if;
    if v_now_local > v_slot_end + make_interval(mins => v_grace) then
      raise exception 'Too late - check-in for the % slot closed at %. Please see the reception desk.',
        to_char(v_slot_start, 'HH12:MI AM'),
        to_char(v_slot_end + make_interval(mins => v_grace), 'HH12:MI AM');
    end if;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, a.date, 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  perform set_config('app.checkin_write', '1', true);

  update appointments
  set status = 'checked_in',
      checked_in_at = v_now,
      checked_in_by = auth.uid(),
      check_in_method = p_method,
      token_number = v_seq,
      arrival_seq = v_seq,
      token_date = a.date,
      was_late = v_late,
      effective_order_time =
        public.compute_effective_order_time(a.date, a.slot_time, v_now, v_grace, v_tz),
      no_show_marked_at = null,
      no_show_auto = false
  where id = a.id;

  perform set_config('app.checkin_write', '0', true);

  return query select v_seq, v_seq, a.date, false, v_late;
end;
$$;

-- ----------------------------------------------------------------------------
-- 84.4 get_checkin_options() - reporting time clamped to the new opening
-- ----------------------------------------------------------------------------
-- Same return shape as section 40, so create-or-replace is enough.
create or replace function public.get_checkin_options(p_appointment_id uuid)
returns table (
  can_self_check_in boolean,
  requires_location boolean,
  paid_online boolean,
  reschedule_window_hours int,
  reporting_time time
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a appointments;
  c clinics;
  v_paid boolean;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select * into c from clinics where id = a.clinic_id;
  v_paid := (a.payment_status = 'paid_online');

  return query select
    (c.self_checkin_enabled or (c.fast_checkin_paid_online and v_paid)),
    c.self_checkin_require_location,
    v_paid,
    case when v_paid then c.reschedule_window_hours_paid_online else c.reschedule_window_hours end,
    a.slot_time - make_interval(mins => least(c.report_before_minutes, coalesce(c.checkin_open_before_minutes, 60)));
end;
$$;

-- ----------------------------------------------------------------------------
-- 84.5 self_check_in() - the scanned booking, and the printed code
-- ----------------------------------------------------------------------------
-- A new argument is a new signature; drop the old one so PostgREST never has
-- two candidates to choose between.
drop function if exists public.self_check_in(text, double precision, double precision);

create or replace function public.self_check_in(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null,
  p_appointment_id uuid default null
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  v_clinic_id uuid;
  v_window bigint;
  v_version int;
  v_now_window bigint;
  v_static boolean;
  c clinics;
  a appointments;
  v_today date;
  v_appt_id uuid;
  v_paid boolean;
  v_distance double precision;
  v_other_clinic text;
begin
  -- 1. A genuine clinic code.
  parts := string_to_array(coalesce(btrim(p_code), ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'clinic' or parts[3] not in ('v1', 'v2')
  then
    raise exception 'That is not a clinic check-in code.';
  end if;
  v_static := parts[3] = 'v2';

  begin
    v_clinic_id := parts[4]::uuid;
    if v_static then
      v_version := parts[5]::int;
    else
      v_window := parts[5]::bigint;
    end if;
  exception when others then
    raise exception 'That is not a clinic check-in code.';
  end;

  if v_static then
    if public.sign_qr_payload('static|' || parts[4] || '|' || parts[5]) <> parts[6] then
      raise exception 'That check-in code is not valid.';
    end if;
  else
    if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> parts[6] then
      raise exception 'That check-in code is not valid.';
    end if;
    v_now_window := public.clinic_checkin_window();
    if v_window <> v_now_window and v_window <> v_now_window - 1 then
      raise exception 'That check-in code has expired - please scan the code on the screen at reception.';
    end if;
  end if;

  select * into c from clinics where id = v_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  if v_static and v_version <> c.static_checkin_version then
    raise exception 'This printed code has been replaced. Please scan the current code at reception, or see the desk.';
  end if;

  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  -- 2. The booking: yours, at THIS clinic, today.
  if p_appointment_id is not null then
    select * into a from appointments where id = p_appointment_id;
    if a.id is null or not public.is_own_mrn(a.member_id) then
      raise exception 'Booking not found.';
    end if;
    if a.clinic_id <> v_clinic_id then
      select name into v_other_clinic from clinics where id = a.clinic_id;
      raise exception 'This booking is at %, not %.', coalesce(v_other_clinic, 'another clinic'), c.name;
    end if;
    if a.date <> v_today then
      raise exception 'This booking is for %, not today.', to_char(a.date, 'DD Mon YYYY');
    end if;
    v_appt_id := a.id;
    v_paid := (a.payment_status = 'paid_online');
  else
    -- Older app versions: the caller's earliest accepted booking here today.
    select a2.id, (a2.payment_status = 'paid_online')
      into v_appt_id, v_paid
    from appointments a2
    where a2.clinic_id = v_clinic_id
      and a2.date = v_today
      and a2.status = 'accepted'
      and public.is_own_mrn(a2.member_id)
    order by a2.slot_time
    limit 1;
    if v_appt_id is null then
      raise exception 'No confirmed appointment found for you at this clinic today.';
    end if;
  end if;

  if not (c.self_checkin_enabled or (c.fast_checkin_paid_online and coalesce(v_paid, false))) then
    raise exception 'This clinic does not offer self check-in - please see the reception desk.';
  end if;

  -- 3. The phone is at the clinic. Always for the printed code.
  if v_static or c.self_checkin_require_location then
    if p_lat is null or p_lng is null then
      raise exception 'We need your location to confirm you are at the clinic. Allow location access and scan again, or see the reception desk.';
    end if;
    if c.lat is null or c.lng is null then
      raise exception 'This clinic has not set its location yet - please see the reception desk.';
    end if;
    v_distance := public.distance_metres(p_lat, p_lng, c.lat, c.lng);
    if v_distance > c.self_checkin_radius_m then
      raise exception 'You appear to be about % from the clinic. Scan again once you are at the clinic.',
        case when v_distance >= 1000 then round((v_distance / 1000)::numeric, 1)::text || ' km'
             else round(v_distance)::int::text || ' m' end;
    end if;
  end if;

  -- 4. The check-in window and the token itself - the same function the desk uses.
  return query select * from public.check_in_appointment(v_appt_id, 'patient_scan', false);
end;
$$;

revoke execute on function public.self_check_in(text, double precision, double precision, uuid) from public, anon;
grant execute on function public.self_check_in(text, double precision, double precision, uuid) to authenticated;
