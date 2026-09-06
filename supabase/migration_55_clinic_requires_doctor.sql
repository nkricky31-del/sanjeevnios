-- ============================================================================
-- 55. CLINIC REGISTRATION MUST INCLUDE AT LEAST ONE DOCTOR
-- ============================================================================
-- Tightens the clinic submission gate from sections 45/48 - the draft ->
-- pending transition that drops a clinic into the admin's queue
-- (enforce_clinic_submission_requirements()) checked only the clinic's own
-- three documents. It never checked the clinic's map location, and never
-- checked that the clinic had added a single doctor - a clinic could reach
-- the admin queue, get approved, and go live with zero doctors on it (it
-- just wouldn't show up in search_doctors(), since that query joins through
-- doctors - a silent gap, not a hard block).
--
--   * enforce_clinic_submission_requirements() - rewritten to ALSO require
--     new.lat/new.lng to be set (the map-location pin from
--     ClinicLocationPicker.tsx) and at least one doctors row for this clinic
--     with status in ('pending', 'approved') - i.e. a doctor that has
--     itself already cleared enforce_doctor_submission_requirements()
--     (agreement signed + every required doctor document on file). This
--     deliberately does NOT re-check the doctor's document list here - that
--     would duplicate a rule that already lives in exactly one place, and
--     doctors.status can only reach 'pending' by having already satisfied
--     it. Same trigger, same "can't be bypassed by calling the API
--     directly" guarantee the existing document check already had.
--   * enforce_doctor_submission_requirements() - fixes a drift bug found
--     while wiring this up: src/lib/documentTypes.ts already marks
--     doctor_photo as `required: true` (added in section 45), but this
--     trigger's own required-type array never included it, so a doctor
--     could reach 'pending' with no photo on file. Added, closing the drift
--     between the two required-list copies noted in section 49's own
--     header.
--   * register_clinic_quick_start() (section 48) inserted a clinic DIRECTLY
--     at status = 'pending', which - because the trigger above only ever
--     fires on the draft -> pending UPDATE - completely bypassed both the
--     original document check and the two new ones here. That was an
--     intentional "lightest possible first step" design at the time, but it
--     directly contradicts this section's own requirement that a clinic
--     with zero doctors can never be submitted, even via the API: skipping
--     straight to 'pending' IS submitting it. Fixed by inserting at 'draft'
--     instead, same as register_clinic() - a quick-start clinic now finishes
--     onboarding (map location, remaining documents, at least one doctor)
--     and explicitly submits through the exact same gate as every other
--     clinic, via ClinicDoctors.tsx's "Send for verification" button. See
--     src/pages/ClinicSignup.tsx for the matching copy changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 55.1 enforce_doctor_submission_requirements() - add the missing doctor_photo
-- ----------------------------------------------------------------------------
create or replace function public.enforce_doctor_submission_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  has_consent boolean;
  missing_required int;
begin
  if new.status = 'pending' and old.status = 'draft' then
    select exists(select 1 from consents where doctor_id = new.id) into has_consent;
    if not has_consent then
      raise exception 'This doctor has not signed the onboarding agreement yet.';
    end if;

    select count(*) into missing_required
    from unnest(array[
      'government_id',
      'medical_registration_certificate',
      'degree_certificate',
      'doctor_clinic_association_proof',
      'doctor_photo'
    ]) as t(required_type)
    where not exists (
      select 1 from (
        select distinct on (doc_type) doc_type, status
        from documents
        where owner_type = 'doctor' and owner_id = new.id
        order by doc_type, created_at desc
      ) latest
      where latest.doc_type = t.required_type and latest.status <> 'rejected'
    );

    if missing_required > 0 then
      raise exception 'All required documents must be uploaded before submitting this doctor for review.';
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 55.2 enforce_clinic_submission_requirements() - add map location + the
-- at-least-one-ready-doctor check
-- ----------------------------------------------------------------------------
create or replace function public.enforce_clinic_submission_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  missing_required int;
  has_ready_doctor boolean;
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

    if new.lat is null or new.lng is null then
      raise exception 'Set the clinic''s map location before submitting for review.';
    end if;

    select exists(
      select 1 from doctors where clinic_id = new.id and status in ('pending', 'approved')
    ) into has_ready_doctor;

    if not has_ready_doctor then
      raise exception 'Add at least one doctor with all required documents submitted before submitting this clinic for review.';
    end if;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 55.3 register_clinic_quick_start() - starts at 'draft', not 'pending', so
-- it goes through the same gate above like every other clinic.
-- ----------------------------------------------------------------------------
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
  values (auth.uid(), trim(p_name), trim(p_reg_no), v_phone, 'draft', true)
  returning * into new_clinic;

  return new_clinic;
end;
$$;
