-- ============================================================================
-- 26. QUEUE POSITIONS: token_no becomes a recomputed position, not a
--     stored-once identity assigned in booking order
-- ============================================================================
-- Previously handle_appointment_status_change() assigned token_no once, at
-- accept time, as max(token_no)+1 over that doctor/date - i.e. BOOKING
-- order. That's what let a 4 PM booking get a lower token than a 1 PM
-- booking made later the same day. token_no is now a cached, recomputed
-- queue POSITION: the real ordering inputs (slot_time, created_at,
-- checked_in_at, patient_type) are stored, and recompute_queue_positions()
-- derives 1..N fresh from them every time the active queue changes. See
-- TESTING.md "Test 6" for how to exercise this.

alter table appointments add column if not exists checked_in_at timestamptz;
-- 'walk_in' rows are, by construction, checked in the moment they're
-- created (see below) - no slot to hold, no grace period to wait out.
-- 'scheduled' is everything booked ahead of time (patient self-booking, or
-- a future appointment made through the walk-in desk flow).
alter table appointments add column if not exists patient_type text not null default 'scheduled'
  check (patient_type in ('scheduled', 'walk_in'));

-- Token assignment removed from the accept transition - a walk-in gets
-- checked_in_at stamped instead (their arrival IS their check-in), and
-- position gets computed by the trigger below, not here. Payment
-- hold/capture/refund logic is unchanged.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    if new.patient_type = 'walk_in' and new.checked_in_at is null then
      new.checked_in_at := now();
    end if;
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

-- Recomputes 1..N over every currently-active (accepted/in_progress)
-- appointment for one doctor+date, ordering by an "effective time":
--   - checked in (walk-in or a scheduled patient who's arrived): their
--     check-in time, floored at their slot time (can't queue-jump by
--     checking in early for a later slot).
--   - not checked in, still within the grace window past their slot:
--     their slot time - holds the position they booked.
--   - not checked in, past the grace window: 'infinity' - sorted behind
--     every genuinely-present patient. The moment they DO check in (even
--     very late), they fall back into the first case at their real
--     check-in time, which is the "move to the next available position
--     behind checked-in patients" rule.
-- Ties (identical effective time - e.g. two patients booked the same slot,
-- neither checked in yet) break on created_at (earlier booking wins), then
-- id as a last-resort deterministic tiebreak.
--
-- Wrapped in a transaction-scoped advisory lock keyed on (doctor_id, date)
-- so two concurrent callers recomputing the SAME doctor's SAME day can't
-- interleave and derive positions from two different snapshots - the
-- second waits for the first to commit, then recomputes from the
-- now-current state. Combined with the partial unique index below, this is
-- the DB-level guarantee that two simultaneous bookings for the same slot
-- can't produce duplicate or lost positions.
create or replace function public.recompute_queue_positions(p_doctor_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grace_minutes constant int := 15;
begin
  perform pg_advisory_xact_lock(hashtext(p_doctor_id::text || p_date::text));

  -- Two-phase reassignment, not one UPDATE. Reordering positions (e.g. a
  -- check-in swaps who holds #2 and #3) means two rows briefly need to swap
  -- values - and appointments_active_token_unique is checked per-row AS
  -- EACH ONE is written, not deferred to the end of the statement (a
  -- partial unique index can't be made DEFERRABLE the way a plain unique
  -- constraint can), so a single UPDATE that assigns row A the value row B
  -- currently holds - before B's own row gets processed - throws a
  -- duplicate-key error even though the FINAL state has no duplicates.
  -- Moving every active row to a disjoint negative value first guarantees
  -- no row's temporary value can ever equal another (still-positive) row's
  -- value, so this pass can't collide; the second pass then can't collide
  -- either, since row_number() gives every row a distinct target and
  -- nothing is left positive from before it runs.
  update appointments a
  set token_no = -ordered.new_position
  from (
    select
      id,
      row_number() over (
        order by
          case
            when checked_in_at is not null then greatest(checked_in_at, (date + slot_time)::timestamptz)
            when now() < (date + slot_time)::timestamptz + make_interval(mins => grace_minutes)
              then (date + slot_time)::timestamptz
            else 'infinity'::timestamptz
          end,
          created_at,
          id
      ) as new_position
    from appointments
    where doctor_id = p_doctor_id
      and date = p_date
      and status in ('accepted', 'in_progress')
  ) ordered
  where a.id = ordered.id;

  update appointments a
  set token_no = ordered.new_position
  from (
    select
      id,
      row_number() over (
        order by
          case
            when checked_in_at is not null then greatest(checked_in_at, (date + slot_time)::timestamptz)
            when now() < (date + slot_time)::timestamptz + make_interval(mins => grace_minutes)
              then (date + slot_time)::timestamptz
            else 'infinity'::timestamptz
          end,
          created_at,
          id
      ) as new_position
    from appointments
    where doctor_id = p_doctor_id
      and date = p_date
      and status in ('accepted', 'in_progress')
  ) ordered
  where a.id = ordered.id;
end;
$$;

-- Fires the recompute whenever a row enters, leaves, or changes position
-- within the active set for a doctor/date - or moves to a different
-- doctor/date while still active (a full-day reschedule), in which case
-- BOTH the old date's queue (which just lost a member) and the new date's
-- queue (which just gained one) need recomputing.
create or replace function public.trigger_recompute_queue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- recompute_queue_positions()'s own nested UPDATE fires this same
  -- trigger again (depth 2) for every row it touches. That pass would just
  -- re-derive the identical positions and find nothing left to change
  -- (recompute only writes rows whose position actually moved) - skip it
  -- outright instead of doing the redundant work.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if TG_OP = 'INSERT' then
    if new.status in ('accepted', 'in_progress') then
      perform public.recompute_queue_positions(new.doctor_id, new.date);
    end if;
    return new;
  end if;

  if old.status in ('accepted', 'in_progress')
     and (old.doctor_id is distinct from new.doctor_id or old.date is distinct from new.date)
  then
    perform public.recompute_queue_positions(old.doctor_id, old.date);
  end if;

  if new.status in ('accepted', 'in_progress') then
    perform public.recompute_queue_positions(new.doctor_id, new.date);
  elsif old.status in ('accepted', 'in_progress') then
    -- Left the active set entirely (done/no_show/rejected/cancelled) -
    -- recompute what's left so everyone shifts up. Its own token_no is
    -- left untouched, frozen at whatever position it last held, as a
    -- historical snapshot (RxPendingWorklist etc. still show it).
    perform public.recompute_queue_positions(new.doctor_id, new.date);
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_recompute_queue on appointments;
create trigger on_appointment_recompute_queue
  after insert or update on appointments
  for each row execute function public.trigger_recompute_queue();

-- DB-level backstop (not just app-level discipline): two active
-- appointments for the same doctor+date can never share a position. Partial
-- (scoped to accepted/in_progress only) so it doesn't collide with frozen
-- historical values left on done/no_show/rejected/cancelled rows.
drop index if exists appointments_active_token_unique;
create unique index appointments_active_token_unique
  on appointments (doctor_id, date, token_no)
  where status in ('accepted', 'in_progress');

-- get_queue_status() (section 5) fed the live "now serving" counter off
-- EVERY row with a non-null token_no - under the old model that was always
-- exactly the active set, since token_no was assigned once and never
-- touched again. Under the new model, done/no_show rows keep a frozen
-- historical token_no forever, which would otherwise show up mixed in with
-- freshly recomputed live positions and could numerically collide with
-- them (a done patient frozen at "3" alongside a live patient freshly
-- recomputed to "3"). Restricting to the active statuses is what the
-- unique index above assumes callers do.
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (token_no int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select a.token_no, a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('accepted', 'in_progress')
  order by a.token_no;
$$;
