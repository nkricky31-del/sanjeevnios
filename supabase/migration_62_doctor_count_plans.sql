-- ============================================================================
-- 62. SUBSCRIPTION PRICE VARIES BY DOCTOR COUNT (refines Part 47's plans)
-- ============================================================================
-- plans (section 43) already had a price/booking-limit/commission per named
-- tier - this adds a second axis, doctor count, as tiered bands (the
-- spec's own example: Solo/Small/Group/Hospital), and the enforcement that
-- was missing entirely: nothing anywhere counted a clinic's doctors against
-- anything before this migration.
--
--   1. plans gains min_doctors/max_doctors (max_doctors null = unlimited,
--      the top tier). The existing Basic/Standard/Premium rows are marked
--      active = false (retired, not deleted - subscriptions.plan_id still
--      references them, and plans_select already shows inactive plans to
--      admins only) rather than renamed, so nothing that already points at
--      them by id breaks. Every existing subscription is remapped to
--      whichever new tier actually fits its clinic's CURRENT doctor count,
--      so nobody is retroactively "over their limit" the moment this runs.
--   2. doctors gains is_active - a plain clinic-controlled "this doctor
--      still works here" toggle, entirely separate from `status`
--      (verification workflow, admin-controlled) and `is_verified`
--      (admin-controlled). There was NO clinic-initiated way to remove a
--      doctor before this column existed - doctors_update's own RLS
--      (already `is_own_clinic(clinic_id) or is_admin()`, no column
--      restriction beyond the separate prevent_self_doctor_approval()
--      trigger blocking a self-service status change to approved/rejected)
--      already permits writing this new column with zero RLS changes.
--   3. "Count only VERIFIED, active doctors" = status = 'approved' AND
--      is_verified AND is_active - all three, everywhere counting happens
--      below.
--   4. Two DIFFERENT reconciliation moments, on purpose (the spec's own
--      "when a doctor is added... before it goes live" vs "when a doctor is
--      removed, move it down on the NEXT billing cycle" asymmetry):
--        - UPGRADE: immediate. reassign_clinic_plan_for_doctor_count() fires
--          the instant a doctor's counted-ness could have just become true
--          (status/is_verified/is_active changing) and moves the clinic UP
--          a tier right then if the new count needs it - never down.
--        - DOWNGRADE: deferred. Only ever happens where a new billing cycle
--          already gets acknowledged - supabase/functions/razorpay-webhook's
--          subscription.charged handler - via plan_for_doctor_count_for_clinic().
--          A clinic that removes a doctor mid-cycle keeps the tier (and the
--          price) it already committed to until that cycle actually ends.
--   5. Reassigning subscriptions.plan_id is the source of truth this app
--      itself reads (ClinicBilling.tsx, invoices) - it does NOT, by itself,
--      change what Razorpay charges next cycle. See
--      supabase/functions/sync-razorpay-subscription-plan for the
--      best-effort side of that (same "DB decision first, external sync
--      best-effort after" split as release-clinic-payout /
--      send-clinic-approval-notice elsewhere in this schema) - "add it next
--      cycle", not pro-rated now, is the rule this migration picked, and
--      it's the one shown on the invoice note in ClinicBilling.tsx.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 62.1 plans - the doctor-count axis
-- ----------------------------------------------------------------------------

alter table plans add column if not exists min_doctors int not null default 1;
alter table plans add column if not exists max_doctors int;
alter table plans drop constraint if exists plans_doctor_range_check;
alter table plans add constraint plans_doctor_range_check
  check (max_doctors is null or max_doctors >= min_doctors);

-- The old booking-volume tiers stay exactly as they were (still referenced
-- by existing subscriptions/invoices/commission_ledger history) but are no
-- longer offered for a NEW subscription - plans_select's own `active or
-- is_admin()` already means only an admin still sees them at all.
update plans set active = false where name in ('Basic', 'Standard', 'Premium');

insert into plans (name, monthly_price, booking_limit, per_booking_commission, min_doctors, max_doctors, active)
values
  ('Solo', 499, null, 0, 1, 1, true),
  ('Small', 1499, null, 0, 2, 5, true),
  ('Group', 3999, null, 0, 6, 15, true),
  ('Hospital', 8999, null, 0, 16, null, true)
on conflict (name) do update set
  min_doctors = excluded.min_doctors,
  max_doctors = excluded.max_doctors,
  active = true;

-- ----------------------------------------------------------------------------
-- 62.2 doctors.is_active - the missing "clinic removes/restores a doctor"
--      lever. No RLS change needed - see this migration's own header.
-- ----------------------------------------------------------------------------

alter table doctors add column if not exists is_active boolean not null default true;

-- ----------------------------------------------------------------------------
-- 62.3 Which plan fits a given doctor count - the one place this logic
--      lives, called from both the immediate-upgrade trigger below and the
--      deferred-downgrade webhook step.
-- ----------------------------------------------------------------------------

create or replace function public.plan_for_doctor_count(p_count int)
returns uuid
language sql
stable
as $$
  select id from plans
  where active
    and greatest(p_count, 1) >= min_doctors
    and (max_doctors is null or greatest(p_count, 1) <= max_doctors)
  order by min_doctors desc
  limit 1;
$$;

create or replace function public.plan_for_doctor_count_for_clinic(p_clinic_id uuid)
returns uuid
language sql
stable
as $$
  select public.plan_for_doctor_count(
    (select count(*)::int from doctors where clinic_id = p_clinic_id and status = 'approved' and is_verified and is_active)
  );
$$;

-- Remap every existing subscription still on a retired plan to whatever new
-- tier its clinic's CURRENT doctor count actually fits - a one-time
-- backfill, naturally idempotent (matches nothing on a second run, since
-- every row will already be on an active plan by then).
update subscriptions s
set plan_id = public.plan_for_doctor_count_for_clinic(s.clinic_id)
where plan_id in (select id from plans where name in ('Basic', 'Standard', 'Premium'))
  and public.plan_for_doctor_count_for_clinic(s.clinic_id) is not null;

-- enforce_clinic_booking_limit() (section 43.5) bootstraps a brand-new
-- clinic's very first subscription row - its hardcoded fallback pointed at
-- 'Basic', now retired. Re-declared with 'Solo' instead; everything else in
-- this function is unchanged from schema.sql.
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
    values (new.clinic_id, 'free', 0, current_date, (current_date + interval '1 month')::date, (select id from plans where name = 'Solo'))
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
-- 62.4 Immediate, upgrade-only reassignment - fires the moment a doctor's
--      counted-ness could just have changed.
-- ----------------------------------------------------------------------------

create or replace function public.reassign_clinic_plan_for_doctor_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_clinic_id uuid;
  counted int;
  correct_plan_id uuid;
  current_plan_id uuid;
  current_price numeric;
  correct_price numeric;
  correct_name text;
  owner uuid;
begin
  target_clinic_id := coalesce(new.clinic_id, old.clinic_id);

  select count(*) into counted
  from doctors
  where clinic_id = target_clinic_id and status = 'approved' and is_verified and is_active;

  correct_plan_id := public.plan_for_doctor_count(counted);
  if correct_plan_id is null then
    return coalesce(new, old);
  end if;

  select plan_id into current_plan_id from subscriptions where clinic_id = target_clinic_id;
  -- No subscription row yet at all - enforce_clinic_booking_limit() creates
  -- one (on 'Solo') the moment this clinic's first booking arrives; nothing
  -- to upgrade before that exists.
  if current_plan_id is null then
    return coalesce(new, old);
  end if;

  select monthly_price into current_price from plans where id = current_plan_id;
  select monthly_price, name into correct_price, correct_name from plans where id = correct_plan_id;

  -- Upgrade-only: a doctor being deactivated/rejected/un-verified can lower
  -- `counted`, but that NEVER moves the plan down here - only a cheaper-to-
  -- more-expensive change ever applies immediately. See this migration's
  -- header for why the two directions are handled in different places.
  if correct_plan_id <> current_plan_id and correct_price > current_price then
    update subscriptions set plan_id = correct_plan_id where clinic_id = target_clinic_id;

    insert into audit_log (actor, action, target)
    values (auth.uid(), 'clinic_plan_auto_upgraded', target_clinic_id::text);

    select owner_id into owner from clinics where id = target_clinic_id;
    if owner is not null then
      insert into notifications (user_id, type, message)
      values (
        owner,
        'plan_auto_upgraded',
        format(
          'Your clinic now has %s active, verified doctor(s), which is beyond your current plan - you''ve been moved to %s (₹%s/month) to cover it. This takes effect on your next billing cycle.',
          counted, correct_name, correct_price
        )
      );
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists on_doctor_reassign_clinic_plan on doctors;
create trigger on_doctor_reassign_clinic_plan
  after insert or update of status, is_verified, is_active on doctors
  for each row
  execute function public.reassign_clinic_plan_for_doctor_count();

-- ----------------------------------------------------------------------------
-- 62.5 What ClinicBilling.tsx (and AddDoctorForm.tsx's own upgrade prompt)
--      actually render - one round trip instead of three separate queries.
-- ----------------------------------------------------------------------------

create or replace function public.get_clinic_doctor_usage(p_clinic_id uuid)
returns table (
  plan_id uuid,
  plan_name text,
  monthly_price numeric,
  min_doctors int,
  max_doctors int,
  doctors_used int,
  next_plan_id uuid,
  next_plan_name text,
  next_plan_price numeric
)
language sql
stable
as $$
  with usage as (
    select count(*)::int as n
    from doctors
    where clinic_id = p_clinic_id and status = 'approved' and is_verified and is_active
  ),
  current_plan as (
    select p.* from subscriptions s join plans p on p.id = s.plan_id where s.clinic_id = p_clinic_id
  ),
  next_plan as (
    -- The next tier up from the CURRENT one by price, regardless of whether
    -- doctors_used has actually reached it yet - "what the next doctor
    -- would cost" needs to answer even at 4 of 5 included, not only once
    -- already over.
    select p.* from plans p, current_plan cp
    where p.active and p.monthly_price > cp.monthly_price
    order by p.monthly_price asc
    limit 1
  )
  select
    cp.id, cp.name, cp.monthly_price, cp.min_doctors, cp.max_doctors,
    u.n,
    np.id, np.name, np.monthly_price
  from usage u
  left join current_plan cp on true
  left join next_plan np on true;
$$;

grant execute on function public.get_clinic_doctor_usage(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 62.6 A doctor the clinic has "removed" (is_active = false) must actually
--      disappear from patient-facing surfaces too, not just stop counting
--      toward the plan - doctors_select/availability_select's public
--      branches (schema.sql sections 5/8) only ever checked status/clinic
--      state before is_active existed. The owning clinic/admin branches are
--      untouched - they still need to see and reactivate an inactive doctor.
-- ----------------------------------------------------------------------------

drop policy if exists "doctors_select" on doctors;
create policy "doctors_select" on doctors for select
  using (
    public.is_own_clinic(clinic_id)
    or public.is_admin()
    or (
      status = 'approved'
      and is_active
      and exists (select 1 from clinics c where c.id = doctors.clinic_id and c.status = 'approved' and c.is_active)
    )
  );

drop policy if exists "availability_select" on doctor_availability;
create policy "availability_select" on doctor_availability for select
  using (
    public.is_admin()
    or exists (select 1 from doctors d where d.id = doctor_availability.doctor_id and public.is_own_clinic(d.clinic_id))
    or exists (
      select 1 from doctors d join clinics c on c.id = d.clinic_id
      where d.id = doctor_availability.doctor_id
        and d.status = 'approved' and d.is_active
        and c.status = 'approved' and c.is_active
    )
  );

-- search_doctors() (migration_61_reviews.sql's version, which added the
-- rating columns) - restated again here just to add `and d.is_active` to
-- its WHERE, same "drop first, CREATE OR REPLACE can't change a return row
-- shape" reasoning as every other re-declaration of this function.
drop function if exists public.search_doctors(text);
create function public.search_doctors(search_term text default '')
returns table (
  doctor_id uuid,
  doctor_name text,
  specialty text,
  clinic_id uuid,
  clinic_name text,
  clinic_address text,
  clinic_lat double precision,
  clinic_lng double precision,
  doctor_verified boolean,
  clinic_verified boolean,
  doctor_avg_rating numeric,
  doctor_review_count int,
  doctor_percent_positive int
)
language sql
stable
as $$
  select
    d.id, d.name, d.specialty, c.id, c.name, c.address, c.lat, c.lng,
    public.is_currently_verified('doctor', d.id),
    public.is_currently_verified('clinic', c.id),
    dr.avg_rating, coalesce(dr.review_count, 0), dr.percent_positive
  from doctors d
  join clinics c on c.id = d.clinic_id
  left join lateral (
    select
      round(avg(r.rating)::numeric, 1) as avg_rating,
      count(*)::int as review_count,
      round(100.0 * count(*) filter (where r.rating >= 4) / nullif(count(*), 0))::int as percent_positive
    from reviews r
    where r.doctor_id = d.id and r.status = 'visible'
  ) dr on true
  where d.status = 'approved'
    and d.is_active
    and c.status = 'approved'
    and c.is_active
    and (
      search_term = ''
      or d.name ilike '%' || search_term || '%'
      or d.specialty ilike '%' || search_term || '%'
      or c.name ilike '%' || search_term || '%'
      or c.address ilike '%' || search_term || '%'
    )
  order by c.name, d.name;
$$;
