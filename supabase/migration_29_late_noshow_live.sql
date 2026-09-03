-- ============================================================================
-- 29. LATE ARRIVALS, NO-SHOWS, AND SKIPPING
-- ============================================================================
-- What happens around arrival time:
--
--   * LATE: checking in after your slot but still inside the window is
--     completely normal - you join the live queue at the position your
--     arrival earns, exactly like everyone else. It's only flagged so the
--     clinic can see it, never penalised.
--   * NO-SHOW: never arriving. The clinic can mark it by hand, or the system
--     sweeps it automatically once the cut-off the clinic sets has passed.
--     A no-show holds no token - it never had one.
--   * TURNING UP ANYWAY: a no-show who walks in later can still be admitted
--     by the desk, which draws them the next token like a walk-in.
--   * SKIPPING: a patient who was called and didn't come forward, after the
--     clinic's set number of reminders, can be pushed to the back of the
--     queue with a fresh token rather than being written off.
--
-- See TESTING.md "Test 10".

-- ----------------------------------------------------------------------------
-- 29.1 Clinic-set thresholds
-- ----------------------------------------------------------------------------
-- How long after the check-in window closes before an unarrived patient is
-- automatically written off.
alter table clinics add column if not exists no_show_cutoff_minutes int not null default 30;
-- How many unanswered reminders before the desk may skip someone.
alter table clinics add column if not exists reminder_limit int not null default 3;

-- ----------------------------------------------------------------------------
-- 29.2 Appointment columns
-- ----------------------------------------------------------------------------
-- Purely informational: the token was still issued in arrival order.
alter table appointments add column if not exists was_late boolean not null default false;
alter table appointments add column if not exists no_show_marked_at timestamptz;
-- Distinguishes the automatic sweep from a receptionist's decision, which
-- matters when someone asks why a booking was written off.
alter table appointments add column if not exists no_show_auto boolean not null default false;
-- How many times this patient has been pushed to the back after being called
-- and not coming forward.
alter table appointments add column if not exists skip_count int not null default 0;

-- ----------------------------------------------------------------------------
-- 29.3 check_in_appointment(), now with a late/no-show override
-- ----------------------------------------------------------------------------
-- The 2-argument version has to go first: adding a defaulted third parameter
-- alongside it would leave two candidate functions and PostgREST could not
-- tell which one a call meant.
drop function if exists public.check_in_appointment(uuid, text);

-- p_allow_late lets the DESK (never a patient self-scan) admit somebody whose
-- window has closed, or who has already been written off as a no-show. It
-- skips the timing guards only - the clinic-ownership check, the arrival
-- counter and the one-token-per-person rule all still apply, so an override
-- still produces an ordinary next-in-line token.
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
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
  v_late boolean := false;
  v_is_desk boolean;
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

  -- Only the desk may override the timing rules. A patient scanning the
  -- reception code can never let themselves in late.
  if p_allow_late and not v_is_desk then
    raise exception 'Only the clinic can admit a late or no-show patient.';
  end if;

  -- Idempotent: "a second scan just shows the existing token".
  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true, a.was_late;
    return;
  end if;

  -- A no-show holds no token, and can only re-enter through an explicit
  -- desk override - which is exactly the "they turned up after all" case.
  if a.status = 'no_show' and not p_allow_late then
    raise exception 'This patient was marked as a no-show. Use "Check in anyway" to admit them.';
  end if;

  if a.status not in ('accepted', 'no_show') then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata'), coalesce(c.checkin_grace_minutes, 30)
    into v_tz, v_grace
  from clinics c where c.id = a.clinic_id;

  v_now_local := now() at time zone v_tz;
  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  -- Arriving after your slot is "late", not "refused" - the flag is recorded
  -- either way, and the token is drawn in arrival order regardless.
  v_late := v_now_local > v_slot_end;

  if not p_allow_late then
    if a.date <> v_now_local::date then
      raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
    end if;
    if v_now_local < v_slot_start - interval '60 minutes' then
      raise exception 'Too early - check-in opens 60 minutes before the % slot.',
        to_char(v_slot_start, 'HH12:MI AM');
    end if;
    if v_now_local > v_slot_end + make_interval(mins => v_grace) then
      raise exception 'Too late - check-in for the % slot closed % minutes after it ended.',
        to_char(v_slot_start, 'HH12:MI AM'), v_grace;
    end if;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, a.date, 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  update appointments
  set status = 'checked_in',
      checked_in_at = now(),
      checked_in_by = auth.uid(),
      check_in_method = p_method,
      token_number = v_seq,
      arrival_seq = v_seq,
      token_date = a.date,
      was_late = v_late,
      -- Re-admitting a no-show clears the write-off.
      no_show_marked_at = null,
      no_show_auto = false
  where id = a.id;

  return query select v_seq, v_seq, a.date, false, v_late;
end;
$$;

-- These two call through to it, so they have to be redeclared for the new
-- return shape. Neither ever passes the override - a scan is never a
-- late-admission decision.
--
-- Dropped rather than replaced, for the same reason as the 2-arg check-in
-- above: they now return an extra `was_late` column, and CREATE OR REPLACE
-- cannot change a function's OUT parameters ("cannot change return type of
-- existing function"). Both are only ever called over RPC from the client,
-- so nothing in the database depends on them.
drop function if exists public.check_in_with_qr(text);
drop function if exists public.self_check_in(text, double precision, double precision);

create or replace function public.check_in_with_qr(p_code text)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  v_id := public.verify_booking_qr(p_code);
  if v_id is null then
    raise exception 'This code is not valid or has expired. Ask the patient to refresh their screen.';
  end if;
  return query select * from public.check_in_appointment(v_id, 'clinic_scan', false);
end;
$$;

create or replace function public.self_check_in(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null
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
  v_now_window bigint;
  c clinics;
  v_appt_id uuid;
  v_distance double precision;
begin
  parts := string_to_array(coalesce(p_code, ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'clinic' or parts[3] <> 'v1'
  then
    raise exception 'That is not a clinic check-in code.';
  end if;

  begin
    v_clinic_id := parts[4]::uuid;
    v_window := parts[5]::bigint;
  exception when others then
    raise exception 'That is not a clinic check-in code.';
  end;

  if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> parts[6] then
    raise exception 'That check-in code is not valid.';
  end if;

  v_now_window := public.clinic_checkin_window();
  if v_window <> v_now_window and v_window <> v_now_window - 1 then
    raise exception 'That check-in code has expired - please scan the code on the screen at reception.';
  end if;

  select * into c from clinics where id = v_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  if not c.self_checkin_enabled then
    raise exception 'This clinic does not offer self check-in - please see the reception desk.';
  end if;

  if c.self_checkin_require_location then
    if p_lat is null or p_lng is null then
      raise exception 'Location is required to check yourself in here. Allow location access and try again.';
    end if;
    if c.lat is null or c.lng is null then
      raise exception 'This clinic has not set its location yet - please see the reception desk.';
    end if;
    v_distance := public.distance_metres(p_lat, p_lng, c.lat, c.lng);
    if v_distance > c.self_checkin_radius_m then
      raise exception 'You appear to be about %m from the clinic. Self check-in only works at the clinic.',
        round(v_distance)::int;
    end if;
  end if;

  select a.id into v_appt_id
  from appointments a
  where a.clinic_id = v_clinic_id
    and a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
    and a.status = 'accepted'
    and public.is_own_mrn(a.member_id)
  order by a.slot_time
  limit 1;

  if v_appt_id is null then
    raise exception 'No confirmed appointment found for you at this clinic today.';
  end if;

  return query select * from public.check_in_appointment(v_appt_id, 'patient_scan', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 29.4 Automatic no-show sweep
-- ----------------------------------------------------------------------------
-- Writes off every accepted appointment nobody ever arrived for, once the
-- clinic's cut-off has passed. Deliberately touches ONLY status='accepted':
-- anyone who checked in holds a token and is the queue's problem, not this
-- function's. Also sweeps up stragglers from previous days, which otherwise
-- sit as "expected" forever.
--
-- Returns how many it marked, so the caller can say something useful.
-- p_clinic_id null = every clinic the caller is allowed to sweep (admin, or
-- a scheduled job running as the definer).
create or replace function public.auto_mark_no_shows(p_clinic_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if p_clinic_id is not null and not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  with due as (
    select a.id
    from appointments a
    join clinics c on c.id = a.clinic_id
    where a.status = 'accepted'
      and (p_clinic_id is null or a.clinic_id = p_clinic_id)
      and (
        -- A day that has already ended, in the clinic's own timezone.
        a.date < (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
        -- ...or today, once slot end + grace + cut-off has gone by.
        or (
          a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
          and (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))
              > (a.date + a.slot_time)
                + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date))
                + make_interval(mins => coalesce(c.checkin_grace_minutes, 30))
                + make_interval(mins => coalesce(c.no_show_cutoff_minutes, 30))
        )
      )
  )
  update appointments a
  set status = 'no_show',
      no_show_marked_at = now(),
      no_show_auto = true
  from due
  where a.id = due.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Best-effort scheduling. pg_cron isn't guaranteed to be available (or
-- enabled) on every project, and the clinic console also calls
-- auto_mark_no_shows() when it loads - so the sweep still happens either way,
-- and this block never breaks the migration if the extension isn't there.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.unschedule('sanjeevni_auto_no_shows');
    exception when others then
      null; -- no existing job to unschedule, or no permission - fall through
    end;
    begin
      perform cron.schedule('sanjeevni_auto_no_shows', '*/10 * * * *',
        $cron$select public.auto_mark_no_shows()$cron$);
    exception when others then
      raise notice 'pg_cron present but scheduling failed; the console will sweep on load instead.';
    end;
  else
    raise notice 'pg_cron unavailable; the clinic console sweeps no-shows when it loads.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 29.5 Skipping a called patient to the back
-- ----------------------------------------------------------------------------
-- The patient was called and didn't come forward. Rather than writing them
-- off, the desk can draw them a FRESH token - they keep their place in the
-- day, just at the back of it. Their original number is gone, which is the
-- honest outcome: the queue moved on without them.
create or replace function public.skip_to_back(p_appointment_id uuid)
returns table (token_number int, arrival_seq int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_seq int;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  if a.status not in ('checked_in', 'called') then
    raise exception 'Only a waiting or called patient can be skipped (this one is "%").', a.status;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, coalesce(a.token_date, a.date), 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  update appointments
  set token_number = v_seq,
      arrival_seq = v_seq,
      status = 'checked_in',
      skip_count = a.skip_count + 1
  where id = a.id;

  return query select v_seq, v_seq;
end;
$$;
