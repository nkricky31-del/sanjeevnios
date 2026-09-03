-- ============================================================================
-- 38. WALK-IN REGISTRATION: ONLY INTO A FREE SLOT
-- ============================================================================
-- Until now a walk-in was never actually checked against availability at
-- all: enforce_slot_capacity() (section 36.4) explicitly skipped
-- patient_type = 'walk_in', and the daily cap (section 33) only ever applied
-- in appointment_only mode. A clinic's front desk could always add "one
-- more" walk-in, no matter how full the doctor's slot grid or the day's cap
-- already was - deliberately, at the time (see section 36.4's own comment:
-- a walk-in's slot_time was just the clock at check-in, "not a claim on one
-- of the doctor's bookable times").
--
-- This migration reverses that: registering a walk-in now has to claim a
-- REAL open slot from the doctor's grid, at ANY clinic, in ANY mode -
-- exactly like an advance booking - and is refused when nothing is free,
-- the same "day full" / "slot full" way an advance booking already is:
--   * The daily cap (day_availability(), section 33.3) now also gates a
--     WALK-IN at an allow_walkins clinic, not just every booking at an
--     appointment_only one. An advance/scheduled booking at an
--     allow_walkins clinic is untouched - still unlimited, exactly as
--     before. Only the walk-in-at-the-desk path gained a ceiling.
--   * Slot capacity (enforce_slot_capacity(), section 36.4) now applies to a
--     walk-in's booking too - the client picks the current-or-next open
--     slot from the doctor's real grid (see findWalkInSlot() in
--     src/lib/queue.ts) instead of stamping the literal clock, and the
--     existing per-slot lock (doctor_slot_locks) makes the last-seat race
--     just as safe for a walk-in as it already was for a scheduled booking.
--   * The waitlist notification (section 33.5) is no longer appointment-only
--     - ANY clinic's waitlist entries now hear about a freed seat, since a
--     walk-in can now genuinely be turned away with "join the waitlist" as
--     the offer, not just an appointment_only patient.
--
-- Everything else about a walk-in is unchanged: found by phone or MRN (MRN
-- lookup is new below - phone lookup already existed, section 25), a new
-- patient still gets an MRN exactly as before (section 18, "Part 40" in the
-- product spec), and the moment the booking is accepted the desk still
-- checks them in immediately and draws their token right there
-- (WalkInForm.tsx's checkInNow - untouched, section 27).
--
-- Supersedes TESTING.md "Test 17" section F's old guarantee ("walk-ins
-- never contend for slot capacity") - see "Test 19" for the new behaviour.

-- ----------------------------------------------------------------------------
-- 38.1 Slot capacity now applies to a walk-in too
-- ----------------------------------------------------------------------------
-- Identical to section 36.4 except the patient_type exemption is gone. A
-- walk-in's slot_time is no longer the raw clock (see WalkInForm.tsx) - it's
-- a real computed slot from the doctor's grid, so counting it here means
-- exactly what it means for a scheduled booking: this exact slot_time's
-- active bookings have reached its capacity.
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity int;
  v_booked int;
begin
  -- Take the slot lock BEFORE counting - see 36.2.
  insert into doctor_slot_locks (doctor_id, date, slot_time)
  values (new.doctor_id, new.date, new.slot_time)
  on conflict (doctor_id, date, slot_time) do update set updated_at = now();

  v_capacity := public.slot_capacity_for(new.doctor_id, new.date, new.slot_time);

  select count(*) into v_booked
  from appointments
  where doctor_id = new.doctor_id
    and date = new.date
    and slot_time = new.slot_time
    and status not in ('cancelled', 'rejected');

  if v_booked >= v_capacity then
    raise exception 'SLOT_FULL: % on % is full (% of % taken) - pick another slot.',
      to_char(new.slot_time, 'HH12:MI AM'), to_char(new.date, 'DD Mon YYYY'), v_booked, v_capacity;
  end if;

  return new;
end;
$$;

-- Trigger itself is unchanged (still named/sorted the same) - only the
-- function body above changed, so no drop/create needed here.

-- ----------------------------------------------------------------------------
-- 38.2 The daily cap now also gates a walk-in, at any clinic
-- ----------------------------------------------------------------------------
-- Identical to section 37.3 except the daily-cap block's guard widens from
-- "appointment_only mode" to "appointment_only mode, OR this is a walk-in
-- anywhere". Everything about appointment_only mode's own contract (the
-- date-range gate, same-day cutoff, auto-accept) is completely unchanged -
-- it still only runs when c.mode = 'appointment_only', so an allow_walkins
-- clinic's SCHEDULED/advance bookings stay exactly as unlimited as before.
create or replace function public.enforce_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_now_local timestamp;
  v_same_day boolean;
  v_taken int;
  v_full boolean;
begin
  select * into c from clinics where id = new.clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_today := v_now_local::date;

  if c.mode = 'appointment_only' then
    v_same_day := (new.date = v_today);

    if new.date < v_today then
      raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
        to_char(case when c.same_day_booking_enabled then v_today else v_today + 1 end, 'DD Mon YYYY');
    end if;

    if v_same_day then
      if not c.same_day_booking_enabled then
        raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
          to_char(v_today + 1, 'DD Mon YYYY');
      end if;

      if new.patient_type = 'scheduled'
         and (new.date + new.slot_time)::timestamp < v_now_local + make_interval(mins => c.same_day_cutoff_minutes)
      then
        raise exception 'SAME_DAY_CUTOFF: the % slot has already passed or is too soon - same-day booking closes % minutes before a slot starts.',
          to_char(new.slot_time, 'HH12:MI AM'), c.same_day_cutoff_minutes;
      end if;
    else
      if new.patient_type = 'walk_in' then
        raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
      end if;

      if new.date > v_today + c.booking_horizon_days then
        raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
          c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
      end if;
    end if;
  end if;

  -- The daily cap: always enforced in appointment_only mode (as before, any
  -- booking), and now ALSO for a walk-in at any clinic - see this
  -- migration's header. A scheduled/advance booking at an allow_walkins
  -- clinic never reaches this block, so stays uncapped exactly as before;
  -- it still counts toward the total the way it always has, for whichever
  -- OTHER booking (a walk-in) does check the cap.
  if c.mode = 'appointment_only' or new.patient_type = 'walk_in' then
    -- Take the day's lock BEFORE counting - see 33.2.
    insert into clinic_day_locks (clinic_id, date)
    values (new.clinic_id, new.date)
    on conflict (clinic_id, date) do update set updated_at = now();

    select seats_taken, is_full into v_taken, v_full
    from public.day_availability(new.clinic_id, new.date);

    if coalesce(v_full, false) then
      raise exception 'FULL_DAY: % is fully booked (% of % seats taken).',
        to_char(new.date, 'DD Mon YYYY'), v_taken, c.daily_cap;
    end if;
  end if;

  -- Inside the cap, so there is nothing to approve - but only appointment_only
  -- mode auto-accepts. A walk-in at an allow_walkins clinic still goes
  -- through the desk's explicit accept step, exactly as before.
  if c.mode = 'appointment_only' and new.status = 'booked' then
    new.status := 'accepted';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 38.3 The waitlist is no longer appointment-only
-- ----------------------------------------------------------------------------
-- Identical to section 33.5's version except the mode gate is gone - a
-- walk-in can now genuinely be turned away from ANY clinic with "join the
-- waitlist" as the offer (see WalkInForm.tsx), so that clinic's waitlist
-- needs to actually fire when a seat frees up, the same way an
-- appointment_only clinic's always has.
create or replace function public.notify_waitlist_on_free_seat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w waitlist;
  v_clinic clinics;
begin
  if new.status not in ('cancelled', 'rejected') or old.status = new.status then
    return new;
  end if;

  select * into v_clinic from clinics where id = new.clinic_id;
  if v_clinic.id is null then
    return new;
  end if;

  select * into w
  from waitlist
  where clinic_id = new.clinic_id and date = new.date and status = 'waiting'
  order by created_at
  limit 1;

  if w.id is null then
    return new;
  end if;

  update waitlist set status = 'offered', offered_at = now() where id = w.id;

  insert into notifications (user_id, type, message)
  select f.account_id, 'waitlist_seat',
         'A seat has opened up at ' || v_clinic.name || ' on '
           || to_char(new.date, 'DD Mon YYYY') || '. Book now - it is first come, first served.'
  from family_members f
  where f.id = w.member_id;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 38.4 Finding an existing patient by MRN, for the walk-in desk
-- ----------------------------------------------------------------------------
-- Mirrors find_family_member_by_phone() (section 25) exactly, for the other
-- half of "find the patient by phone / MRN" - a receptionist who already
-- knows the patient's medical record number (from a card, a past visit
-- slip) shouldn't have to fall back to a phone-number guess. Unlike the
-- phone lookup, this is NOT "create if not found" from the caller's side -
-- an MRN is supposed to name one specific existing patient, so the desk
-- form treats "not found" as an error to fix (typo?) rather than a cue to
-- register a new one under a number that was never actually theirs.
create or replace function public.find_family_member_by_mrn(p_mrn text)
returns table (id uuid, mrn text, name text, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select fm.id, fm.mrn, fm.name, fm.phone
  from family_members fm
  where fm.mrn = trim(p_mrn)
    and (public.is_clinic() or public.is_admin());
$$;
