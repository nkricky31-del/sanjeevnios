-- ============================================================================
-- 52. MARK PAID AT CLINIC - CLEARS THE DUE AMOUNT LIVE
-- ============================================================================
-- Ties the clinic desk's "Mark paid" button (ClinicCheckIn.tsx, Part 44) to
-- the patient's own booking screen (BookingStatus.tsx), over the exact same
-- realtime channel the live token already uses ("queue:<doctor_id>:<date>",
-- section 5/26).
--
-- Three things change together:
--
--   1. mark_paid_at_clinic() now records WHO collected the money and WHEN,
--      not just the fact that it happened - appointments gains paid_amount,
--      paid_at and marked_paid_by. It is made explicitly idempotent: calling
--      it again on an already-paid_at_clinic appointment is a no-op that
--      returns without touching the existing record, so a double-tap (or two
--      desk staff pressing it at once) never double-counts or overwrites who
--      actually took the cash.
--
--   2. Section 30.5's "presence cannot be forged" guard (guard_presence_columns)
--      is extended to cover the same ground for money: a plain client update
--      can no longer set payment_status to 'paid_at_clinic', or write
--      paid_amount/paid_at/marked_paid_by, directly. Only mark_paid_at_clinic()
--      (which announces itself with app.payment_write, the same pattern
--      app.checkin_write already uses) may set them. This matters here
--      specifically because appointments_update's USING clause allows the
--      PATIENT themselves to update their own booking row
--      (is_own_member(member_id)) - without this guard, a patient could
--      simply PATCH their own pay_at_clinic booking to paid_at_clinic and
--      make their own due amount vanish without paying anyone.
--      AdminPayments.tsx's existing direct `update ... set payment_status =
--      'refunded'` is untouched: the guard only blocks the transition INTO
--      'paid_at_clinic' and writes to the three new columns, not refunds.
--
--   3. The live-queue broadcast trigger (section 27.8) only fired on a
--      status or token_number change, so marking someone paid never woke up
--      anyone watching BookingStatus.tsx's realtime channel - the patient's
--      "Amount due" line would only have updated on their next manual
--      refresh. Its WHEN clause now also fires on a payment_status change.
--      The broadcast payload itself carries the raw row either way (as it
--      already did for status/token_number) - every subscriber's handler
--      only uses it as a ping to refetch through the normal RLS-protected
--      read path, never reads fields off the payload, so this adds no new
--      exposure.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 52.1 appointments - who/when/how much was collected at the desk
-- ----------------------------------------------------------------------------
alter table appointments add column if not exists paid_amount numeric;
alter table appointments add column if not exists paid_at timestamptz;
alter table appointments add column if not exists marked_paid_by uuid references profiles (id);

-- ----------------------------------------------------------------------------
-- 52.2 mark_paid_at_clinic() - now idempotent, and stamps who/when/how much.
-- ----------------------------------------------------------------------------
create or replace function public.mark_paid_at_clinic(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  v_amount numeric;
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
  if a.payment_status = 'free_followup' then
    raise exception 'This is a free follow-up - there is nothing to collect.';
  end if;

  -- Idempotent: tapping "Mark paid" again on an already-settled appointment
  -- (double tap, stale tab, two desks at once) just leaves the existing
  -- paid record - amount, time, who - exactly as it was.
  if a.payment_status = 'paid_at_clinic' then
    return;
  end if;

  select coalesce(net_amount, amount) into v_amount
  from payments
  where appointment_id = a.id
  order by created_at desc
  limit 1;

  perform set_config('app.payment_write', '1', true);
  update appointments
  set payment_status = 'paid_at_clinic',
      paid_amount = coalesce(v_amount, 0),
      paid_at = now(),
      marked_paid_by = auth.uid()
  where id = a.id;
  perform set_config('app.payment_write', '0', true);

  update payments set status = 'captured' where appointment_id = a.id and status = 'pending';
end;
$$;

-- ----------------------------------------------------------------------------
-- 52.3 Money cannot be forged either - same pattern as section 30.5's
-- presence guard, extended to the paid-at-clinic record.
-- ----------------------------------------------------------------------------
create or replace function public.guard_presence_columns()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.checkin_write', true), '') = '1'
     or coalesce(current_setting('app.payment_write', true), '') = '1' then
    return new;  -- we're inside check_in_appointment()/skip_to_back()/mark_paid_at_clinic()
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

  if new.payment_status = 'paid_at_clinic' and new.payment_status is distinct from old.payment_status then
    raise exception 'paid_at_clinic is recorded by mark_paid_at_clinic(), not by writing payment_status directly.';
  end if;
  if new.paid_amount is distinct from old.paid_amount then
    raise exception 'paid_amount is recorded by mark_paid_at_clinic(), not by writing to it directly.';
  end if;
  if new.paid_at is distinct from old.paid_at then
    raise exception 'paid_at is recorded by mark_paid_at_clinic(), not by writing to it directly.';
  end if;
  if new.marked_paid_by is distinct from old.marked_paid_by then
    raise exception 'marked_paid_by is recorded by mark_paid_at_clinic(), not by writing to it directly.';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 52.4 The live-queue broadcast also fires on a payment_status change now,
-- so BookingStatus.tsx's realtime channel wakes up the instant the desk
-- taps "Mark paid" - same channel the live token already rides.
-- ----------------------------------------------------------------------------
drop trigger if exists on_appointment_queue_broadcast on appointments;
create trigger on_appointment_queue_broadcast
  after update on appointments
  for each row
  when (
    old.status is distinct from new.status
    or old.token_number is distinct from new.token_number
    or old.payment_status is distinct from new.payment_status
  )
  execute function public.broadcast_appointment_queue_change();
