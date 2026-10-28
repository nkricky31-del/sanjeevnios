-- ============================================================================
-- 88. MONEY TOTALS THAT STAY RIGHT AT ANY SIZE
-- ============================================================================
-- Several screens added money up in the browser from the rows they had
-- loaded. One request returns at most 1,000 rows (the API's limit), and
-- Billing loaded only the latest 200, so past that the totals were silently
-- wrong:
--   * Admin dashboard: clinics by status, online money collected, platform
--     revenue.
--   * Admin Billing: "Total revenue" (the latest 200 invoices/commissions).
--   * Admin Settlements: the amount shown in "Release ₹X?" and the tab
--     counts (every settled payout ever was loaded too, crowding out the
--     eligible ones).
--   * A clinic's Earnings: Pending / Ready / Paid, and filtering by older
--     dates.
-- These functions add up in the database instead. All read-only.
--
-- One rule change: the dashboard's platform revenue also counted refunded
-- and on-hold fees. It now uses the same rule as Billing (migration 59):
-- only eligible, released and settled fees are revenue.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 88.1 Platform totals (admin dashboard + billing)
-- ----------------------------------------------------------------------------
create or replace function public.admin_platform_totals(p_today date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  return jsonb_build_object(
    'clinics_by_status', coalesce(
      (select jsonb_object_agg(s.status, s.n) from (select status::text as status, count(*)::int as n from clinics group by status) s),
      '{}'::jsonb),
    'doctors', (select count(*)::int from doctors),
    'patients', (select count(*)::int from profiles where role = 'patient'),
    'appointments_today', (select count(*)::int from appointments where date = p_today),
    'online_collected', (select coalesce(sum(amount), 0) from payments where status = 'captured' and method = 'online'),
    'subscription_revenue', (select coalesce(sum(amount), 0) from invoices where status = 'paid'),
    'commission_revenue', (select coalesce(sum(platform_fee), 0) from settlements where status in ('eligible', 'released', 'settled'))
  );
end;
$$;

revoke all on function public.admin_platform_totals(date) from public, anon;
grant execute on function public.admin_platform_totals(date) to authenticated;

-- ----------------------------------------------------------------------------
-- 88.2 Settlements per clinic and status (admin Settlements screen)
-- ----------------------------------------------------------------------------
-- net_total is what the clinic is owed for those rows: the recorded payout
-- once released/settled, otherwise collected minus the platform fee - the
-- same formula the screen uses for each row.
create or replace function public.admin_settlement_totals()
returns table (clinic_id uuid, clinic_name text, status text, rows_count int, net_total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  return query
    select s.clinic_id,
           c.name::text,
           s.status::text,
           count(*)::int,
           round(sum(case when s.status in ('released', 'settled') then coalesce(s.net_payout, s.net_amount - s.platform_fee)
                          else s.net_amount - s.platform_fee end), 2)
    from settlements s
    join clinics c on c.id = s.clinic_id
    where s.status <> 'collected'
    group by s.clinic_id, c.name, s.status;
end;
$$;

revoke all on function public.admin_settlement_totals() from public, anon;
grant execute on function public.admin_settlement_totals() to authenticated;

-- ----------------------------------------------------------------------------
-- 88.3 A clinic's earnings totals, optionally for a range of visit dates
-- ----------------------------------------------------------------------------
-- Buckets as on the Earnings screen: pending = collected, visit not yet done
-- (raw amount - no fee yet); ready = eligible; paid = released or settled;
-- other = on hold or refunded. With a date range, only payments whose visit
-- falls in it count (as the screen's filter always did).
create or replace function public.clinic_earnings_totals(p_clinic_id uuid, p_from date default null, p_to date default null)
returns table (bucket text, rows_count int, total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'Not your clinic.';
  end if;
  return query
    select b.bucket, count(*)::int, round(sum(b.amount), 2)
    from (
      select case
               when s.status = 'collected' then 'pending'
               when s.status = 'eligible' then 'ready'
               when s.status in ('released', 'settled') then 'paid'
               else 'other'
             end as bucket,
             case
               when s.status = 'collected' then s.net_amount
               when s.status in ('released', 'settled') then coalesce(s.net_payout, s.net_amount - s.platform_fee)
               else s.net_amount - s.platform_fee
             end as amount
      from settlements s
      left join appointments a on a.id = s.appointment_id
      where s.clinic_id = p_clinic_id
        and (p_from is null or a.date >= p_from)
        and (p_to is null or a.date <= p_to)
    ) b
    group by b.bucket;
end;
$$;

revoke all on function public.clinic_earnings_totals(uuid, date, date) from public, anon;
grant execute on function public.clinic_earnings_totals(uuid, date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 88.4 Billable doctors per clinic (admin Billing screen)
-- ----------------------------------------------------------------------------
-- Same rule as get_clinic_doctor_usage() (migration 62): approved, verified
-- and active. Billing counted these from a list of every such doctor on the
-- platform - cut off at 1,000.
create or replace function public.admin_billable_doctor_counts()
returns table (clinic_id uuid, doctors_used int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Admins only.';
  end if;
  return query
    select d.clinic_id, count(*)::int
    from doctors d
    where d.status = 'approved' and d.is_verified and d.is_active
    group by d.clinic_id;
end;
$$;

revoke all on function public.admin_billable_doctor_counts() from public, anon;
grant execute on function public.admin_billable_doctor_counts() to authenticated;
