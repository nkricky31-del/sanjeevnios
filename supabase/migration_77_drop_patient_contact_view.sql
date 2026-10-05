-- 77. Drop the old SECURITY DEFINER view. Run ONLY after migration 76 is applied
-- AND the frontend that calls get_patient_contacts() is live (the old build reads
-- this view and would show blank patient names until it is replaced).
drop view if exists public.patient_contact;
