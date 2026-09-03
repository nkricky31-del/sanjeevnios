-- ============================================================================
-- 34. PUBLISH THE DAY SCHEDULE (the night-before batch)
-- ============================================================================
-- This is SCHEDULING, not check-in. The evening before (or whenever the
-- clinic opens), the desk publishes the running order for that day's booked
-- patients in ONE action. For every booked patient that day, publishing:
--
--   * assigns a sequence number - their place in the day's order, 1..N,
--   * works out an estimated appointment time, walking forward from the
--     clinic's day-start time in fixed per-patient minutes, and
--   * notifies the patient that their number and time are now available.
--
-- Publishing does NOT check anyone in and does NOT touch token_number - that
-- stays exactly what section 27 made it: a real number handed out at the
-- door, in arrival order, the moment a patient is actually checked in. A
-- published sequence number is a plan; the arrival token is what actually
-- happened. Being CALLED still requires check-in on arrival, which is what
-- keeps a no-show from stalling the queue - see check_in_appointment().
--
-- Ordering follows booked slot time (every appointment has one), falling
-- back to booking time (created_at) only to break a tie between two
-- identical slot times. The clinic can override that order, or block out a
-- break, before publishing - see 34.3 and 34.4.
--
-- See TESTING.md "Test 15".

-- ----------------------------------------------------------------------------
-- 34.1 Clinic settings the estimate is built from
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists publish_start_time time not null default '09:00:00';

alter table clinics drop constraint if exists clinics_avg_minutes_per_patient_check;
alter table clinics add column if not exists avg_minutes_per_patient int not null default 10;
alter table clinics add constraint clinics_avg_minutes_per_patient_check check (avg_minutes_per_patient > 0);

-- ----------------------------------------------------------------------------
-- 34.2 Appointment columns
-- ----------------------------------------------------------------------------
-- The published running-order number. Deliberately a separate column from
-- token_number (section 27): this one is assigned the night before, to
-- EVERY booked patient, in booking order; token_number is assigned at the
-- door, only to patients who actually showed up, in arrival order. Mixing
-- the two would silently reintroduce the "a punctual booking loses its place
-- to whoever happens to arrive first" problem section 27 was written to fix.
alter table appointments add column if not exists sequence_no int;
alter table appointments add column if not exists estimated_time time;
-- Null until the first publish for this appointment's day; set on every
-- publish/republish after that. Read by the client purely to decide whether
-- to show "your number will be published" or the number itself - it isn't
-- used in check-in.
alter table appointments add column if not exists schedule_published_at timestamptz;
-- The clinic's manual reorder, set directly (appointments RLS already lets
-- the owning clinic update its own rows). A plain rank rather than an
-- integer position: to move a patient between two neighbours, the clinic
-- sets this to the midpoint of their two ranks, so reordering one patient
-- never requires renumbering everyone else. Null means "no override - use
-- slot time".
alter table appointments add column if not exists day_order_override double precision;

-- One published sequence number per clinic per day. Catches a bug in
-- compute_day_schedule() rather than silently handing two patients the same
-- slip.
drop index if exists appointments_clinic_day_sequence_unique;
create unique index appointments_clinic_day_sequence_unique
  on appointments (clinic_id, date, sequence_no)
  where sequence_no is not null;

-- ----------------------------------------------------------------------------
-- 34.3 Breaks the clinic blocks out before publishing
-- ----------------------------------------------------------------------------
-- "Insert a `minutes`-long gap before whoever ends up as the `before_seq`th
-- patient." Kept as a position in the FINAL order rather than a clock time,
-- because the whole point of a break is to hold regardless of how the
-- clinic reorders people around it - a lunch break "before patient 15" stays
-- before patient 15 even if patient 15 changes.
create table if not exists clinic_schedule_breaks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  before_seq int not null check (before_seq > 0),
  minutes int not null check (minutes > 0),
  label text,
  created_at timestamptz not null default now()
);

alter table clinic_schedule_breaks enable row level security;

drop policy if exists "clinic_schedule_breaks_all" on clinic_schedule_breaks;
create policy "clinic_schedule_breaks_all" on clinic_schedule_breaks for all
  using (public.is_own_clinic(clinic_id) or public.is_admin())
  with check (public.is_own_clinic(clinic_id) or public.is_admin());

create index if not exists clinic_schedule_breaks_day_idx on clinic_schedule_breaks (clinic_id, date);

-- ----------------------------------------------------------------------------
-- 34.4 compute_day_schedule(): the ordering, shared by preview and publish
-- ----------------------------------------------------------------------------
-- Everyone with a live reservation for the day - booked, accepted, or
-- already further along (a republish mid-day must not drop someone who has
-- since been checked in). Cancelled/rejected/completed/no_show hold no
-- place in a running order.
--
-- Order: the clinic's manual rank if it set one, else booking-time-derived
-- rank (slot_time, then created_at to break a tie). Read-only - this never
-- writes anything, so calling it twice in the same publish (once to find
-- who fell out, once to write) is cheap and always consistent.
create or replace function public.compute_day_schedule(p_clinic_id uuid, p_date date)
returns table (appointment_id uuid, seq int, estimated_time time)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c clinics;
  v_clock time;
  v_minutes int;
  v_seq int := 0;
  v_break_minutes int;
  r record;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  v_clock := c.publish_start_time;
  v_minutes := greatest(c.avg_minutes_per_patient, 1);

  for r in (
    with base as (
      select a.id,
             row_number() over (order by a.slot_time, a.created_at) as base_rank,
             a.day_order_override
      from appointments a
      where a.clinic_id = p_clinic_id
        and a.date = p_date
        and a.status in ('booked', 'accepted', 'checked_in', 'called', 'in_consultation')
    )
    select id
    from base
    order by coalesce(day_order_override, base_rank), base_rank
  ) loop
    v_seq := v_seq + 1;

    -- Any break(s) the clinic placed right before this position push the
    -- clock forward before this patient's time is set.
    select coalesce(sum(b.minutes), 0) into v_break_minutes
    from clinic_schedule_breaks b
    where b.clinic_id = p_clinic_id and b.date = p_date and b.before_seq = v_seq;
    v_clock := v_clock + make_interval(mins => v_break_minutes);

    appointment_id := r.id;
    seq := v_seq;
    estimated_time := v_clock;
    return next;

    v_clock := v_clock + make_interval(mins => v_minutes);
  end loop;
end;
$$;

-- Read-only look at what publishing WOULD do, so the clinic can review the
-- order (and add breaks / drag people around) before committing to it.
-- Touches nothing.
create or replace function public.preview_day_schedule(p_clinic_id uuid, p_date date)
returns table (
  appointment_id uuid,
  seq int,
  estimated_time time,
  member_name text,
  doctor_name text,
  slot_time time,
  status text,
  patient_type text,
  day_order_override double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select c.appointment_id, c.seq, c.estimated_time, fm.name, d.name, a.slot_time, a.status, a.patient_type,
         a.day_order_override
  from public.compute_day_schedule(p_clinic_id, p_date) c
  join appointments a on a.id = c.appointment_id
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  order by c.seq;
$$;

-- ----------------------------------------------------------------------------
-- 34.5 publish_day_schedule(): the one action
-- ----------------------------------------------------------------------------
-- Writes sequence_no/estimated_time/schedule_published_at onto every
-- appointment compute_day_schedule() names, notifies each patient, and hands
-- back the published list (with the patient's permanent visit id - the
-- encounter_no every booking already carries, see section 18 - so the
-- clinic/patient screens have something stable to print or scan against).
-- Nothing here sets checked_in_at, status, or token_number: this function
-- never makes anyone "present".
create or replace function public.publish_day_schedule(p_clinic_id uuid, p_date date)
returns table (
  appointment_id uuid,
  seq int,
  estimated_time time,
  member_name text,
  encounter_no text,
  doctor_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  c clinics;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  -- Anyone who has fallen out of today's run since the last publish
  -- (cancelled, rejected, written off as a no-show) loses their stale number
  -- rather than go on showing a slip for a place that no longer exists.
  update appointments a
  set sequence_no = null, estimated_time = null
  where a.clinic_id = p_clinic_id and a.date = p_date
    and a.sequence_no is not null
    and not exists (
      select 1 from public.compute_day_schedule(p_clinic_id, p_date) comp where comp.appointment_id = a.id
    );

  update appointments a
  set sequence_no = comp.seq,
      estimated_time = comp.estimated_time,
      schedule_published_at = v_now
  from public.compute_day_schedule(p_clinic_id, p_date) comp
  where a.id = comp.appointment_id;

  -- Tell every patient in this run their place and time. Sent on every
  -- publish, including a republish after a reorder - the point is that the
  -- number on the patient's phone always matches what's on file, not that it
  -- is announced exactly once.
  insert into notifications (user_id, appointment_id, type, message)
  select fm.account_id, a.id, 'schedule_published',
    'Your number for ' || to_char(p_date, 'DD Mon YYYY') || ' at ' || c.name || ' is #' || a.sequence_no
      || ', expected around ' || to_char(a.estimated_time, 'HH12:MI AM')
      || '. This is your place in the day''s order, not a check-in - you will still need to check in when you arrive.'
  from appointments a
  join family_members fm on fm.id = a.member_id
  where a.clinic_id = p_clinic_id and a.date = p_date and a.schedule_published_at = v_now;

  return query
  select a.id, a.sequence_no, a.estimated_time, fm.name, e.encounter_no, d.name
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  left join encounters e on e.id = a.encounter_id
  where a.clinic_id = p_clinic_id and a.date = p_date and a.schedule_published_at = v_now
  order by a.sequence_no;
end;
$$;
