-- ============================================================================
-- 79. NO ROUTINE ADMIN ACCESS TO PATIENT HEALTH DATA
-- ============================================================================
-- Run ONLY after migration 78 is applied, at least one security_approver and one
-- ops/support person exist, and you have completed one break-glass request end
-- to end (SECURITY_INTERNAL.md, test 2). Until then admins can still read
-- these tables.
--
-- Removes every is_admin() branch that let an internal account read or write
-- clinical data: visits, prescriptions, files (+ the storage objects), patient
-- conditions, the full family_members row, and the admin-only encounters
-- policy. Patients keep their own data, clinic staff keep their audited
-- 12-hour grants (migration 68). Internal staff now reach a patient's record
-- only through breakglass_open_patient().
--
-- NOT changed (and why):
--   * appointments / waitlist / payments stay admin-readable: bookings,
--     fraud review, settlements and refunds need them. appointments.reason
--     (free text a patient typed) is therefore still visible to admins - treat
--     it as sensitive and keep admin accounts few and on MFA.
--   * family_members insert/update keep their admin branch (record merges, name
--     changes). With no SELECT policy for admin, an UPDATE finds zero rows, so
--     this cannot be used to read anything.
-- To undo: re-run the policy blocks from migration_68 / 24 / 20.
-- ============================================================================

-- visits
drop policy if exists "visits_select" on visits;
create policy "visits_select" on visits for select
  using (
    exists (
      select 1 from appointments a
      where a.id = visits.appointment_id
        and (public.is_own_mrn(a.member_id) or public.has_health_access(a.clinic_id, a.member_id))
    )
  );

drop policy if exists "visits_write" on visits;
create policy "visits_write" on visits for all
  using (
    exists (select 1 from appointments a where a.id = visits.appointment_id and public.has_health_access(a.clinic_id, a.member_id))
  )
  with check (
    exists (select 1 from appointments a where a.id = visits.appointment_id and public.has_health_access(a.clinic_id, a.member_id))
  );

-- prescriptions
drop policy if exists "prescriptions_select" on prescriptions;
create policy "prescriptions_select" on prescriptions for select
  using (
    exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id
        and (public.is_own_mrn(a.member_id) or public.has_health_access(a.clinic_id, a.member_id))
    )
  );

drop policy if exists "prescriptions_write" on prescriptions;
create policy "prescriptions_write" on prescriptions for all
  using (
    exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  )
  with check (
    exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

-- files (+ their storage objects)
drop policy if exists "files_select" on files;
create policy "files_select" on files for select
  using (
    public.is_own_mrn(member_id)
    or exists (
      select 1 from appointments a
      where a.id = files.appointment_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

drop policy if exists "appointment_files_select" on storage.objects;
create policy "appointment_files_select" on storage.objects for select
  using (
    bucket_id = 'appointment-files'
    and exists (
      select 1 from appointments a
      where (a.id)::text = (storage.foldername(objects.name))[1]
        and (public.is_own_mrn(a.member_id) or public.has_download_grant(objects.name))
    )
  );

-- known conditions
drop policy if exists "patient_conditions_select" on patient_conditions;
create policy "patient_conditions_select" on patient_conditions for select
  using (
    public.is_own_mrn(patient_id)
    or exists (
      select 1 from appointments a
      where a.member_id = patient_conditions.patient_id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );
drop policy if exists "patient_conditions_insert" on patient_conditions;
create policy "patient_conditions_insert" on patient_conditions for insert
  with check (public.is_own_mrn(patient_id));
drop policy if exists "patient_conditions_delete" on patient_conditions;
create policy "patient_conditions_delete" on patient_conditions for delete
  using (public.is_own_mrn(patient_id));

-- the full patient row
drop policy if exists "family_select" on family_members;
create policy "family_select" on family_members for select
  using (
    account_id = auth.uid()
    or exists (
      select 1 from appointments a
      where a.member_id = family_members.id and public.has_health_access(a.clinic_id, a.member_id)
    )
  );

-- encounters: the admin-only policy goes
drop policy if exists "encounters_select_admin" on encounters;
