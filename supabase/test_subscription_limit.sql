-- ============================================================================
-- Step-by-step commands to test the Free-tier booking limit.
-- Run each numbered block ONE AT A TIME in Supabase SQL Editor, in order.
-- ============================================================================

-- 1) Find your test clinic's id. Copy the "id" value from the row you want
--    to test with - you'll paste it into step 2 below.
select id, name, status, is_active from clinics order by created_at desc;


-- 2) Paste the id from step 1 in place of PASTE_CLINIC_ID_HERE (keep the
--    quotes) and run this. Sets that clinic to Free plan, 49/50 bookings
--    used - one booking away from the limit.
insert into subscriptions (clinic_id, tier, bookings_used, period_start, period_end)
values ('PASTE_CLINIC_ID_HERE', 'free', 49, current_date, (current_date + interval '1 month')::date)
on conflict (clinic_id) do update set
  tier = 'free',
  bookings_used = 49,
  period_start = excluded.period_start,
  period_end = excluded.period_end;


-- 3) Now go to the app: refresh the clinic dashboard tab - you should see
--    an amber "nearing your Free plan limit: 49/50" banner.


-- 4) Make ONE more booking through the app (as a patient, or via the
--    clinic's own "+ Walk-in" button). It should succeed.


-- 5) Refresh the clinic dashboard again - banner should now be red,
--    "reached your Free plan limit."


-- 6) Try to make ANOTHER booking through the app. It should FAIL with:
--    "This clinic has reached its booking limit for this period.
--     Please try again later or contact the clinic."


-- 7) Confirm bookings_used stayed at 50 (the failed attempt wasn't
--    counted) - paste the same clinic id from step 1 here too.
select tier, bookings_used, period_start, period_end
from subscriptions
where clinic_id = 'PASTE_CLINIC_ID_HERE';


-- 8) To unblock it: in the app, log in as admin -> Subscriptions tab ->
--    change that clinic's plan to Pro or Premium. Then try booking again
--    through the app - it should succeed immediately, no other change needed.


-- 9) Separately, test is_active: in the admin Subscriptions tab, click
--    "Deactivate" on any clinic, then try booking it through the app - it
--    should fail immediately with "This clinic isn't currently accepting
--    bookings." regardless of tier/usage. Click "Activate" again to confirm
--    bookings resume.
