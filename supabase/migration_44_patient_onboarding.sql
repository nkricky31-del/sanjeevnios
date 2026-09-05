-- ============================================================================
-- 44. PATIENT ONBOARDING PROFILE
-- ============================================================================
-- Runs once, right after a new phone sign-up, before any other patient
-- screen - see PatientOnboardingGate.tsx, which wraps the whole patient app
-- in App.tsx OUTSIDE PatientDeclarationGate (the existing platform
-- declaration + DPDP consent gate). The onboarding form itself records the
-- platform declaration acceptance as part of its own submit (reusing
-- usePatientDeclarationStatus() - the same hook/table PatientDeclarationGate
-- already reads), so by the time a new patient reaches that gate, only the
-- DPDP consent (untouched, not mentioned in this spec) is left to show, if
-- anything.
--
--   * profiles.onboarding_complete - the gate flag. Backfilled to true for
--     every existing patient who already has at least one family member (a
--     brand new column defaulting to false would otherwise force every
--     current user back through onboarding on their next login).
--   * family_members gains address/pincode/emergency_contact_name/
--     emergency_contact_phone - the fields the spec requires that didn't
--     already exist (name, dob, gender, email, blood_group, city, photo_path
--     all already did, from earlier migrations).
-- No new RLS is needed: profiles_update already lets a patient write their
-- own row, and family_insert/family_update already let them write their own
-- family_members rows - the same policies FamilyMemberForm.tsx and the
-- Profile screen's "Personal Details" panel already rely on.
-- ============================================================================

alter table profiles add column if not exists onboarding_complete boolean not null default false;

update profiles set onboarding_complete = true
where role = 'patient'
  and onboarding_complete = false
  and exists (select 1 from family_members where account_id = profiles.id);

-- Never gated for a clinic/admin account - App.tsx only ever renders
-- PatientOnboardingGate for the patient branch, but this keeps the column
-- honest for anyone who queries it directly (e.g. the admin console).
update profiles set onboarding_complete = true where role in ('clinic', 'admin') and onboarding_complete = false;

alter table family_members add column if not exists address text;
alter table family_members add column if not exists pincode text;
alter table family_members add column if not exists emergency_contact_name text;
alter table family_members add column if not exists emergency_contact_phone text;
