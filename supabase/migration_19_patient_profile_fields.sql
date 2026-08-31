
-- ============================================================================
-- 19. PATIENT PROFILE WITH ENCOUNTER LIST
-- ============================================================================
-- Three more optional fields on family_members, needed for the patient
-- profile header (see PatientProfile.tsx). No new RLS needed - governed by
-- the same family_select/family_update policies as every other column on
-- this table.
alter table family_members add column if not exists email text;
alter table family_members add column if not exists blood_group text;
alter table family_members add column if not exists city text;
