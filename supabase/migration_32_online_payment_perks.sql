-- ============================================================================
-- 32. REWARDING ONLINE PAYMENT - WITH CONVENIENCE, NEVER PRIORITY
-- ============================================================================
-- Paying online may buy a patient a faster, calmer arrival. It may never buy
-- them an earlier turn.
--
-- Everything in this file is about the DOOR, not the QUEUE:
--   * skip the counter - check in by self-scan instead of queueing to pay,
--   * a guaranteed confirmed slot - the booking is accepted without waiting
--     on the clinic's inbox,
--   * a gentler rescheduling window.
--
-- Note what is absent, deliberately and permanently: nothing here touches
-- effective_order_time, checked_in_at, token_number or arrival_seq. The order
-- rule in section 31 reads none of these settings and never reads
-- payment_status at all, so no combination of them can move a paid patient
-- ahead of an earlier-slot one. Section 30.5's guard trigger keeps the
-- presence columns unwritable from outside the check-in path regardless.
--
-- All three perks are opt-in per clinic - they change how a clinic runs its
-- front desk, which is the clinic's call, not the platform's.
--
-- See TESTING.md "Test 13".

-- ----------------------------------------------------------------------------
-- 32.1 Clinic settings
-- ----------------------------------------------------------------------------

-- Skip the counter: a patient who has already paid online may self-scan
-- reception's rotating code even at a clinic that hasn't opened self check-in
-- to everyone. Presence is still proven exactly as in section 28 - the code
-- rotates every few minutes and is verified server-side, plus the optional
-- geofence. This shortens the QUEUE AT THE COUNTER, not the queue for the
-- doctor.
alter table clinics add column if not exists fast_checkin_paid_online boolean not null default false;

-- Guaranteed confirmed slot: a booking paid online is accepted on the spot
-- rather than waiting in the clinic's approval inbox.
alter table clinics add column if not exists auto_confirm_paid_online boolean not null default false;

-- Easier rescheduling: how close to the appointment a patient may still
-- cancel or move it. The paid-online window is allowed to be shorter (i.e.
-- more forgiving) - it is never used to grant queue position.
alter table clinics add column if not exists reschedule_window_hours int not null default 2;
alter table clinics add column if not exists reschedule_window_hours_paid_online int not null default 1;

-- ----------------------------------------------------------------------------
-- 32.2 Guaranteed confirmed slot
-- ----------------------------------------------------------------------------
-- Fires on insert, before the booking ever reaches the clinic's inbox. Only
-- for a clinic that has switched it on, and only for money actually taken
-- online. It sets status - never a presence column - so the patient still
-- holds no token and must still physically arrive.
create or replace function public.auto_confirm_paid_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto boolean;
begin
  if new.payment_status = 'paid_online' and new.status = 'booked' then
    select auto_confirm_paid_online into v_auto from clinics where id = new.clinic_id;
    if coalesce(v_auto, false) then
      new.status := 'accepted';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_appointment_auto_confirm on appointments;
create trigger on_appointment_auto_confirm
  before insert on appointments
  for each row execute function public.auto_confirm_paid_booking();

-- ----------------------------------------------------------------------------
-- 32.3 Skip-the-counter self check-in
-- ----------------------------------------------------------------------------
-- Same function as section 28/29, with one clause widened: the clinic gate
-- now passes if self check-in is open to everyone OR this particular patient
-- paid online and the clinic offers the fast lane. Every anti-fraud check is
-- untouched - correctly signed CURRENT reception code, an accepted
-- appointment at this clinic today, optional geofence - and it still ends in
-- the ordinary check_in_appointment(), which draws an ordinary token.
drop function if exists public.self_check_in(text, double precision, double precision);
create or replace function public.self_check_in(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  v_clinic_id uuid;
  v_window bigint;
  v_now_window bigint;
  c clinics;
  v_appt_id uuid;
  v_paid boolean;
  v_distance double precision;
begin
  parts := string_to_array(coalesce(p_code, ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'clinic' or parts[3] <> 'v1'
  then
    raise exception 'That is not a clinic check-in code.';
  end if;

  begin
    v_clinic_id := parts[4]::uuid;
    v_window := parts[5]::bigint;
  exception when others then
    raise exception 'That is not a clinic check-in code.';
  end;

  if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> parts[6] then
    raise exception 'That check-in code is not valid.';
  end if;

  v_now_window := public.clinic_checkin_window();
  if v_window <> v_now_window and v_window <> v_now_window - 1 then
    raise exception 'That check-in code has expired - please scan the code on the screen at reception.';
  end if;

  select * into c from clinics where id = v_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  -- The caller's own accepted appointment at this clinic, today.
  select a.id, (a.payment_status = 'paid_online')
    into v_appt_id, v_paid
  from appointments a
  where a.clinic_id = v_clinic_id
    and a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
    and a.status = 'accepted'
    and public.is_own_mrn(a.member_id)
  order by a.slot_time
  limit 1;

  if v_appt_id is null then
    raise exception 'No confirmed appointment found for you at this clinic today.';
  end if;

  -- The widened gate. Either the clinic lets everyone self check in, or this
  -- patient has already paid online and the clinic offers the fast lane.
  if not (c.self_checkin_enabled or (c.fast_checkin_paid_online and coalesce(v_paid, false))) then
    raise exception 'This clinic does not offer self check-in - please see the reception desk.';
  end if;

  if c.self_checkin_require_location then
    if p_lat is null or p_lng is null then
      raise exception 'Location is required to check yourself in here. Allow location access and try again.';
    end if;
    if c.lat is null or c.lng is null then
      raise exception 'This clinic has not set its location yet - please see the reception desk.';
    end if;
    v_distance := public.distance_metres(p_lat, p_lng, c.lat, c.lng);
    if v_distance > c.self_checkin_radius_m then
      raise exception 'You appear to be about %m from the clinic. Self check-in only works at the clinic.',
        round(v_distance)::int;
    end if;
  end if;

  return query select * from public.check_in_appointment(v_appt_id, 'patient_scan', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 32.4 What the patient's app needs to know
-- ----------------------------------------------------------------------------
-- The pass screen has to explain the right thing to the right patient - "tap
-- to check in" versus "check in at the counter when you pay" - which means
-- knowing the clinic's settings for THIS booking. A patient can already read
-- the clinic row, but not the columns that matter here, so this hands back
-- exactly the four facts the screen needs and nothing else.
create or replace function public.get_checkin_options(p_appointment_id uuid)
returns table (
  can_self_check_in boolean,
  requires_location boolean,
  paid_online boolean,
  reschedule_window_hours int
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
    case when v_paid then c.reschedule_window_hours_paid_online else c.reschedule_window_hours end;
end;
$$;
