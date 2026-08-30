-- ============================================================================
-- Migration for the subscriptions/access-control feature (schema.sql
-- section 12). Paste this whole file into Supabase Dashboard -> SQL Editor
-- -> Run. Safe to re-run.
-- ============================================================================

-- One subscription row per clinic - guarantees the "get or create" logic in
-- the trigger below (and the admin console's upsert-by-tier) always targets
-- exactly one row, never creates a duplicate.
alter table subscriptions drop constraint if exists subscriptions_clinic_id_unique;
alter table subscriptions add constraint subscriptions_clinic_id_unique unique (clinic_id);

alter table subscriptions drop constraint if exists subscriptions_tier_check;
alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'premium'));

-- Blocks a new appointment outright if the clinic is inactive, or if it's on
-- the free tier and already at/over its booking limit for the current
-- period - applies uniformly to patient bookings AND clinic-entered
-- walk-ins, since both go through this same appointments table. Lazily
-- creates a clinic's subscription row (defaulting to free) the first time
-- it's needed, and lazily rolls the period over once it's expired, so no
-- scheduled job is required anywhere.
--
-- security definer: a plain patient booking an appointment has no RLS
-- access to read/write `subscriptions` (subscriptions_select/write are
-- admin+own-clinic only) - this needs to touch it regardless of who's
-- making the booking, so it runs with the function owner's privileges,
-- bypassing that RLS entirely (same reasoning as is_own_clinic() etc above).
--
-- The free-tier limit (50) is display-mirrored in src/lib/subscription.ts
-- for the admin/clinic UI - THIS is what's actually enforced.
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
    insert into subscriptions (clinic_id, tier, bookings_used, period_start, period_end)
    values (new.clinic_id, 'free', 0, current_date, (current_date + interval '1 month')::date)
    returning * into sub;
  elsif sub.period_end is null or sub.period_end < current_date then
    update subscriptions
    set bookings_used = 0, period_start = current_date, period_end = (current_date + interval '1 month')::date
    where id = sub.id
    returning * into sub;
  end if;

  limit_val := case sub.tier when 'free' then 50 else null end;

  if limit_val is not null and sub.bookings_used >= limit_val then
    raise exception 'This clinic has reached its booking limit for this period. Please try again later or contact the clinic.';
  end if;

  update subscriptions set bookings_used = bookings_used + 1 where id = sub.id;

  return new;
end;
$$;

drop trigger if exists on_appointment_enforce_subscription on appointments;
create trigger on_appointment_enforce_subscription
  before insert on appointments
  for each row
  execute function public.enforce_clinic_booking_limit();
