-- ============================================================================
-- 59. PAYMENT SETTLEMENT - SanjeevniOS collects online payments first, an
--     admin releases them to clinics (refines Part 47's commission_ledger)
-- ============================================================================
-- commission_ledger (migration 43 / section 43.4) already computes exactly
-- the right number - net_amount minus a per-booking platform_fee, from the
-- clinic's own plan.per_booking_commission - but only ever as a single,
-- static row written once an appointment completes. There was no earlier
-- "money has been collected but the visit isn't done yet" state, and no way
-- to actually RELEASE that money to a clinic - AdminPayments.tsx's
-- "Clinic payouts" section (src/lib/payouts.ts) grew up separately, using
-- its own hardcoded flat 10% fee with no completion gate at all, bulk-
-- marking a clinic's ENTIRE captured balance "paid" with one click. That
-- section is retired by this migration (its math never agreed with the real
-- per-plan commission this schema already tracks) - see AdminSettlements.tsx.
--
-- This migration:
--   1. RENAMES commission_ledger to settlements and gives it a real state
--      machine: collected -> eligible -> released -> settled, plus on_hold
--      and refunded. A row now exists from the moment an online payment is
--      actually CAPTURED (razorpay-capture-payment has already moved real
--      money into the platform's Razorpay account by then - see that
--      function's own comment), not just once the visit is done.
--   2. Server-enforced transitions, all inside handle_appointment_status_change()
--      (already the one place appointment-status side effects live):
--        accepted  -> INSERT at 'collected' (fee not known yet)
--        completed -> 'collected' becomes 'eligible', fee computed NOW (same
--                     timing commission_ledger always used - a clinic's plan
--                     can change between booking and completion, so the fee
--                     in effect at completion is the one that counts)
--        rejected/cancelled -> 'refunded' (mirrors the existing payment refund)
--        no_show   -> 'on_hold' (a human has to decide - see the spec's own
--                     "no-shows... stay on_hold")
--   3. release_settlement() / release_eligible_settlements() - the only way
--      an 'eligible' row becomes 'released'. Admin-only, records who and
--      when, computes net_payout = net_amount - platform_fee right then (so
--      the recorded figure never drifts if a plan's commission rate changes
--      later). set_settlement_hold()/resolve_settlement_hold() cover a
--      manual dispute, on top of the automatic no_show one.
--   4. NOT a wallet: release only ever changes THIS ledger. Whether real
--      money actually moves is a separate, best-effort step
--      (supabase/functions/release-clinic-payout) that calls Razorpay
--      ROUTE's Transfers API against clinics.razorpay_fund_account_id (a
--      linked/sub-merchant account you provision on Razorpay's own side -
--      nothing here holds funds itself). mark_settlement_settled() is the
--      manual fallback for as long as that isn't configured yet; once it is,
--      razorpay-webhook's new transfer.processed handler does the same thing
--      automatically, off a signed event - never a client callback.
--   5. A real gap this closes: AdminPayments.tsx's existing "Reverse
--      payment" action could previously "refund" a payment whose money had
--      already left the platform. prevent_refund_after_release() now blocks
--      that at the database level, not just by convention.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 59.1 clinics - where a linked/sub-merchant account id lives, once you
--      provision one on Razorpay's own dashboard (Route). Null is the normal
--      state until then - nothing here requires it to exist.
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists razorpay_fund_account_id text;

-- ----------------------------------------------------------------------------
-- 59.2 settlements (was commission_ledger)
-- ----------------------------------------------------------------------------
-- Guarded with IF EXISTS / a pg_constraint check rather than the plain form
-- every other rename in this schema can get away with, since plain
-- "ALTER TABLE x RENAME" has no idempotent form on its own - re-running this
-- migration a second time (this schema's own "safe to re-run" rule) would
-- otherwise fail the moment commission_ledger no longer exists to rename.
alter table if exists commission_ledger rename to settlements;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'commission_ledger_appointment_id_unique') then
    alter table settlements rename constraint commission_ledger_appointment_id_unique to settlements_appointment_id_unique;
  end if;
  if exists (select 1 from pg_constraint where conname = 'commission_ledger_pkey') then
    alter table settlements rename constraint commission_ledger_pkey to settlements_pkey;
  end if;
end $$;

alter table settlements add column if not exists payment_id uuid references payments (id) on delete cascade;
-- Default 'eligible', not 'collected' - every row that already exists the
-- FIRST time this column is added is a pre-existing (pre-migration) row,
-- which by construction is already both collected and completed (see this
-- migration's header). This only matters for THAT one-time backfill: both
-- INSERTs in 59.3 below always state `status` explicitly, so a brand new
-- row's status never actually comes from this default, and a second,
-- accidental re-run of this whole script is still safe - "add column if
-- not exists" is then a no-op, so the default is never reapplied to
-- anything.
alter table settlements add column if not exists status text not null default 'eligible';
alter table settlements add column if not exists hold_reason text;
alter table settlements add column if not exists net_payout numeric;
alter table settlements add column if not exists released_by uuid references profiles (id);
alter table settlements add column if not exists released_at timestamptz;
alter table settlements add column if not exists settled_at timestamptz;
alter table settlements add column if not exists razorpay_transfer_id text;

-- Naturally idempotent (only ever touches a row still missing payment_id),
-- unlike a status backfill would have been - a second run just matches
-- zero rows.
update settlements s set payment_id = p.id
from payments p
where s.appointment_id = p.appointment_id and s.payment_id is null;

alter table settlements drop constraint if exists settlements_status_check;
alter table settlements add constraint settlements_status_check
  check (status in ('collected', 'eligible', 'on_hold', 'refunded', 'released', 'settled'));

drop policy if exists "commission_ledger_select" on settlements;
drop policy if exists "settlements_select" on settlements;
create policy "settlements_select" on settlements for select
  using (public.is_admin() or public.is_own_clinic(clinic_id));
-- Still no insert/update policy for any role - every write below goes
-- through a SECURITY DEFINER function that checks is_admin() itself, same
-- shape as commission_ledger's own original comment described.

-- ----------------------------------------------------------------------------
-- 59.3 handle_appointment_status_change() - collected/eligible/on_hold/
--      refunded transitions, alongside the payment/coupon bookkeeping it
--      already did.
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

    -- The money has genuinely moved into the platform's Razorpay account by
    -- now (razorpay-capture-payment already succeeded, client-side, before
    -- this status flip is ever written - see that function's own comment).
    -- The fee isn't known yet (that still depends on completion), so this
    -- starts at 0 and 59.3's 'completed' branch below fills it in.
    insert into settlements (clinic_id, appointment_id, payment_id, net_amount, commission_rate, platform_fee, status)
    select new.clinic_id, new.id, p.id, coalesce(p.net_amount, p.amount, 0), 0, 0, 'collected'
    from payments p
    where p.appointment_id = new.id and p.method = 'online' and p.status = 'captured'
    on conflict (appointment_id) do nothing;
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status in ('hold', 'captured');
    update settlements set status = 'refunded'
      where appointment_id = new.id and status in ('collected', 'eligible', 'on_hold');

    with released as (
      update coupon_redemptions set status = 'released'
      where appointment_id = new.id and status = 'reserved'
      returning coupon_id
    )
    update coupons set times_used = greatest(times_used - 1, 0)
    where id in (select coupon_id from released);
  end if;

  -- "No-shows... stay on_hold" (this migration's spec) - unlike a
  -- reject/cancel, nobody has decided yet whether this payment should be
  -- refunded or still counts as a completed visit for payout purposes, so
  -- it neither becomes eligible nor gets auto-refunded. resolve_settlement_hold()
  -- is how an admin later moves it either way.
  if new.status = 'no_show' and old.status is distinct from 'no_show' then
    update settlements set status = 'on_hold', hold_reason = coalesce(hold_reason, 'Patient no-show')
      where appointment_id = new.id and status in ('collected', 'eligible');
  end if;

  if new.status = 'completed' and old.status is distinct from 'completed' then
    -- UPSERT, not the old plain insert-or-skip: the common case now is that
    -- a 'collected' row already exists (inserted when the appointment was
    -- accepted, above) and just needs its fee computed and its status
    -- advanced. The `where` guard on the update half is defensive - it
    -- refuses to step on a row a dispute or a refund has already moved
    -- somewhere else, which shouldn't be reachable given old.status was
    -- just confirmed not 'completed', but costs nothing to also assert here.
    insert into settlements (clinic_id, appointment_id, payment_id, net_amount, commission_rate, platform_fee, status)
    select
      new.clinic_id,
      new.id,
      p.id,
      coalesce(p.net_amount, p.amount, 0),
      coalesce(pl.per_booking_commission, 0),
      coalesce(p.net_amount, p.amount, 0) * coalesce(pl.per_booking_commission, 0),
      'eligible'
    from payments p
    left join subscriptions s on s.clinic_id = new.clinic_id
    left join plans pl on pl.id = s.plan_id
    where p.appointment_id = new.id and p.method = 'online' and p.status = 'captured'
    on conflict (appointment_id) do update set
      status = 'eligible',
      commission_rate = excluded.commission_rate,
      platform_fee = excluded.platform_fee
    where settlements.status = 'collected';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 59.4 Release / hold / settle - the only ways an 'eligible' row moves.
-- ----------------------------------------------------------------------------

create or replace function public.release_settlement(p_settlement_id uuid)
returns settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  result settlements;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can release a payout.';
  end if;

  update settlements
  set status = 'released',
      net_payout = net_amount - platform_fee,
      released_by = auth.uid(),
      released_at = now()
  where id = p_settlement_id and status = 'eligible'
  returning * into result;

  if result.id is null then
    raise exception 'This payment is not currently eligible for release.';
  end if;

  return result;
end;
$$;

-- "ALL AT ONCE" - every eligible row, or every eligible row for one clinic
-- (p_clinic_id given) - released together in one statement rather than one
-- release_settlement() call per row, so a bulk release is genuinely one
-- atomic action, not N separate ones that could partially fail.
create or replace function public.release_eligible_settlements(p_clinic_id uuid default null)
returns setof settlements
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can release a payout.';
  end if;

  return query
    update settlements
    set status = 'released',
        net_payout = net_amount - platform_fee,
        released_by = auth.uid(),
        released_at = now()
    where status = 'eligible'
      and (p_clinic_id is null or clinic_id = p_clinic_id)
    returning *;
end;
$$;

create or replace function public.set_settlement_hold(p_settlement_id uuid, p_reason text)
returns settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  result settlements;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can put a payment on hold.';
  end if;
  if trim(coalesce(p_reason, '')) = '' then
    raise exception 'A reason is required.';
  end if;

  update settlements
  set status = 'on_hold', hold_reason = trim(p_reason)
  where id = p_settlement_id and status in ('collected', 'eligible')
  returning * into result;

  if result.id is null then
    raise exception 'This payment cannot be put on hold from its current state.';
  end if;

  return result;
end;
$$;

-- A dispute resolves one of two ways: it turns out fine (back to 'eligible',
-- release proceeds normally) or the patient is owed a refund ('refunded' -
-- this only updates THIS ledger; actually refunding the patient's payment
-- is the existing "Reverse payment" action in AdminPayments.tsx, still
-- available since prevent_refund_after_release() below only blocks a
-- refund AFTER release, never before).
create or replace function public.resolve_settlement_hold(p_settlement_id uuid, p_resolution text)
returns settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  result settlements;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can resolve a hold.';
  end if;
  if p_resolution not in ('eligible', 'refunded') then
    raise exception 'Resolution must be either eligible or refunded.';
  end if;

  update settlements
  set status = p_resolution
  where id = p_settlement_id and status = 'on_hold'
  returning * into result;

  if result.id is null then
    raise exception 'This payment is not currently on hold.';
  end if;

  return result;
end;
$$;

-- Manual fallback for as long as Razorpay Route isn't configured for a
-- clinic (or as a manual override): confirms the payout actually reached
-- the clinic, same as razorpay-webhook's transfer.processed handler does
-- automatically once Route is live.
create or replace function public.mark_settlement_settled(p_settlement_id uuid, p_transfer_id text default null)
returns settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  result settlements;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can confirm a settlement.';
  end if;

  update settlements
  set status = 'settled',
      settled_at = now(),
      razorpay_transfer_id = coalesce(p_transfer_id, razorpay_transfer_id)
  where id = p_settlement_id and status = 'released'
  returning * into result;

  if result.id is null then
    raise exception 'This payment has not been released yet.';
  end if;

  return result;
end;
$$;

-- ----------------------------------------------------------------------------
-- 59.5 Close the gap this whole feature would otherwise open: AdminPayments.tsx's
--      existing "Reverse payment" action updates `payments` directly from the
--      client (not through an RPC), and until now had no idea a settlement
--      system existed - it could "refund" a payment whose net had already
--      been released (even settled) to the clinic, silently lying about
--      where the money actually is.
-- ----------------------------------------------------------------------------
create or replace function public.prevent_refund_after_release()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'refunded' and old.status is distinct from 'refunded' then
    if exists (select 1 from settlements where payment_id = old.id and status in ('released', 'settled')) then
      raise exception 'This payment has already been released to the clinic and can''t be reversed here - handle it as a manual clawback instead.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_payment_prevent_refund_after_release on payments;
create trigger on_payment_prevent_refund_after_release
  before update on payments
  for each row
  execute function public.prevent_refund_after_release();
