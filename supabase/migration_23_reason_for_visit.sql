
-- ============================================================================
-- 23. REASON FOR VISIT
-- ============================================================================
-- encounters.reason (section 18) has had no way to ever be populated -
-- nothing in the booking or walk-in flow captured it. Adding it to
-- appointments (optional, filled in by the patient/clinic at booking time)
-- and copying it onto the encounter at creation, same snapshot pattern as
-- department/visit_type already use.
alter table appointments add column if not exists reason text;

create or replace function public.create_encounter_for_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mrn text;
  v_department text;
  new_encounter_id uuid;
begin
  select mrn into v_mrn from family_members where id = new.member_id;
  select specialty into v_department from doctors where id = new.doctor_id;

  insert into encounters (encounter_no, mrn, patient_id, clinic_id, doctor_id, department, visit_datetime, reason)
  values (
    public.generate_encounter_no(),
    v_mrn,
    new.member_id,
    new.clinic_id,
    new.doctor_id,
    v_department,
    (new.date + new.slot_time)::timestamptz,
    new.reason
  )
  returning id into new_encounter_id;

  new.encounter_id := new_encounter_id;
  return new;
end;
$$;
