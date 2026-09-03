-- ============================================================================
-- 30. FAIR QUEUE - DATA: PAYMENT AND PRESENCE ARE SEPARATE FACTS
-- ============================================================================
-- Two facts about an appointment that must never be conflated:
--
--   payment_status  - has the money been dealt with?
--                     pay_at_clinic / paid_online / paid_at_clinic / refunded
--   checked_in_at   - is the patient PHYSICALLY here?
--
-- Paying online does NOT check anyone in and buys NO queue priority. Someone
-- who paid online from their sofa is not in the live queue at all; they hold
-- no token until they walk through the door, exactly like everyone else. All
-- online payment buys is a faster tap at the desk, because there's no cash to
-- count.
--
-- This file makes that separation structural rather than merely intended:
-- section 30.5 stops presence columns being written by anything other than
-- the check-in path, so no amount of updating payment_status can manufacture
-- a token.
--
-- See TESTING.md "Test 11".

-- ----------------------------------------------------------------------------
-- 30.1 payment_status vocabulary
-- ----------------------------------------------------------------------------
-- The old values came from the demo payment flow: 'unpaid' (nothing decided),
-- 'cod' (pay cash on the day), 'hold' (money authorised online), 'captured'
-- (taken online). They collapse cleanly onto the four states that actually
-- matter to a receptionist.
alter table appointments drop constraint if exists appointments_payment_status_check;

update appointments set payment_status = 'pay_at_clinic'
where payment_status in ('unpaid', 'cod');

-- A hold is money already committed by the patient online; for this app's
-- purposes that is "paid online" - the desk has nothing to collect.
update appointments set payment_status = 'paid_online'
where payment_status in ('hold', 'captured');

alter table appointments alter column payment_status set default 'pay_at_clinic';
alter table appointments add constraint appointments_payment_status_check
  check (payment_status in ('pay_at_clinic', 'paid_online', 'paid_at_clinic', 'refunded'));

-- ----------------------------------------------------------------------------
-- 30.2 grace_minutes
-- ----------------------------------------------------------------------------
-- The clinic-wide setting already exists (clinics.checkin_grace_minutes, from
-- section 27). This adds an optional PER-APPOINTMENT override for the
-- occasional "this patient warned us they'd be late" case; null means "use
-- the clinic's setting", which is the normal state of the world.
alter table appointments add column if not exists grace_minutes int;

create or replace function public.effective_grace_minutes(p_appointment_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(a.grace_minutes, c.checkin_grace_minutes, 30)
  from appointments a
  join clinics c on c.id = a.clinic_id
  where a.id = p_appointment_id;
$$;

-- ----------------------------------------------------------------------------
-- 30.3 effective_order_time
-- ----------------------------------------------------------------------------
-- What the queue will actually sort on. The full fairness formula (weighing
-- the booked slot against real arrival, so a punctual 3PM booking isn't
-- overtaken by a 4PM booking who merely walked in first) lands in the NEXT
-- step. For now it is stamped with the arrival moment, which is exactly what
-- the queue orders by today - so the column is already true, just not yet
-- clever.
alter table appointments add column if not exists effective_order_time timestamptz;

-- Backfill the rows that already have a real arrival.
update appointments
set effective_order_time = checked_in_at
where checked_in_at is not null and effective_order_time is null;

-- ----------------------------------------------------------------------------
-- 30.4 Status changes no longer touch payment except to refund
-- ----------------------------------------------------------------------------
-- Accepting a booking used to flip 'hold' to 'captured'. Under the new
-- vocabulary there is nothing to flip: money paid online is already
-- paid_online, and a pay_at_clinic booking stays pay_at_clinic until someone
-- actually hands over cash (see mark_paid_at_clinic below). The only
-- automatic transition left is a refund when a booking is called off.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded'
    where appointment_id = new.id and status in ('hold', 'captured', 'pending');
  end if;
  return new;
end;
$$;

-- Collecting cash at the counter. Deliberately its own function, and
-- deliberately says nothing about presence: marking someone paid does not
-- check them in, and checking someone in does not mark them paid.
create or replace function public.mark_paid_at_clinic(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  if a.payment_status = 'paid_online' then
    raise exception 'This appointment was already paid online - there is nothing to collect.';
  end if;
  if a.payment_status = 'refunded' then
    raise exception 'This appointment has been refunded.';
  end if;

  update appointments set payment_status = 'paid_at_clinic' where id = a.id;
  update payments set status = 'captured' where appointment_id = a.id and status = 'pending';
end;
$$;

-- ----------------------------------------------------------------------------
-- 30.5 Presence cannot be forged
-- ----------------------------------------------------------------------------
-- appointments_update lets a clinic update its own rows, which until now
-- included checked_in_at, token_number and arrival_seq - so a determined
-- client could hand itself a token straight from the API, bypassing the
-- arrival counter entirely. Since this whole part rests on "presence is a
-- fact, not a claim", those columns are now writable ONLY from inside the
-- check-in functions, which announce themselves with a transaction-local
-- flag before they write.
--
-- Clearing a value back to null is still allowed: undoing a mistaken
-- check-in is a legitimate desk correction, and it grants nobody a place in
-- the queue.
create or replace function public.guard_presence_columns()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.checkin_write', true), '') = '1' then
    return new;  -- we're inside check_in_appointment()/skip_to_back()
  end if;

  if new.checked_in_at is not null and new.checked_in_at is distinct from old.checked_in_at then
    raise exception 'checked_in_at is set by checking a patient in, not by writing to it directly.';
  end if;
  if new.token_number is not null and new.token_number is distinct from old.token_number then
    raise exception 'token_number is issued by the arrival counter, not by writing to it directly.';
  end if;
  if new.arrival_seq is not null and new.arrival_seq is distinct from old.arrival_seq then
    raise exception 'arrival_seq is issued by the arrival counter, not by writing to it directly.';
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_guard_presence on appointments;
create trigger on_appointment_guard_presence
  before update on appointments
  for each row execute function public.guard_presence_columns();

-- ----------------------------------------------------------------------------
-- 30.6 The check-in path, re-declared to set the flag
-- ----------------------------------------------------------------------------
-- Same behaviour as section 29, plus: it announces itself to the guard above,
-- and it stamps effective_order_time. Note what it still does NOT do - it
-- never reads or writes payment_status. Presence and payment stay strangers.
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
      -- Placeholder until the fairness formula arrives: arrival time is what
      -- the queue orders by today.
      effective_order_time = v_now,
      no_show_marked_at = null,
      no_show_auto = false
  where id = a.id;

  perform set_config('app.checkin_write', '0', true);

  return query select v_seq, v_seq, a.date, false, v_late;
end;
$$;

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
  v_now timestamptz := now();
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

  perform set_config('app.checkin_write', '1', true);

  update appointments
  set token_number = v_seq,
      arrival_seq = v_seq,
      status = 'checked_in',
      skip_count = a.skip_count + 1,
      effective_order_time = v_now
  where id = a.id;

  perform set_config('app.checkin_write', '0', true);

  return query select v_seq, v_seq;
end;
$$;
