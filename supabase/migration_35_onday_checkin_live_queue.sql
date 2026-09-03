-- ============================================================================
-- 35. ON-THE-DAY CHECK-IN: SCAN OR PATIENT ID, AND THE LIVE QUEUE
-- ============================================================================
-- The reception-desk screen for the day itself: scan the patient's QR (or
-- type their patient ID - their MRN, see section 18) and see, in one look,
-- who they are, their photo, their PRE-ASSIGNED number and time from the
-- night-before publish (section 34), and what's owed - before committing to
-- anything. Only pressing "Check in" actually does something.
--
-- Nothing about arrival order, no-idle, no-preemption or the grace window is
-- reimplemented here. Those rules already exist, already tested (see
-- TESTING.md "Test 7" and "Test 12"), and this migration deliberately reuses
-- them exactly as they stand:
--   * check_in_appointment() / check_in_with_qr()  (sections 27, 28, 30.6, 31)
--     are what actually marks a patient present and puts them on the live
--     board. This migration does not touch them.
--   * get_clinic_queue() / call_next_patient() / get_queue_status()
--     (section 31) are what serves the live board in order, skipping anyone
--     not checked in, never preempting, and applying the grace-period rule to
--     a late arrival. Also untouched.
--   * mark_paid_at_clinic() (section 30.4) is what the "Mark paid" button
--     calls. Also untouched.
--
-- What this migration adds is the piece in front of all of that: a single
-- read-only lookup that resolves "this QR" or "this patient ID" to the one
-- appointment it means, for TODAY at THIS clinic, and hands back everything
-- the scan card needs to show - without checking anyone in. The "sequence
-- number" a patient is quoted here is the one publish_day_schedule() (section
-- 34) already assigned the night before; it stays a distinct fact from
-- token_number by the same reasoning section 34.2 already gives - this is
-- what the desk shows as "your expected number" right up until the patient
-- is actually standing at the door, at which point checking them in is what
-- puts them on the live board, ordered by the existing fair-queue rule.
--
-- Also new: a patient photo, shown on the scan card so the desk can match
-- face to name at a glance. Stored the same way every other upload in this
-- app is - a private bucket, a path column, and a signed URL fetched on
-- demand.
--
-- See TESTING.md "Test 16".

-- ----------------------------------------------------------------------------
-- 35.1 Patient photo
-- ----------------------------------------------------------------------------
alter table family_members add column if not exists photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'patient-photos', 'patient-photos', false, 5242880,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Stored as "{member_id}/{random}-{filename}". Readable by the owning
-- account (to preview their own upload) and by any clinic that has an
-- appointment with this patient (so the check-in scan card can show it) -
-- the same "has this clinic ever seen this patient" reach get_clinic_queue()
-- already relies on via family_members. Writable only by the owning account.
drop policy if exists "patient_photos_select" on storage.objects;
create policy "patient_photos_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1]
        and (
          public.is_own_member(fm.id)
          or public.is_admin()
          or exists (
            select 1 from appointments a
            where a.member_id = fm.id and public.is_own_clinic(a.clinic_id)
          )
        )
    )
  );

drop policy if exists "patient_photos_insert" on storage.objects;
create policy "patient_photos_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1] and public.is_own_member(fm.id)
    )
  );

drop policy if exists "patient_photos_update" on storage.objects;
create policy "patient_photos_update" on storage.objects for update
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1] and public.is_own_member(fm.id)
    )
  );

drop policy if exists "patient_photos_delete" on storage.objects;
create policy "patient_photos_delete" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1] and public.is_own_member(fm.id)
    )
  );

-- ----------------------------------------------------------------------------
-- 35.2 lookup_checkin(): resolve a scan or a patient ID to today's
-- appointment, read-only
-- ----------------------------------------------------------------------------
-- Exactly one of p_qr_code / p_mrn is supplied by the caller. Raises rather
-- than returning an empty set, so the scan card can show one clear reason
-- ("not found", "not your clinic", "no appointment today") instead of a
-- silent blank.
--
-- The QR branch trusts verify_booking_qr() (section 28.2) for identity and
-- does not itself re-check the date - check_in_with_qr() still enforces the
-- arrival window when the desk actually presses "Check in", so scanning a
-- code for the wrong day surfaces as an error at that point, same as it
-- always has.
--
-- The patient-ID branch is scoped to TODAY in the CLINIC's own timezone
-- (same reasoning as check_in_appointment()'s date guard, section 27.7) and
-- to appointments actually live for the desk to act on: confirmed but not
-- yet arrived, marked no-show but possibly walking in anyway, or already on
-- the live board (so re-scanning/re-typing after check-in just shows the
-- same patient again rather than an error).
create or replace function public.lookup_checkin(
  p_clinic_id uuid,
  p_qr_code text default null,
  p_mrn text default null
)
returns table (
  appointment_id uuid,
  member_id uuid,
  patient_name text,
  photo_path text,
  mrn text,
  dob date,
  gender text,
  status text,
  already_checked_in boolean,
  token_number int,
  sequence_no int,
  estimated_time time,
  slot_time time,
  doctor_name text,
  payment_status text,
  amount_due numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_appt_id uuid;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  if p_qr_code is not null and trim(p_qr_code) <> '' then
    v_appt_id := public.verify_booking_qr(p_qr_code);
    if v_appt_id is null then
      raise exception 'This code is not valid or has expired. Ask the patient to refresh their screen.';
    end if;
  elsif p_mrn is not null and trim(p_mrn) <> '' then
    select a.id into v_appt_id
    from appointments a
    join family_members fm on fm.id = a.member_id
    where fm.mrn = trim(p_mrn)
      and a.clinic_id = p_clinic_id
      and a.date = v_today
      and a.status in ('accepted', 'no_show', 'checked_in', 'called', 'in_consultation')
    order by (a.status = 'accepted') desc, a.slot_time
    limit 1;
    if v_appt_id is null then
      raise exception 'No appointment found for patient ID "%" today at this clinic.', trim(p_mrn);
    end if;
  else
    raise exception 'Scan a QR code or enter a patient ID.';
  end if;

  if not exists (select 1 from appointments a where a.id = v_appt_id and a.clinic_id = p_clinic_id) then
    raise exception 'This booking is not at your clinic.';
  end if;

  return query
  select
    a.id, fm.id, fm.name, fm.photo_path, fm.mrn, fm.dob, fm.gender,
    a.status, (a.checked_in_at is not null), a.token_number,
    a.sequence_no, a.estimated_time, a.slot_time, d.name,
    a.payment_status, p.amount
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  left join payments p on p.appointment_id = a.id
  where a.id = v_appt_id;
end;
$$;
