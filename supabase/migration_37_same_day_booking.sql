-- ============================================================================
-- 37. SAME-DAY BOOKING FOR APPOINTMENT-ONLY CLINICS
-- ============================================================================
-- Section 33 ("Part 44" in the product spec) gave an appointment_only clinic
-- a hard rule: no same-day booking, no walk-ins, from anyone. That's still
-- the default. This migration lets a clinic running that mode OPT IN to
-- same-day booking on top of it, without touching allow_walkins clinics at
-- all - they already accept same-day bookings and walk-ins today, unchanged.
--
-- Three new clinic settings, all off by default so no existing clinic's
-- behaviour changes until it turns them on:
--   * same_day_booking_enabled  - the switch itself.
--   * same_day_cutoff_minutes   - how close to a slot same-day booking still
--                                  works. A scheduled slot inside this window
--                                  (or already passed) is refused - a walk-in
--                                  is exempt, since its "slot" is just the
--                                  clock at the desk, not a future promise.
--   * auto_checkin_verified_same_day - see below.
--
-- A same-day booking still goes through every existing gate once its date is
-- allowed at all: the daily cap and per-day lock (section 33.3/33.4) and, for
-- a genuine scheduled slot, the slot capacity check (section 36.4, "Prompt 1"
-- - is this slot still free). Nothing about those is touched here.
--
-- Token timing - the reason this is its own migration and not a one-line
-- relaxation of the date check:
--   * A walk-in registered at the desk is, as it always has been, standing
--     right there - WalkInForm already checks that patient in immediately
--     and draws their token the moment it accepts the booking (see
--     WalkInForm.tsx / check_in_appointment()). Lifting the walk-in block
--     below for a same-day-enabled clinic is all that's needed; nothing else
--     changes for that path.
--   * A same-day booking made through the PATIENT'S OWN APP, while their
--     device can verifiably place them at the clinic (the same geofence
--     idea section 28 already uses for self check-in), is treated the same
--     way - checked in immediately, token drawn right away. See 37.3.
--   * A same-day booking made remotely - from home, for a slot later today,
--     with no location fix or one outside the clinic's radius - gets NONE of
--     that. It is accepted exactly like an advance booking and collects its
--     token only when the patient actually arrives and checks in, through
--     the ordinary check_in_appointment() path. This is the whole point: a
--     token is never held by someone who is not, in fact, there.
--
-- See TESTING.md "Test 18".

-- ----------------------------------------------------------------------------
-- 37.1 Clinic settings
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists same_day_booking_enabled boolean not null default false;

alter table clinics add column if not exists same_day_cutoff_minutes int not null default 30;
alter table clinics drop constraint if exists clinics_same_day_cutoff_minutes_check;
alter table clinics add constraint clinics_same_day_cutoff_minutes_check
  check (same_day_cutoff_minutes >= 0);

-- Off by default, same reasoning as self_checkin_enabled (section 28.3): this
-- changes who can walk away with a live token, which is the clinic's call.
alter table clinics add column if not exists auto_checkin_verified_same_day boolean not null default false;

-- A separate radius from self_checkin_radius_m (section 28.3) rather than
-- reusing it - a clinic may want self check-in off (or a tighter/looser
-- radius for it) while still trusting this narrower, booking-time check, or
-- vice versa. Same default as that column's.
alter table clinics add column if not exists same_day_checkin_radius_m int not null default 150;
alter table clinics drop constraint if exists clinics_same_day_checkin_radius_m_check;
alter table clinics add constraint clinics_same_day_checkin_radius_m_check
  check (same_day_checkin_radius_m > 0);

-- ----------------------------------------------------------------------------
-- 37.2 Appointment columns: the booking-time location fix
-- ----------------------------------------------------------------------------
-- Optional, set only by a same-day booking made from the patient's own app
-- that could get a fix - never by a walk-in (the desk already knows they're
-- present) and never by an advance booking (irrelevant until the day of).
-- Kept as real columns rather than passed-and-discarded, both so 37.3 below
-- can read them from NEW inside the same INSERT and so there's a record of
-- what the auto-check-in decision (or non-decision) was actually based on.
alter table appointments add column if not exists booking_lat double precision;
alter table appointments add column if not exists booking_lng double precision;

-- ----------------------------------------------------------------------------
-- 37.3 The policy, extended - same trigger function, same trigger name
-- ----------------------------------------------------------------------------
-- Re-declared rather than layered as a second trigger: the date/patient-type
-- gate is one contiguous decision, and splitting it across two triggers would
-- mean re-deriving "is this clinic even in appointment_only mode" twice and
-- risking the two disagreeing about what "today" is. Everything from section
-- 33.4 is preserved for a clinic that leaves same_day_booking_enabled off -
-- same messages, same order, same behaviour (see TESTING.md "Test 14",
-- untouched by this migration).
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

  -- Everything below is this mode's contract. Other clinics are untouched.
  if c.mode <> 'appointment_only' then
    return new;
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_today := v_now_local::date;
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

    -- A walk-in's "slot" is just the clock at the desk (see migration 36's
    -- enforce_slot_capacity, which never counts a walk-in against slot
    -- capacity either) - not a claim on a future time - so the cutoff, which
    -- exists to stop a SPECIFIC slot being grabbed moments before it starts,
    -- only applies to a genuine scheduled booking.
    if new.patient_type = 'scheduled'
       and (new.date + new.slot_time)::timestamp < v_now_local + make_interval(mins => c.same_day_cutoff_minutes)
    then
      raise exception 'SAME_DAY_CUTOFF: the % slot has already passed or is too soon - same-day booking closes % minutes before a slot starts.',
        to_char(new.slot_time, 'HH12:MI AM'), c.same_day_cutoff_minutes;
    end if;
    -- Walk-ins fall through from here exactly like any other same-day
    -- booking - the daily cap below still applies to them.
  else
    if new.patient_type = 'walk_in' then
      raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
    end if;

    if new.date > v_today + c.booking_horizon_days then
      raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
        c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
    end if;
  end if;

  -- Take the day's lock BEFORE counting. Two patients going for the last seat
  -- serialise here: the second one waits, then counts a day that is now full.
  insert into clinic_day_locks (clinic_id, date)
  values (new.clinic_id, new.date)
  on conflict (clinic_id, date) do update set updated_at = now();

  select seats_taken, is_full into v_taken, v_full
  from public.day_availability(new.clinic_id, new.date);

  if coalesce(v_full, false) then
    raise exception 'FULL_DAY: % is fully booked (% of % seats taken).',
      to_char(new.date, 'DD Mon YYYY'), v_taken, c.daily_cap;
  end if;

  -- Inside the cap, so there is nothing to approve: the only question this
  -- clinic asks of a booking is whether a seat exists.
  if new.status = 'booked' then
    new.status := 'accepted';
  end if;

  return new;
end;
$$;

-- Trigger itself is unchanged (still named/sorted to fire first) - only the
-- function body above changed, so no drop/create needed here.

-- ----------------------------------------------------------------------------
-- 37.4 Confirmed-present same-day bookings get their token immediately
-- ----------------------------------------------------------------------------
-- AFTER INSERT, not folded into 37.3's BEFORE INSERT trigger, and deliberately
-- calling check_in_appointment() rather than re-implementing any part of it:
-- the row needs a real id first, and this way the arrival-window rule, the
-- token counter and the effective_order_time stamp are exactly the same code
-- every other check-in path uses (sections 27/31) - not a second copy that
-- could drift from it.
--
-- Wrapped in its own sub-transaction (the BEGIN/EXCEPTION block) so a
-- check-in that check_in_appointment() would refuse anyway - most likely
-- because the slot is still more than 60 minutes out - never fails the
-- booking itself. The patient walks away with a valid accepted appointment
-- either way; they just collect their token at the door instead of this
-- instant, like any other same-day booking made without a location fix.
create or replace function public.auto_checkin_verified_same_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_now_local timestamp;
begin
  -- Only a genuine scheduled same-day booking is in scope. A walk-in is
  -- already checked in by the time its row exists (WalkInForm calls
  -- check_in_appointment() itself right after accepting it); an advance
  -- booking for a future date has nothing to verify yet.
  if new.patient_type <> 'scheduled' or new.status <> 'accepted' then
    return new;
  end if;

  select * into c from clinics where id = new.clinic_id;
  if c.id is null
     or c.mode <> 'appointment_only'
     or not c.same_day_booking_enabled
     or not c.auto_checkin_verified_same_day
  then
    return new;
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  if new.date <> v_now_local::date then
    return new;
  end if;

  -- No location fix to check against, or the clinic hasn't set its own
  -- location yet - either way, presence is simply unverified, which is the
  -- same as "not confirmed present". Falls through to a normal check-in
  -- later, same as a booking made from home.
  if new.booking_lat is null or new.booking_lng is null or c.lat is null or c.lng is null then
    return new;
  end if;

  if public.distance_metres(new.booking_lat, new.booking_lng, c.lat, c.lng) > c.same_day_checkin_radius_m then
    return new;
  end if;

  begin
    -- 'patient_scan' - the same method self_check_in() (section 28.6) uses
    -- for its own location-verified path; this is that same idea, just
    -- confirmed at booking time instead of a separate scan afterwards.
    perform public.check_in_appointment(new.id, 'patient_scan', false);
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists on_appointment_auto_checkin_same_day on appointments;
create trigger on_appointment_auto_checkin_same_day
  after insert on appointments
  for each row execute function public.auto_checkin_verified_same_day();
