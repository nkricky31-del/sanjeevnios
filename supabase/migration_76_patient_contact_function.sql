-- ============================================================================
-- 76. patient_contact: SECURITY DEFINER view -> explicit SECURITY DEFINER function
-- ============================================================================
-- The Supabase security advisor flags public.patient_contact (migration 68)
-- because a view that runs with its OWNER's rights hides that fact. The access
-- rule is intentional and unchanged: the front desk sees only minimal columns
-- (age, never dob; nothing clinical) for patients with a visit/waitlist entry
-- at their own clinic in the last 30 days, plus a user's own family members and
-- admins. A function states that openly instead: same predicate, same columns,
-- fixed search_path, no anon access, and it takes the ids you ask about, so it
-- cannot be used to list the whole table.
--
-- ROLLOUT: run THIS file first, deploy the frontend (it now calls the function),
-- then run migration_77 to drop the old view.
-- ============================================================================

create or replace function public.get_patient_contacts(p_ids uuid[])
returns table (
  id         uuid,
  name       text,
  relation   text,
  account_id uuid,
  phone      text,
  gender     text,
  age        int,
  mrn        text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    fm.id,
    fm.name,
    fm.relation,
    fm.account_id,
    fm.phone,
    fm.gender,
    case when fm.dob is not null then extract(year from age(current_date, fm.dob))::int end as age,
    fm.mrn
  from family_members fm
  where auth.uid() is not null
    and fm.id = any (p_ids)
    and (
      fm.account_id = auth.uid()
      or public.is_admin()
      or exists (
        select 1 from appointments a
        where a.member_id = fm.id
          and a.date >= current_date - 30
          and public.is_own_clinic(a.clinic_id)
      )
      or exists (
        select 1 from waitlist w
        where w.member_id = fm.id
          and w.date >= current_date - 30
          and public.is_own_clinic(w.clinic_id)
      )
    );
$$;

revoke all on function public.get_patient_contacts(uuid[]) from public, anon;
grant execute on function public.get_patient_contacts(uuid[]) to authenticated;
