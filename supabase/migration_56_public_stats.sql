-- ============================================================================
-- 56. PUBLIC MARKETING SITE - LIVE STATS (aggregate-only, cached, anon-safe)
-- ============================================================================
-- The public marketing site (sanjeevnios.in) needs a "clinics onboarded /
-- clinics live / patients served / doctors onboarded / cities covered" strip
-- on its home page, fetched with NO session (anon role) from a page that
-- anyone - including a crawler - can load. Two things have to be true for
-- that to be safe:
--
--   1. Every number is a COUNT, never a row. get_public_stats() below never
--      selects a name, phone, address, or any other column that identifies
--      a specific clinic/doctor/patient - only aggregate counts cross
--      clinics/doctors/appointments. It's SECURITY DEFINER purely to reach
--      across every clinic's rows for those counts (RLS would otherwise
--      restrict an anon caller to nothing at all) - not to expose anything
--      that RLS would otherwise hide, since nothing row-shaped is returned.
--   2. It "cannot be hammered": public_stats_cache is a one-row table this
--      function only recomputes from the live tables when its own
--      computed_at is more than 5 minutes old - every call inside that
--      window (which is every call, in practice, on a marketing page) just
--      reads the single cached row. Same "sweep on read, no cron needed"
--      shape already used by sweep_expired_verifications() /
--      auto_mark_no_shows() elsewhere in this schema, just triggered by a
--      read instead of a write. The `for update` row lock while checking
--      staleness means concurrent hits right at the 5-minute mark still
--      only trigger ONE recompute, not a thundering herd of them.
--
-- clinics.city is new - ClinicLocationPicker.tsx already reverse-geocodes a
-- pin to a formatted address string, but never kept the structured city
-- component needed to count distinct cities honestly (regex-splitting the
-- free-text formatted_address would be unreliable). src/lib/geocoding.ts now
-- asks Nominatim for addressdetails and returns city alongside lat/lng, and
-- ClinicLocationPicker.tsx saves it here.
--
-- "Onboarded" (clinics/doctors) deliberately excludes 'draft' - an abandoned
-- signup that never even finished the submission checklist (section 55)
-- isn't a real number to advertise - and excludes 'rejected', since that
-- clinic/doctor never actually joined. "Live" is approved + active, exactly
-- Part 30's own patient-visibility gate. "Cities covered" is scoped to that
-- same live population - a draft clinic's pin isn't coverage patients can
-- actually book into yet.
-- ============================================================================

alter table clinics add column if not exists city text;

create table if not exists public_stats_cache (
  id boolean primary key default true check (id),
  clinics_onboarded int not null default 0,
  clinics_live int not null default 0,
  patients_served int not null default 0,
  doctors_onboarded int not null default 0,
  cities_covered int not null default 0,
  computed_at timestamptz not null default '2000-01-01'::timestamptz
);
insert into public_stats_cache (id) values (true) on conflict (id) do nothing;

alter table public_stats_cache enable row level security;

-- Harmless to expose broadly (aggregate counts only) - readable directly
-- too, not just through get_public_stats(), same "admin/system-owned,
-- everyone reads" shape as conditions_ref / verification_requirements.
drop policy if exists "public_stats_cache_select" on public_stats_cache;
create policy "public_stats_cache_select" on public_stats_cache for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policy for any role - the cache is only ever
-- written by get_public_stats() below, which is SECURITY DEFINER and so
-- bypasses RLS entirely for its own write.

create or replace function public.get_public_stats()
returns table (
  clinics_onboarded int,
  clinics_live int,
  patients_served int,
  doctors_onboarded int,
  cities_covered int,
  computed_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cached public_stats_cache;
begin
  select * into cached from public_stats_cache where id = true for update;

  if cached.computed_at < now() - interval '5 minutes' then
    update public_stats_cache set
      clinics_onboarded = (select count(*) from clinics where status in ('pending', 'approved')),
      clinics_live = (select count(*) from clinics where status = 'approved' and is_active),
      patients_served = (select count(*) from appointments where status = 'completed'),
      doctors_onboarded = (select count(*) from doctors where status in ('pending', 'approved')),
      cities_covered = (
        select count(distinct city) from clinics
        where city is not null and status = 'approved' and is_active
      ),
      computed_at = now()
    where id = true
    returning * into cached;
  end if;

  return query select
    cached.clinics_onboarded, cached.clinics_live, cached.patients_served,
    cached.doctors_onboarded, cached.cities_covered, cached.computed_at;
end;
$$;

grant execute on function public.get_public_stats() to anon, authenticated;
