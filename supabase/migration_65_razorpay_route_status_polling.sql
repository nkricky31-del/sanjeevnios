-- ============================================================================
-- 65. RAZORPAY ROUTE - poll a linked account's status on demand (no webhook
--     configured - see migration 64's own header on product.route.* events)
-- ============================================================================
-- migration 64 assumed the Razorpay dashboard would have product.route.*
-- events wired to razorpay-webhook, so a linked account's status would
-- update itself as Razorpay's review moves it along. That webhook is
-- deliberately NOT being configured for now, so razorpay_account_status
-- would otherwise freeze at whatever create-clinic-linked-account saw at
-- submit time ('requested', almost always) forever. This adds the pull
-- side to match: clinics.razorpay_route_product_id (the product
-- CONFIGURATION's own id, e.g. "acc_prd_xxx" - distinct from
-- razorpay_fund_account_id, the ACCOUNT's id - Razorpay's "Fetch a Product
-- Configuration" endpoint needs both) plus one more parameter on
-- admin_set_clinic_payout_account() to record it. check-clinic-payout-
-- account-status (a new edge function) is the only thing that ever reads
-- this column back out, to know which product to re-fetch.
-- ============================================================================

alter table clinics add column if not exists razorpay_route_product_id text;

-- Re-declare the trigger body to also cover the new column - same function,
-- same trigger, nothing to re-attach.
create or replace function public.guard_clinic_payout_account()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.payout_account_write', true), '') = '1' then
    return new;  -- we're inside admin_set_clinic_payout_account()
  end if;
  if current_user = 'service_role' then
    return new;  -- see migration 64's own comment on this branch
  end if;

  if new.razorpay_fund_account_id is distinct from old.razorpay_fund_account_id
     or new.razorpay_account_status is distinct from old.razorpay_account_status
     or new.razorpay_account_note is distinct from old.razorpay_account_note
     or new.razorpay_route_product_id is distinct from old.razorpay_route_product_id then
    raise exception 'A clinic''s payout account can only be changed by admin_set_clinic_payout_account().';
  end if;

  return new;
end;
$$;

create or replace function public.admin_set_clinic_payout_account(
  p_clinic_id uuid,
  p_account_id text,
  p_status text,
  p_note text default null,
  p_product_id text default null
)
returns clinics
language plpgsql
security definer
set search_path = public
as $$
declare
  result clinics;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can set a clinic''s payout account.';
  end if;
  if p_status not in ('not_started', 'requested', 'under_review', 'needs_clarification', 'activated', 'suspended') then
    raise exception 'Unrecognised payout account status: %', p_status;
  end if;

  perform set_config('app.payout_account_write', '1', true);

  update clinics
  set razorpay_fund_account_id = coalesce(p_account_id, razorpay_fund_account_id),
      razorpay_account_status = p_status,
      razorpay_account_note = p_note,
      razorpay_route_product_id = coalesce(p_product_id, razorpay_route_product_id)
  where id = p_clinic_id
  returning * into result;

  if result.id is null then
    raise exception 'Clinic not found.';
  end if;

  return result;
end;
$$;
