-- ============================================================================
-- 42. COUPON ENGINE - DATA + VALIDATION
-- ============================================================================
-- Evolves the coupons/coupon_redemptions tables and reserve_coupon() from
-- migration 41 into the richer shape asked for here, in place - not a
-- second, parallel coupon system. Existing rows (including any coupon
-- already created and used while testing migration 41/42) carry forward:
-- column renames preserve data, and times_used is backfilled from the real
-- redemption history rather than starting back at zero.
--
--   * coupons gains: description, valid_from (valid_to is the renamed
--     expires_at), per_user_limit (replaces the one_per_patient boolean -
--     a real number now, not just yes/no), total_limit (renamed from
--     max_redemptions) + a maintained times_used counter, applies_to (only
--     'app_booking' is ever produced by this app today - see
--     validate_and_price()'s own comment on why it's still checked), and
--     clinic_id (null = valid at every clinic; set = restricted to one).
--   * coupon_redemptions.patient_account_id is renamed to patient_id -
--     still profiles(id), the ACCOUNT holder, not a specific family member.
--     Tying a limit to the account rather than to whichever dependent is
--     being booked for is deliberate: otherwise "one per patient" could be
--     defeated just by adding another family member under the same login.
--   * validate_and_price(code, patient_id, clinic_id, gross_amount) replaces
--     reserve_coupon() as the ONE entry point: validates AND reserves in the
--     same atomic step, returning a machine-readable reason_code (plus a
--     human `reason`) instead of only a sentence. It takes an explicit
--     patient_id/clinic_id (rather than assuming auth.uid()) so a clinic can
--     apply a coupon on a patient's behalf later (e.g. a desk-assisted
--     booking), while still requiring the caller be that patient, an admin,
--     or that clinic.
--   * Concurrency: a `select ... for update` locks the coupon's own row for
--     the duration of the check-and-reserve, serializing every reservation
--     attempt against THAT coupon - the only mechanism that works for an
--     arbitrary per_user_limit/total_limit (a unique index can only ever
--     enforce "at most one", not "at most N"), so it's the one used here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 42.1 coupons: rename to the new shape, add the new columns
-- ----------------------------------------------------------------------------
alter table coupons rename column discount_type to type;
alter table coupons rename column discount_value to value;
alter table coupons rename column max_discount_amount to max_discount;
alter table coupons rename column min_order_amount to min_amount;
alter table coupons rename column expires_at to valid_to;
alter table coupons rename column max_redemptions to total_limit;

alter table coupons add column if not exists description text;
alter table coupons add column if not exists valid_from timestamptz;
alter table coupons add column if not exists per_user_limit int;
alter table coupons add column if not exists times_used int not null default 0;
alter table coupons add column if not exists applies_to text not null default 'app_booking';
alter table coupons add column if not exists clinic_id uuid references clinics (id) on delete cascade;

-- one_per_patient boolean -> per_user_limit int (null = unlimited per user,
-- matching total_limit's own "null = unlimited" convention).
update coupons set per_user_limit = 1 where one_per_patient and per_user_limit is null;
alter table coupons drop column if exists one_per_patient;

-- Switching times_used from "count the rows every time" to a maintained
-- counter must not silently forget usage that already happened.
update coupons c
set times_used = coalesce(
  (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status in ('reserved', 'confirmed')),
  0
);

alter table coupons drop constraint if exists coupons_code_uppercase_check;
alter table coupons add constraint coupons_code_uppercase_check check (code = upper(code));

alter table coupons drop constraint if exists coupons_percent_max_check;
alter table coupons add constraint coupons_percent_max_check check (type <> 'percent' or value <= 100);

alter table coupons drop constraint if exists coupons_per_user_limit_check;
alter table coupons add constraint coupons_per_user_limit_check check (per_user_limit is null or per_user_limit > 0);

-- Only value this app ever produces today - see validate_and_price()'s note
-- on why this is still worth enforcing even with a single allowed value.
alter table coupons drop constraint if exists coupons_applies_to_check;
alter table coupons add constraint coupons_applies_to_check check (applies_to in ('app_booking'));

-- ----------------------------------------------------------------------------
-- 42.2 coupon_redemptions: patient_account_id -> patient_id
-- ----------------------------------------------------------------------------
alter table coupon_redemptions rename column patient_account_id to patient_id;

drop policy if exists "coupon_redemptions_select" on coupon_redemptions;
create policy "coupon_redemptions_select" on coupon_redemptions for select
  using (
    public.is_admin()
    or patient_id = auth.uid()
    or (
      appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = coupon_redemptions.appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 42.3 validate_and_price() - replaces reserve_coupon()
-- ----------------------------------------------------------------------------
drop function if exists public.reserve_coupon(text, numeric);

create or replace function public.validate_and_price(
  p_code text,
  p_patient_id uuid,
  p_clinic_id uuid,
  p_gross_amount numeric
)
returns table (
  valid boolean,
  reason_code text,
  reason text,
  discount_amount numeric,
  net_amount numeric,
  redemption_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon coupons;
  v_discount numeric;
  v_per_user_count int;
  v_redemption_id uuid;
begin
  if not (auth.uid() = p_patient_id or public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    return query select false, 'NOT_AUTHORIZED'::text, 'You are not allowed to apply a coupon for this patient.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  -- The row lock - see this migration's header for why it's the right tool
  -- here. Held until this function's transaction commits (the caller's own
  -- RPC call), so two fast taps of Apply can never both pass every check
  -- below before either has actually recorded its reservation.
  select * into v_coupon from coupons where code = upper(trim(p_code)) for update;

  if v_coupon.id is null then
    return query select false, 'NOT_FOUND'::text, 'This code is not valid.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if not v_coupon.active then
    return query select false, 'INACTIVE'::text, 'This code is not active.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  -- 'app_booking' is the only value this app has ever produced, but the
  -- column exists precisely so a future non-booking use of a coupon can't
  -- accidentally be accepted here just because nothing checked it.
  if v_coupon.applies_to <> 'app_booking' then
    return query select false, 'NOT_APPLICABLE'::text, 'This code cannot be used for a booking.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.clinic_id is not null and v_coupon.clinic_id <> p_clinic_id then
    return query select false, 'WRONG_CLINIC'::text, 'This code is not valid at this clinic.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.valid_from is not null and now() < v_coupon.valid_from then
    return query select false, 'NOT_STARTED'::text, 'This code is not active yet.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.valid_to is not null and now() > v_coupon.valid_to then
    return query select false, 'EXPIRED'::text, 'This code has expired.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if p_gross_amount < v_coupon.min_amount then
    return query select false, 'MIN_AMOUNT_NOT_MET'::text,
      format('This code needs a minimum order of Rs.%s.', v_coupon.min_amount)::text,
      0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  if v_coupon.per_user_limit is not null then
    select count(*) into v_per_user_count
    from coupon_redemptions
    where coupon_id = v_coupon.id and patient_id = p_patient_id and status in ('reserved', 'confirmed');
    if v_per_user_count >= v_coupon.per_user_limit then
      return query select false, 'PER_USER_LIMIT_REACHED'::text, 'You have already used this code.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;
  end if;

  if v_coupon.total_limit is not null and v_coupon.times_used >= v_coupon.total_limit then
    return query select false, 'TOTAL_LIMIT_REACHED'::text, 'This code has already been fully used.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  v_discount := case v_coupon.type
    when 'flat' then v_coupon.value
    else round(p_gross_amount * v_coupon.value / 100.0)
  end;
  if v_coupon.type = 'percent' and v_coupon.max_discount is not null then
    v_discount := least(v_discount, v_coupon.max_discount);
  end if;
  v_discount := least(v_discount, p_gross_amount - 1); -- never discount to zero or negative

  insert into coupon_redemptions (coupon_id, patient_id, discount_amount, status)
  values (v_coupon.id, p_patient_id, v_discount, 'reserved')
  returning id into v_redemption_id;

  update coupons set times_used = times_used + 1 where id = v_coupon.id;

  return query select true, null::text, null::text, v_discount, (p_gross_amount - v_discount), v_redemption_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 42.4 release_coupon_redemption() - now also gives the slot back
-- ----------------------------------------------------------------------------
create or replace function public.release_coupon_redemption(p_redemption_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon_id uuid;
begin
  update coupon_redemptions
  set status = 'released'
  where id = p_redemption_id and patient_id = auth.uid() and status = 'reserved'
  returning coupon_id into v_coupon_id;

  if v_coupon_id is not null then
    update coupons set times_used = greatest(times_used - 1, 0) where id = v_coupon_id;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 42.5 create_payment_with_coupon() - renamed columns, whole-rupee rounding
-- ----------------------------------------------------------------------------
create or replace function public.create_payment_with_coupon(
  p_appointment_id uuid,
  p_method text,
  p_redemption_id uuid default null
)
returns table (payment_id uuid, gross_amount numeric, discount_amount numeric, net_amount numeric)
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

  select consultation_fee into v_fee from doctors where id = a.doctor_id;
  v_convenience := case when p_method = 'online' then 10 else 0 end;
  v_gross := v_fee + v_convenience;

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

  insert into payments (appointment_id, amount, method, status, gross_amount, coupon_code, discount_amount, net_amount, funded_by)
  values (
    p_appointment_id,
    v_net,
    p_method,
    case when p_method = 'online' then 'hold' else 'pending' end,
    v_gross,
    v_coupon_code,
    v_discount,
    v_net,
    v_funded_by
  )
  returning id into v_payment_id;

  return query select v_payment_id, v_gross, v_discount, v_net;
end;
$$;

-- ----------------------------------------------------------------------------
-- 42.6 handle_appointment_status_change() - give the slot back on release too
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
    update coupon_redemptions set status = 'confirmed' where appointment_id = new.id and status = 'reserved';
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status in ('hold', 'captured');

    with released as (
      update coupon_redemptions set status = 'released'
      where appointment_id = new.id and status = 'reserved'
      returning coupon_id
    )
    update coupons set times_used = greatest(times_used - 1, 0)
    where id in (select coupon_id from released);
  end if;

  return new;
end;
$$;
