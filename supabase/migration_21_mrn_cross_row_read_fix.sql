
-- ============================================================================
-- 21. CLOSE MRN CROSS-ROW READ GAP
-- ============================================================================
-- is_own_member(member_id) (section 3) only matches the EXACT family_members
-- row a booking references. Since one human can have several family_members
-- rows sharing an mrn (a walk-in row at a clinic they haven't logged into
-- yet, alongside their own self-registered row - see section 18), a patient
-- could see the ENCOUNTER for a visit filed under a sibling row (fixed for
-- encounters in section 20) but still get an empty appointment/visit/
-- prescription/files read for it, because those tables' own SELECT policies
-- were still keyed off the exact row, not the person.
--
-- is_own_mrn() closes that: true if the target family_members row's mrn
-- matches ANY family_members row the caller's own account owns. It's a
-- strict superset of is_own_member() (a row always shares its own mrn with
-- itself), so every SELECT policy below simply replaces one with the other.
-- INSERT/UPDATE policies are deliberately left alone - creating or
-- cancelling a booking should still only ever act on a row the caller
-- actually owns, not any row that happens to share their mrn (some of
-- which may be owned by a CLINIC's account, not the patient's).
create or replace function public.is_own_mrn(target_member_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from family_members target
    join family_members mine on mine.mrn = target.mrn
    where target.id = target_member_id and mine.account_id = auth.uid()
  );
$$;

drop policy if exists "appointments_select" on appointments;
create policy "appointments_select" on appointments for select
  using (public.is_own_mrn(member_id) or public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "visits_select" on visits;
create policy "visits_select" on visits for select
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a
      where a.id = visits.appointment_id
        and (public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "prescriptions_select" on prescriptions;
create policy "prescriptions_select" on prescriptions for select
  using (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id
        and (public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "files_select" on files;
create policy "files_select" on files for select
  using (
    public.is_admin()
    or public.is_own_mrn(member_id)
    or exists (
      select 1 from appointments a where a.id = files.appointment_id and public.is_own_clinic(a.clinic_id)
    )
  );

-- Same gap, same fix, for the actual file download (not just the files
-- table row) - otherwise a patient could see the file exists but not
-- open it.
drop policy if exists "appointment_files_select" on storage.objects;
create policy "appointment_files_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'appointment-files'
    and exists (
      select 1 from appointments a
      where a.id::text = (storage.foldername(name))[1]
        and (public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id) or public.is_admin())
    )
  );
