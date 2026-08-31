
-- ============================================================================
-- 22. DPDP DATA-CONSENT CHECKBOX
-- ============================================================================
-- A second, separate consent - handling the patient's personal/health data
-- under the DPDP Act - reusing patient_declarations' shape (patient_id,
-- version, accepted_at, ip) rather than a parallel table, since it's the
-- exact same kind of record. `consent_type` is the only new thing:
-- 'platform_disclaimer' is the existing declaration from section 17,
-- 'dpdp_data_consent' is this one - each tracked, versioned, and re-prompted
-- on a wording change entirely independently of the other (see
-- usePatientConsent.ts). Existing rows default to 'platform_disclaimer' so
-- nothing already accepted needs to be re-accepted under the old type.
alter table patient_declarations add column if not exists consent_type text not null default 'platform_disclaimer';

-- Redeclared to also require the DPDP consent before a self-service booking,
-- same "hard version of the rule" reasoning as the platform declaration -
-- still skipped for a clinic/admin creating the appointment (walk-ins,
-- see section 17's version of this function for why).
create or replace function public.enforce_patient_declaration_before_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_patient_id uuid;
  has_platform_declaration boolean;
  has_dpdp_consent boolean;
begin
  if public.is_own_clinic(new.clinic_id) or public.is_admin() then
    return new;
  end if;

  select account_id into booking_patient_id from family_members where id = new.member_id;

  select
    exists(select 1 from patient_declarations where patient_id = booking_patient_id and consent_type = 'platform_disclaimer'),
    exists(select 1 from patient_declarations where patient_id = booking_patient_id and consent_type = 'dpdp_data_consent')
  into has_platform_declaration, has_dpdp_consent;

  if not has_platform_declaration then
    raise exception 'You must accept the platform declaration before booking.';
  end if;
  if not has_dpdp_consent then
    raise exception 'You must accept the data-sharing consent before booking.';
  end if;

  return new;
end;
$$;
