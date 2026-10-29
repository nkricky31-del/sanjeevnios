-- ============================================================================
-- 90. LIVE UPDATES FOR THE ADMIN CONSOLE
-- ============================================================================
-- The admin console only refreshed when opened, when a tab was reopened, or
-- on Refresh. Now, when something an admin acts on changes, the database sends
-- a small signal on the private channel "admin:events" and the admin screens
-- showing it refresh within a couple of seconds:
--   clinics        - new registrations, status, payout account, settings
--   doctors        - doctors added or changed (verification)
--   documents      - verification documents uploaded or reviewed
--   name_changes   - name change requests
--   reviews        - patient reviews (moderation)
--   subscriptions  - plan / billing status / renewal changes and invoices
--   payments       - refunds
--   settlements    - payouts put on hold
--   breakglass     - emergency access requests (and their approval)
-- The signal says only which of these changed - no ids, no personal data -
-- and only admins can listen to the channel. Busy, routine changes (every
-- booking, every payment, the per-booking usage counter) send nothing: the
-- console refreshes those figures on its own every minute while it is open.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 90.1 The signal
-- ----------------------------------------------------------------------------
create or replace function public.admin_signal_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- tg_argv[0]: which area changed (also the event name the console listens for)
  perform realtime.send(jsonb_build_object('area', tg_argv[0]), tg_argv[0], 'admin:events', true);
  return null;
exception when others then
  -- Live updates are a convenience: a problem sending one must never fail
  -- the change that triggered it.
  raise warning 'admin signal (%) not sent: %', tg_argv[0], sqlerrm;
  return null;
end;
$$;

revoke all on function public.admin_signal_trigger() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 90.2 When to send it
-- ----------------------------------------------------------------------------
-- Low-volume tables: once per statement (a bulk change is one signal).
drop trigger if exists admin_signal_clinics on clinics;
create trigger admin_signal_clinics
  after insert or update or delete on clinics
  for each statement execute function public.admin_signal_trigger('clinics');

drop trigger if exists admin_signal_doctors on doctors;
create trigger admin_signal_doctors
  after insert or update or delete on doctors
  for each statement execute function public.admin_signal_trigger('doctors');

drop trigger if exists admin_signal_documents on documents;
create trigger admin_signal_documents
  after insert or update or delete on documents
  for each statement execute function public.admin_signal_trigger('documents');

drop trigger if exists admin_signal_name_changes on name_change_requests;
create trigger admin_signal_name_changes
  after insert or update or delete on name_change_requests
  for each statement execute function public.admin_signal_trigger('name_changes');

drop trigger if exists admin_signal_reviews on reviews;
create trigger admin_signal_reviews
  after insert or update or delete on reviews
  for each statement execute function public.admin_signal_trigger('reviews');

drop trigger if exists admin_signal_invoices on invoices;
create trigger admin_signal_invoices
  after insert or update or delete on invoices
  for each statement execute function public.admin_signal_trigger('subscriptions');

drop trigger if exists admin_signal_breakglass on breakglass_requests;
create trigger admin_signal_breakglass
  after insert or update or delete on breakglass_requests
  for each statement execute function public.admin_signal_trigger('breakglass');

-- Subscriptions: every booking bumps bookings_used, so only real plan /
-- billing changes (and new or removed subscriptions) count.
drop trigger if exists admin_signal_subscriptions_rows on subscriptions;
create trigger admin_signal_subscriptions_rows
  after insert or delete on subscriptions
  for each statement execute function public.admin_signal_trigger('subscriptions');

drop trigger if exists admin_signal_subscriptions_plan on subscriptions;
create trigger admin_signal_subscriptions_plan
  after update on subscriptions
  for each row
  when (
    old.plan_id is distinct from new.plan_id
    or old.tier is distinct from new.tier
    or old.billing_status is distinct from new.billing_status
    or old.current_period_end is distinct from new.current_period_end
    or old.razorpay_subscription_id is distinct from new.razorpay_subscription_id
  )
  execute function public.admin_signal_trigger('subscriptions');

-- Payments: only refunds (every booking writes a payment).
drop trigger if exists admin_signal_refunds on payments;
create trigger admin_signal_refunds
  after update of status on payments
  for each row
  when (new.status = 'refunded' and old.status is distinct from new.status)
  execute function public.admin_signal_trigger('payments');

-- Settlements: only payouts put on hold (one is written per online payment).
drop trigger if exists admin_signal_holds on settlements;
create trigger admin_signal_holds
  after update of status on settlements
  for each row
  when (new.status = 'on_hold' and old.status is distinct from new.status)
  execute function public.admin_signal_trigger('settlements');

-- ----------------------------------------------------------------------------
-- 90.3 Only admins can listen
-- ----------------------------------------------------------------------------
drop policy if exists "admin_events_select" on realtime.messages;
create policy "admin_events_select" on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() = 'admin:events'
    and public.is_admin()
  );
