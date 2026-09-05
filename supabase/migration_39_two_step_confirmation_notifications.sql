-- ============================================================================
-- 39. TWO-STEP CONFIRMATION: PATIENT NOTIFICATIONS
-- ============================================================================
-- A booking is a REQUEST until the clinic accepts it. Until now the two
-- halves of that were only half-wired:
--   * BookingForm.tsx already inserted a payments row with status = 'hold'
--     for an online payment (or 'pending' for COD) the moment a booking was
--     created - but nothing ever told the patient that had happened, and
--     nothing ever moved that hold to 'captured'. handle_appointment_status_
--     change() used to do the capture on accept (see its very first version,
--     section 5), but section 30.4 removed that step on the theory that
--     appointments.payment_status already said 'paid_online' from booking
--     time, so "there was nothing left to flip." That left the payments
--     ledger - the thing payouts.ts and AdminPayments.tsx actually sum over -
--     permanently stuck on 'hold' for every online booking, captured or not.
--   * Rejecting a booking already auto-refunded a real hold via the same
--     trigger, but the message shown to the patient (RejectAppointmentForm.tsx)
--     never said so, and the refund step also fired for a COD payment that
--     was still sitting at 'pending' - i.e. never actually collected - which
--     would misrepresent an uncollected desk payment as one that was taken
--     back.
--
-- This migration:
--   1. Restores capture-on-accept, but ONLY on the payments ledger (status:
--      'hold' -> 'captured') - appointments.payment_status is left exactly
--      as section 30.4 set it, since same-day auto-checkin, fast-checkin and
--      the extended reschedule window (sections 32, 37) all key off it
--      staying 'paid_online' from the moment of booking and none of that
--      changes here.
--   2. Narrows the auto-refund-on-reject/cancel step to real money movements
--      only (hold/captured), leaving an untouched COD 'pending' row alone.
--   3. Adds a `channel` column to notifications (in_app / whatsapp / sms) -
--      the SAME table every existing notice already uses, just able to now
--      record which wire a message actually went out on.
--   4. Adds a partial unique index + a log_notification() RPC that upserts
--      against it, so the three one-shot lifecycle notices this flow sends
--      (booking_received, appointment_confirmed, appointment_rejected) can
--      never be duplicated - by a double-tap on Accept/Reject, a retried
--      request, or two clinic staff acting on the same booking at once -
--      while every other existing notification type (reminders, check-in,
--      queue alerts) is untouched and keeps inserting normally.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 39.1 Capture on accept, refund only real holds
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update payments set status = 'captured'
    where appointment_id = new.id and status = 'hold';
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    -- 'pending' (an uncollected COD payment) is deliberately excluded here -
    -- see this migration's header.
    update payments set status = 'refunded'
    where appointment_id = new.id and status in ('hold', 'captured');
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 39.2 notifications.channel - which wire a message went out on
-- ----------------------------------------------------------------------------
alter table notifications add column if not exists channel text not null default 'in_app';
alter table notifications drop constraint if exists notifications_channel_check;
alter table notifications add constraint notifications_channel_check
  check (channel in ('in_app', 'whatsapp', 'sms'));

-- ----------------------------------------------------------------------------
-- 39.3 De-duplication for the three one-shot lifecycle notices
-- ----------------------------------------------------------------------------
-- Only these three types are covered - a reminder or queue alert can (and
-- should) still fire more than once per appointment.
create unique index if not exists notifications_lifecycle_dedup_idx
  on notifications (appointment_id, type, channel)
  where appointment_id is not null
    and type in ('booking_received', 'appointment_confirmed', 'appointment_rejected');

-- security definer so a clinic can log a notice addressed to the patient
-- (same ownership chain notifications_insert already allows), and so the
-- caller - clinic or patient - never needs SELECT access to someone else's
-- notifications row just to learn whether its own insert was new or a
-- duplicate skipped by the index above.
create or replace function public.log_notification(
  p_user_id uuid,
  p_appointment_id uuid,
  p_type text,
  p_channel text,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if not (
    public.is_admin()
    or p_user_id = auth.uid()
    or (
      p_appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = p_appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  ) then
    raise exception 'Not allowed to notify this user.';
  end if;

  insert into notifications (user_id, appointment_id, type, channel, message)
  values (p_user_id, p_appointment_id, p_type, p_channel, p_message)
  on conflict (appointment_id, type, channel)
    where appointment_id is not null
      and type in ('booking_received', 'appointment_confirmed', 'appointment_rejected')
  do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
