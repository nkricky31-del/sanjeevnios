-- ============================================================================
-- Test fixture: turns a second test login into an approved clinic with one
-- approved doctor and Mon-Fri 10:00-13:00 availability (12 patients/day).
-- There's no clinic sign-up screen yet (a future feature) - this is a stand-in
-- so the search & booking flow has something real to book against.
--
-- BEFORE running this:
-- 1. In Supabase Dashboard -> Authentication -> Providers -> Phone -> Test OTP,
--    add a SECOND pair: +919999999999 -> 654321 (must be different from the
--    patient's +917541985886, since each phone number is a separate account).
-- 2. In the app, log in once with +919999999999 / 654321, then log out.
--    That first login is what creates its profiles row - this script needs
--    that row to already exist.
-- 3. Then run this whole file in Supabase Dashboard -> SQL Editor -> Run.
-- Safe to re-run: it skips anything that already exists.
-- ============================================================================

-- Matched with "like '%9999999999'" (last 10 digits) instead of an exact "="
-- because Supabase sometimes stores auth.users.phone without the leading
-- "+91" - an exact match on '+919999999999' can silently find zero rows.
update profiles set role = 'clinic', name = 'Test Clinic Owner'
where phone like '%9999999999' and role <> 'clinic';

insert into clinics (owner_id, name, reg_no, address, status, is_active)
select p.id, 'Test Clinic', 'REG-TEST-001', '12 MG Road, Bengaluru', 'approved', true
from profiles p
where p.phone like '%9999999999'
  and not exists (select 1 from clinics c where c.owner_id = p.id);

insert into doctors (clinic_id, name, reg_no, specialty, status, consultation_fee)
select c.id, 'Dr. Test Doctor', 'DOC-TEST-001', 'General Physician', 'approved', 300
from clinics c
where c.name = 'Test Clinic'
  and not exists (select 1 from doctors d where d.clinic_id = c.id);

insert into doctor_availability (doctor_id, weekday, start_time, end_time, max_patients_per_day)
select d.id, w.weekday, '10:00', '13:00', 12
from doctors d
cross join (values (1), (2), (3), (4), (5)) as w(weekday) -- Monday-Friday
where d.name = 'Dr. Test Doctor'
  and not exists (
    select 1 from doctor_availability da where da.doctor_id = d.id and da.weekday = w.weekday
  );
