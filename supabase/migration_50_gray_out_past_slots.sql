-- ============================================================================
-- 50. GRAY OUT PAST TIME SLOTS
-- ============================================================================
-- enforce_booking_policy()'s SAME_DAY_CUTOFF check (section 37.3) - "a
-- same-day slot that has already passed, or starts too soon, can't be
-- booked" - has only ever applied to an appointment_only clinic that opted
-- into same-day booking, gated by `if c.mode = 'appointment_only' then ...`.
-- An allow_walkins clinic (the default, and the common case) has never had
-- ANY same-day past-slot protection at all: a patient could book a 10 AM
-- slot from home at 2 PM the same day, and the server would happily accept
-- it - SlotPicker.tsx showed every one of today's computed slots as a plain,
-- selectable time with no time-of-day awareness whatsoever.
--
--   * clinics.past_slot_buffer_minutes - a new, always-on setting (default
--     10 minutes, matches the spec's own example) that plays the exact same
--     role same_day_cutoff_minutes already plays for an appointment_only
--     clinic, for every OTHER clinic. Admin-editable from
--     ClinicBookingMode.tsx, same as its sibling.
--   * enforce_booking_policy() - the SAME_DAY_CUTOFF check is generalized
--     from "only in appointment_only mode" to "in any mode, for a scheduled
--     (not walk-in) booking on today's date" - using same_day_cutoff_minutes
--     where that admin-set number already applies (appointment_only + same-
--     day booking enabled), and past_slot_buffer_minutes everywhere else.
--     Deliberately kept as the SAME error prefix (SAME_DAY_CUTOFF) rather
--     than a new one: the client already has a complete, working "That time
--     is too close now" recovery screen wired to that exact prefix
--     (isSameDayCutoffError() in bookingPolicy.ts, BookingForm.tsx's
--     sameDayCutoff state) - this is the same rule, now applied more widely,
--     not a second rule to keep consistent with the first.
--   * Everything else about enforce_booking_policy() - the advance-only
--     date-range checks, the daily cap, walk-in gating, auto-accept - is
--     completely unchanged, and still scoped to appointment_only mode only.
-- ============================================================================

alter table clinics add column if not exists past_slot_buffer_minutes int not null default 10;
alter table clinics drop constraint if exists clinics_past_slot_buffer_minutes_check;
alter table clinics add constraint clinics_past_slot_buffer_minutes_check
  check (past_slot_buffer_minutes >= 0);

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
  v_cutoff_minutes int;
begin
  select * into c from clinics where id = new.clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_today := v_now_local::date;
  v_same_day := (new.date = v_today);

  if c.mode = 'appointment_only' then
    if new.date < v_today then
      raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
        to_char(case when c.same_day_booking_enabled then v_today else v_today + 1 end, 'DD Mon YYYY');
    end if;

    if v_same_day then
      if not c.same_day_booking_enabled then
        raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
          to_char(v_today + 1, 'DD Mon YYYY');
      end if;

      if new.patient_type = 'walk_in' then
        raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
      end if;
    else
      if new.date > v_today + c.booking_horizon_days then
        raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
          c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
      end if;
    end if;
  end if;

  -- GRAY OUT PAST TIME SLOTS (schema.sql section 50) - a scheduled booking
  -- for a slot that has already started, or starts within the buffer below,
  -- is refused - in ANY clinic mode, not just appointment_only. A walk-in's
  -- slot_time is a real, currently-open slot picked from the doctor's grid
  -- at the moment of registration (section 38), never a stale one, so this
  -- never applies to patient_type = 'walk_in'.
  if v_same_day and new.patient_type = 'scheduled' then
    v_cutoff_minutes := case
      when c.mode = 'appointment_only' and c.same_day_booking_enabled then c.same_day_cutoff_minutes
      else c.past_slot_buffer_minutes
    end;

    if (new.date + new.slot_time)::timestamp < v_now_local + make_interval(mins => v_cutoff_minutes) then
      raise exception 'SAME_DAY_CUTOFF: the % slot has already passed or is too soon - same-day booking closes % minutes before a slot starts.',
        to_char(new.slot_time, 'HH12:MI AM'), v_cutoff_minutes;
    end if;
  end if;

  -- The daily cap: always enforced in appointment_only mode (as before, any
  -- booking), and now ALSO for a walk-in at any clinic (section 38.2). A
  -- scheduled/advance booking at an allow_walkins clinic never reaches this
  -- block, so stays uncapped exactly as before.
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
