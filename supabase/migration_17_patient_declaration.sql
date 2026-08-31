
-- ============================================================================
-- 17. PATIENT DECLARATION + PLATFORM DISCLAIMER
-- ============================================================================
-- Records a patient's acceptance of the plain-English "Sanjeevni is a
-- booking platform, not a care provider" declaration - shown once at signup
-- (PatientDeclarationGate.tsx, wraps the whole patient app in App.tsx) and
-- again on their first booking confirmation (BookingForm.tsx). "Latest row
-- wins" for version currency, same pattern as consents: accepting a new
-- declaration_version later is a new row, not an update, so the acceptance
-- history is never destroyed.
create table if not exists patient_declarations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references profiles (id) on delete cascade,
  declaration_version text not null,
  accepted_at timestamptz not null default now(),
  ip text
);

alter table patient_declarations enable row level security;

drop policy if exists "patient_declarations_select" on patient_declarations;
create policy "patient_declarations_select" on patient_declarations for select
  using (patient_id = auth.uid() or public.is_admin());

drop policy if exists "patient_declarations_insert" on patient_declarations;
create policy "patient_declarations_insert" on patient_declarations for insert
  with check (patient_id = auth.uid());
-- No update/delete policy - an immutable acceptance record, same as consents.

-- Blocks booking at the DB level if the patient has never accepted any
-- version of the declaration - the hard version of the check
-- PatientDeclarationGate.tsx/BookingForm.tsx also do client-side. Checks
-- that a row EXISTS, not that it's the CURRENT version - "must be the
-- current version" stays a client-side/UX concern (re-prompted at signup
-- and at first booking on a version bump), the same tradeoff already made
-- for the doctor consent flow in enforce_doctor_submission_requirements().
--
-- Deliberately skipped for a clinic (or admin) creating the appointment:
-- walk-ins are booked BY the clinic on the patient's behalf, under a
-- family_members row owned by the CLINIC's own account (see
-- claim_walk_in_records() in section 9) - that's not a patient using the
-- self-service app, so the declaration doesn't apply there.
create or replace function public.enforce_patient_declaration_before_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_patient_id uuid;
  has_declaration boolean;
begin
  if public.is_own_clinic(new.clinic_id) or public.is_admin() then
    return new;
  end if;

  select account_id into booking_patient_id from family_members where id = new.member_id;
  select exists(
    select 1 from patient_declarations where patient_id = booking_patient_id
  ) into has_declaration;

  if not has_declaration then
    raise exception 'You must accept the platform declaration before booking.';
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_declaration_check on appointments;
create trigger on_appointment_declaration_check
  before insert on appointments
  for each row execute function public.enforce_patient_declaration_before_booking();
