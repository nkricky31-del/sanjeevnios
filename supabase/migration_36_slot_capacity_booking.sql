-- ============================================================================
-- 36. SLOT-BASED BOOKING: CAPACITY & AVAILABILITY
-- ============================================================================
-- Until now a "slot" was never a real thing in the database - DoctorPage and
-- WalkInForm compute the day's slot TIMES on the client (see computeSlots()
-- in time.ts) and get_taken_slots() just says which of those exact times
-- already has ANY active booking. That is a capacity of exactly 1, silently,
-- with no server-side atomicity: two patients whose inserts land in the same
-- moment can both succeed at the same slot_time, because nothing ever locks
-- or re-checks between "is it free" and "take it".
--
-- This migration makes a slot a real capacity concept and closes that race,
-- for BOTH advance bookings and same-day walk-ins booked ahead:
--   * Each weekly availability window (doctor_availability) now carries a
--     slot_capacity - how many patients ONE of its computed time slots can
--     hold. Defaults to 1, so every existing clinic behaves exactly as
--     before until someone raises it.
--   * A slot is full when the number of active (not cancelled/rejected)
--     bookings at that exact (doctor, date, slot_time) reaches its capacity.
--   * Taking the last seat in a slot is enforced atomically on the server,
--     the same way section 33.2's clinic_day_locks makes the daily-cap check
--     race-proof: a per-slot lock row is taken BEFORE counting, so the
--     second of two simultaneous inserts for the last seat waits, then
--     counts a slot that is now full and is refused.
--   * The existing daily cap (section 33, "Part 44" in the product spec)
--     is untouched and still only applies in appointment_only mode - a day
--     is full when THAT cap is reached OR every one of the doctor's slots
--     for the day is full, whichever comes first. The second half of that
--     is simply what happens once every computed slot_time has hit its own
--     capacity: get_taken_slots() (redeclared below) reports all of them
--     taken, and the picker has nothing left to offer.
--
-- Deliberately NOT a stored, independently-maintained booked_count column -
-- see clinic_day_locks' own comment (section 33.2) for why a cached tally
-- that has to be kept in sync by hand (insert here, decrement there, don't
-- forget the reject path...) drifts the moment anyone misses a spot, and a
-- capacity limit that quietly drifts is worse than none. A slot's booked
-- count is always taken live from `appointments`, exactly like the daily
-- cap already is; doctor_slot_locks is the lock, not the ledger.
--
-- See TESTING.md "Test 17".

-- ----------------------------------------------------------------------------
-- 36.1 Capacity per slot
-- ----------------------------------------------------------------------------
-- How many patients ONE computed slot in this window can hold. Distinct from
-- max_patients_per_day, which decides how many slots the window is divided
-- into in the first place (see computeSlots() in time.ts) - that number times
-- this one is the window's true total capacity for the day.
alter table doctor_availability add column if not exists slot_capacity int not null default 1;
alter table doctor_availability drop constraint if exists doctor_availability_slot_capacity_check;
alter table doctor_availability add constraint doctor_availability_slot_capacity_check
  check (slot_capacity > 0);

-- ----------------------------------------------------------------------------
-- 36.2 The per-slot lock
-- ----------------------------------------------------------------------------
-- One row per (doctor, day, slot_time), used purely as a mutex - same shape
-- and purpose as clinic_day_locks (section 33.2), one level more specific.
-- Two patients racing for the last seat in one slot both try to take this
-- row; the second waits for the first to commit, then re-counts a slot that
-- is now full. Not a stored seat count - see the migration header above.
create table if not exists doctor_slot_locks (
  doctor_id uuid not null references doctors (id) on delete cascade,
  date date not null,
  slot_time time not null,
  updated_at timestamptz not null default now(),
  primary key (doctor_id, date, slot_time)
);

alter table doctor_slot_locks enable row level security;
-- No policies: reached only from the security-definer functions below.

-- ----------------------------------------------------------------------------
-- 36.3 Resolving a slot's capacity
-- ----------------------------------------------------------------------------
-- Which weekly window a given (doctor, date, slot_time) falls in, and that
-- window's slot_capacity. Falls back to 1 for a slot_time that doesn't land
-- inside any current window (e.g. a walk-in's "right now" timestamp, or a
-- window since removed) - the same conservative default the column itself
-- uses, so an unmatched slot is never silently treated as unlimited.
create or replace function public.slot_capacity_for(p_doctor_id uuid, p_date date, p_slot_time time)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select da.slot_capacity
      from doctor_availability da
      where da.doctor_id = p_doctor_id
        and da.weekday = extract(dow from p_date)::smallint
        and da.start_time <= p_slot_time
        and p_slot_time < da.end_time
      order by da.start_time
      limit 1
    ),
    1
  );
$$;

-- ----------------------------------------------------------------------------
-- 36.4 Enforced atomically on insert
-- ----------------------------------------------------------------------------
-- Named to sort right after on_appointment_aa_booking_policy (section 33.4)
-- and before every other BEFORE INSERT trigger on this table, so a booking
-- that's about to be refused for a full slot doesn't burn a subscription
-- booking, an encounter number, or an auto-confirm - same reasoning as why
-- the daily-cap gate sorts first.
--
-- Only genuine scheduled slot bookings claim a seat: patient_type = 'walk_in'
-- is a patient standing at the desk right now, whose slot_time is just the
-- clock at check-in (see createAndAcceptAppointment() in WalkInForm.tsx) -
-- not a claim on one of the doctor's bookable times, so it never contends
-- for slot capacity. A future visit booked in that same walk-in flow IS
-- patient_type = 'scheduled' and goes through exactly like a patient
-- self-booking one.
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
  if new.patient_type <> 'scheduled' then
    return new;
  end if;

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

drop trigger if exists on_appointment_ab_slot_capacity on appointments;
create trigger on_appointment_ab_slot_capacity
  before insert on appointments
  for each row execute function public.enforce_slot_capacity();

-- ----------------------------------------------------------------------------
-- 36.5 get_taken_slots(), made capacity-aware
-- ----------------------------------------------------------------------------
-- Re-declared: a slot_time now reports as taken only once its ACTIVE booking
-- count reaches its capacity, not the instant it has one booking. For every
-- clinic still on the default slot_capacity = 1 this returns exactly what it
-- always did. Every existing caller (SlotPicker, WalkInForm's future-slot
-- picker, queue.ts's findNextBestSlot/findNextNSlots used by the waitlist and
-- RejectAppointmentForm's "next available slot" suggestion) treats this as
-- "times to exclude from the picker", so all of them gain capacity-aware
-- behaviour with no caller-side change.
create or replace function public.get_taken_slots(p_doctor_id uuid, p_date date)
returns table (slot_time time)
language sql
stable
security definer
set search_path = public
as $$
  select a.slot_time
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status not in ('rejected', 'cancelled')
  group by a.slot_time
  having count(*) >= public.slot_capacity_for(p_doctor_id, p_date, a.slot_time);
$$;

-- ----------------------------------------------------------------------------
-- 36.6 Index
-- ----------------------------------------------------------------------------
-- Both the trigger's live count and get_taken_slots() filter/group on
-- exactly this shape.
create index if not exists appointments_doctor_date_slot_idx
  on appointments (doctor_id, date, slot_time)
  where status not in ('cancelled', 'rejected');
