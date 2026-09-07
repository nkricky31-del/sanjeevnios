-- ============================================================================
-- 60. CLINIC PAYOUT DASHBOARD - a payout reference number for the clinic
--     side of migration 59's settlement ledger
-- ============================================================================
-- The clinic's own Earnings page (src/components/ClinicEarnings.tsx) needs
-- "a reference number the clinic can match against its bank" the moment a
-- payment moves to Paid. razorpay_transfer_id (migration 59) only ever gets
-- set once Razorpay Route is actually configured and release-clinic-payout
-- successfully creates a transfer - most clinics won't have that yet. This
-- gives every released row a stable, human-readable reference regardless of
-- Route ("PO-00000123" - same "generate once, on the triggering event" shape
-- as generate_mrn()/generate_clinic_code()), so the feature works today and
-- the real Razorpay transfer id (once Route is live) is simply shown
-- alongside it as the authoritative bank-side reference.
--
-- Read access: nothing new needed here. settlements_select (migration 59)
-- already reads `public.is_admin() or public.is_own_clinic(clinic_id)` - a
-- clinic already sees its own rows, this just gives release_settlement()/
-- release_eligible_settlements() one more column to fill in.
-- ============================================================================

alter table settlements add column if not exists payout_reference text;
create unique index if not exists settlements_payout_reference_idx on settlements (payout_reference) where payout_reference is not null;

create sequence if not exists payout_reference_seq start 1;

create or replace function public.generate_payout_reference()
returns text
language sql
as $$
  select 'PO-' || lpad(nextval('payout_reference_seq')::text, 8, '0');
$$;

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
      released_at = now(),
      payout_reference = coalesce(payout_reference, public.generate_payout_reference())
  where id = p_settlement_id and status = 'eligible'
  returning * into result;

  if result.id is null then
    raise exception 'This payment is not currently eligible for release.';
  end if;

  return result;
end;
$$;

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
        released_at = now(),
        payout_reference = coalesce(payout_reference, public.generate_payout_reference())
    where status = 'eligible'
      and (p_clinic_id is null or clinic_id = p_clinic_id)
    returning *;
end;
$$;
