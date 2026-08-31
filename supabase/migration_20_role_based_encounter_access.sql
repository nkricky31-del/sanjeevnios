
-- ============================================================================
-- 20. ROLE-BASED ENCOUNTER ACCESS
-- ============================================================================
-- Replaces the single combined "encounters_select" policy from section 18
-- with three separate, individually-named policies - Postgres OR's together
-- every permissive policy that applies to a given SELECT, so this behaves
-- identically to one big OR'd condition, but each rule reads and audits on
-- its own exactly as specified:
--
--   Admin:   MRN = selected patient                    -> show all encounters
--   Patient: MRN = logged-in patient                    -> show all their encounters
--   Clinic:  MRN = selected patient AND clinic_id = my clinic -> show only that clinic's encounters
--
-- This is enforced entirely in the database - PatientProfile.tsx just runs
-- a plain `select * from encounters where mrn = ?` with no role branching
-- of its own, so a direct API call (bypassing the UI, or a bug in it)
-- cannot leak another clinic's rows: Postgres itself never returns them.
--
-- One real bug fixed here vs section 18's version: the old patient branch
-- matched `fm.id = patient_id` (the exact family_members row THIS
-- encounter happens to reference), not the patient's mrn. Since one human
-- can have several family_members rows sharing an mrn (see section 18 -
-- e.g. a walk-in row at a clinic they haven't logged into yet, alongside
-- their own self-registered row), that missed encounters filed under a
-- sibling row the patient doesn't directly own. Matching by mrn instead
-- correctly surfaces every encounter tied to their identity, regardless of
-- which specific row each one happens to reference.
drop policy if exists "encounters_select" on encounters;

create policy "encounters_select_admin" on encounters for select
  using (public.is_admin());

create policy "encounters_select_patient" on encounters for select
  using (
    exists (
      select 1 from family_members fm
      where fm.account_id = auth.uid() and fm.mrn = encounters.mrn
    )
  );

create policy "encounters_select_clinic" on encounters for select
  using (public.is_own_clinic(clinic_id));
