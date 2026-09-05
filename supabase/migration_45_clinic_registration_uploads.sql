-- ============================================================================
-- 45. CLINIC REGISTRATION WITH UPLOADS
-- ============================================================================
-- Wires the existing documents/agreement infrastructure (sections 14, and
-- the doctor-onboarding-gate added alongside section 15's map location work)
-- into the CLINIC's own registration, exactly mirroring the pattern a doctor
-- already goes through - not a new, parallel system:
--
--   * clinics.status gains 'draft', the same way doctors.status did:
--     register_clinic() now creates a clinic as 'draft' (invisible to
--     admin/search, same as 'pending' already was to patients) instead of
--     immediately 'pending'. A clinic reaches the admin's queue only once it
--     explicitly submits - see ClinicOnboardingScreen.tsx - mirroring
--     DoctorOnboardingScreen.tsx exactly. Existing clinics are untouched:
--     they're already 'pending' or later, never retroactively 'draft'.
--   * enforce_clinic_submission_requirements() is the hard version of that
--     gate (draft -> pending blocked unless every required clinic document
--     has an on-file, non-rejected upload), exactly mirroring
--     enforce_doctor_submission_requirements() - a client-side check can be
--     bypassed by calling the API directly, this can't.
--   * clinics.contact_phone - the "contact" field the registration form now
--     also collects, alongside name/reg_no/address (map location was
--     already collected separately via ClinicLocationPicker.tsx - section
--     15 - now surfaced as part of the same onboarding flow instead of a
--     disconnected dashboard tab).
--   * Two new clinic document types (clinic_address_proof, clinic_license)
--     and one new doctor one (doctor_photo) in src/lib/documentTypes.ts -
--     AdminDocumentReview.tsx and DocumentChecklist.tsx need zero changes
--     for this, since both already render entirely from that list.
--
-- Deliberately NOT combined into one gate: a clinic's own submission and
-- each doctor's submission stay independent, exactly as they already were
-- for doctors-vs-each-other (each doctor already has its own draft/pending
-- lifecycle, reviewed independently by admin) - "the agreement" the spec's
-- combined sentence refers to is the per-doctor one (consents.doctor_id),
-- since a clinic itself signs nothing. Testing this therefore means
-- submitting the clinic AND its doctor as two related but separate steps -
-- see TESTING.md.
-- ============================================================================

alter table clinics add column if not exists contact_phone text;

alter table clinics alter column status set default 'draft';
alter table clinics drop constraint if exists clinics_status_check;
alter table clinics add constraint clinics_status_check
  check (status in ('draft', 'pending', 'approved', 'rejected'));

-- Mirrors doctors_update's own fix exactly: the owning clinic may only move
-- itself between draft and pending - approved/rejected stays admin-only.
drop policy if exists "clinics_update" on clinics;
create policy "clinics_update" on clinics for update
  using (owner_id = auth.uid() or public.is_admin())
  with check (
    public.is_admin()
    or (owner_id = auth.uid() and status in ('draft', 'pending'))
  );

-- The required-doc-type list here must be kept in sync with the `required:
-- true` entries for ownerType 'clinic' in src/lib/documentTypes.ts.
create or replace function public.enforce_clinic_submission_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  missing_required int;
begin
  if new.status = 'pending' and old.status = 'draft' then
    select count(*) into missing_required
    from unnest(array[
      'clinic_registration_certificate',
      'clinic_address_proof',
      'clinic_license'
    ]) as t(required_type)
    where not exists (
      select 1 from (
        select distinct on (doc_type) doc_type, status
        from documents
        where owner_type = 'clinic' and owner_id = new.id
        order by doc_type, created_at desc
      ) latest
      where latest.doc_type = t.required_type and latest.status <> 'rejected'
    );

    if missing_required > 0 then
      raise exception 'All required documents must be uploaded before submitting this clinic for review.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_clinic_submit_check on clinics;
create trigger on_clinic_submit_check
  before update on clinics
  for each row
  execute function public.enforce_clinic_submission_requirements();

-- register_clinic() now starts a clinic at 'draft' (not 'pending') and takes
-- a contact phone number. p_contact_phone is optional at the RPC level (the
-- registration FORM enforces it as required, same "DB permissive, UI
-- enforces required" split already used for name/address elsewhere in this
-- function).
--
-- A trailing parameter with a default is allowed by CREATE OR REPLACE, but
-- Postgres still treats the old 3-argument signature as a DIFFERENT
-- overload rather than something this replaces - both would otherwise stay
-- callable side by side, and the stale 3-arg one still creates a clinic as
-- 'pending' with no contact_phone, silently defeating this whole migration
-- for any caller that happens to invoke it. Drop it explicitly first.
drop function if exists public.register_clinic(text, text, text);

create or replace function public.register_clinic(p_name text, p_reg_no text, p_address text, p_contact_phone text default null)
returns clinics
language plpgsql
as $$
declare
  new_clinic clinics;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to register a clinic.';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Clinic name is required.';
  end if;

  if exists (select 1 from clinics where owner_id = auth.uid()) then
    raise exception 'This account already has a registered clinic.';
  end if;

  update profiles set role = 'clinic' where id = auth.uid() and role = 'patient';

  insert into clinics (owner_id, name, reg_no, address, contact_phone, status, is_active)
  values (
    auth.uid(),
    trim(p_name),
    nullif(trim(coalesce(p_reg_no, '')), ''),
    nullif(trim(coalesce(p_address, '')), ''),
    nullif(trim(coalesce(p_contact_phone, '')), ''),
    'draft',
    true
  )
  returning * into new_clinic;

  return new_clinic;
end;
$$;
