-- ============================================================================
-- 33. ADVANCE-ONLY BOOKING WITH A DAILY CAP (a clinic MODE)
-- ============================================================================
-- Some clinics don't want a waiting room full of hopefuls. They take a fixed
-- number of patients per day, booked in advance only, and that's that.
--
-- This is a MODE, not a rewrite: a clinic runs either
--   'allow_walkins'     - everything as before (the default; nothing changes
--                         for existing clinics), or
--   'appointment_only'  - no same-day booking, no walk-ins from anyone
--                         (patient app OR front desk), bookings limited to a
--                         horizon of N days ahead, and a hard daily cap.
--
-- In appointment_only mode a booking inside the cap is auto-confirmed - there
-- is nothing for the clinic to approve when the only question was "is there a
-- seat". The clinic can still cancel an individual booking with a reason.
--
-- When a day is full the patient is offered the waitlist for that day and/or
-- the next day that still has room.
--
-- See TESTING.md "Test 14".

-- ----------------------------------------------------------------------------
-- 33.1 Clinic settings
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists mode text not null default 'allow_walkins';
alter table clinics drop constraint if exists clinics_mode_check;
alter table clinics add constraint clinics_mode_check
  check (mode in ('allow_walkins', 'appointment_only'));

-- How far ahead patients may book. 1 = tomorrow only, which is the default
-- for this mode's archetype.
alter table clinics add column if not exists booking_horizon_days int not null default 1;
alter table clinics add column if not exists daily_cap int not null default 100;

-- ----------------------------------------------------------------------------
-- 33.2 The per-day lock
-- ----------------------------------------------------------------------------
-- One row per (clinic, day), used purely as a mutex. Two patients racing for
-- the last seat both try to take this row; the second waits for the first to
-- commit and then counts again, so it sees the seat gone.
--
-- Deliberately NOT a stored seat count. A cached number drifts the moment a
-- booking is cancelled, rescheduled or moved by the full-day tool, and a
-- capacity limit that quietly drifts is worse than none. The row is the lock;
-- the count is always taken live from `appointments`.
create table if not exists clinic_day_locks (
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, date)
);

alter table clinic_day_locks enable row level security;
-- No policies: reached only from the security-definer functions below.

-- ----------------------------------------------------------------------------
-- 33.3 How full is a day?
-- ----------------------------------------------------------------------------
-- Cancelled and rejected bookings free their seat. A no-show does NOT - that
-- seat was held all day by someone who simply didn't come, and the day is
-- over by the time it matters.
create or replace function public.day_availability(p_clinic_id uuid, p_date date)
returns table (seats_taken int, daily_cap int, seats_left int, is_full boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    taken.n::int,
    c.daily_cap,
    greatest(c.daily_cap - taken.n, 0)::int,
    (taken.n >= c.daily_cap)
  from clinics c
  cross join lateral (
    select count(*) as n
    from appointments a
    where a.clinic_id = c.id
      and a.date = p_date
      and a.status not in ('cancelled', 'rejected')
  ) taken
  where c.id = p_clinic_id;
$$;

-- The soonest day inside the horizon that still has room. Used to offer a
-- patient somewhere to go when their preferred day is full.
create or replace function public.next_available_day(p_clinic_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_day date;
  v_full boolean;
  i int;
begin
  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    return null;
  end if;

  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  -- appointment_only starts at tomorrow; allow_walkins can still use today.
  for i in (case when c.mode = 'appointment_only' then 1 else 0 end)..c.booking_horizon_days loop
    v_day := v_today + i;
    if exists (select 1 from clinic_holidays h where h.clinic_id = c.id and h.date = v_day) then
      continue;
    end if;
    select is_full into v_full from public.day_availability(c.id, v_day);
    if not coalesce(v_full, false) then
      return v_day;
    end if;
  end loop;

  return null;
end;
$$;

-- ----------------------------------------------------------------------------
-- 33.4 The policy, enforced on insert
-- ----------------------------------------------------------------------------
-- Named to sort FIRST among this table's BEFORE INSERT triggers (Postgres
-- fires them in alphabetical order). It has to beat
-- on_appointment_create_encounter, or a booking that's about to be refused
-- would burn an encounter number on its way out.
create or replace function public.enforce_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
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

  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  if new.patient_type = 'walk_in' then
    raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
  end if;

  if new.date <= v_today then
    raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
      to_char(v_today + 1, 'DD Mon YYYY');
  end if;

  if new.date > v_today + c.booking_horizon_days then
    raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
      c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
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

drop trigger if exists on_appointment_aa_booking_policy on appointments;
create trigger on_appointment_aa_booking_policy
  before insert on appointments
  for each row execute function public.enforce_booking_policy();

-- ----------------------------------------------------------------------------
-- 33.5 Waitlist
-- ----------------------------------------------------------------------------
create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete cascade,
  doctor_id uuid references doctors (id) on delete set null,
  date date not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'offered', 'converted', 'cancelled')),
  offered_at timestamptz,
  created_at timestamptz not null default now(),
  -- One entry per person per clinic per day; asking twice doesn't buy a
  -- better place.
  unique (clinic_id, member_id, date)
);

alter table waitlist enable row level security;

drop policy if exists "waitlist_select" on waitlist;
create policy "waitlist_select" on waitlist for select
  using (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_mrn(member_id));

drop policy if exists "waitlist_insert" on waitlist;
create policy "waitlist_insert" on waitlist for insert
  with check (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_mrn(member_id));

drop policy if exists "waitlist_update" on waitlist;
create policy "waitlist_update" on waitlist for update
  using (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_mrn(member_id));

create index if not exists waitlist_clinic_date_idx on waitlist (clinic_id, date, created_at);

-- When a seat frees on a full day, tell the person who has been waiting
-- longest. It only NOTIFIES - it never books on their behalf, because a seat
-- silently allocated to someone who has since made other plans is worse than
-- no seat at all.
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
  if v_clinic.mode <> 'appointment_only' then
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

drop trigger if exists on_appointment_free_seat on appointments;
create trigger on_appointment_free_seat
  after update on appointments
  for each row execute function public.notify_waitlist_on_free_seat();

-- Joining the waitlist. Idempotent: asking again returns the existing entry
-- rather than creating a second one or moving anybody up.
create or replace function public.join_waitlist(
  p_clinic_id uuid,
  p_member_id uuid,
  p_date date,
  p_doctor_id uuid default null
)
returns table (id uuid, already_waiting boolean, place int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing waitlist;
  v_id uuid;
begin
  if not (public.is_admin() or public.is_own_mrn(p_member_id) or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select * into v_existing
  from waitlist
  where clinic_id = p_clinic_id and member_id = p_member_id and date = p_date;

  if v_existing.id is not null then
    if v_existing.status = 'cancelled' then
      update waitlist set status = 'waiting', created_at = now() where id = v_existing.id;
    end if;
    v_id := v_existing.id;
  else
    insert into waitlist (clinic_id, member_id, doctor_id, date)
    values (p_clinic_id, p_member_id, p_doctor_id, p_date)
    returning waitlist.id into v_id;
  end if;

  return query
  select v_id,
         (v_existing.id is not null),
         (select count(*)::int
          from waitlist w2
          where w2.clinic_id = p_clinic_id and w2.date = p_date
            and w2.status in ('waiting', 'offered')
            and w2.created_at <= (select w3.created_at from waitlist w3 where w3.id = v_id));
end;
$$;
