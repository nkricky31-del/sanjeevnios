-- 15. CLINIC MAP LOCATION
-- ============================================================================

-- No new RLS needed: clinics_select/clinics_update already govern these
-- exactly like every other clinic column (owner sees/edits their own;
-- patients see them once the clinic is approved+active).
alter table clinics add column if not exists lat double precision;
alter table clinics add column if not exists lng double precision;
alter table clinics add column if not exists formatted_address text;

-- Re-declared with clinic_lat/clinic_lng added to the result so the patient
-- search page can sort/filter by "nearest to me" - drop first since
-- CREATE OR REPLACE can't change a function's return row shape.
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
  clinic_lng double precision
)
language sql
stable
as $$
  select d.id, d.name, d.specialty, c.id, c.name, c.address, c.lat, c.lng
  from doctors d
  join clinics c on c.id = d.clinic_id
  where d.status = 'approved'
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
