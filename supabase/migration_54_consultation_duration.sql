-- ============================================================================
-- 54. CONSULTATION DURATION - timed automatically from the status change
-- ============================================================================
-- Extends the visit/consultation flow (WaitingList.tsx's "Start consultation"
-- / "Complete" buttons, VisitScreen.tsx). Nothing in either file needs to
-- change to make this work: both already just do a plain
-- `appointments.update({ status })` (see WaitingList.tsx's setStatus()), and
-- everything below reacts to THAT status change - the same "derive from the
-- status column" pattern broadcast_appointment_queue_change() (section 27.8)
-- and mark_paid_at_clinic() (section 52) already use.
--
-- Four things land together:
--
--   1. appointments.called_at - stamped the instant call_next_patient()
--      (section 31) flips status to 'called'. Exists mainly as the fallback
--      start-of-consultation reference for guard case #3 below, but is also
--      just generally useful (same idea as checked_in_at).
--
--   2. visits gains consultation_started_at, consultation_ended_at,
--      duration_minutes, waiting_time_minutes and needs_review. All five are
--      written ONLY by sync_consultation_stats() below (guard_consultation_stats()
--      rejects a direct write the same way guard_presence_columns() already
--      protects checked_in_at/token_number) - a clinic can still freely write
--      notes/diagnosis/follow_up_* on the same row (VisitScreen.tsx), just not
--      back-date its own consultation timing.
--
--   3. sync_consultation_stats() - an AFTER UPDATE trigger on appointments
--      that fires only when status actually changes:
--        - -> 'in_consultation': ensures a visits row exists for this
--          appointment (VisitScreen.tsx otherwise only creates one once the
--          doctor first saves notes or signs a prescription - this makes sure
--          there's always somewhere to record the start time even if the
--          doctor never types anything) and stamps consultation_started_at +
--          waiting_time_minutes (checked_in_at -> now, section 27).
--        - -> 'completed': stamps consultation_ended_at + duration_minutes.
--          Guards the odd cases the spec calls out: if consultation_started_at
--          was never recorded (status jumped straight to 'completed' outside
--          the normal called -> in_consultation path), falls back to
--          called_at; if NEITHER exists, duration_minutes is left null and
--          needs_review is set. A consultation left open for more than
--          CONSULTATION_REVIEW_THRESHOLD_MINUTES (180 = 3 hours - generous for
--          a single visit, well short of "overnight") also gets
--          needs_review = true, WITHOUT lying about the actual elapsed time -
--          get_doctor_avg_consultation_minutes() below simply excludes
--          needs_review rows from the average, so one stuck/forgotten visit
--          can never drag a doctor's reported average toward six hours.
--
--   4. get_doctor_avg_consultation_minutes(doctor_id) - a SECURITY DEFINER
--      aggregate (same shape as get_queue_status()/is_currently_verified():
--      returns a number, never a row) so both the clinic's own queue screen
--      and a PATIENT'S "estimated wait" (average x people ahead, replacing
--      the cruder slot-width guess once a doctor has any history at all) can
--      read it without needing direct SELECT on other patients' visits.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 54.1 appointments.called_at
-- ----------------------------------------------------------------------------
alter table appointments add column if not exists called_at timestamptz;

-- Always the LATEST call - skip_to_back() (section 31) resets the same row to
-- 'checked_in' and it can be called again later, and the freshest call time
-- is what waiting/duration math should anchor to either way. Overwrites
-- unconditionally rather than rejecting, so a plain `update({status})` from
-- WaitingList.tsx never has to know this column exists.
create or replace function public.stamp_called_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'called' and old.status is distinct from new.status then
    new.called_at := now();
  else
    -- Pinned to whatever it already was on every other update, so a client
    -- can never sneak in a fabricated value on an update that leaves status
    -- alone (e.g. a reminder_count bump while already 'called').
    new.called_at := old.called_at;
  end if;
  return new;
end;
$$;

drop trigger if exists before_appointment_called_at on appointments;
create trigger before_appointment_called_at
  before update on appointments
  for each row
  execute function public.stamp_called_at();

-- ----------------------------------------------------------------------------
-- 54.2 visits gains the timing columns.
-- ----------------------------------------------------------------------------
alter table visits add column if not exists consultation_started_at timestamptz;
alter table visits add column if not exists consultation_ended_at timestamptz;
alter table visits add column if not exists duration_minutes int;
alter table visits add column if not exists waiting_time_minutes int;
alter table visits add column if not exists needs_review boolean not null default false;

-- ----------------------------------------------------------------------------
-- 54.3 Money/presence-style guard: these five columns are recorded
-- automatically, never editable by hand, in either table's clinic-facing
-- write path.
-- ----------------------------------------------------------------------------
create or replace function public.guard_consultation_stats()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.consultation_write', true), '') = '1' then
    return new;  -- we're inside sync_consultation_stats()
  end if;

  if tg_op = 'INSERT' then
    if new.consultation_started_at is not null or new.consultation_ended_at is not null
       or new.duration_minutes is not null or new.waiting_time_minutes is not null
       or new.needs_review is true
    then
      raise exception 'Consultation timing is recorded automatically and cannot be set directly.';
    end if;
    return new;
  end if;

  if new.consultation_started_at is distinct from old.consultation_started_at
     or new.consultation_ended_at is distinct from old.consultation_ended_at
     or new.duration_minutes is distinct from old.duration_minutes
     or new.waiting_time_minutes is distinct from old.waiting_time_minutes
     or new.needs_review is distinct from old.needs_review
  then
    raise exception 'Consultation timing is recorded automatically and cannot be edited directly.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_visits_consultation_stats on visits;
create trigger guard_visits_consultation_stats
  before insert or update on visits
  for each row
  execute function public.guard_consultation_stats();

-- ----------------------------------------------------------------------------
-- 54.4 sync_consultation_stats() - the only thing that ever writes those
-- five columns.
-- ----------------------------------------------------------------------------
create or replace function public.sync_consultation_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v visits;
  v_start timestamptz;
  v_minutes numeric;
  v_wait numeric;
begin
  -- Started: make sure a visits row exists (VisitScreen.tsx otherwise only
  -- creates one once the doctor saves something) and stamp the start.
  if new.status = 'in_consultation' and old.status is distinct from new.status then
    select * into v from visits where appointment_id = new.id order by created_at desc limit 1;

    if new.checked_in_at is not null then
      v_wait := round((extract(epoch from (now() - new.checked_in_at)) / 60)::numeric);
    else
      v_wait := null;
    end if;

    perform set_config('app.consultation_write', '1', true);
    if v.id is null then
      insert into visits (appointment_id, consultation_started_at, waiting_time_minutes)
      values (new.id, now(), v_wait);
    else
      update visits set consultation_started_at = now(), waiting_time_minutes = v_wait where id = v.id;
    end if;
    perform set_config('app.consultation_write', '0', true);
  end if;

  -- Completed: stamp the end + duration. Falls back to called_at if the
  -- consultation was somehow never marked started; flags (never silently
  -- caps) anything over 3 hours so one forgotten/stuck visit can't corrupt
  -- the average below.
  if new.status = 'completed' and old.status is distinct from new.status then
    select * into v from visits where appointment_id = new.id order by created_at desc limit 1;

    v_start := coalesce(v.consultation_started_at, new.called_at);
    if v_start is not null then
      v_minutes := round((extract(epoch from (now() - v_start)) / 60)::numeric);
    else
      v_minutes := null;
    end if;

    perform set_config('app.consultation_write', '1', true);
    if v.id is null then
      insert into visits (appointment_id, consultation_ended_at, duration_minutes, needs_review)
      values (new.id, now(), v_minutes, (v_start is null or v_minutes > 180));
    else
      update visits
      set consultation_ended_at = now(),
          duration_minutes = v_minutes,
          needs_review = (v_start is null or v_minutes > 180)
      where id = v.id;
    end if;
    perform set_config('app.consultation_write', '0', true);
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_consultation_stats on appointments;
create trigger on_appointment_consultation_stats
  after update on appointments
  for each row
  when (new.status is distinct from old.status)
  execute function public.sync_consultation_stats();

-- ----------------------------------------------------------------------------
-- 54.5 get_doctor_avg_consultation_minutes() - the clinic's "average
-- consultation time" display, and the number BookingStatus.tsx multiplies by
-- "people ahead" for a real estimated wait once a doctor has any history.
-- ----------------------------------------------------------------------------
create or replace function public.get_doctor_avg_consultation_minutes(p_doctor_id uuid)
returns table (avg_minutes numeric, sample_size int)
language sql
security definer
stable
set search_path = public
as $$
  select round(avg(v.duration_minutes)), count(*)::int
  from visits v
  join appointments a on a.id = v.appointment_id
  where a.doctor_id = p_doctor_id
    and v.duration_minutes is not null
    and not v.needs_review;
$$;
