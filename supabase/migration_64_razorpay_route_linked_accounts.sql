-- ============================================================================
-- 64. RAZORPAY ROUTE - actually provision a clinic's linked account (fills
--     the gap migration 59 left open: "provisioned on Razorpay's own
--     dashboard... nothing here holds funds itself")
-- ============================================================================
-- release-clinic-payout (migration 59) already calls Razorpay's Transfer API
-- correctly once clinics.razorpay_fund_account_id (a Route linked-account id,
-- e.g. "acc_xxx" - the column name predates this migration but that's what it
-- always held) is populated. Nothing anywhere ever SET that column except a
-- human pasting an id in by hand. This migration adds the missing onboarding
-- step - create-clinic-linked-account (a new edge function, admin-only) calls
-- Razorpay's Account API to create the linked account and request its Route
-- product/settlement configuration, then records the result here.
--
--   1. clinics gains razorpay_account_status (Razorpay's own Route PRODUCT
--      activation_status vocabulary: requested/under_review/
--      needs_clarification/activated/suspended, plus 'not_started' before
--      anything is attempted - THIS status, not the account's own top-level
--      status, is what actually gates whether a transfer can succeed) and
--      razorpay_account_note (the latest clarification/requirement message
--      from Razorpay, so an admin sees WHY without leaving the app).
--   2. guard_clinic_payout_account() - same "announce yourself with a
--      session GUC" shape as guard_presence_columns()/guard_locked_name()
--      (app.payment_write, app.name_change_write), not an is_admin() check
--      directly: is_admin() reads auth.uid(), which is NULL for both an
--      anonymous caller AND a service-role/SQL-editor session with no user
--      JWT at all, so gating on it directly would just as happily lock out
--      a legitimate manual fix as it blocks a clinic. Only
--      admin_set_clinic_payout_account() may write these columns now -
--      closes a real pre-existing gap, not just a new one: clinics_update's
--      own USING clause (`is_own_clinic(id) or is_admin()`) has allowed a
--      clinic to silently overwrite ITS OWN razorpay_fund_account_id since
--      migration 59, which would misroute its own future payouts to
--      whatever account it typed in.
--   3. admin_set_clinic_payout_account() - the only door in. Admin-only,
--      called with the ADMIN's own session (not a service-role client) from
--      create-clinic-linked-account, same "let auth.uid() do the real admin
--      check" shape as release_settlement() and friends.
-- ============================================================================

alter table clinics add column if not exists razorpay_account_status text not null default 'not_started';
alter table clinics drop constraint if exists clinics_razorpay_account_status_check;
alter table clinics add constraint clinics_razorpay_account_status_check
  check (razorpay_account_status in ('not_started', 'requested', 'under_review', 'needs_clarification', 'activated', 'suspended'));
alter table clinics add column if not exists razorpay_account_note text;

create or replace function public.guard_clinic_payout_account()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.payout_account_write', true), '') = '1' then
    return new;  -- we're inside admin_set_clinic_payout_account()
  end if;
  -- razorpay-webhook's product.route.* handler writes these columns
  -- directly (via its service-role client, never exposed to any browser)
  -- once Razorpay itself confirms an activation-status change - the same
  -- trust boundary release-clinic-payout already relies on to write
  -- settlements.razorpay_transfer_id the same way. current_user really is
  -- the Postgres role named service_role for a service-role-authenticated
  -- request - not a claim that could be spoofed by a normal session.
  if current_user = 'service_role' then
    return new;
  end if;

  if new.razorpay_fund_account_id is distinct from old.razorpay_fund_account_id
     or new.razorpay_account_status is distinct from old.razorpay_account_status
     or new.razorpay_account_note is distinct from old.razorpay_account_note then
    raise exception 'A clinic''s payout account can only be changed by admin_set_clinic_payout_account().';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_clinics_payout_account on clinics;
create trigger guard_clinics_payout_account
  before update on clinics
  for each row
  execute function public.guard_clinic_payout_account();

create or replace function public.admin_set_clinic_payout_account(
  p_clinic_id uuid,
  p_account_id text,
  p_status text,
  p_note text default null
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
      razorpay_account_note = p_note
  where id = p_clinic_id
  returning * into result;

  if result.id is null then
    raise exception 'Clinic not found.';
  end if;

  return result;
end;
$$;
