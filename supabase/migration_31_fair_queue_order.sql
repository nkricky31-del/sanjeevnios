-- ============================================================================
-- 31. FAIR QUEUE - THE ORDER RULE
-- ============================================================================
-- Who gets served first. Two ideas, held together:
--
--   1. Only patients who are CHECKED IN can be called at all. Someone who
--      hasn't walked through the door is not in the running, however early
--      their slot and however they paid.
--
--   2. Among those present, order by:
--          effective_order_time ASC, then checked_in_at ASC
--      where effective_order_time is
--        * the patient's SLOT time, if they arrived on time (checked in at
--          or before slot + grace) - so the earlier appointment wins, which
--          is the whole point of booking one; or
--        * their ACTUAL arrival time, if they were more than grace late -
--          so a 9AM booking wandering in at 2PM can't leapfrog everyone who
--          turned up when they said they would.
--
-- Payment is not consulted anywhere in this file. It cannot be: nothing here
-- reads payment_status.
--
-- Worked example (see TESTING.md "Test 12"):
--   A - 4PM slot, paid online, checks in 2:45 -> on time  -> effective 16:00
--   B - 3PM slot, paid at desk, checks in 2:55 -> on time -> effective 15:00
--   B is called first, despite A having arrived ten minutes earlier and paid
--   online. The earlier APPOINTMENT wins among punctual patients.

-- ----------------------------------------------------------------------------
-- 31.1 The rule itself, as one function
-- ----------------------------------------------------------------------------
-- Kept separate so check-in, the backfill below, and anyone reasoning about
-- the queue are all using literally the same arithmetic.
--
-- Everything is computed in the clinic's own wall-clock: slot_time is a plain
-- local time, so comparing it against a UTC now() would be wrong by the
-- offset. The result is converted back to timestamptz for storage.
create or replace function public.compute_effective_order_time(
  p_date date,
  p_slot_time time,
  p_checked_in_at timestamptz,
  p_grace_minutes int,
  p_timezone text default 'Asia/Kolkata'
)
returns timestamptz
language sql
immutable
as $$
  select case
    when p_checked_in_at is null then null
    -- On time (or early): the booked slot is what orders them.
    when (p_checked_in_at at time zone p_timezone)
         <= (p_date + p_slot_time) + make_interval(mins => p_grace_minutes)
      then ((p_date + p_slot_time) at time zone p_timezone)
    -- More than grace late: they forfeit slot priority and are ordered by
    -- when they actually turned up.
    else p_checked_in_at
  end;
$$;

-- ----------------------------------------------------------------------------
-- 31.2 Stamp it at check-in
-- ----------------------------------------------------------------------------
-- Identical to section 30's version except for the effective_order_time line,
-- which now applies the rule instead of always using the arrival moment.
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

  select coalesce(c.timezone, 'Asia/Kolkata') into v_tz from clinics c where c.id = a.clinic_id;
  v_grace := public.effective_grace_minutes(a.id);

  v_now_local := v_now at time zone v_tz;
  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

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

-- Bring existing checked-in rows onto the rule (section 30 stamped them with
-- the plain arrival time).
update appointments a
set effective_order_time = public.compute_effective_order_time(
      a.date, a.slot_time, a.checked_in_at,
      coalesce(a.grace_minutes, c.checkin_grace_minutes, 30),
      coalesce(c.timezone, 'Asia/Kolkata'))
from clinics c
where c.id = a.clinic_id and a.checked_in_at is not null;

-- ----------------------------------------------------------------------------
-- 31.3 The ordered queue, for the clinic
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: ordinary RLS applies, so a clinic sees exactly
-- its own appointments and nobody else's. Because a clinic can see ALL of its
-- own rows for that doctor/day, the position computed here is the true one.
create or replace function public.get_clinic_queue(p_doctor_id uuid, p_date date)
returns table (
  queue_position int,
  id uuid,
  token_number int,
  status text,
  slot_time time,
  checked_in_at timestamptz,
  effective_order_time timestamptz,
  was_late boolean,
  reminder_count int,
  skip_count int,
  payment_status text,
  patient_name text,
  account_id uuid,
  phone text,
  gender text,
  dob date
)
language sql
stable
as $$
  select
    row_number() over (order by a.effective_order_time asc, a.checked_in_at asc)::int,
    a.id, a.token_number, a.status, a.slot_time, a.checked_in_at, a.effective_order_time,
    a.was_late, a.reminder_count, a.skip_count, a.payment_status,
    f.name, f.account_id, f.phone, f.gender, f.dob
  from appointments a
  join family_members f on f.id = a.member_id
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
  order by a.effective_order_time asc, a.checked_in_at asc;
$$;

-- ----------------------------------------------------------------------------
-- 31.4 The ordered queue, for patients
-- ----------------------------------------------------------------------------
-- Same ordering, but carrying nothing that identifies anybody - just the
-- position, the token being called, and the state. A patient finds their own
-- row by their own token number. security definer because a patient cannot
-- (and must not) read other patients' appointment rows directly.
--
-- Dropped rather than replaced: it gains a `position` column, and OUT
-- parameters are part of a function's return type.
drop function if exists public.get_queue_status(uuid, date);
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (queue_position int, token_number int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select
    row_number() over (order by a.effective_order_time asc, a.checked_in_at asc)::int,
    a.token_number,
    a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
    and a.token_number is not null
  order by a.effective_order_time asc, a.checked_in_at asc;
$$;

-- ----------------------------------------------------------------------------
-- 31.5 Calling the next patient
-- ----------------------------------------------------------------------------
-- Server-side so the order rule can't be reinterpreted by a client.
--
-- No preemption: if somebody is already called or in consultation, this
-- refuses rather than pulling the doctor off them.
--
-- No idling: the candidate set is only ever patients who are physically here,
-- so the doctor is never held waiting for someone who hasn't arrived. An
-- earlier-slot patient who turns up within grace simply sorts to the front
-- and takes the NEXT free turn - never the current one.
create or replace function public.call_next_patient(p_doctor_id uuid, p_date date)
returns table (id uuid, token_number int, queue_position int, patient_name text, account_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_clinic_id uuid;
  v_busy uuid;
  v_next appointments;
begin
  select a.clinic_id into v_clinic_id
  from appointments a where a.doctor_id = p_doctor_id limit 1;

  if v_clinic_id is null then
    raise exception 'No appointments for this doctor.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(v_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select a.id into v_busy
  from appointments a
  where a.doctor_id = p_doctor_id and a.date = p_date
    and a.status in ('called', 'in_consultation')
  limit 1;

  if v_busy is not null then
    raise exception 'Someone is already being seen - finish or skip them first.';
  end if;

  select * into v_next
  from appointments a
  where a.doctor_id = p_doctor_id and a.date = p_date and a.status = 'checked_in'
  order by a.effective_order_time asc, a.checked_in_at asc
  limit 1;

  if v_next.id is null then
    raise exception 'Nobody is checked in and waiting.';
  end if;

  update appointments set status = 'called' where id = v_next.id;

  return query
  select v_next.id, v_next.token_number, 1, f.name, f.account_id
  from family_members f where f.id = v_next.member_id;
end;
$$;
