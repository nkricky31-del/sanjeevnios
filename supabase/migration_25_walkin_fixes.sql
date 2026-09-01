-- ============================================================================
-- 25. WALK-IN FIXES: duplicate-patient linking, clinic holidays
-- ============================================================================
-- See TESTING.md "Test 5" for how to exercise these.

-- A clinic registering a walk-in needs to know if this phone number already
-- belongs to an existing patient (either their own real account, or a walk-in
-- stub created by ANY clinic) so it can attach the visit to that same
-- family_members row instead of creating a duplicate one. Plain RLS can't
-- support this lookup: family_select only lets a clinic see a member once
-- THAT clinic already has an appointment with them - which is exactly the
-- chicken-and-egg this function exists to break. security definer, and
-- gated to clinic/admin callers since it returns a name+mrn for a phone
-- number the caller didn't necessarily "own" the way an appointment implies.
-- Prefers a row owned by a genuine patient account over a clinic-created
-- stub (the real identity should win over a placeholder); among ties, the
-- oldest row (the original identity, not a later duplicate).
create or replace function public.find_family_member_by_phone(p_phone text)
returns table (id uuid, mrn text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select fm.id, fm.mrn, fm.name
  from family_members fm
  join profiles p on p.id = fm.account_id
  where fm.phone = p_phone
    and (public.is_clinic() or public.is_admin())
  order by (p.role = 'patient') desc, fm.created_at asc
  limit 1;
$$;

-- Specific dates a clinic is closed (festival, doctor leave covering the
-- whole clinic, etc.) - on top of the existing weekly doctor_availability.
-- Deliberately clinic-scoped, not per-doctor: the ask ("respect the clinic's
-- ... holidays") and the walk-in flow's own framing are both clinic-level,
-- and a per-doctor version can be layered on later without a shape change
-- here if it turns out to be needed.
create table if not exists clinic_holidays (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (clinic_id, date)
);

alter table clinic_holidays enable row level security;

-- Readable by the owning clinic, admin, or anyone booking (needs to know
-- which dates to grey out) as long as the clinic is publicly visible -
-- same visibility rule doctors/availability already use.
drop policy if exists "clinic_holidays_select" on clinic_holidays;
create policy "clinic_holidays_select" on clinic_holidays for select
  using (
    public.is_own_clinic(clinic_id)
    or public.is_admin()
    or exists (
      select 1 from clinics c
      where c.id = clinic_holidays.clinic_id and c.status = 'approved' and c.is_active
    )
  );

drop policy if exists "clinic_holidays_write" on clinic_holidays;
create policy "clinic_holidays_write" on clinic_holidays for all
  using (public.is_own_clinic(clinic_id) or public.is_admin())
  with check (public.is_own_clinic(clinic_id) or public.is_admin());
