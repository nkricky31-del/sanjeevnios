-- ============================================================================
-- 92. PATIENT PHOTOS: THE STORAGE RULES NEVER MATCHED
-- ============================================================================
-- Since migration 35 no family member's photo could be uploaded (Profile >
-- Family > photo failed with "new row violates row-level security policy"),
-- and no clinic could see one on the check-in card. Inside these rules,
-- "name" was meant to be the file's path, but the query around it reads
-- family_members, which has a name column of its own (the person's name), so
-- each rule compared a member's id with the person's name and never matched.
-- Every rule now reads the file's path as objects.name.
--
-- Who may do what is unchanged:
--   see                 the account the person belongs to, an admin, or a
--                       clinic the person has an appointment with
--   add, change, remove the account the person belongs to
-- ============================================================================

drop policy if exists "patient_photos_select" on storage.objects;
create policy "patient_photos_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from public.family_members fm
      where fm.id::text = (storage.foldername(objects.name))[1]
        and (
          public.is_own_member(fm.id)
          or public.is_admin()
          or exists (
            select 1 from public.appointments a
            where a.member_id = fm.id and public.is_own_clinic(a.clinic_id)
          )
        )
    )
  );

drop policy if exists "patient_photos_insert" on storage.objects;
create policy "patient_photos_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from public.family_members fm
      where fm.id::text = (storage.foldername(objects.name))[1] and public.is_own_member(fm.id)
    )
  );

drop policy if exists "patient_photos_update" on storage.objects;
create policy "patient_photos_update" on storage.objects for update
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from public.family_members fm
      where fm.id::text = (storage.foldername(objects.name))[1] and public.is_own_member(fm.id)
    )
  );

drop policy if exists "patient_photos_delete" on storage.objects;
create policy "patient_photos_delete" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from public.family_members fm
      where fm.id::text = (storage.foldername(objects.name))[1] and public.is_own_member(fm.id)
    )
  );
