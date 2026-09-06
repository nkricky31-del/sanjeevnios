-- ============================================================================
-- 48. QUICK-START CLINIC REGISTRATION
-- ============================================================================
-- Section 45 gave a clinic a two-stage signup: register_clinic() creates a
-- 'draft', then the clinic has to fill in map location + THREE required
-- documents (clinic_registration_certificate, clinic_address_proof,
-- clinic_license) before it can even flip itself to 'pending' and join the
-- admin's queue (see enforce_clinic_submission_requirements()). That's the
-- right bar for a clinic that's fully setting itself up in one sitting, but
-- it's a lot to ask before a clinic has been seen by anyone at all.
--
-- register_clinic_quick_start() is a SECOND, LIGHTER path onto the exact
-- same clinics/documents tables - not a parallel system:
--   * Collects only name + registration number (no address, no separately-
--     typed contact phone - the account's own OTP-verified profiles.phone
--     is used as the contact number, since that's who the admin/patients
--     would actually be reaching).
--   * Inserts the clinic DIRECTLY at status = 'pending', skipping 'draft'
--     entirely - enforce_clinic_submission_requirements() only ever fires
--     on an UPDATE (old.status='draft' -> new.status='pending'), so an
--     INSERT straight at 'pending' never touches that gate. The client
--     (ClinicSignup.tsx) is expected to upload exactly one document -
--     clinic_registration_certificate, via the same uploadVerificationDocument()
--     path DocumentChecklist.tsx already uses - immediately after this
--     returns, but nothing here requires that to have happened first: a
--     'pending' clinic with zero documents rows already renders and can
--     already be approved in AdminConsole.tsx today (verified against the
--     current admin queue query - it has no document-count check, only a
--     check for an unresolved REJECTION, which an empty document list can
--     never have).
--   * clinics_insert/update RLS (section 45) and the clinics_status_check
--     constraint already allow this - 'pending' is already a valid value,
--     and clinics_insert only ever required owner_id = auth.uid(). Nothing
--     else changes.
--   * The Part 30 patient-visibility gate (search_doctors(), clinics_select,
--     doctors_select - all requiring status = 'approved' AND is_active) is
--     completely untouched: a quick-start clinic is just as invisible to
--     patients at 'pending' as a fully-onboarded one ever was.
--   * The clinic can still open the Doctors tab (ClinicOnboardingScreen.tsx)
--     at any time afterwards to add its map location, its doctors, and the
--     two remaining documents - that screen already renders regardless of
--     clinics.status, and its "Submit for review" button (which only makes
--     sense for a 'draft' clinic) simply never appears for a clinic that
--     took this path, since it's already 'pending'.
-- ============================================================================

create or replace function public.register_clinic_quick_start(
  p_name text,
  p_reg_no text
)
returns clinics
language plpgsql
as $$
declare
  new_clinic clinics;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to register a clinic.';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Clinic name is required.';
  end if;
  if trim(coalesce(p_reg_no, '')) = '' then
    raise exception 'Clinic registration number is required.';
  end if;

  if exists (select 1 from clinics where owner_id = auth.uid()) then
    raise exception 'This account already has a registered clinic.';
  end if;

  select phone into v_phone from profiles where id = auth.uid();

  update profiles set role = 'clinic' where id = auth.uid() and role = 'patient';

  insert into clinics (owner_id, name, reg_no, contact_phone, status, is_active)
  values (auth.uid(), trim(p_name), trim(p_reg_no), v_phone, 'pending', true)
  returning * into new_clinic;

  return new_clinic;
end;
$$;
