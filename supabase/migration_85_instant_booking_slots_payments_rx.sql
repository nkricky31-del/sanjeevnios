-- ============================================================================
-- 85. INSTANT BOOKING, SLOTS FROM PATIENTS-PER-HOUR, ONLINE PAYMENT SWITCH,
--     OPTIONAL PATIENT QR, BILINGUAL PRESCRIPTION ADVICE
-- ============================================================================
--   1. Slots. A doctor's availability can now be set as "patients per hour"
--      plus a slot length. 10 patients an hour = 6 minutes each, so a
--      15-minute slot holds floor(10 * 15 / 60) = 2 patients; once 2 are
--      booked the slot is full (enforce_slot_capacity, section 36, already
--      refuses the third). Windows saved the old way keep working unchanged.
--   2. No more Accept / Reject. Every booking is confirmed the moment it is
--      made (subject to the same slot, daily-cap and patient rules as before).
--      Bookings still waiting for a decision are confirmed by this migration,
--      except any whose online payment is still on hold - those need the
--      Razorpay capture call, which only the app can make, so they stay in the
--      clinic's short "older requests" list until confirmed or cancelled.
--   3. Online payments are captured when the patient pays (razorpay-verify-
--      payment calls record_online_payment_captured below), not when a clinic
--      accepts. A checkout the patient walks away from is cancelled after 20
--      minutes so the slot is released (nothing was charged).
--   4. clinics.online_payments_enabled - off: patients only see "pay at the
--      clinic". Enforced in create_payment_with_coupon(), not just hidden.
--   5. clinics.patient_qr_enabled - off: no QR on the patient's booking; the
--      patient scans the clinic's QR (self check-in) or is found at the desk
--      by name, phone or booking ID. Enforced in issue_booking_qr().
--   6. prescriptions.advice_en / advice_hi - the doctor's general advice in
--      English and Hindi. Medicine timing and food instructions live in each
--      item of prescriptions.items (jsonb, written by the app).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 85.1 Slots from patients per hour
-- ----------------------------------------------------------------------------
alter table doctor_availability add column if not exists patients_per_hour int;
alter table doctor_availability add column if not exists slot_minutes int;

alter table doctor_availability drop constraint if exists doctor_availability_patients_per_hour_check;
alter table doctor_availability add constraint doctor_availability_patients_per_hour_check
  check (patients_per_hour is null or patients_per_hour between 1 and 120);
alter table doctor_availability drop constraint if exists doctor_availability_slot_minutes_check;
alter table doctor_availability add constraint doctor_availability_slot_minutes_check
  check (slot_minutes is null or slot_minutes between 5 and 120);
alter table doctor_availability drop constraint if exists doctor_availability_rate_pair_check;
alter table doctor_availability add constraint doctor_availability_rate_pair_check
  check ((patients_per_hour is null) = (slot_minutes is null));

-- For a window set by rate, derive the two columns everything else already
-- reads: slot_capacity (patients per slot) and max_patients_per_day, which
-- has always really meant "number of slots in the window" (computeSlots()
-- and slot_minutes_for() divide the window by it).
create or replace function public.derive_availability_capacity()
returns trigger
language plpgsql
as $$
declare
  v_window int;
begin
  if new.patients_per_hour is null or new.slot_minutes is null then
    return new;
  end if;

  v_window := floor(extract(epoch from (new.end_time - new.start_time)) / 60)::int;
  if v_window < new.slot_minutes then
    raise exception 'The working hours (% min) are shorter than one % minute slot.', v_window, new.slot_minutes;
  end if;
  if new.patients_per_hour * new.slot_minutes < 60 then
    raise exception 'At % patients an hour each patient needs % minutes - choose a slot of at least % minutes.',
      new.patients_per_hour, ceil(60.0 / new.patients_per_hour)::int, ceil(60.0 / new.patients_per_hour)::int;
  end if;

  new.slot_capacity := greatest(1, floor(new.patients_per_hour * new.slot_minutes / 60.0)::int);
  new.max_patients_per_day := floor(v_window::numeric / new.slot_minutes)::int;
  return new;
end;
$$;

drop trigger if exists on_availability_derive_capacity on doctor_availability;
create trigger on_availability_derive_capacity
  before insert or update on doctor_availability
  for each row execute function public.derive_availability_capacity();

-- A slot's length: the window's own slot_minutes when it was set by rate,
-- otherwise the old "window divided by its slot count".
create or replace function public.slot_minutes_for(p_doctor_id uuid, p_date date)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select coalesce(
        da.slot_minutes,
        greatest(
          1,
          floor(
            (extract(epoch from (da.end_time - da.start_time)) / 60)
            / nullif(da.max_patients_per_day, 0)
          )::int
        )
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

-- How many seats each slot of a day has and how many are taken, so the slot
-- grid can say "1 left". Counts only - nothing about who booked.
create or replace function public.get_slot_occupancy(p_doctor_id uuid, p_date date)
returns table (slot_time time, booked int, capacity int)
language sql
stable
security definer
set search_path = public
as $$
  select a.slot_time,
         count(*)::int,
         public.slot_capacity_for(p_doctor_id, p_date, a.slot_time)
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status not in ('rejected', 'cancelled')
  group by a.slot_time;
$$;

-- ----------------------------------------------------------------------------
-- 85.2 Clinic switches
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists online_payments_enabled boolean not null default false;
alter table clinics add column if not exists patient_qr_enabled boolean not null default false;

-- ----------------------------------------------------------------------------
-- 85.3 Every booking is confirmed on the spot
-- ----------------------------------------------------------------------------
-- Same trigger (on_appointment_auto_confirm, section 32.2) - it used to do this
-- only for paid-online bookings at clinics that opted in; now it does it for
-- every booking. The booking rules, slot capacity and daily cap triggers all
-- run in the same insert, so a booking that breaks one is still refused.
create or replace function public.auto_confirm_paid_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'booked' then
    new.status := 'accepted';
  end if;
  return new;
end;
$$;

drop trigger if exists on_appointment_auto_confirm on appointments;
create trigger on_appointment_auto_confirm
  before insert on appointments
  for each row execute function public.auto_confirm_paid_booking();

-- Bookings already waiting for a decision: confirm them now (today or later),
-- one at a time so a single row that no longer passes the booking rules can't
-- stop the rest. Online payments still on hold are left for the clinic (see
-- this migration's header).
do $$
declare
  r record;
begin
  for r in
    select a.id, fm.account_id, a.date, a.slot_time
    from appointments a
    join clinics c on c.id = a.clinic_id
    join family_members fm on fm.id = a.member_id
    where a.status = 'booked'
      and a.date >= (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
      and not exists (
        select 1 from payments p
        where p.appointment_id = a.id and p.method = 'online' and p.status = 'hold'
      )
  loop
    begin
      update appointments set status = 'accepted' where id = r.id and status = 'booked';
      insert into notifications (user_id, appointment_id, type, channel, message)
      values (
        r.account_id, r.id, 'appointment_confirmed', 'in_app',
        'Your appointment on ' || to_char(r.date, 'DD Mon YYYY') || ' at ' || to_char(r.slot_time, 'HH12:MI AM')
          || ' is confirmed. Please arrive on time and check in at the clinic.'
      )
      on conflict do nothing;
    exception when others then
      raise notice 'Could not confirm appointment %: %', r.id, sqlerrm;
    end;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 85.4 Payment creation: online switch + coupons on confirmed bookings
-- ----------------------------------------------------------------------------
-- Restated from section 46 with two changes:
--   * an online payment is refused when the clinic has online payments off;
--   * a coupon is confirmed straight away for a booking that is already
--     confirmed and won't go through an online capture (cash / free). It used
--     to be confirmed on Accept, which no longer happens. Online coupons are
--     confirmed by record_online_payment_captured() below.
create or replace function public.create_payment_with_coupon(
  p_appointment_id uuid,
  p_method text,
  p_redemption_id uuid default null
)
returns table (payment_id uuid, gross_amount numeric, discount_amount numeric, net_amount numeric, is_free boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  v_fee numeric;
  v_convenience numeric;
  v_gross numeric;
  v_discount numeric := 0;
  v_net numeric;
  v_redemption coupon_redemptions;
  v_coupon coupons;
  v_funded_by text;
  v_coupon_code text;
  v_payment_id uuid;
  v_is_free boolean := false;
  v_orig_doctor uuid;
  v_due_date date;
  v_payment_status text;
  v_online_ok boolean;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;
  if exists (select 1 from payments where appointment_id = p_appointment_id) then
    raise exception 'A payment already exists for this appointment.';
  end if;
  if p_method not in ('online', 'cod') then
    raise exception 'Invalid payment method.';
  end if;

  if a.follow_up_of is not null then
    select ap.doctor_id, v.follow_up_due_date into v_orig_doctor, v_due_date
    from visits v join appointments ap on ap.id = v.appointment_id
    where v.id = a.follow_up_of;

    if v_orig_doctor is not null and v_orig_doctor = a.doctor_id
       and v_due_date is not null and a.date <= v_due_date then
      v_is_free := true;
    end if;
  end if;

  if p_method = 'online' and not v_is_free then
    select online_payments_enabled into v_online_ok from clinics where id = a.clinic_id;
    if not coalesce(v_online_ok, false) then
      raise exception 'This clinic takes payment at the clinic only - choose "Pay at clinic".';
    end if;
  end if;

  select consultation_fee into v_fee from doctors where id = a.doctor_id;

  if v_is_free then
    v_gross := v_fee;
    v_convenience := 0;
    v_discount := v_fee;
    v_net := 0;
    v_payment_status := 'waived';
  else
    v_convenience := case when p_method = 'online' then 10 else 0 end;
    v_gross := v_fee + v_convenience;
    v_payment_status := case when p_method = 'online' then 'hold' else 'pending' end;

    if p_redemption_id is not null then
      select * into v_redemption from coupon_redemptions where id = p_redemption_id;
      if v_redemption.id is null or v_redemption.patient_id <> auth.uid() or v_redemption.status <> 'reserved' then
        raise exception 'This coupon is no longer applied - please re-apply it.';
      end if;
      if v_redemption.reserved_at < now() - interval '15 minutes' then
        raise exception 'Your coupon reservation expired - please re-apply it.';
      end if;

      select * into v_coupon from coupons where id = v_redemption.coupon_id;
      if not v_coupon.active or (v_coupon.valid_to is not null and v_coupon.valid_to < now()) then
        raise exception 'This coupon is no longer valid.';
      end if;
      if v_gross < v_coupon.min_amount then
        raise exception 'This coupon needs a minimum order of Rs.%.', v_coupon.min_amount;
      end if;

      v_discount := case v_coupon.type
        when 'flat' then v_coupon.value
        else round(v_gross * v_coupon.value / 100.0)
      end;
      if v_coupon.type = 'percent' and v_coupon.max_discount is not null then
        v_discount := least(v_discount, v_coupon.max_discount);
      end if;
      v_discount := least(v_discount, v_gross - 1);
      v_coupon_code := v_coupon.code;
      v_funded_by := v_coupon.funded_by;

      update coupon_redemptions
      set appointment_id = p_appointment_id, discount_amount = v_discount
      where id = p_redemption_id;
    end if;

    v_net := v_gross - v_discount;
  end if;

  insert into payments (appointment_id, amount, method, status, gross_amount, coupon_code, discount_amount, net_amount, funded_by)
  values (
    p_appointment_id,
    v_net,
    p_method,
    v_payment_status,
    v_gross,
    v_coupon_code,
    v_discount,
    v_net,
    v_funded_by
  )
  returning id into v_payment_id;

  if v_is_free then
    update appointments set payment_status = 'free_followup' where id = p_appointment_id;
  end if;

  if p_redemption_id is not null and p_method = 'cod' and a.status not in ('booked', 'rejected', 'cancelled') then
    update coupon_redemptions set status = 'confirmed' where id = p_redemption_id and status = 'reserved';
  end if;

  return query select v_payment_id, v_gross, v_discount, v_net, v_is_free;
end;
$$;

-- ----------------------------------------------------------------------------
-- 85.5 Online payment captured (called by razorpay-verify-payment only)
-- ----------------------------------------------------------------------------
-- The bookkeeping Accept used to trigger, done when the money is actually
-- captured: payment -> captured, coupon confirmed, settlement row opened.
create or replace function public.record_online_payment_captured(p_appointment_id uuid, p_razorpay_payment_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  update payments
  set status = 'captured', razorpay_payment_id = coalesce(p_razorpay_payment_id, razorpay_payment_id)
  where appointment_id = p_appointment_id and method = 'online' and status = 'hold';

  update coupon_redemptions set status = 'confirmed'
  where appointment_id = p_appointment_id and status = 'reserved';

  insert into settlements (clinic_id, appointment_id, payment_id, net_amount, commission_rate, platform_fee, status)
  select a.clinic_id, a.id, p.id, coalesce(p.net_amount, p.amount, 0), 0, 0, 'collected'
  from payments p
  where p.appointment_id = a.id and p.method = 'online' and p.status = 'captured'
  on conflict (appointment_id) do nothing;
end;
$$;

revoke all on function public.record_online_payment_captured(uuid, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 85.6 Abandoned online checkouts
-- ----------------------------------------------------------------------------
-- The booking is confirmed (and holds its slot) before the patient pays. If
-- the payment is never completed, release the slot after 20 minutes. Nothing
-- was charged - an unverified Razorpay authorisation lapses on its own.
create or replace function public.cancel_abandoned_online_bookings()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  with due as (
    select a.id
    from appointments a
    join payments p on p.appointment_id = a.id
    where a.status = 'accepted'
      and p.method = 'online'
      and p.status = 'hold'
      and p.razorpay_payment_id is null
      and p.created_at < now() - interval '20 minutes'
  ), moved as (
    update appointments a set status = 'cancelled'
    from due where a.id = due.id
    returning a.id
  )
  select count(*) into v_count from moved;
  return v_count;
end;
$$;

revoke all on function public.cancel_abandoned_online_bookings() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  begin
    perform cron.unschedule('sanjeevni_abandoned_checkout_sweep');
  exception when others then
    null;
  end;
  perform cron.schedule('sanjeevni_abandoned_checkout_sweep', '*/10 * * * *', 'select public.cancel_abandoned_online_bookings()');
exception when others then
  raise notice 'pg_cron unavailable (%). Abandoned online checkouts will not be released automatically.', sqlerrm;
end $$;

-- ----------------------------------------------------------------------------
-- 85.7 Patient QR only when the clinic uses it
-- ----------------------------------------------------------------------------
create or replace function public.issue_booking_qr(p_appointment_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  a appointments;
  v_enabled boolean;
  v_exp timestamptz;
  v_payload text;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  if not (public.is_admin() or public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select patient_qr_enabled into v_enabled from clinics where id = a.clinic_id;
  if not coalesce(v_enabled, false) then
    raise exception 'PATIENT_QR_OFF: this clinic checks you in with the clinic QR at reception, or by your name or phone at the desk.';
  end if;

  v_exp := now() + interval '10 minutes';
  v_payload := a.id::text || '|' || extract(epoch from v_exp)::bigint::text;

  return query
  select
    'sanjeevni:appt:v2:' || a.id::text || ':' ||
      extract(epoch from v_exp)::bigint::text || ':' || public.sign_qr_payload(v_payload),
    v_exp;
end;
$$;

-- ----------------------------------------------------------------------------
-- 85.8 Prescription advice in English and Hindi
-- ----------------------------------------------------------------------------
alter table prescriptions add column if not exists advice_en text;
alter table prescriptions add column if not exists advice_hi text;
alter table prescriptions drop constraint if exists prescriptions_advice_length_check;
alter table prescriptions add constraint prescriptions_advice_length_check
  check (coalesce(length(advice_en), 0) <= 2000 and coalesce(length(advice_hi), 0) <= 2000);
alter table prescriptions drop constraint if exists prescriptions_items_shape_check;
alter table prescriptions add constraint prescriptions_items_shape_check
  check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 40) not valid;
