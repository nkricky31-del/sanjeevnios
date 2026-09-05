-- ============================================================================
-- 43. CLINIC-TO-ADMIN BILLING - how the platform earns
-- ============================================================================
-- Two revenue lines, both settled through Razorpay, both trusting only
-- signed webhooks for anything that actually changes billing state:
--
--   1. SUBSCRIPTIONS - a clinic pays a recurring monthly fee to stay listed.
--      plans (name/monthly_price/booking_limit/per_booking_commission)
--      replaces the hardcoded TIERS constant in src/lib/subscription.ts as
--      the source of truth for booking limits - enforce_clinic_booking_limit()
--      below now reads plans.booking_limit instead of a hardcoded 50. The
--      existing `subscriptions` table (already one row per clinic, already
--      carrying a period) is where "subscribe on the clinic" naturally
--      lands - not a new table - it gains plan_id, razorpay_subscription_id,
--      current_period_end and billing_status.
--      A Razorpay subscription is created with a fixed retry schedule on
--      Razorpay's own side; subscription.pending (a charge failed, Razorpay
--      is retrying) marks billing_status = 'past_due' immediately, and only
--      subscription.halted (Razorpay has exhausted every retry) sets
--      clinics.is_active = false - i.e. Razorpay's own retry window IS the
--      "short grace period" the spec asks for; no cron job invents a second
--      one. subscription.charged (any successful charge, first or renewal)
--      always reactivates and records an invoice.
--   2. COMMISSION - a per-booking cut of the appointment's own net_amount,
--      recorded once an appointment is marked completed, for later
--      settlement (this only RECORDS the fee - it does not attempt to
--      auto-collect it via a second Razorpay charge).
--
-- IMPORTANT FIX bundled in here: handle_appointment_status_change() has been
-- missing `security definer` since migration 39 first started writing to
-- coupon_redemptions from inside it. A plain clinic/patient action has no
-- RLS write access to coupon_redemptions (by design - see migration 41's
-- header), so every one of those writes has been silently matching zero
-- rows this whole time instead of erroring. Section 43.7 repairs the one
-- reservation this has already left stranded; section 43.6 fixes the
-- function itself so it stops happening (and is a matching risk for the
-- new commission_ledger write this migration adds to the same trigger).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 43.1 plans
-- ----------------------------------------------------------------------------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  monthly_price numeric not null check (monthly_price >= 0),
  -- null = unlimited bookings/month.
  booking_limit int check (booking_limit is null or booking_limit > 0),
  -- Fraction of an appointment's net_amount taken as platform commission
  -- once it's completed - 0 to 1 (e.g. 0.02 = 2%). Optional: 0 is valid and
  -- is the default.
  per_booking_commission numeric not null default 0 check (per_booking_commission >= 0 and per_booking_commission <= 1),
  -- Set once a matching Razorpay Plan exists (created lazily, on first
  -- subscribe - see razorpay-create-subscription) - null until then.
  razorpay_plan_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table plans enable row level security;
drop policy if exists "plans_select" on plans;
create policy "plans_select" on plans for select using (active or public.is_admin());
drop policy if exists "plans_write" on plans;
create policy "plans_write" on plans for all using (public.is_admin());

-- Basic mirrors the old 'free' tier exactly (50 bookings/month, no cost) so
-- every existing clinic's behaviour is unchanged the moment this runs.
-- Standard/Premium mirror old 'pro'/'premium' (unlimited) with example
-- prices/commissions an admin can edit directly in the table (or via SQL -
-- there's no plans-admin CRUD screen yet, matching how several other
-- clinic-level settings in this project start out SQL-managed).
insert into plans (name, monthly_price, booking_limit, per_booking_commission)
values
  ('Basic', 0, 50, 0),
  ('Standard', 999, null, 0),
  ('Premium', 2499, null, 0.02)
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- 43.2 subscriptions - extended, not replaced
-- ----------------------------------------------------------------------------
alter table subscriptions add column if not exists plan_id uuid references plans (id);
alter table subscriptions add column if not exists razorpay_subscription_id text;
-- Distinct from the existing period_start/period_end (date - the monthly
-- USAGE-count reset window, lazily rolled by enforce_clinic_booking_limit()).
-- This is the actual Razorpay BILLING cycle's end, a real instant in time.
alter table subscriptions add column if not exists current_period_end timestamptz;
alter table subscriptions add column if not exists billing_status text not null default 'active';
alter table subscriptions drop constraint if exists subscriptions_billing_status_check;
alter table subscriptions add constraint subscriptions_billing_status_check
  check (billing_status in ('active', 'past_due'));
alter table subscriptions add column if not exists past_due_since timestamptz;

update subscriptions set plan_id = (select id from plans where name = 'Basic') where tier = 'free' and plan_id is null;
update subscriptions set plan_id = (select id from plans where name = 'Standard') where tier = 'pro' and plan_id is null;
update subscriptions set plan_id = (select id from plans where name = 'Premium') where tier = 'premium' and plan_id is null;

-- ----------------------------------------------------------------------------
-- 43.3 invoices - one row per billing cycle attempt (paid or failed)
-- ----------------------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount numeric not null,
  status text not null check (status in ('paid', 'failed')),
  razorpay_invoice_id text,
  razorpay_payment_id text,
  created_at timestamptz not null default now()
);

alter table invoices enable row level security;
drop policy if exists "invoices_select" on invoices;
create policy "invoices_select" on invoices for select
  using (public.is_admin() or public.is_own_clinic(clinic_id));
-- No insert/update policy for plain users at all - only razorpay-webhook
-- (service role, bypasses RLS as table owner) ever writes an invoice.

-- ----------------------------------------------------------------------------
-- 43.4 commission_ledger - one row per completed appointment, for later
-- settlement (this records the fee; it does not collect it automatically).
-- ----------------------------------------------------------------------------
create table if not exists commission_ledger (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  appointment_id uuid not null references appointments (id) on delete cascade,
  net_amount numeric not null,
  commission_rate numeric not null,
  platform_fee numeric not null,
  created_at timestamptz not null default now()
);
alter table commission_ledger add constraint commission_ledger_appointment_id_unique unique (appointment_id);

alter table commission_ledger enable row level security;
drop policy if exists "commission_ledger_select" on commission_ledger;
create policy "commission_ledger_select" on commission_ledger for select using (public.is_admin());
-- No write policy for plain users - only handle_appointment_status_change()
-- (security definer as of 43.6) ever inserts a row.

-- ----------------------------------------------------------------------------
-- 43.5 enforce_clinic_booking_limit() - reads plans.booking_limit now,
-- instead of a hardcoded "50 if tier = free".
-- ----------------------------------------------------------------------------
create or replace function public.enforce_clinic_booking_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  clinic_is_active boolean;
  sub subscriptions;
  limit_val int;
begin
  select is_active into clinic_is_active from clinics where id = new.clinic_id;
  if clinic_is_active is false then
    raise exception 'This clinic isn''t currently accepting bookings.';
  end if;

  select * into sub from subscriptions where clinic_id = new.clinic_id;

  if sub.id is null then
    insert into subscriptions (clinic_id, tier, bookings_used, period_start, period_end, plan_id)
    values (new.clinic_id, 'free', 0, current_date, (current_date + interval '1 month')::date, (select id from plans where name = 'Basic'))
    returning * into sub;
  elsif sub.period_end is null or sub.period_end < current_date then
    update subscriptions
    set bookings_used = 0, period_start = current_date, period_end = (current_date + interval '1 month')::date
    where id = sub.id
    returning * into sub;
  end if;

  select booking_limit into limit_val from plans where id = sub.plan_id;

  if limit_val is not null and sub.bookings_used >= limit_val then
    raise exception 'This clinic has reached its booking limit for this period. Please try again later or contact the clinic.';
  end if;

  update subscriptions set bookings_used = bookings_used + 1 where id = sub.id;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 43.6 handle_appointment_status_change() - the security definer fix, plus
-- commission recording on completed.
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
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

  if new.status = 'completed' and old.status is distinct from 'completed' then
    insert into commission_ledger (clinic_id, appointment_id, net_amount, commission_rate, platform_fee)
    select
      new.clinic_id,
      new.id,
      coalesce(p.net_amount, p.amount, 0),
      coalesce(pl.per_booking_commission, 0),
      coalesce(p.net_amount, p.amount, 0) * coalesce(pl.per_booking_commission, 0)
    from payments p
    left join subscriptions s on s.clinic_id = new.clinic_id
    left join plans pl on pl.id = s.plan_id
    where p.appointment_id = new.id
      and coalesce(p.net_amount, p.amount, 0) * coalesce(pl.per_booking_commission, 0) > 0
    on conflict (appointment_id) do nothing;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 43.7 One-time repair for the dormant bug described in this migration's
-- header - fixes any reservation the missing security definer left stranded.
-- ----------------------------------------------------------------------------
update coupon_redemptions cr
set status = 'confirmed'
from appointments a
where a.id = cr.appointment_id
  and cr.status = 'reserved'
  and a.status = 'accepted';

with stuck as (
  update coupon_redemptions cr
  set status = 'released'
  from appointments a
  where a.id = cr.appointment_id
    and cr.status = 'reserved'
    and a.status in ('rejected', 'cancelled')
  returning cr.coupon_id
)
update coupons c
set times_used = greatest(times_used - 1, 0)
where id in (select coupon_id from stuck);
