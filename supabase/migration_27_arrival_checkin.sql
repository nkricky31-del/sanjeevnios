-- ============================================================================
-- 27. ARRIVAL CHECK-IN + LIVE TOKEN
-- ============================================================================
-- Replaces section 26's model. There, token_no was a queue POSITION derived
-- from slot time and recomputed on every change. Here the token is a real,
-- permanent number handed out at the door: nobody holds a token until they
-- physically arrive and are checked in, and the number is issued in strict
-- ARRIVAL ORDER, per clinic, per day. A patient who booked 10:00 and never
-- turns up simply never takes a number, so they can't hold up the people
-- standing in the waiting room.
--
-- See TESTING.md "Test 7" for how to exercise this.

-- ----------------------------------------------------------------------------
-- 27.0 Retire section 26's recompute machinery - FIRST, before anything else
-- ----------------------------------------------------------------------------
-- This has to happen before the column rename and before the status backfill
-- below, for two reasons:
--   * recompute_queue_positions()'s body is stored as TEXT and refers to
--     token_no. A column rename does NOT rewrite it, so the moment 27.2
--     renames token_no -> token_number that function is broken.
--   * its trigger fires on any UPDATE of an accepted/in_progress row - which
--     is exactly what 27.3's status backfill does. Leaving it attached means
--     the backfill runs the now-broken function and the whole migration dies
--     with 'column "token_no" ... does not exist'.
-- Positions are no longer derived at all under this model - the token is
-- assigned once, at the door, and never moves - so nothing here should keep
-- rewriting token numbers.

drop trigger if exists on_appointment_recompute_queue on appointments;
drop function if exists public.trigger_recompute_queue();
drop function if exists public.recompute_queue_positions(uuid, date);
drop index if exists appointments_active_token_unique;

-- The section 5 broadcast trigger's WHEN clause also names token_no, but a
-- trigger's WHEN expression is stored parsed (by attribute number), so it
-- follows the rename by itself. It gets rebuilt in 27.8 regardless.

-- ----------------------------------------------------------------------------
-- 27.1 Clinic-level settings the check-in window depends on
-- ----------------------------------------------------------------------------

-- How long after a slot has finished the desk may still check someone in.
alter table clinics add column if not exists checkin_grace_minutes int not null default 30;

-- Every date/time in this app is clinic-local wall-clock (todayISO() on the
-- client is the browser's local calendar date, and slot_time is a plain
-- time). Supabase runs Postgres in UTC, so comparing those against now()
-- directly is wrong by the UTC offset - which matters a great deal for a
-- window like "60 minutes before the slot". Storing the clinic's timezone
-- lets the check-in guard below compare local wall-clock to local
-- wall-clock instead.
alter table clinics add column if not exists timezone text not null default 'Asia/Kolkata';

-- ----------------------------------------------------------------------------
-- 27.2 Appointment columns
-- ----------------------------------------------------------------------------

-- token_no (section 26) becomes token_number - same column, renamed to the
-- name the arrival-token model uses. Guarded so the migration is re-runnable
-- and so a database built fresh from schema.sql (which already declares
-- token_number) isn't disturbed.
do $$
begin
  if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments' and column_name = 'token_no'
      )
     and not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments' and column_name = 'token_number'
      )
  then
    alter table appointments rename column token_no to token_number;
  end if;
end $$;

alter table appointments add column if not exists token_number int;
-- The day a token belongs to. Kept explicitly rather than inferred from
-- `date` so a token always carries the day it was actually issued, even if
-- an appointment's date is later corrected.
alter table appointments add column if not exists token_date date;
-- The raw per-clinic-per-day arrival counter. token_number is what gets
-- shown/called; arrival_seq is the ordinal it was issued from. They're
-- identical today - they're separate so a clinic can later renumber or
-- prefix displayed tokens without disturbing the record of who arrived in
-- what order.
alter table appointments add column if not exists arrival_seq int;
-- checked_in_at already exists from section 26; the rest are new.
alter table appointments add column if not exists checked_in_by uuid references profiles (id);
alter table appointments add column if not exists check_in_method text;

alter table appointments drop constraint if exists appointments_check_in_method_check;
alter table appointments add constraint appointments_check_in_method_check
  check (check_in_method is null or check_in_method in ('clinic_scan', 'patient_scan', 'manual'));

-- ----------------------------------------------------------------------------
-- 27.3 Status lifecycle
-- ----------------------------------------------------------------------------
-- booked -> accepted -> checked_in -> called -> in_consultation -> completed
-- plus cancelled / no_show, and rejected (the clinic declining a booking,
-- which the reject flow in the app has always had).
--
-- Renames of the three existing states are applied to live rows first, with
-- the constraint dropped, then the new constraint goes on.

alter table appointments drop constraint if exists appointments_status_check;

update appointments set status = 'booked' where status = 'pending';
update appointments set status = 'in_consultation' where status = 'in_progress';
update appointments set status = 'completed' where status = 'done';

alter table appointments alter column status set default 'booked';
alter table appointments add constraint appointments_status_check
  check (status in (
    'booked', 'accepted', 'checked_in', 'called',
    'in_consultation', 'completed', 'cancelled', 'rejected', 'no_show'
  ));

-- Every token in the table right now predates this model. Section 26 issued
-- them as per-DOCTOR queue positions, so the same number legitimately repeats
-- across two doctors at one clinic on one day - which the per-CLINIC unique
-- index in 27.4 then (correctly) rejects. They were never arrival tokens, so
-- rather than renumber them into a history that didn't happen, clear them.
-- Completed visits keep their encounter, visit notes and prescriptions; they
-- just stop claiming a token number that was never issued at a door.
--
-- checked_in_at goes with them, deliberately. This model's invariant is
-- "checked_in_at is set exactly when a token has been issued" - leaving a
-- stale timestamp behind with no number would make check_in_appointment()
-- take its already-checked-in branch forever and hand back a null token.
-- Anyone mid-flow simply gets checked in again at the desk, which is what
-- actually draws them a real number.
update appointments
set token_number = null,
    arrival_seq = null,
    token_date = null,
    checked_in_at = null,
    checked_in_by = null,
    check_in_method = null;

-- Nothing can be mid-arrival either: section 26 had no checked_in/called
-- states, so any row that survived the rename as one of those came from a
-- re-run, and the cleared timestamps above mean it holds no token. Send it
-- back to 'accepted' so the desk re-checks it in properly.
update appointments set status = 'accepted' where status in ('checked_in', 'called');

-- ----------------------------------------------------------------------------
-- 27.4 One token per clinic per day
-- ----------------------------------------------------------------------------
-- (The section 26 machinery this replaces was already dropped up in 27.0.)
--
-- One token per clinic per day, full stop. This is the DB-level guarantee
-- that two receptionists checking people in at the same instant can't hand
-- out the same number - the counter below serialises them, and this catches
-- anything that ever slipped past it.
drop index if exists appointments_clinic_token_unique;
create unique index appointments_clinic_token_unique
  on appointments (clinic_id, token_date, token_number)
  where token_number is not null;

-- ----------------------------------------------------------------------------
-- 27.5 The per-clinic-per-day token counter
-- ----------------------------------------------------------------------------
-- A single row per (clinic, day) holding the last number issued. The
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING in check_in_appointment()
-- takes a row lock, so concurrent check-ins queue behind each other and each
-- one comes away with its own number - no max()+1 read-then-write race.
create table if not exists clinic_token_counters (
  clinic_id uuid not null references clinics (id) on delete cascade,
  token_date date not null,
  last_seq int not null default 0,
  primary key (clinic_id, token_date)
);

-- No policies: this table is reached ONLY through the security-definer
-- function below, never directly by a client.
alter table clinic_token_counters enable row level security;

-- ----------------------------------------------------------------------------
-- 27.6 Slot length helper
-- ----------------------------------------------------------------------------
-- The same "window divided by daily capacity" arithmetic computeSlots() uses
-- on the client, so the server's idea of when a slot ends matches the one the
-- patient was shown when booking. Falls back to 15 minutes when the doctor
-- has no availability configured for that weekday.
create or replace function public.slot_minutes_for(p_doctor_id uuid, p_date date)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select greatest(
        1,
        floor(
          (extract(epoch from (da.end_time - da.start_time)) / 60)
          / nullif(da.max_patients_per_day, 0)
        )::int
      )
      from doctor_availability da
      where da.doctor_id = p_doctor_id
        and da.weekday = extract(dow from p_date)::int
      order by da.start_time
      limit 1
    ),
    15
  );
$$;

-- ----------------------------------------------------------------------------
-- 27.7 check_in_appointment(): the only way a token is ever issued
-- ----------------------------------------------------------------------------
-- Guardrails, in order:
--   * caller must be the owning clinic, an admin, or the patient themselves
--     (the patient_scan case),
--   * a second check-in is not an error - it just returns the token already
--     held, so a double scan at the desk is harmless,
--   * status must be 'accepted' (a booking the clinic hasn't confirmed, or
--     one already cancelled/rejected, can't take a number),
--   * the appointment must be for today in the CLINIC's timezone,
--   * now must be inside [slot - 60 min, slot end + clinic grace].
-- Only then does it draw the next number.
create or replace function public.check_in_appointment(
  p_appointment_id uuid,
  p_method text default 'manual'
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean)
language plpgsql
security definer
set search_path = public
as $$
-- The RETURNS TABLE names above are also plpgsql variables, and three of
-- them are real column names on `appointments`. Every reference below is
-- either qualified (a.token_number) or an unambiguous SET/INSERT target, and
-- every local is p_/v_ prefixed - this directive makes the intent explicit
-- so a bare identifier can never silently resolve to the OUT variable.
#variable_conflict use_column
declare
  a appointments;
  v_tz text;
  v_grace int;
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
begin
  if p_method is null or p_method not in ('clinic_scan', 'patient_scan', 'manual') then
    raise exception 'Unknown check-in method: %', p_method;
  end if;

  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  if not (
    public.is_admin()
    or public.is_own_clinic(a.clinic_id)
    or public.is_own_mrn(a.member_id)
  ) then
    raise exception 'You are not allowed to check in this appointment.';
  end if;

  -- Idempotent by design: "a second scan just shows the existing token".
  -- Requires a token to actually be there, not merely a timestamp - a row
  -- with checked_in_at set but no number (only reachable from legacy data)
  -- must fall through and draw a real one rather than return null forever.
  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true;
    return;
  end if;

  if a.status <> 'accepted' then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata'), coalesce(c.checkin_grace_minutes, 30)
    into v_tz, v_grace
  from clinics c where c.id = a.clinic_id;

  v_now_local := now() at time zone v_tz;

  if a.date <> v_now_local::date then
    raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
  end if;

  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  if v_now_local < v_slot_start - interval '60 minutes' then
    raise exception 'Too early - check-in opens 60 minutes before the % slot.',
      to_char(v_slot_start, 'HH12:MI AM');
  end if;

  if v_now_local > v_slot_end + make_interval(mins => v_grace) then
    raise exception 'Too late - check-in for the % slot closed % minutes after it ended.',
      to_char(v_slot_start, 'HH12:MI AM'), v_grace;
  end if;

  -- Draw the next arrival number for this clinic, this day. The row lock
  -- taken by ON CONFLICT DO UPDATE is what makes concurrent check-ins safe.
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
      token_date = a.date
  where id = a.id;

  return query select v_seq, v_seq, a.date, false;
end;
$$;

-- ----------------------------------------------------------------------------
-- 27.8 Status-driven side effects, updated for the new names
-- ----------------------------------------------------------------------------
-- Token assignment is gone from here entirely (it lives in
-- check_in_appointment above). What's left is the payment hold/capture/refund
-- behaviour, unchanged except for the renamed statuses.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    if new.payment_status = 'hold' then
      new.payment_status := 'captured';
    end if;
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
  elsif new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'hold' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status = 'hold';
  end if;
  return new;
end;
$$;

-- The live-queue broadcast fired on token_no; that column is token_number now.
drop trigger if exists on_appointment_queue_broadcast on appointments;
create trigger on_appointment_queue_broadcast
  after update on appointments
  for each row
  when (old.status is distinct from new.status or old.token_number is distinct from new.token_number)
  execute function public.broadcast_appointment_queue_change();

-- ----------------------------------------------------------------------------
-- 27.9 Queries the app reads the live queue through
-- ----------------------------------------------------------------------------
-- The waiting room for one doctor on one day: everyone who has actually
-- arrived and not yet finished. Tokens are issued per CLINIC, so these
-- numbers won't be contiguous when a clinic runs two doctors at once - they
-- stay correctly ordered, which is all the "who's next" logic needs.
--
-- Dropped rather than replaced: this function's OUT column was token_no and
-- is now token_number, and CREATE OR REPLACE cannot rename OUT parameters
-- ("cannot change return type of existing function"). Nothing in the
-- database depends on it - it's called over RPC from the client - so
-- dropping it is safe.
drop function if exists public.get_queue_status(uuid, date);
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (token_number int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select a.token_number, a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
    and a.token_number is not null
  order by a.token_number;
$$;

-- Slots are taken by any booking that hasn't been called off - the renamed
-- statuses don't change which those are, but this is re-declared so a fresh
-- run of the file leaves no reference to the old vocabulary.
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
    and a.status not in ('rejected', 'cancelled');
$$;

-- ----------------------------------------------------------------------------
-- 27.10 RLS, updated for the renamed statuses
-- ----------------------------------------------------------------------------
-- Unchanged in substance: a patient may only cancel their own booking, and
-- only while it's still 'booked'/'accepted' and more than two hours out.
-- Once they're checked in, the desk owns the record.
drop policy if exists "appointments_update" on appointments;
create policy "appointments_update" on appointments for update
  using (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (public.is_own_member(member_id) and status in ('booked', 'accepted'))
  )
  with check (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (
      public.is_own_member(member_id)
      and status = 'cancelled'
      and (date + slot_time)::timestamp > now() + interval '2 hours'
    )
  );
