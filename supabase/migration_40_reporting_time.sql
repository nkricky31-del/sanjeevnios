-- ============================================================================
-- 40. REPORTING TIME
-- ============================================================================
-- Every accepted appointment now carries a reporting time - when the patient
-- should aim to reach the clinic, distinct from the slot time itself. It is
-- guidance only: the token is still assigned at check-in, in arrival order
-- (check_in_appointment(), section 27), and served in fair order (section
-- 31). Arriving at the reporting time does not by itself create a token, and
-- nothing here changes when check-in is allowed to happen.
--
--   1. clinics.report_before_minutes - a per-clinic setting, default 30.
--   2. get_checkin_options() (section 32.4) now also returns reporting_time,
--      computed as slot_time - least(report_before_minutes, 60). The clamp
--      to 60 keeps the reporting time from ever falling before check-in
--      even opens (check_in_appointment() refuses check-in earlier than
--      slot_time - 60 minutes, hardcoded there - see this migration's
--      header). A clinic that sets report_before_minutes above 60 still
--      sees its own setting reflected honestly wherever it's edited; only
--      the derived reporting time is capped.
--   3. notifications' one-shot dedup (migration 39) is widened to cover a
--      fourth type, reporting_time_reminder - the single "reporting time is
--      approaching" nudge (src/pages/BookingStatus.tsx), so it can never be
--      sent more than once per appointment either.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 40.1 The clinic setting
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists report_before_minutes int not null default 30;
alter table clinics drop constraint if exists clinics_report_before_minutes_check;
alter table clinics add constraint clinics_report_before_minutes_check
  check (report_before_minutes > 0);

-- ----------------------------------------------------------------------------
-- 40.2 get_checkin_options() - hand back the derived, clamped reporting time
-- ----------------------------------------------------------------------------
-- A new OUT column changes the function's row type, which create-or-replace
-- refuses outright ("cannot change return type of existing function") - drop
-- it first. Safe here: nothing else in the database calls this function (it
-- has no triggers depending on it, and callers below are only ever the app,
-- which re-resolves the function by name on its next call).
drop function if exists public.get_checkin_options(uuid);
create function public.get_checkin_options(p_appointment_id uuid)
returns table (
  can_self_check_in boolean,
  requires_location boolean,
  paid_online boolean,
  reschedule_window_hours int,
  reporting_time time
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a appointments;
  c clinics;
  v_paid boolean;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select * into c from clinics where id = a.clinic_id;
  v_paid := (a.payment_status = 'paid_online');

  return query select
    (c.self_checkin_enabled or (c.fast_checkin_paid_online and v_paid)),
    c.self_checkin_require_location,
    v_paid,
    case when v_paid then c.reschedule_window_hours_paid_online else c.reschedule_window_hours end,
    a.slot_time - make_interval(mins => least(c.report_before_minutes, 60));
end;
$$;

-- ----------------------------------------------------------------------------
-- 40.3 Widen the lifecycle dedup to cover the reporting-time reminder too
-- ----------------------------------------------------------------------------
drop index if exists notifications_lifecycle_dedup_idx;
create unique index notifications_lifecycle_dedup_idx
  on notifications (appointment_id, type, channel)
  where appointment_id is not null
    and type in (
      'booking_received', 'appointment_confirmed', 'appointment_rejected', 'reporting_time_reminder'
    );

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
      and type in (
        'booking_received', 'appointment_confirmed', 'appointment_rejected', 'reporting_time_reminder'
      )
  do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
