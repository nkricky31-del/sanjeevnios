-- ============================================================================
-- 41. PATIENT PAYMENT AT CHECKOUT - COUPONS + REAL RAZORPAY (authorize/capture)
-- ============================================================================
-- Two things land together because they touch the exact same money path:
--
-- COUPONS
--   * coupons - the catalog. Never directly readable by the app (RLS locks
--     it to admin) - a patient can only ever learn whether a code works
--     through reserve_coupon() below, which is the literal "validate on the
--     server, never in the app" requirement.
--   * coupon_redemptions - a reserve -> confirm/release ledger, exactly
--     mirroring the hold -> captured/refunded lifecycle payments already has:
--       - reserve_coupon() inserts a 'reserved' row the moment the patient
--         taps Apply, appointment_id still null (no booking exists yet).
--       - create_payment_with_coupon() links appointment_id once the
--         booking is actually created, and independently RE-DERIVES the
--         discount from the doctor's real fee - the reservation's own
--         figure (computed from whatever gross the client claimed at Apply
--         time) is a preview only, never trusted for the real charge.
--       - handle_appointment_status_change() confirms it on accept
--         (payment captured) or releases it on reject/cancel, same trigger
--         that already drives the payment hold's own capture/refund.
--       - An unlinked reservation (appointment_id still null) simply stops
--         counting toward "already used" / the global cap after 15 minutes
--         - the "abandoned" case releases itself with no cron job needed.
--
-- RAZORPAY (authorize now, capture on Accept, per Part 46's hold model)
--   * payments gains gross_amount / coupon_code / discount_amount /
--     net_amount / funded_by / razorpay_order_id / razorpay_payment_id.
--     `amount` keeps meaning exactly what it always has (the real
--     transactional figure - equal to net_amount) so payouts.ts and
--     AdminPayments.tsx keep working unmodified.
--   * The actual "hold" is a Razorpay order created with payment_capture: 0
--     (authorize-only) - see supabase/functions/razorpay-create-order. The
--     "capture" is a real Razorpay API call the clinic's Accept action makes
--     (supabase/functions/razorpay-capture-payment) BEFORE this trigger ever
--     flips payments.status locally - see ClinicQueue.tsx's acceptAppointment.
--   * Reject needs no Razorpay API call at all: an authorized-but-never-
--     captured payment auto-releases on Razorpay's side within days on its
--     own, which is functionally a refund from the patient's perspective -
--     the existing local "flip payments.status to refunded" bookkeeping
--     already reflects that correctly without a network call.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 41.1 Coupons catalog + redemption ledger
-- ----------------------------------------------------------------------------
create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type text not null check (discount_type in ('flat', 'percent')),
  discount_value numeric not null check (discount_value > 0),
  -- Caps a percent discount's rupee value; meaningless (and ignored) for a
  -- flat discount.
  max_discount_amount numeric check (max_discount_amount is null or max_discount_amount > 0),
  min_order_amount numeric not null default 0,
  -- Total number of successful uses this code will ever grant; null = unlimited.
  max_redemptions int check (max_redemptions is null or max_redemptions > 0),
  one_per_patient boolean not null default true,
  -- Who eats the discount - see payouts.ts: 'platform' leaves the clinic's
  -- payout on the full gross fee (the platform's own margin absorbs it);
  -- 'clinic' reduces what the clinic is owed by the discount amount.
  funded_by text not null default 'platform' check (funded_by in ('platform', 'clinic')),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references coupons (id) on delete cascade,
  -- Null from the moment reserve_coupon() creates this row (Apply time) until
  -- create_payment_with_coupon() links it to the real booking.
  appointment_id uuid references appointments (id) on delete cascade,
  patient_account_id uuid not null references profiles (id) on delete cascade,
  discount_amount numeric not null,
  status text not null default 'reserved' check (status in ('reserved', 'confirmed', 'released')),
  reserved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists coupon_redemptions_coupon_patient_idx
  on coupon_redemptions (coupon_id, patient_account_id, status);

alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;

-- coupons: nobody reads this from the app directly - see this migration's
-- header. Only admin manages the catalog (via SQL for now, same as several
-- other clinic-level settings in this project).
drop policy if exists "coupons_select" on coupons;
create policy "coupons_select" on coupons for select using (public.is_admin());
drop policy if exists "coupons_write" on coupons;
create policy "coupons_write" on coupons for all using (public.is_admin());

-- coupon_redemptions: same ownership chain as payments - the patient who
-- holds it, the clinic once it's linked to one of their appointments, admin.
-- No insert/update/delete policy at all: every write goes through a
-- security-definer function below (or the trigger), which is deliberate -
-- a coupon's discount must never be something the client can just insert.
drop policy if exists "coupon_redemptions_select" on coupon_redemptions;
create policy "coupon_redemptions_select" on coupon_redemptions for select
  using (
    public.is_admin()
    or patient_account_id = auth.uid()
    or (
      appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = coupon_redemptions.appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 41.2 payments - the extra accounting columns
-- ----------------------------------------------------------------------------
alter table payments add column if not exists gross_amount numeric;
alter table payments add column if not exists coupon_code text;
alter table payments add column if not exists discount_amount numeric not null default 0;
alter table payments add column if not exists net_amount numeric;
alter table payments add column if not exists funded_by text check (funded_by is null or funded_by in ('platform', 'clinic'));
alter table payments add column if not exists razorpay_order_id text;
alter table payments add column if not exists razorpay_payment_id text;

-- ----------------------------------------------------------------------------
-- 41.3 reserve_coupon() - the Apply button. Validates AND reserves in one
-- atomic step (the spec's "reserve the coupon use when applied").
-- ----------------------------------------------------------------------------
create or replace function public.reserve_coupon(p_code text, p_gross_amount numeric)
returns table (valid boolean, reason text, discount_amount numeric, net_amount numeric, redemption_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon coupons;
  v_uid uuid := auth.uid();
  v_discount numeric;
  v_confirmed_count int;
  v_live_count int;
  v_global_live_count int;
  v_redemption_id uuid;
begin
  if v_uid is null then
    return query select false, 'You must be signed in to apply a coupon.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  select * into v_coupon from coupons where code = upper(trim(p_code));
  if v_coupon.id is null or not v_coupon.active then
    return query select false, 'This code is not valid.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
    return query select false, 'This code has expired.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if p_gross_amount < v_coupon.min_order_amount then
    return query select false,
      format('This code needs a minimum order of Rs.%s.', v_coupon.min_order_amount)::text,
      0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  if v_coupon.one_per_patient then
    select count(*) into v_confirmed_count
    from coupon_redemptions
    where coupon_id = v_coupon.id and patient_account_id = v_uid and status = 'confirmed';
    if v_confirmed_count > 0 then
      return query select false, 'You have already used this code.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;

    -- A still-live reservation (linked to a real booking, or unlinked but
    -- inside the 15-minute abandonment window) blocks a second Apply of the
    -- same code while the first is still in flight.
    select count(*) into v_live_count
    from coupon_redemptions
    where coupon_id = v_coupon.id and patient_account_id = v_uid and status = 'reserved'
      and (appointment_id is not null or reserved_at > now() - interval '15 minutes');
    if v_live_count > 0 then
      return query select false, 'This code is already applied to a booking you have in progress.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;
  end if;

  if v_coupon.max_redemptions is not null then
    select count(*) into v_global_live_count
    from coupon_redemptions
    where coupon_id = v_coupon.id
      and (
        status = 'confirmed'
        or (status = 'reserved' and (appointment_id is not null or reserved_at > now() - interval '15 minutes'))
      );
    if v_global_live_count >= v_coupon.max_redemptions then
      return query select false, 'This code has already been fully used.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;
  end if;

  v_discount := case v_coupon.discount_type
    when 'flat' then v_coupon.discount_value
    else round(p_gross_amount * v_coupon.discount_value / 100.0, 2)
  end;
  if v_coupon.max_discount_amount is not null then
    v_discount := least(v_discount, v_coupon.max_discount_amount);
  end if;
  v_discount := least(v_discount, p_gross_amount - 1); -- never discount to zero or negative

  insert into coupon_redemptions (coupon_id, patient_account_id, discount_amount, status)
  values (v_coupon.id, v_uid, v_discount, 'reserved')
  returning id into v_redemption_id;

  return query select true, null::text, v_discount, (p_gross_amount - v_discount), v_redemption_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 41.4 release_coupon_redemption() - "Remove" in the UI, and BookingForm's
-- own cleanup path when a reservation was made but the booking never went
-- through (slot filled, payment insert failed, Razorpay checkout abandoned).
-- ----------------------------------------------------------------------------
create or replace function public.release_coupon_redemption(p_redemption_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update coupon_redemptions
  set status = 'released'
  where id = p_redemption_id and patient_account_id = auth.uid() and status = 'reserved';
end;
$$;

-- ----------------------------------------------------------------------------
-- 41.5 create_payment_with_coupon() - the actual charge. Replaces
-- BookingForm.tsx's old plain `insert into payments`: this is where the
-- gross amount is looked up server-side (the doctor's real consultation_fee
-- - never trusted from the client) and the coupon math is independently
-- re-run against it, so nothing a client claimed at Apply time is ever
-- trusted for the real total.
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
  -- Flat platform convenience fee, online payments only (there is no
  -- gateway to charge a fee for on a cash-at-clinic booking). Kept as a
  -- literal here rather than a table so it stays a single, obvious number -
  -- see src/lib/billing.ts's PLATFORM_CONVENIENCE_FEE, which this must match.
  v_convenience := case when p_method = 'online' then 10 else 0 end;
  v_gross := v_fee + v_convenience;

  if p_redemption_id is not null then
    select * into v_redemption from coupon_redemptions where id = p_redemption_id;
    if v_redemption.id is null or v_redemption.patient_account_id <> auth.uid() or v_redemption.status <> 'reserved' then
      raise exception 'This coupon is no longer applied - please re-apply it.';
    end if;
    if v_redemption.reserved_at < now() - interval '15 minutes' then
      raise exception 'Your coupon reservation expired - please re-apply it.';
    end if;

    select * into v_coupon from coupons where id = v_redemption.coupon_id;
    -- Defense in depth: re-check the facts that could have changed, or been
    -- misrepresented by the client's gross_amount, since reserve_coupon() ran.
    if not v_coupon.active or (v_coupon.expires_at is not null and v_coupon.expires_at < now()) then
      raise exception 'This coupon is no longer valid.';
    end if;
    if v_gross < v_coupon.min_order_amount then
      raise exception 'This coupon needs a minimum order of Rs.%.', v_coupon.min_order_amount;
    end if;

    v_discount := case v_coupon.discount_type
      when 'flat' then v_coupon.discount_value
      else round(v_gross * v_coupon.discount_value / 100.0, 2)
    end;
    if v_coupon.max_discount_amount is not null then
      v_discount := least(v_discount, v_coupon.max_discount_amount);
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
-- 41.6 Confirm/release the coupon redemption on the same status change that
-- already captures/refunds the payment.
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
    update coupon_redemptions set status = 'released' where appointment_id = new.id and status = 'reserved';
  end if;

  return new;
end;
$$;
