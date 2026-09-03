# Testing: MRN cross-row fix, DPDP consent, notifications + reason for visit, known conditions, walk-in fixes, arrival check-in

Covers fifteen fixes/features built together:

1. MRN cross-row read gap (appointments/visits/prescriptions/files RLS)
2. DPDP data-consent checkbox
3. Notifications list page + reason-for-visit field
4. Known conditions (patient-declared health conditions)
5. Walk-in registration fixes: error surfacing, duplicate-patient linking, future-appointment calendar, clinic holidays
6. Queue positions (superseded by 7): the interim model that recomputed a position from slot time
7. Arrival check-in + live token: no token until the patient arrives; issued in arrival order, per clinic, per day
8. Clinic check-in screen: QR scan + manual "mark arrived", live waiting list, and the waiting-room token board
9. Patient arrival QR: signed, short-lived booking code, live token after check-in, and optional self check-in
10. Late arrivals, no-shows (manual + auto at a clinic-set cut-off), skipping, and live queue updates
11. Fair queue data: payment and presence stored as separate facts; paying online buys no priority
12. Fair queue order rule: slot time for punctual arrivals, real arrival time for the very late; computed server-side
13. Online payment rewarded with convenience only: fast check-in, auto-confirmed slot, easier rescheduling - never queue position
14. Appointment-only clinic mode: advance booking within a horizon, a race-safe daily cap, auto-confirm, and a waitlist
15. Publish the day schedule: the night-before batch that gives every booked patient a sequence number, an estimated time and a notification - without checking anyone in

## Setup (do this first)

Run these fourteen files, **in order**, in the Supabase SQL Editor:

1. `supabase/migration_21_mrn_cross_row_read_fix.sql`
2. `supabase/migration_22_dpdp_consent.sql`
3. `supabase/migration_23_reason_for_visit.sql`
4. `supabase/migration_24_known_conditions.sql`
5. `supabase/migration_25_walkin_fixes.sql`
6. `supabase/migration_26_queue_positions.sql`
7. `supabase/migration_27_arrival_checkin.sql`
8. `supabase/migration_28_signed_qr_self_checkin.sql`
9. `supabase/migration_29_late_noshow_live.sql`
10. `supabase/migration_30_fair_queue_data.sql`
11. `supabase/migration_31_fair_queue_order.sql`
12. `supabase/migration_32_online_payment_perks.sql`
13. `supabase/migration_33_advance_only_booking.sql`
14. `supabase/migration_34_publish_day_schedule.sql`

Each should run with no red errors. Then open `http://localhost:5173/`.

## Test 1 — MRN cross-row read gap

This one needs a patient whose MRN spans **two different `family_members` rows** — the scenario from the MRN feature (same phone number walk-in-registered at two different clinics).

1. **As Clinic A**, register a walk-in with a phone number, e.g. `9876543210` — note the patient's name and the MRN shown in the confirmation.
2. **As Clinic B** (a different clinic), register a walk-in with the **same phone number** `9876543210`. It should get the **same MRN** as step 1 (confirms the dedup still works).
3. In Supabase, find the two separate `family_members` rows sharing that MRN:
   ```sql
   select id, name, account_id, mrn from family_members where mrn = '<the shared MRN>';
   ```
   You'll see two rows with different `id` and different `account_id` (each owned by its clinic).
4. **Log in as the patient** using that same phone number (`+919876543210`) via normal OTP login. This triggers `claim_walk_in_records()`, which re-parents *matching-phone* rows — but only if the phone matches exactly; if you used slightly different clinic-side data it may not re-parent both, which is fine — we want at least one row NOT owned by this login for the test to be meaningful. If both got re-parented, skip re-parenting by using a govt-ID-only match instead (register the second walk-in with a different phone but the same Government ID as the first).
5. Go to **Profile -> tap the MRN** -> you land on the patient profile with the encounters table. You should see **both** encounters (Clinic A and Clinic B) — confirms the earlier encounters-level fix still works.
6. Click the eye icon on the encounter tied to the row you *don't* directly own (the one still owned by the other clinic's account) -> open `EncounterDetail`. **Before this fix**, the visit's notes/diagnosis/prescription/files section would show "No linked visit record found" even if the clinic had actually completed the visit. **After this fix**, if that clinic recorded a diagnosis/prescription for that visit, it should now show up correctly.

If you don't want to set up the two-row scenario, a simpler sanity check: as any patient with a normal single-row MRN, confirm everything still works exactly as before (nothing should have broken for the common case).

## Test 2 — DPDP data-consent checkbox

1. Log out, then sign up with a **brand-new phone number** (one that's never used this app before).
2. On first login, you should see the "Before you continue" screen with **two separate sections**, each with its own checkbox:
   - "Platform declaration" (the existing one)
   - "Data-sharing consent" (new — DPDP text)
3. Try clicking "Accept and continue" with only one box checked — it should show an error and not proceed.
4. Check both boxes, click "Accept and continue" — you should land in the app normally.
5. Verify in Supabase:
   ```sql
   select consent_type, declaration_version, accepted_at from patient_declarations
   where patient_id = '<this patient''s auth user id>' order by accepted_at;
   ```
   You should see **two rows** — one `platform_disclaimer`, one `dpdp_data_consent`.
6. Now test the booking-screen fallback: delete one of those two rows (e.g. the DPDP one) directly in Supabase, then try to book an appointment. The booking screen should show just the "Data-sharing consent" checkbox (not the platform one, since that's still accepted) and block Confirm until it's checked.
7. To confirm the DB-level hard block: try inserting an appointment directly via SQL for a patient with neither consent recorded — it should fail with `You must accept the data-sharing consent before booking.` (or the platform one, whichever it hits first).

## Test 3 — Notifications list + reason for visit

### Reason for visit

1. Book a new appointment as a patient, and type something into the new "Reason for visit" field (e.g. "Fever and cough").
2. After booking, go to that encounter's detail page (`BookingStatus` -> the visit, or via `PatientProfile` -> eye icon) — under "Reason" you should now see your typed text instead of "—".
3. Try the same thing via a clinic's Walk-in form (the "+ Walk-in" button in the Queue tab) — same result.

### Notifications list

1. As any role (patient/clinic/admin) with at least one existing notification (e.g. a clinic that's been approved/rejected before, or a patient who's had a booking accepted), look at the bell icon in the top-right of any page — if there's an unread notification, you should see a small amber dot on it.
2. Click the bell — you should land on `/notifications`, showing your full notification history, newest first, unread ones highlighted (bold, light blue background, with a dot).
3. Tap one — it should un-highlight (marked read) immediately, and if you're a patient and it's linked to a booking, it should also jump you to that booking's status page.
4. If there's more than one unread, click "Mark all as read" at the top — all should un-highlight at once.
5. Refresh the page — the read state should persist (confirms it actually wrote to the DB, not just local state). Go back to any other page — the bell's amber dot should now be gone.
6. Repeat steps 1-2 logged in as a **different role** (e.g. admin) — confirms the same `/notifications` page works for everyone, showing only that account's own notifications.

## Test 4 — Known conditions

### How to test

1. Make sure `supabase/migration_24_known_conditions.sql` has been run (see Setup above) — skip if building fresh from `schema.sql`, it's already merged in there.
2. `cd sanjeevnios-web && npm run dev`, then open the printed URL (normally `http://localhost:5173/`).
3. Log in as a patient using a Supabase Test OTP number (Dashboard → Authentication → Providers → Phone → Test OTP — add a phone number with a fixed OTP code there if you haven't already, so you can log in without real SMS).
4. Follow steps 1-11 below (short version: save Diabetes + Hypertension for one family member, "no known conditions" for another, then verify both in the UI and via SQL).

### Steps

1. **As a patient**, go to **Profile**. You should have at least two family members listed (add a second with "+ Add profile" if you only have one — e.g. yourself as "Self" and one more as "Child"/"Spouse"/etc).
2. Under the **first** family member, tap **"Health info"**. The `KnownConditionsForm` should appear below the grid, defaulted to "Not answered".
3. Click **"Yes, has known condition(s)"** — a checkbox grid of conditions appears (Diabetes, Hypertension (high BP), Asthma/respiratory, Thyroid, Heart disease, Liver disease, Kidney disease, Cancer, Epilepsy, Mental-health, Pregnancy (current)).
4. Check **Diabetes** and **Hypertension (high BP)**, leave "Other" blank, click **Save**. You should see "Saved." and, after it reloads, "Last updated \<just now\>." in the helper text.
5. Tap **"Hide health info"**, then tap **"Health info"** under the **second** family member. Click **"No known conditions"**, then **Save** — confirms the 3-state answer is per-person, not shared.
6. Refresh the whole page (hard reload). Reopen "Health info" on both — the first should still show "Yes" with Diabetes + Hypertension checked, the second should still show "No" — confirms it persisted, not just local state.
7. Verify in Supabase:
   ```sql
   select fm.name, fm.has_known_conditions, fm.known_conditions_other, fm.conditions_updated_at,
          array_agg(cr.name) filter (where cr.name is not null) as conditions
   from family_members fm
   left join patient_conditions pc on pc.patient_id = fm.id
   left join conditions_ref cr on cr.id = pc.condition_id
   where fm.id in ('<first family member id>', '<second family member id>')
   group by fm.id, fm.name, fm.has_known_conditions, fm.known_conditions_other, fm.conditions_updated_at;
   ```
   The first row should show `has_known_conditions = 'yes'` and `conditions = {Diabetes, "Hypertension (high BP)"}`; the second should show `has_known_conditions = 'no'` and `conditions = {}`.
8. Confirm the audit log picked both up:
   ```sql
   select action, target, at from audit_log
   where action in ('update_known_conditions', 'add_patient_condition', 'remove_patient_condition')
   order by at desc limit 10;
   ```
   You should see `update_known_conditions` for both family members, plus `add_patient_condition` rows for Diabetes and Hypertension.
9. **As a clinic that has an appointment/encounter with the "yes" family member**, open that patient's profile (Search or Queue -> patient -> MRN). Under the header you should see **"Known conditions: Yes"** with **Diabetes** and **Hypertension (high BP)** pills — read-only (no form, no way to edit). Open the "no" family member's profile the same way — it should show **"Known conditions: No known conditions"** with no pills.
10. **As a clinic with no appointment history for either patient**, searching them up should not surface the conditions at all (RLS blocks the read) — confirms Part 40 access is scoped to clinics that have actually seen the patient.
11. **As admin**, go to **Admin console -> Conditions** tab. You should see the full catalog with Active/Inactive toggles. Add a new condition (e.g. "Osteoporosis"), confirm it appears, then go back to a patient's "Health info" form as that patient — it should now show up in the checkbox grid. Deactivate it from the admin tab — it should disappear from the patient's form on next load, but a patient who'd already selected it keeps that selection (deactivating hides it from new picks, it doesn't retroactively remove existing rows).

## Test 5 — Walk-in fixes

### How to test

1. Make sure `supabase/migration_25_walkin_fixes.sql` has been run (see Setup above).
2. `cd sanjeevnios-web && npm run dev`, open the printed URL.
3. Log in as at least two different clinics (Test OTP numbers - Dashboard → Authentication → Providers → Phone → Test OTP) and one patient, in separate browser profiles/incognito windows so you can be logged in as more than one role at once.
4. Short version: register a walk-in with a phone number at one clinic, register the same phone at a second clinic and confirm it links instead of duplicating, then try the future-appointment checkbox in the walk-in form. Full steps below.

### Error surfacing (issue 1)

1. **As a clinic**, Queue tab -> "+ Walk-in", fill in a name + doctor, leave phone blank, submit. It should succeed normally (unchanged happy path).
2. To see the new failure handling: temporarily set `VITE_SUPABASE_URL` in `.env.local` to a wrong/unreachable URL, restart `npm run dev`, and submit a walk-in. **Before this fix**, the button would say "Adding..." forever with no error. **After this fix**, it should show a red "Unexpected error: ..." message and re-enable the button. Revert `.env.local` afterward.
3. Submit a walk-in with a doctor whose clinic is over its free-tier booking limit (50/period) if you have one set up — you should get a clear red error, not a silent nothing.

### Duplicate-patient linking + phone normalization (issue 2)

1. **As Clinic A**, register a walk-in with phone `9876543210`, name "Test Patient". Note the MRN shown.
2. **As Clinic B** (a different clinic), register a walk-in with the **same phone** `9876543210` but a different/misspelled name. The confirmation should say **"Matched to an existing patient record - no duplicate created"** and show the **same MRN** as step 1.
3. Verify in Supabase there's only **one** `family_members` row for that phone:
   ```sql
   select id, name, account_id, mrn from family_members where phone = '919876543210';
   ```
   Should return exactly one row, with two `appointments` rows (one per clinic) pointing at its `id`.
4. **Log in as the patient** using `+919876543210` via OTP. `claim_walk_in_records()` runs automatically — go to Profile -> tap the MRN -> you should see **both** clinics' visits under one profile.
5. Paste-truncation check: in the walk-in phone field, paste `+91 98765 43210` (with the plus and spaces) directly instead of typing — it should resolve to `9876543210`, not get mangled. Repeat on the Login screen's phone field and `FamilyMemberForm`.
6. If `claim_walk_in_records()` ever fails to link (e.g. a phone mismatch from data entered before this fix), it now logs `claim_walk_in_records failed: ...` to the browser console on login instead of failing completely silently — check DevTools console if a patient reports missing history.

### Future-appointment calendar (issue 3)

1. **As a clinic**, "+ Walk-in", fill in the patient's details, then check **"Also book a future appointment for this patient"**. A day-strip + slot grid should appear (same style as the patient-facing doctor page).
2. Pick a day 3+ days out and a slot — submit. The confirmation should show today's **booking reference + queue position**, and a separate **"Future appointment booked for \<date\> at \<time\> — ref \<ref\>, position #\<n\>"**.
3. Verify two `appointments` rows exist for that member: one for today (status `accepted`, `patient_type = 'walk_in'`), one for the future date (status `accepted`, `patient_type = 'scheduled'`, its own position numbering starting fresh for that date).
4. Leave the checkbox unchecked and submit a normal walk-in — confirms "register only" still works with no future booking forced.
5. Check the checkbox but don't pick a date/slot, then submit — should show "Pick a date and time for the future appointment..." and not submit anything.
6. **Holidays**: in the Queue tab, click "Holidays", add a date a few days out with a reason (e.g. "Festival"). Reopen the walk-in form's future-booking calendar (and the patient-facing `DoctorPage` for the same doctor) — that date should be greyed out/unselectable in both places.

## Test 6 — Queue positions

### How to test

1. Make sure `supabase/migration_26_queue_positions.sql` has been run (see Setup above) — this depends on migration 25 having run first.
2. `cd sanjeevnios-web && npm run dev`, open the printed URL.
3. Set up one doctor with hourly slots (see Setup below), then book 2 PM, 4 PM, 1 PM in that order as a patient, and accept them in that same order as the clinic — positions should come out 1/2/3 by time, not by booking order. That's the core fix; scenarios B-D below cover the rest (mid-day walk-in, late arrival, concurrency).

### Setup

Give one doctor hourly slots so the ordering is easy to eyeball: **Doctors tab -> that doctor -> Availability**, set today's weekday to **13:00–17:00** with **max patients/day = 4** (produces slots at 1 PM, 2 PM, 3 PM, 4 PM).

### Scenario A — 2 PM booked first, then 4 PM, then 1 PM

1. As a patient (any family member, can be the same one 3 times), book **2 PM** for today.
2. Book **4 PM** for today.
3. Book **1 PM** for today.
4. **As the clinic**, go to the Pending approval inbox and **Accept all three, in any order** (e.g. accept 2 PM first, then 4 PM, then 1 PM — the exact bug scenario from the brief).
5. Open the Queue tab for today. Positions should read **1 PM = #1, 2 PM = #2, 4 PM = #3** — booking/acceptance order no longer matters, only slot time does. (Before this fix, accepting in that order would have given 2 PM=#1, 4 PM=#2, 1 PM=#3 - the exact bug.)
6. Verify in Supabase:
   ```sql
   select slot_time, token_no from appointments
   where doctor_id = '<doctor id>' and date = current_date and status = 'accepted'
   order by token_no;
   ```

### Scenario B — a walk-in added mid-day

1. With the three bookings above still active, **as the clinic**, add a walk-in ("+ Walk-in") for the same doctor right now (assume it's currently between 2 PM and 4 PM, e.g. 2:30 PM real time - adjust the scenario to whatever time you're actually testing at).
2. The walk-in should land in the queue **between the 2 PM and 4 PM patients** (its check-in time is "now", which sorts after 2 PM's held slot-time position and before 4 PM's), not appended to the very end.
3. Verify positions shifted correctly: the walk-in got inserted, 4 PM's position number increased by one, 1 PM/2 PM unaffected.

### Scenario C — a late arrival past the grace period

1. Pick the 1 PM booking from Scenario A (still `accepted`, not checked in).
2. Simulate it being well past its slot without check-in by backdating it in SQL (don't wait 15 real minutes):
   ```sql
   update appointments set slot_time = (now() - interval '20 minutes')::time
   where doctor_id = '<doctor id>' and date = current_date and slot_time = '13:00:00';
   ```
   This UPDATE itself fires the recompute trigger (new.status is still 'accepted'), so positions recalculate immediately.
3. Reload the Queue tab: the 1 PM patient should have dropped to the **back** of the active queue (behind the 2 PM/4 PM/walk-in, all of whom are within their own grace or already checked in) — not still holding position #1.
4. Now click **"Check in"** on that same patient's row. Their position should immediately move to wherever "arriving right now" places them (typically right at/near the back, same spot, since check-in time is still "now") — confirming the "next available position behind checked-in patients" rule, not a return to their original #1.
5. Verify: `select slot_time, checked_in_at, token_no from appointments where id = '<that appointment id>';` — `checked_in_at` should be set, `token_no` should reflect the back-of-queue position.

### Scenario D — two simultaneous bookings for the same slot

1. Structural check first — confirm no two active appointments for the same doctor/date ever share a position:
   ```sql
   select doctor_id, date, token_no, count(*)
   from appointments
   where status in ('accepted', 'in_progress')
   group by doctor_id, date, token_no
   having count(*) > 1;
   ```
   Should always return zero rows (the partial unique index `appointments_active_token_unique` makes this a hard DB constraint, not just app discipline).
2. For a genuine concurrency test: open two browser tabs as two different patients, both select the **same** open slot on `DoctorPage`, and submit within a second of each other. One should succeed; the other should fail on `appointments`' existing slot-uniqueness behavior (a doctor/date/slot combo already taken shows up in `get_taken_slots` - if both somehow raced before either committed, the second acceptance will still get a distinct position from `recompute_queue_positions`'s advisory-locked recompute, never a duplicate one, and the check in step 1 will still pass afterward).
3. To specifically stress the recompute's locking rather than the slot-taken check: as the clinic, accept two *different* pending bookings for the same doctor/date in as close succession as you can manage (two clicks, one right after the other) and re-run the query in step 1 - still zero duplicates.

## Test 7 — Arrival check-in + live token

### How to test

1. Make sure `supabase/migration_27_arrival_checkin.sql` has been run (see Setup above). It supersedes section 26: token numbers are no longer recomputed positions, they're issued once, at the door, in arrival order.
2. `cd sanjeevnios-web && npm run dev`, open the printed URL.
3. Give the doctor availability that covers **now** (Doctors tab -> Availability -> today's weekday, a window containing the current time). Check-in only opens 60 minutes before a slot, so a slot in that window is what makes this testable.
4. Short version: book for today, accept it, check in — a token appears. Check a second person in — they get the next number.

### The main path

1. **As a patient**, book an appointment with that doctor **for today**, at a slot close to the current time. On the booking's status page you should see **"Your Token Number — — "** with "You'll get your token when you check in at the clinic." No number yet: that's the whole point.
2. **As the clinic**, Queue tab -> **Pending approval** -> **Accept**. The patient's booking moves into **Expected**, still with no token (the badge shows "—"). The patient gets a notification saying they'll receive their token on arrival.
3. Still on the clinic's Queue tab, in **Expected**, press **Check in**. You should see a green line: *"Checked in \<name\> — token #1."* The row moves out of Expected and into **Live queue** carrying token **1**.
4. Reload the patient's booking page — the big number is now **1**, with "Checked in at \<time\>", people-ahead and estimated-wait tiles.
5. Verify in Supabase:
   ```sql
   select token_number, arrival_seq, token_date, status, check_in_method, checked_in_at
   from appointments where id = '<appointment id>';
   ```
   `status` = `checked_in`, `token_number` = `arrival_seq` = 1, `token_date` = today, `check_in_method` = `manual`.

### Arrival order — the second person gets the next number

1. Book and accept a **second** appointment for today at the same clinic (same doctor is fine, or a different one — tokens are per **clinic** per day, not per doctor).
2. Check that second patient in. They should get token **2**, regardless of whose booked slot was earlier.
3. To prove arrival order beats booking order, do it with the slots reversed: give patient A the **later** slot and patient B the **earlier** one, then check **A** in first. A gets #1, B gets #2 — the person who showed up first is served first.
4. Confirm the counter agrees:
   ```sql
   select * from clinic_token_counters where clinic_id = '<clinic id>' and token_date = current_date;
   ```
   `last_seq` should equal the highest token issued today.

### Guardrails

1. **Double check-in**: press **Check in** twice on the same patient (or have the patient's row re-scanned). The second press must NOT issue a new number — it reports *"...is already checked in — token #N"* with the same N, and `clinic_token_counters.last_seq` does not move.
2. **Not accepted yet**: try checking in a booking still sitting in **Pending approval** (call the RPC directly, since the button only appears in Expected):
   ```sql
   select * from public.check_in_appointment('<a booked appointment id>', 'manual');
   ```
   Should fail with *"Only an accepted appointment can be checked in..."*.
3. **Wrong day**: accept an appointment for **tomorrow**. Its row in Expected shows the Check in button disabled with "Check-in is only possible on the day of the appointment." Calling the RPC directly should fail with *"This appointment is for ..., not today."*
4. **Too early**: accept a booking for today at a slot more than 60 minutes away, then call the RPC directly. Should fail with *"Too early - check-in opens 60 minutes before the ... slot."*
5. **Too late**: take a today booking whose slot has passed, and push it further back so it's outside the grace window:
   ```sql
   update appointments set slot_time = (now() at time zone 'Asia/Kolkata')::time - interval '3 hours'
   where id = '<appointment id>';
   ```
   Check-in should fail with *"Too late - check-in for the ... slot closed N minutes after it ended."* Widen the window by raising the clinic's grace period and confirm it then succeeds:
   ```sql
   update clinics set checkin_grace_minutes = 240 where id = '<clinic id>';
   ```

### Walk-ins and the rest of the lifecycle

1. **Walk-in**: Queue tab -> "+ Walk-in" -> register someone. Because a walk-in is by definition standing at the desk, it books, accepts and checks in in one go — the confirmation shows their token in large type, and it's the next number in the day's arrival order.
2. **Call next**: press **Call next**. It calls the **lowest token still waiting**, moves them to `called`, and notifies the patient ("Token #N is being called now"). The patient's page switches to "It's your turn — please go in."
3. **Start consultation** on that row -> `in_consultation`. **Complete visit** -> `completed` (still gated on a prescription being attached, or "no prescription needed" being ticked in the visit screen).
4. Confirm the whole lifecycle landed:
   ```sql
   select status, token_number, checked_in_at from appointments
   where clinic_id = '<clinic id>' and date = current_date order by token_number;
   ```

### Concurrency

Two receptionists checking in at the same instant must never share a number. The counter row is locked by `INSERT ... ON CONFLICT DO UPDATE`, so they serialise. To sanity-check that no duplicates exist:
```sql
select clinic_id, token_date, token_number, count(*)
from appointments
where token_number is not null
group by clinic_id, token_date, token_number
having count(*) > 1;
```
Should always return zero rows — `appointments_clinic_token_unique` makes it a hard DB constraint, not just app discipline.

## Test 8 — Clinic check-in screen (scan + manual) and the token board

No new migration for this one — it's the UI on top of Test 7's
`check_in_appointment()`. Make sure migration 27 has been run.

### Setup

1. `npm run dev`, and give the doctor availability that **covers right now** (Doctors → Availability → today's weekday). Check-in opens 60 minutes before a slot, so the slot has to be near the current time.
2. Two browser profiles (or one normal + one incognito) so you can be the **patient** and the **clinic** at the same time.
3. For the scan test, the clinic browser needs a camera and needs to be on `localhost` or `https` — browsers refuse `getUserMedia` on a plain-http origin that isn't localhost. If you're testing over the network, use the manual path instead.

### A. Mark arrived (works everywhere, no camera needed)

1. **As a patient**, book with that doctor **for today**.
2. **As the clinic**, the console opens on the new **Today** tab. Accept the booking first: **Bookings** tab → Pending approval → **Accept**, then go back to **Today**.
3. Under **Mark arrived** you should see that patient listed with their slot, MRN and booking ref. Type part of their **name**, then their **phone**, then their **MRN** — the list should filter on each.
4. Press **Mark arrived**. You should get a green panel with **"Checked in — \<name\>"** and the token in very large type.
5. The patient drops out of "Mark arrived" and appears under **Waiting** with that token. The patient's own screen (other browser) flips from the QR to the big token number within a few seconds, without a manual refresh.

### B. Scan the patient's QR

1. **As the patient**, open the accepted booking. Above "You'll get your token when you check in" there's now a **QR code** plus the booking reference.
2. **As the clinic**, Today tab → **Scan patient QR** → allow camera access.
3. Point the clinic device's camera at the patient's screen (phone screen, or the other browser window on the same monitor if you have a webcam). On a successful read you get the same green **Checked in — \<name\>** panel with the token, and the scanner stays open so you can scan the next person.
4. Verify the method was recorded as a scan:
   ```sql
   select check_in_method, token_number, checked_in_at
   from appointments where id = '<appointment id>';
   ```
   `check_in_method` should be `clinic_scan` (it's `manual` for the Mark-arrived path).

**Scanner cases worth trying:**
- Scan any **other** QR (a UPI code, a product barcode) → *"Not a SanjeevniOS booking code"*, no check-in.
- Scan the **same patient twice** → *"Already checked in"* with the same token; the counter does not advance.
- Scan a booking for a **different day** → *"Wrong day"* naming the actual date.
- Scan a booking belonging to **another clinic** → *"Booking not found"* — RLS never returns that row, so the desk can't act on it. This is the Part 40 rule holding: a clinic only ever sees and checks in its own appointments.

### C. Waiting list actions

With at least two people checked in:
1. **Call next** calls the **lowest token still waiting** (not the earliest booking) and notifies that patient; their screen says "It's your turn — please go in."
2. That row's actions become **Start consultation** → **Complete**. Complete is still gated on a prescription being attached (or "No prescription needed" ticked) in **Open visit**.
3. **No-show** is available on any row.
4. Open the same clinic in a second tab — an action in one tab updates the other within a few seconds over the realtime channel.

### D. The token board

1. Today tab → **Token board** (or go to `/board` directly as a clinic).
2. It shows **Now serving** in very large type, plus the next few waiting tokens, and the clinic name. No patient names — a waiting room is a public space, so only numbers are shown.
3. Press the fullscreen icon to throw it on a TV/second monitor.
4. With the board open on one screen, **Call next** on another — the board should update on its own (realtime, with a 15-second poll as a backstop).
5. The board is clinic-wide: if two doctors are seeing patients at once, the second appears in a smaller "also serving" row, and each token shows which doctor it belongs to.

## Test 9 — Patient arrival QR (signed) + optional self check-in

### Setup

1. Run `supabase/migration_28_signed_qr_self_checkin.sql` in the SQL Editor.
2. `npm run dev`. As the clinic, give the doctor availability that **covers right now** — check-in opens 60 minutes before a slot.
3. Two browser profiles: one signed in as the **patient**, one as the **clinic**.

### A. Showing the QR before arrival

1. **As a patient**, book with that doctor **for today**. **As the clinic**, Bookings tab → **Accept** it.
2. **As the patient**, open the booking → press **"Show this at reception"**. You land on the pass screen (`/bookings/<id>/pass`), which should show:
   - a **"Not checked in yet"** chip,
   - a **QR code**,
   - the **Booking ID**, patient + MRN, **clinic name**, **date & slot**, and doctor.
3. Confirm the code is genuinely signed and short-lived:
   ```sql
   select * from public.issue_booking_qr('<appointment id>');
   ```
   You get `sanjeevni:appt:v2:<uuid>:<expiry>:<16-hex signature>` and an `expires_at` ~10 minutes out. Call it twice — the signature changes as the expiry moves, so each code is fresh.
4. Prove a forged code is refused. Take a valid code and change one character of the signature (or of the uuid), then:
   ```sql
   select public.verify_booking_qr('<the tampered code>');
   ```
   Returns `NULL`. A correct, unexpired code returns the appointment id.
5. Prove an old code dies. Craft one with a past expiry:
   ```sql
   select public.verify_booking_qr(
     'sanjeevni:appt:v2:<appointment id>:' || (extract(epoch from now())::bigint - 60)::text || ':0000000000000000'
   );
   ```
   `NULL` — so a screenshot taken earlier is worthless.

### B. Scanning it, and the screen flipping to the live token

1. Keep the patient's pass screen open on one device/window.
2. **As the clinic**, Today tab → **Scan patient QR** → allow the camera → point it at the patient's QR.
3. The clinic gets **"Checked in — \<name\>"** with the token in large type, and the patient appears in **Waiting**.
4. **Without touching the patient's device**, watch the pass screen: within a few seconds it flips from the QR to:
   - **"Checked in at \<time\>"**,
   - the **token number** in very large type,
   - **Now serving**, **Ahead**, and **Est. wait**.
5. As the clinic, press **Call next**. The patient's screen updates on its own to *"It's your turn — please go in."* — that's the realtime channel; there's also a 15-second poll as a backstop.
6. Verify the method was recorded:
   ```sql
   select check_in_method, token_number, checked_in_at, checked_in_by
   from appointments where id = '<appointment id>';
   ```
   `check_in_method` = `clinic_scan`.

### C. Optional self check-in

Off by default. Turn it on for your clinic:
```sql
update clinics set self_checkin_enabled = true where id = '<clinic id>';
```

1. **As the clinic**, Today tab → **Self check-in code** (the button only appears once enabled) → the poster screen at `/poster` shows a large rotating QR. Leave it open, ideally fullscreen.
2. **As a patient** with an accepted appointment for today, open the pass screen. There's now a **"Scan reception code to check in"** button.
3. Tap it, allow the camera, scan the poster screen. Your own screen flips straight to the token view — no receptionist involved.
4. Verify it was recorded as a patient scan:
   ```sql
   select check_in_method from appointments where id = '<appointment id>';
   ```
   `patient_scan`.

**The anti-cheat cases:**
- **Old photo of the poster.** Photograph the poster code, wait ~6 minutes (it rotates every 3, and the previous window is still accepted), then scan the photo → *"That check-in code has expired..."*. To test without waiting, hand-build a stale code:
  ```sql
  select public.self_check_in(
    'sanjeevni:clinic:v1:<clinic id>:' || (public.clinic_checkin_window() - 5)::text || ':'
      || public.sign_qr_payload('<clinic id>|' || (public.clinic_checkin_window() - 5)::text)
  );
  ```
  Correctly signed but stale → refused.
- **Forged code.** Same call with a made-up signature → *"That check-in code is not valid."*
- **Someone else's clinic / no appointment.** Scan a valid code for a clinic where you have no appointment today → *"No confirmed appointment found for you at this clinic today."*
- **Self check-in switched off.** Set `self_checkin_enabled = false` and scan → *"This clinic does not offer self check-in..."*, and the button disappears from the patient's screen.

**Optional geofence** (belt and braces on top of rotation):
```sql
update clinics set self_checkin_require_location = true, lat = <clinic lat>, lng = <clinic lng>
where id = '<clinic id>';
```
Now self check-in asks for location permission. Deny it → *"Location is required..."*. To simulate being far away, set the clinic's `lat`/`lng` to somewhere else and try again → *"You appear to be about Nm from the clinic..."*. `self_checkin_radius_m` (default 150) controls how close is close enough.

> A genuinely **printed** poster is deliberately not supported: a static code is precisely what a photograph defeats. The reception code is meant for a tablet or monitor. If a clinic insists on paper, turn on `self_checkin_require_location` so physical presence is still proven.

## Test 10 — Late arrivals, no-shows, skipping, and live updates

### Setup

1. Run `supabase/migration_29_late_noshow_live.sql`.
2. `npm run dev`; availability covering **right now**; two browser profiles (patient + clinic).
3. Note the clinic's thresholds — shorten them to make testing quick:
   ```sql
   select checkin_grace_minutes, no_show_cutoff_minutes, reminder_limit
   from clinics where id = '<clinic id>';

   -- fast test values
   update clinics set checkin_grace_minutes = 5, no_show_cutoff_minutes = 5, reminder_limit = 1
   where id = '<clinic id>';
   ```

### A. Late arrival still gets a normal token

1. Book + accept an appointment for today, with a slot that has **already passed** but is still inside `slot end + grace`. Easiest way is to move the slot backwards:
   ```sql
   update appointments set slot_time = (now() at time zone 'Asia/Kolkata')::time - interval '20 minutes'
   where id = '<appointment id>';
   ```
   (Make sure `checkin_grace_minutes` is large enough to still be inside the window — set it to 60 for this step.)
2. **As the clinic**, Today tab → **Mark arrived**. It succeeds, the banner reads **"Checked in (late)"** with the note *"Arrived after their slot — they join the queue at their arrival position."*
3. The patient appears in **Waiting** with a normal next-in-line token and an amber **Late** chip. They are *not* pushed to the back and *not* penalised — the flag is information only:
   ```sql
   select token_number, arrival_seq, was_late from appointments where id = '<appointment id>';
   ```

### B. No-show, auto-marked after the cut-off  ← the one you asked about

1. Book and **accept** an appointment for today. Do **not** check it in.
2. Push it far enough into the past that slot end + grace + cut-off has all elapsed:
   ```sql
   update appointments set slot_time = (now() at time zone 'Asia/Kolkata')::time - interval '3 hours'
   where id = '<appointment id>';
   ```
   (With `checkin_grace_minutes = 5` and `no_show_cutoff_minutes = 5` from the setup, three hours is comfortably past.)
3. Trigger the sweep. Either **reload the clinic console's Today tab** (it sweeps on load), or call it directly:
   ```sql
   select public.auto_mark_no_shows('<clinic id>');   -- returns how many it marked
   ```
4. Confirm:
   ```sql
   select status, no_show_marked_at, no_show_auto, token_number
   from appointments where id = '<appointment id>';
   ```
   `status` = `no_show`, `no_show_auto` = `true`, `no_show_marked_at` set, and **`token_number` is still NULL** — a no-show never receives a token.
5. In the console, the patient has moved out of **Expected** into a **"Marked as no-show"** section labelled *auto-marked at cut-off*.
6. Check it does **not** touch anyone who did arrive: check another patient in first, then re-run the sweep — their `checked_in`/`called` row is untouched, because the sweep only ever looks at `status = 'accepted'`.
7. `pg_cron`: if your project has it, the migration also schedules this every 10 minutes as `sanjeevni_auto_no_shows`. Check with `select * from cron.job;`. If it's absent the migration says so in a NOTICE and the console's on-load sweep covers it — nothing breaks either way.

### C. A no-show who turns up anyway

1. On that same no-show row, press **"Check in anyway"**.
2. They're admitted despite the window having closed, and get the **next token** in the day's arrival order — like a walk-in. `was_late` is true, and `no_show_marked_at` / `no_show_auto` are cleared:
   ```sql
   select status, token_number, was_late, no_show_marked_at from appointments where id = '<appointment id>';
   ```
3. Confirm a **patient** can't do this to themselves — the override is desk-only. From the patient's session (or via their token), `check_in_appointment('<id>','patient_scan',true)` raises *"Only the clinic can admit a late or no-show patient."*

### D. Live token update reaching the patient app  ← the other one you asked about

1. **As the patient**, check in (any route above) and leave the pass screen open — `/bookings/<id>/pass`. It shows the token, **Now serving**, **Ahead**, **Est. wait**.
2. **As the clinic**, in **Waiting**, press **Call next** for a *different, earlier* patient.
3. Watch the patient's screen **without touching it**: **Now serving** changes and **Ahead** drops, within a couple of seconds. That's the realtime broadcast; there's also a 15-second poll behind it, so pulling the network briefly and restoring it still converges.
4. Keep calling patients until this patient has **0 ahead**. Their screen shows a banner **"You're next! Please head to the consultation area now."** — and the same text lands in their bell / `/notifications`.
5. With more than 30 minutes' worth of people ahead, the earlier `~N minutes away` alert fires once instead. Each alert fires **once**, not on every queue tick.
6. Finally, call this patient: their screen flips to *"It's your turn — please go in."*

### E. Reminders and skipping

1. With a patient in **Called** state, the row shows `Reminders: 0/<reminder_limit>` and a **Send reminder** link. Press it — the patient gets a notification and the counter goes up.
2. Once the counter reaches the clinic's `reminder_limit`, a **Skip to back** action appears.
3. Press it. The patient gets a **fresh token at the back of the queue** (their old number is gone — the queue moved on), a `Skipped ×1` chip appears on their row, and they're notified with the new number:
   ```sql
   select token_number, skip_count from appointments where id = '<appointment id>';
   ```
4. The skipped patient's own screen updates to the new token automatically.

Remember to put the clinic's thresholds back when you're done:
```sql
update clinics set checkin_grace_minutes = 30, no_show_cutoff_minutes = 30, reminder_limit = 3
where id = '<clinic id>';
```

## Test 11 — Fair queue data: payment and presence are separate

The point of this one: **paying online buys no queue priority.** A patient who
paid online but is still at home holds no token at all. Online payment only
means there's nothing to collect at the counter.

### Setup

1. Run `supabase/migration_30_fair_queue_data.sql`.
2. Availability covering **now**; a patient and a clinic browser profile.
3. Confirm the vocabulary migrated — no old values should remain:
   ```sql
   select payment_status, count(*) from appointments group by payment_status;
   ```
   Only `pay_at_clinic` / `paid_online` / `paid_at_clinic` / `refunded` (the old `unpaid`/`cod` became `pay_at_clinic`, `hold`/`captured` became `paid_online`).

### The 3PM cash / 4PM online scenario

1. **As a patient**, book **two** appointments for today with the same doctor:
   - one at a **3PM-ish** slot, paying **Cash at clinic**,
   - one at a **4PM-ish** slot, paying **Pay online**.
   (Use whatever two slots your availability actually offers — the earlier/later relationship is what matters.)
2. **As the clinic**, accept both. Look at the raw rows — payment is recorded, presence is not:
   ```sql
   select slot_time, payment_status, checked_in_at, token_number, status
   from appointments where date = current_date order by slot_time;
   ```
   Expect: 3PM → `pay_at_clinic`, 4PM → `paid_online`, **both `checked_in_at` NULL and both `token_number` NULL**. The one who paid online has *no* token and is *not* in the queue.
3. On the **Today** tab, both appear under **Expected**, each with a payment chip — *Pay at clinic* (amber) and *Paid online* (green). The paid-online row says *"Nothing to collect — but they still need to be checked in like anyone else."*
4. Now check them in — **the 3PM one first**, then the 4PM one. Both get tokens in arrival order (3PM → #1, 4PM → #2). Paying online did not jump the queue.
5. Confirm the two facts are stored independently:
   ```sql
   select slot_time, payment_status, checked_in_at, token_number, arrival_seq, effective_order_time
   from appointments where date = current_date order by token_number;
   ```
   Every row now has **both** a payment_status **and** a checked_in_at — two separate columns, neither derived from the other.
6. **Take the cash**: on the 3PM patient (still `pay_at_clinic`), press **Mark paid**. It becomes `paid_at_clinic`. Critically, re-run the query — `checked_in_at` and `token_number` are **unchanged**. Recording payment moved nothing in the queue.

### Proving the separation can't be bypassed

1. Paying online cannot manufacture presence. Take a booking that is `accepted`, not checked in, and try to fake it directly:
   ```sql
   update appointments set checked_in_at = now() where id = '<appointment id>';
   ```
   Refused: *"checked_in_at is set by checking a patient in, not by writing to it directly."*
   ```sql
   update appointments set token_number = 1 where id = '<appointment id>';
   ```
   Refused: *"token_number is issued by the arrival counter..."*
   Only `check_in_appointment()` / `skip_to_back()` may write those columns — they announce themselves to the guard trigger before writing. This closes a real hole: `appointments_update` lets a clinic update its own rows, which previously included handing itself a token straight from the API.
2. Clearing a mistaken check-in is still allowed (it grants nobody a place):
   ```sql
   update appointments set checked_in_at = null where id = '<some checked-in appointment>';
   ```
   Succeeds.
3. `mark_paid_at_clinic` refuses nonsense: call it on the 4PM (already `paid_online`) booking →
   ```sql
   select public.mark_paid_at_clinic('<the paid_online appointment id>');
   ```
   *"This appointment was already paid online - there is nothing to collect."*

### grace_minutes and effective_order_time

- `grace_minutes` on the appointment is an optional override; null means "use the clinic's `checkin_grace_minutes`":
  ```sql
  select public.effective_grace_minutes('<appointment id>');   -- clinic's value
  update appointments set grace_minutes = 5 where id = '<appointment id>';
  select public.effective_grace_minutes('<appointment id>');   -- now 5
  ```
- `effective_order_time` is stamped at check-in (currently the arrival moment, which is what the queue orders by today). The full fairness formula — weighing the booked slot against real arrival — is the next step; the column is already populated and correct, just not yet clever.

## Test 12 — The order rule (A vs B, and the very-late patient)

### Setup

1. Run `supabase/migration_31_fair_queue_order.sql`.
2. One doctor, availability covering a wide window today (e.g. 09:00–18:00) so 3PM and 4PM slots both exist.
3. Note the grace period — the default is 30 minutes:
   ```sql
   select checkin_grace_minutes from clinics where id = '<clinic id>';
   ```

Because these scenarios depend on specific clock times, the reliable way to reproduce them is to book and check people in normally, then **set `checked_in_at` and let the rule recompute** — the helper below does exactly what check-in does, so you're testing the real function, not a fixture:

```sql
-- Re-stamp one appointment as though it had been checked in at a given time.
update appointments a
set checked_in_at = (current_date + time '<HH:MM>') at time zone coalesce(c.timezone,'Asia/Kolkata'),
    effective_order_time = public.compute_effective_order_time(
      a.date, a.slot_time,
      (current_date + time '<HH:MM>') at time zone coalesce(c.timezone,'Asia/Kolkata'),
      coalesce(a.grace_minutes, c.checkin_grace_minutes, 30),
      coalesce(c.timezone,'Asia/Kolkata'))
from clinics c
where c.id = a.clinic_id and a.id = '<appointment id>';
```
(The guard from section 30 blocks writing `checked_in_at` directly, so run this in the SQL Editor, which connects as the table owner and bypasses RLS/guards — that's why this is a test-only shortcut, not something the app can do.)

### A vs B — the worked example

**A** = 4PM slot, **paid online**, checked in **14:45**.
**B** = 3PM slot, **paid at clinic**, checked in **14:55**.

1. Book two appointments for today with the same doctor: one at **15:00** (B, cash) and one at **16:00** (A, pay online). Accept both.
2. Check **A** in first, then **B** (so A genuinely arrives first and holds the lower token).
3. Re-stamp their arrival times with the helper above: A → `14:45`, B → `14:55`.
4. Look at what the rule produced:
   ```sql
   select f.name, a.slot_time, a.payment_status, a.token_number,
          a.checked_in_at, a.effective_order_time
   from appointments a join family_members f on f.id = a.member_id
   where a.date = current_date and a.status in ('checked_in','called','in_consultation')
   order by a.effective_order_time, a.checked_in_at;
   ```
   Both arrived well inside grace, so each takes their **slot** as effective time: **A → 16:00, B → 15:00**. B sorts first.
5. Ask the server for the queue as the clinic sees it:
   ```sql
   select queue_position, patient_name, token_number, slot_time, effective_order_time
   from public.get_clinic_queue('<doctor id>', current_date);
   ```
   **B is queue_position 1, A is queue_position 2** — even though A checked in ten minutes earlier and holds the lower token, and even though A paid online. That's the whole rule in one row.
6. In the app: open the clinic's **Today** tab. The Waiting list shows **B above A**, each row showing its position (big) and its token (small, underneath). Press **Call next** → **B is called**, not A.
7. On A's phone (`/bookings/<A>/pass`), **Your position in line** reads **2** while their token is the lower number — which is exactly why both are labelled.

### The very-late early-slot patient does NOT jump

**C** = 9AM slot, wanders in at **14:00**. **D** = 1PM slot, punctual, checked in **12:55**.

1. Book a **09:00** appointment (C) and a **13:00** one (D) for today; accept both; check both in (use **Check in anyway** for C, since 9AM is long past its window).
2. Re-stamp: C → `14:00`, D → `12:55`.
3. Check the rule:
   ```sql
   select f.name, a.slot_time, a.checked_in_at, a.effective_order_time, a.was_late
   from appointments a join family_members f on f.id = a.member_id
   where a.date = current_date and a.status = 'checked_in'
   order by a.effective_order_time;
   ```
   - **C**: 14:00 is more than grace past 09:00, so C **forfeits slot priority** — effective becomes their real arrival, **14:00**, and `was_late` is true.
   - **D**: 12:55 is within grace of 13:00, so effective is the **slot**, **13:00**.
   - **D sorts before C.** Had the rule naively used slot_time, C's 09:00 would have put them in front of everybody all day — that's precisely what this prevents.
4. `get_clinic_queue` and the Waiting list agree: **D position 1, C position 2**.

> Note what is *not* claimed here: C still comes before someone whose slot is 3PM and who arrives at 14:30 — because at 14:00 C was standing in the clinic and that person wasn't. The rule stops a late patient inheriting their *original* priority; it doesn't punish them beyond that.

### No idling, no preemption

1. With someone **in consultation**, press **Call next** → refused: *"Someone is already being seen - finish or skip them first."* The doctor is never interrupted.
2. With nobody present, **Call next** → *"Nobody is checked in and waiting."* The doctor is never held waiting for someone who hasn't arrived — only checked-in patients are ever candidates.
3. Now the "next free turn" case: while D is being seen, check in a patient whose slot is **earlier** than everyone still waiting. They sort to the front of the *waiting* rows immediately, but D's consultation continues undisturbed. **Complete** D, press **Call next** → the newly-arrived earlier-slot patient is called next.

### Both apps agree

Payment never enters any of this: re-run any of the queries above after flipping a patient between `pay_at_clinic` and `paid_online` and the order is unchanged.

The clinic list, the patient's position, and the waiting-room board all read from the same two columns (`effective_order_time`, then `checked_in_at`) — `get_clinic_queue` for the desk, `get_queue_status` for the patient (positions only, no identities), and the board's own query. Open all three at once and call a patient: they move together.

## Test 13 — Online payment: convenience, never priority

### Setup

1. Run `supabase/migration_32_online_payment_perks.sql`.
2. All three perks are **off by default** — a clinic opts in. Turn them on for yours:
   ```sql
   update clinics
   set fast_checkin_paid_online = true,      -- skip the counter
       auto_confirm_paid_online  = true,     -- guaranteed confirmed slot
       reschedule_window_hours = 2,
       reschedule_window_hours_paid_online = 1
   where id = '<clinic id>';
   ```
   Note `self_checkin_enabled` stays **false** — that's the point of the next test: a paid-online patient gets the fast lane even where general self check-in is closed.
3. Availability covering **now**. Open `/poster` as the clinic on a second screen (the rotating reception code).

### A. Guaranteed confirmed slot

1. As a patient, book for today and choose **Pay online**. Note the copy under the payment buttons: it says paying now means a single scan at check-in and *"does not move you up the queue"*.
2. The booking should arrive **already accepted** — it never sits in the clinic's Pending approval inbox:
   ```sql
   select status, payment_status from appointments where id = '<appointment id>';
   ```
   `accepted` / `paid_online`. Critically, `checked_in_at` and `token_number` are still **NULL** — a confirmed slot is not a place in the queue.
3. Book another as **Cash at clinic** — that one *does* land in Pending approval, as before.

### B. Instant check-in for the online-paid patient

1. On the paid-online booking, open **Show this at reception**. Because they've paid, the screen reads *"Already paid — scan the reception code and you're checked in"* and *"Nothing to pay at the counter, so there's no queue to stand in to check in."* The button is a solid **Fast check-in — skip the counter**.
2. Tap it, scan the `/poster` code. You're checked in — no receptionist involved — and the screen flips to the live token view.
3. Confirm it went through the patient path and got an ordinary token:
   ```sql
   select check_in_method, token_number, checked_in_at, effective_order_time
   from appointments where id = '<appointment id>';
   ```
   `patient_scan`, a normal next-in-line token.
4. Now the contrast: open the **cash** booking's pass screen. It says *"Show this code at the reception desk"* and *"You'll check in at the counter when you pay."* — and there is **no** fast check-in button, because `self_checkin_enabled` is false and they haven't paid online.
5. Prove the fast lane is genuinely payment-scoped, not a hole. From the cash patient's session, try the same call directly:
   ```sql
   select public.self_check_in('<paste the current poster code>');
   ```
   *"This clinic does not offer self check-in - please see the reception desk."*

### C. The live position still respects appointment order  ← the important one

Set up so the paid-online patient has the **later** slot:

1. **P** (paid online) — slot **16:00**. **Q** (cash) — slot **15:00**.
2. Check **P** in first via fast check-in, then check **Q** in at the desk. P arrived first, paid online, and holds the lower token.
3. Ask the server:
   ```sql
   select queue_position, patient_name, slot_time, payment_status, token_number, effective_order_time
   from public.get_clinic_queue('<doctor id>', current_date);
   ```
   **Q is queue_position 1, P is 2.** Both were punctual, so each is ordered by their slot — 15:00 before 16:00. Paying online, arriving first, and holding the lower token changed nothing.
4. On P's phone: **"Your position in line · live"** shows **2**, with the line *"This updates as people arrive. Turn order follows appointment time, then arrival."* The number is live, not frozen.
5. Watch it move: as the clinic calls and completes Q, P's position updates to 1 on its own (realtime, with a 15-second poll behind it).

### D. Easier rescheduling (the third perk)

1. On the **paid-online** booking, the "Important Information" note reads *"up to 1 hour before"*; on the **cash** one it reads *"up to 2 hours before"* — from `reschedule_window_hours_paid_online` vs `reschedule_window_hours`.
2. Change the figures and reload to confirm both are clinic-driven, not hardcoded.

### E. The invariant

Payment cannot buy position, by construction: `get_clinic_queue`, `get_queue_status` and `call_next_patient` order on `effective_order_time` then `checked_in_at` and never read `payment_status`. Prove it directly — flip a waiting patient's payment state and re-run the queue query:
```sql
update appointments set payment_status = 'paid_online' where id = '<a waiting appointment id>';
select queue_position, patient_name, payment_status from public.get_clinic_queue('<doctor id>', current_date);
```
The order is identical before and after. And the presence columns still can't be written directly (section 30.5), so no perk can be turned into a token:
```sql
update appointments set token_number = 1 where id = '<any appointment id>';   -- refused
```

## Test 14 — Appointment-only mode: advance booking with a daily cap

### Setup

1. Run `supabase/migration_33_advance_only_booking.sql`.
2. `npm run dev`. As the clinic, go to the new **Booking mode** tab, choose **Appointment only**, and set:
   - **Days ahead patients can book**: `1` (tomorrow only)
   - **Patients per day**: `2` (a small cap makes filling it quick)

   Save. Or in SQL:
   ```sql
   update clinics set mode = 'appointment_only', booking_horizon_days = 1, daily_cap = 2
   where id = '<clinic id>';
   ```
3. Give the doctor availability on **tomorrow's weekday** with at least 3 slots, so the cap runs out before the slots do — that's the point being tested.

### A. Same-day booking is blocked

1. As a patient, open the doctor and look at the day strip. **Today is not offered** — the strip starts at tomorrow and ends at the horizon. A note explains: *"This clinic takes advance bookings only — no same-day appointments..."*
2. The database enforces it too, not just the UI. Try to insert a same-day booking directly:
   ```sql
   insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
   values ('<member id>', '<doctor id>', '<clinic id>', current_date, '11:00', 'booked', 'pay_at_clinic');
   ```
   Refused: *"This clinic takes advance bookings only - the earliest you can book is ..."*
3. Beyond the horizon is refused as well — same insert with `current_date + 5`:
   *"This clinic accepts bookings up to 1 day(s) ahead ..."*

### B. No walk-ins, from either side

1. On the clinic's **Today** tab, the **+ Walk-in** button is **gone** in this mode.
2. And it's blocked at the database, so it can't be reached another way:
   ```sql
   insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status, patient_type)
   values ('<member id>', '<doctor id>', '<clinic id>', current_date + 1, '11:00', 'booked', 'pay_at_clinic', 'walk_in');
   ```
   Refused: *"This clinic is appointment-only - walk-ins are not accepted."*

### C. Filling the day to the cap  ← the main one

1. As a patient, book **tomorrow**. Note the slot picker shows **"2 of 2 seats left"** beside "Available slots".
2. Confirm the booking. It should be **auto-confirmed** — it never appears in the clinic's Pending approval inbox:
   ```sql
   select status, date from appointments where id = '<appointment id>';
   ```
   `accepted`.
3. Book a second one for tomorrow (a different family member, or a different patient account). The picker now reads **"1 of 2 seats left"**. Confirm it.
4. Check the day is now full:
   ```sql
   select * from public.day_availability('<clinic id>', current_date + 1);
   ```
   `seats_taken = 2`, `seats_left = 0`, `is_full = true`.
5. **Try a third booking.** Two ways to see the refusal:
   - In the app, the picker now shows **"Day full"** and *"This day is fully booked (2/2)..."*.
   - If you were already mid-flow when it filled (open the form before booking #2, confirm after), pressing **Confirm** lands on the **"That day just filled up"** screen — the raw error is caught and turned into the two ways forward.
   - Directly, to see the underlying refusal:
     ```sql
     insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
     values ('<member id>', '<doctor id>', '<clinic id>', current_date + 1, '12:00', 'booked', 'pay_at_clinic');
     ```
     *"FULL_DAY: ... is fully booked (2 of 2 seats taken)."*

### D. The waitlist and the next day

From the "That day just filled up" screen:

1. Press **Join the waitlist for this day** → *"You're on the waitlist — number 1 in line."*
   ```sql
   select status, date from waitlist where clinic_id = '<clinic id>';
   ```
2. The screen also shows **Next day with room**, from `next_available_day()`:
   ```sql
   select public.next_available_day('<clinic id>');
   ```
   With `booking_horizon_days = 1` and tomorrow full, this returns `NULL` and the screen says every bookable day is full — raise the horizon to `3` and it will return the next open day instead.
3. **Free a seat** and watch the waitlist fire: cancel one of the two bookings for tomorrow (as the patient, or `update appointments set status = 'cancelled' where id = '...'`). The longest-waiting patient is notified automatically:
   ```sql
   select status, offered_at from waitlist where clinic_id = '<clinic id>';
   select message from notifications where type = 'waitlist_seat' order by at desc limit 1;
   ```
   Status becomes `offered`, and the message says a seat has opened up. It is an **invitation to book**, not a held seat — deliberately, since silently allocating a seat to someone who has since made other plans is worse than not offering one.
4. `day_availability` now shows `seats_left = 1` again — cancelling genuinely frees the seat, because the cap counts live rows rather than a stored tally that could drift.

### E. Two patients racing for the last seat

The count is taken while holding a per-day lock row (`clinic_day_locks`), so two simultaneous bookings for the final seat serialise — the second waits, re-counts, and sees the day full.

To exercise it, open two SQL Editor tabs and run in each, at the same time, with the day one seat short of the cap:
```sql
begin;
insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
values ('<member id>', '<doctor id>', '<clinic id>', current_date + 1, '13:00', 'booked', 'pay_at_clinic');
-- pause here before committing, then run COMMIT in one tab and watch the other
```
One commits; the other fails with `FULL_DAY`. Then confirm no day ever exceeds its cap:
```sql
select a.clinic_id, a.date, count(*), c.daily_cap
from appointments a join clinics c on c.id = a.clinic_id
where c.mode = 'appointment_only' and a.status not in ('cancelled','rejected')
group by a.clinic_id, a.date, c.daily_cap
having count(*) > c.daily_cap;
```
Should always return zero rows.

### F. Other clinics are unaffected

Set a different clinic to `allow_walkins` (the default) and confirm same-day booking, walk-ins and the approval inbox all still work exactly as before — none of the rules above apply outside the mode.

## Test 15 — Publish the day schedule

### Setup

1. Run `supabase/migration_34_publish_day_schedule.sql`.
2. `npm run dev`. As a patient, book **2-3 appointments for tomorrow** with the same clinic (different doctors is fine) and have the clinic **accept** each one (Bookings tab → Pending approval → Accept). Note each booking's `id`.
3. As the clinic, open the **Publish day** tab.

### A. Preview does nothing yet

1. Set the date picker to tomorrow. The preview list shows every accepted booking for that day, numbered **#1, #2, ...** with an estimated time under each, in slot-time order.
2. Confirm nothing has been written yet:
   ```sql
   select id, sequence_no, estimated_time, schedule_published_at, token_number, status
   from appointments where date = current_date + 1 and clinic_id = '<clinic id>';
   ```
   `sequence_no`, `estimated_time`, `schedule_published_at` and `token_number` are all `null`. Refreshing the preview, changing the date-start/avg-minutes settings, or navigating away and back changes nothing in the database — only **Publish** writes anything.

### B. Publishing — the main one

1. (Optional) Under **Day starts at** / **Avg minutes / patient**, set e.g. `09:00` and `15`, then **Save estimate settings**. The preview's estimated times update immediately (first patient ≈ 9:00 AM, second ≈ 9:15 AM, ...).
2. Press **Publish N patients**. The screen switches to "Published order" showing the same numbers/times, now confirmed.
3. Check every booked patient got a number, a time, and nobody was checked in:
   ```sql
   select id, sequence_no, estimated_time, schedule_published_at, token_number, checked_in_at, status
   from appointments where date = current_date + 1 and clinic_id = '<clinic id>'
   order by sequence_no;
   ```
   `sequence_no` is `1..N`, `estimated_time` is set, `schedule_published_at` is set — and **`token_number` and `checked_in_at` are still `null`, and `status` is unchanged** (still `accepted`, not `checked_in`). Publishing only plans; it never checks anyone in.
4. Every patient has a visit id already (assigned at booking, section 18 — publishing just surfaces it):
   ```sql
   select a.id, e.encounter_no from appointments a join encounters e on e.id = a.encounter_id
   where a.date = current_date + 1 and a.clinic_id = '<clinic id>';
   ```
5. Each row's **QR** button mints the same signed, short-lived code `issue_booking_qr()` has always produced (section 28) — it's not a new code, just shown here for convenience.

### C. Every patient was notified

```sql
select user_id, message from notifications where type = 'schedule_published' order by at desc limit 5;
```
One row per patient, each naming their own number and estimated time, and saying explicitly it is *not* a check-in.

### D. The patient sees it, still not checked in

1. As the patient, open **My Bookings → (the booking) → Appointment Details**. The "Your Token Number — —" placeholder is replaced by **"Your number for the day — #N"** with the estimated time, and a note that this is not a check-in.
2. Open **Show this at reception** (the pass screen, `/bookings/:id/pass`): the same number/time appears above the QR code, and the QR itself still works exactly as before (10-minute signed code, self-refreshing).
3. Confirm status is still `accepted`, not `checked_in` — the patient has **not** been marked present by any of this.

### E. Reordering before (or after) publishing

1. Back in preview (or re-open Publish day for the same date), use the **↑ / ↓** buttons on one patient to move them ahead of another. The list re-orders immediately and a "Reordered manually · reset to slot time" link appears on that row.
2. Confirm it's a real column, not just a UI reshuffle:
   ```sql
   select id, day_order_override from appointments where id = '<the moved appointment id>';
   ```
   Not null.
3. Press **Publish** again. `sequence_no`/`estimated_time` update to match the new order — republishing is safe and sends a fresh notification to everyone in the run.
4. Click **reset to slot time** on that row (or clear it manually) and republish — it falls back to slot-time order.

### F. Breaks hold their position

1. In the **Breaks** panel, add a break **before #2**, `30` minutes, label "Lunch". Reload the preview: the patient who is #2 (and everyone after) has their estimated time pushed 30 minutes later than it would otherwise be; #1 is unaffected.
2. Move a different patient into position #2 (via the reorder buttons in section E) and reload the preview — the break still lands in front of whoever is now #2, not the original patient. Delete the break (trash icon) and the times shift back.

### G. Falling out of the run

1. Publish the day (section B), then **cancel** one of the published bookings (as the patient, or `update appointments set status = 'cancelled' where id = '...'`).
2. Publish the same day again. The cancelled appointment's `sequence_no`/`estimated_time` are cleared:
   ```sql
   select id, status, sequence_no, estimated_time from appointments where id = '<the cancelled id>';
   ```
   `sequence_no` and `estimated_time` are `null`; everyone after it in the order has shifted down by one and been renumbered with no gap.

### H. Checking in is still a separate act

With the day published, go to the **Today** tab and check the patient in the ordinary way (scan, self check-in, or "Check in"). Only *now* do `token_number` and `checked_in_at` get set:
```sql
select sequence_no, estimated_time, token_number, checked_in_at, status from appointments where id = '<appointment id>';
```
`sequence_no`/`estimated_time` are unchanged from publishing; `token_number` is freshly assigned in **arrival order**, independent of `sequence_no` — confirming the two numbers really are separate systems, exactly as designed.

## Test 16 — On-the-day check-in: scan or patient ID, payment, and the live board

### Setup

1. Run `supabase/migration_35_onday_checkin_live_queue.sql`.
2. `npm run dev`. As a patient, book **two appointments for today** with the same clinic/doctor — one **online-paid**, one **pay-at-clinic** — and have the clinic **accept** both (Bookings tab → Pending approval → Accept). Optionally publish today's schedule first (Test 15) so both have a `sequence_no`/`estimated_time`.
3. As the patient (either booking), open a family member's **Profile → My Family**, tap their avatar, and upload a JPG/PNG. Confirm it appears immediately in place of the initial.
4. As the clinic, open the **Today** tab.

### A. Scanning shows a preview, not an instant check-in

1. As the patient, open **Show this at reception** (`/bookings/:id/pass`) for the online-paid booking to display its QR.
2. At the clinic, press **Scan patient QR** and point the camera at it. The camera closes and a card appears showing: the patient's **photo** (if uploaded in step 3) or their initials, their name and MRN, the doctor and slot time, their **"Expected #N · ~time"** badge if the day was published (or "Not yet published" if not), and a green **Paid online** pill.
3. Confirm nothing was written yet:
   ```sql
   select status, checked_in_at, token_number from appointments where id = '<appointment id>';
   ```
   Still `accepted`, `checked_in_at` and `token_number` both `null` — the scan only looked the patient up.
4. Press **Check in** on the card. The card is replaced by the usual "Checked in — token #N" banner, and the query above now shows `status = 'checked_in'` with both columns set.

### B. Pay-at-clinic shows the exact amount, and paying doesn't check anyone in

1. Scan (or type the patient ID — see C) the **pay-at-clinic** booking. The card shows **"Collect ₹\<fee>"** with a **Mark paid** button instead of a green pill.
2. Press **Mark paid**. The pill switches to green "Paid at clinic" in place. Confirm:
   ```sql
   select payment_status, checked_in_at from appointments where id = '<appointment id>';
   ```
   `payment_status = 'paid_at_clinic'`, `checked_in_at` still `null` — paying is a separate act from arriving, exactly like Test 11.
3. Now press **Check in** on the same card to actually seat them.

### C. Typing the patient ID does the same lookup

1. Note the second patient's MRN (Profile → Personal Details, or the `family_members.mrn` column).
2. At the clinic, type it into **Patient ID (MRN-...)** and press **Look up** (or Enter). The identical preview card appears, resolved by MRN instead of a QR.
3. Typing an MRN with no live appointment today at this clinic (or a stranger's MRN) shows a plain error ("No appointment found for patient ID ... today at this clinic") — no card, nothing written.

### D. The live board serves only the checked-in, and reuses the grace/no-idle rules as-is

1. With both patients checked in (A and C above), scroll to **Waiting** on the Today tab. Both appear, ordered exactly as `get_clinic_queue()` (schema.sql section 31) always has — this migration does not change that function, so Test 12's "no idling, no preemption, and a very-late early slot doesn't jump the queue" behaviour applies unchanged here.
2. Book and accept a **third** appointment for today, later in the day, but do **not** check them in. Confirm the live board does not include them and **Call next** never selects them — the queue only ever contains checked-in patients (no idling).
3. Press **Call next**. The board shows "Now serving: #N" for whichever checked-in patient sorts first. Check the un-arrived third patient in now (scan or ID) — they slot into the board in their correct position, not at the front and not blocking whoever is already being served (no preemption).

## Test 17 — Slot-based booking: capacity & availability

### Setup

1. Run `supabase/migration_36_slot_capacity_booking.sql`.
2. Give a doctor availability with a **small, easy-to-fill window** and a **slot capacity above 1**, so filling one slot doesn't take forever and you can tell "slot full" apart from "day full":
   ```sql
   insert into doctor_availability (doctor_id, weekday, start_time, end_time, max_patients_per_day, slot_capacity)
   values ('<doctor id>', extract(dow from current_date)::int, '10:00', '10:30', 1, 2)
   -- max_patients_per_day = 1 -> exactly one computed slot, 10:00
   -- slot_capacity = 2        -> that slot holds 2 patients
   on conflict do nothing;
   ```
   (Or from the clinic's **Doctors** tab, in the availability form's new **Capacity per slot** field — set it to `2` and save a window with `Max patients/day` = `1`.)
3. `npm run dev`.

### A. The picker shows one slot, selectable, capacity 2

1. As a patient, open the doctor. The day strip lands on today (or the window's weekday); **Available slots** shows exactly one time, **10:00 AM**, and it's selectable (not greyed out).

### B. First booking succeeds, slot still shows selectable

1. Book **10:00 AM** for one family member. Confirm:
   ```sql
   select count(*) from appointments
   where doctor_id = '<doctor id>' and date = current_date and slot_time = '10:00'
     and status not in ('cancelled', 'rejected');
   ```
   `1`.
2. Reopen the doctor's page (or refresh). **10:00 AM** is still shown and still selectable — one seat of two is taken, so the slot isn't full yet.

### C. Second booking takes the last seat; the slot is now full

1. Book **10:00 AM** again for a different family member (or a different patient account). It succeeds.
2. Reopen the doctor's page. **10:00 AM** now renders **greyed out and unselectable** — no times are hidden, the full one is just disabled, matching what section 36's `get_taken_slots()` now reports (2 of 2 taken).
3. Confirm at the database:
   ```sql
   select public.get_taken_slots('<doctor id>', current_date);
   ```
   Returns `10:00`.

### D. A third patient cannot take the same slot — the actual test asked for

This is the one to run twice: once as a straightforward refusal, once as a genuine concurrent race for "the last seat."

**Straightforward refusal** — with the slot already full from step C, try to insert directly:
```sql
insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
values ('<a third member id>', '<doctor id>', '<clinic id>', current_date, '10:00', 'booked', 'pay_at_clinic');
```
Refused: `SLOT_FULL: 10:00 AM on <today> is full (2 of 2 taken) - pick another slot.` Nothing is written — re-run the `count(*)` query from B and it's still `2`.

**The actual race** — confirm two simultaneous bookings for the *last* seat can't both win. Start from a slot with **one seat free** (cancel one of the two 10:00 AM bookings above, or use a fresh doctor/day with `slot_capacity = 2` and only one booking so far), then open **two SQL Editor tabs** and in each run:
```sql
begin;
insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
values ('<a member id>', '<doctor id>', '<clinic id>', current_date, '10:00', 'booked', 'pay_at_clinic');
-- pause here before committing
```
Then, as close together as you can manage, run `commit;` in both tabs (or commit one, then the other). One commits cleanly; the other's `INSERT` raises `SLOT_FULL` — it was blocked on `doctor_slot_locks`' row lock (section 36.2) until the first transaction committed, then re-counted the slot and saw it full. Confirm no slot ever exceeds its capacity:
```sql
select doctor_id, date, slot_time, count(*), public.slot_capacity_for(doctor_id, date, slot_time) as capacity
from appointments
where status not in ('cancelled', 'rejected')
group by doctor_id, date, slot_time
having count(*) > public.slot_capacity_for(doctor_id, date, slot_time);
```
Should always return zero rows.

### E. Cancelling frees the seat live, not from a stored count

1. Cancel one of the two 10:00 AM bookings: `update appointments set status = 'cancelled' where id = '...';`
2. `select public.get_taken_slots('<doctor id>', current_date);` no longer includes `10:00` — reopen the doctor's page and it's selectable again. The count was never cached (see the migration header, section 36) so there's nothing to have drifted.

### F. Walk-ins booked "right now" never contend for slot capacity — SUPERSEDED

**This section's guarantee no longer holds as of `migration_38_walkin_slot_availability.sql`.** A walk-in's `slot_time` is no longer the raw clock - the desk now claims a real computed slot from the doctor's grid, and it DOES contend for capacity, same as a scheduled booking. See "Test 19" for the new behaviour. (Part 3 below - the future-booking sub-flow - was always true and still is.)

1. ~~On the clinic's **Today** tab, add a walk-in (immediate, not the "also book a future appointment" checkbox) for the same doctor, several times in a row within the same minute if you can manage it.~~
2. ~~All of them succeed — `patient_type = 'walk_in'` bookings use the clock at check-in as their `slot_time`, which `enforce_slot_capacity()` (section 36.4) explicitly ignores, so they never compete for a bookable slot's seats.~~
3. Tick **Also book a future appointment for this patient** and pick a date/slot for the SAME doctor — this one IS `patient_type = 'scheduled'` and behaves exactly like B–D above: try to fill its slot to capacity from two walk-in forms (or a walk-in form and the patient app) and confirm the second is refused with `SLOT_FULL`.

### G. Other daily-cap behaviour (section 33) is unaffected

1. On an `appointment_only` clinic (Test 14), fill a day to its `daily_cap` using slots with plenty of spare capacity. The day still refuses with `FULL_DAY` even though individual slots aren't full — the two limits are independent, and the day is full at whichever one is hit first, exactly as the migration header describes.

## Test 18 — Same-day booking for appointment-only clinics

### Setup

1. Run `supabase/migration_37_same_day_booking.sql`.
2. Use the `appointment_only` clinic from Test 14 (or set one up the same way), and give the doctor an availability window that **includes right now** with slots at least an hour apart, e.g. if it's 2:15 PM:
   ```sql
   insert into doctor_availability (doctor_id, weekday, start_time, end_time, max_patients_per_day, slot_capacity)
   values ('<doctor id>', extract(dow from current_date)::int, '13:00', '18:00', 5, 1)
   on conflict do nothing;
   -- five 1-hour-ish slots today: 13:00, 14:00, 15:00, 16:00, 17:00
   ```
3. Leave `same_day_booking_enabled` OFF for part A, then turn it on for the rest:
   ```sql
   update clinics set same_day_booking_enabled = true, same_day_cutoff_minutes = 30 where id = '<clinic id>';
   ```
   Or from the clinic's **Booking mode** tab: switch to **Appointment only**, tick **Allow same-day booking**, set the cutoff, Save.
4. For parts C–D, also set the clinic's location and turn on auto-check-in (no UI for these two yet — SQL only, same as `self_checkin_enabled`):
   ```sql
   update clinics set lat = <clinic latitude>, lng = <clinic longitude>,
     auto_checkin_verified_same_day = true, same_day_checkin_radius_m = 150
   where id = '<clinic id>';
   ```

### A. Off by default — Test 14's behaviour is untouched

With `same_day_booking_enabled = false` (the default), repeat Test 14 A and B exactly — same-day booking and walk-ins are still refused with the same messages. Nothing in this migration changes that clinic's behaviour until the setting is turned on.

### B. Same-day booking made remotely — accepted, but NO token yet

This is the "booked from home" path — don't grant location access for this one (or run it directly in SQL, which never carries a location fix regardless).

1. With `same_day_booking_enabled = true`, as a patient, open the doctor. **Today is now offered** in the day strip. Pick a slot that's comfortably more than the cutoff away (e.g. `17:00` if it's 2:15 PM) and confirm the booking **without** allowing the browser's location prompt (dismiss/deny it, or just test via SQL):
   ```sql
   insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
   values ('<member id>', '<doctor id>', '<clinic id>', current_date, '17:00', 'booked', 'pay_at_clinic');
   ```
2. Check the result:
   ```sql
   select status, token_number, checked_in_at, booking_lat from appointments where member_id = '<member id>' and date = current_date;
   ```
   `status = 'accepted'`, and **`token_number` and `checked_in_at` are both `null`** — booked, not checked in. Exactly like an advance booking; this patient collects a token later at `check_in_appointment()` when they actually arrive (see Test 7/16 for that path).

### C. Same-day booking made AT the clinic — instant token

The "confirmed present" path from step 4's settings. In the app this means allowing location access while physically at (or within `same_day_checkin_radius_m` metres of) the clinic; to exercise it without leaving your desk, insert directly with the clinic's own coordinates:

```sql
insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status, booking_lat, booking_lng)
values ('<member id>', '<doctor id>', '<clinic id>', current_date, '15:00', 'booked', 'pay_at_clinic',
        (select lat from clinics where id = '<clinic id>'), (select lng from clinics where id = '<clinic id>'))
returning id;
```
Pick a slot time within the normal check-in window (no more than 60 minutes from now — `check_in_appointment()`'s own arrival-window rule, section 27.7, still applies here). Check the result:
```sql
select status, token_number, checked_in_at, check_in_method from appointments where id = '<the id just inserted>';
```
`status = 'checked_in'`, **`token_number` is set**, `checked_in_at` is set, `check_in_method = 'patient_scan'` — checked in the instant the booking was made, no separate check-in step required.

### D. Too far from the clinic — treated as remote

Repeat C but with coordinates far from the clinic (e.g. `booking_lat = 0, booking_lng = 0`). The insert still succeeds (`status = 'accepted'`), but `token_number` and `checked_in_at` stay `null` — same outcome as B. Unverified presence is simply presence not confirmed, not an error.

### E. The cutoff

1. With `same_day_cutoff_minutes = 30`, try to book a same-day **scheduled** slot inside that window (e.g. `14:00` when it's `13:45`, or any slot already in the past):
   ```sql
   insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status)
   values ('<member id>', '<doctor id>', '<clinic id>', current_date, '14:00', 'booked', 'pay_at_clinic');
   ```
   Refused: `SAME_DAY_CUTOFF: the 02:00 PM slot has already passed or is too soon - same-day booking closes 30 minutes before a slot starts.` In the app, that same slot shows greyed out with a **"· Closed"** tag rather than being offered at all.
2. A walk-in is exempt from this check — its "slot" is the clock at the desk, not a future promise (see part F).

### F. Walk-ins, now allowed same-day

1. On the clinic's **Today** tab, the **+ Walk-in** button is now **present** (it was hidden in Test 14 B; compare with part A above where it's still hidden).
2. Register a walk-in. It's checked in immediately with a token, exactly as it always has been for an `allow_walkins` clinic — WalkInForm's own `checkInNow: true` call to `check_in_appointment()` is untouched by this migration.
3. A walk-in for a date other than today is still refused — same message as Test 14 B:
   ```sql
   insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status, patient_type)
   values ('<member id>', '<doctor id>', '<clinic id>', current_date + 1, '11:00', 'booked', 'pay_at_clinic', 'walk_in');
   ```
   Refused: *"This clinic is appointment-only - walk-ins are not accepted."*

### G. The daily cap still applies to same-day bookings

Fill the day's `daily_cap` (Test 14 C) using a mix of same-day and advance bookings — `FULL_DAY` is refused once the cap is hit regardless of which day's booking pushed it there. Same-day booking is a new way IN, not a way around the cap.

## Test 19 — Walk-in registration: only into a free slot

### Setup

1. Run `supabase/migration_38_walkin_slot_availability.sql`.
2. Use an `allow_walkins` clinic (the default). Give the doctor a **small, easy-to-fill** availability window for today, e.g. if it's 2:00 PM:
   ```sql
   insert into doctor_availability (doctor_id, weekday, start_time, end_time, max_patients_per_day, slot_capacity)
   values ('<doctor id>', extract(dow from current_date)::int, '13:30', '14:30', 4, 1)
   on conflict do nothing;
   -- four 15-minute slots today: 13:30, 13:45, 14:00, 14:15
   ```
3. (Optional, for part D) Lower the clinic's daily cap so it's easy to hit:
   ```sql
   update clinics set daily_cap = 2 where id = '<clinic id>';
   ```
   Note this now applies to `allow_walkins` clinics too (schema.sql section 38.2) - it never did before.

### A. Registering into a free slot — instant token

1. `npm run dev`. On the clinic's **Today** tab, press **+ Walk-in** and pick the doctor from setup. The banner above the form reads **"A slot is free — will be booked for [time] and checked in immediately"**, naming whichever of today's computed slots is current (or the soonest one still ahead).
2. Fill in a patient name (and optionally phone/MRN/age/gender), leave **Collect payment now** on **Cash**, and press **Add to queue**.
3. Result: "Checked in to today's queue for [doctor]" with a live **token number**, a booking reference, and "Payment collected — cash, ₹[fee]". Confirm at the database:
   ```sql
   select status, token_number, checked_in_at, payment_status, patient_type, slot_time
   from appointments where id = '<the new appointment id>';
   ```
   `status = 'checked_in'`, `token_number` set, `payment_status = 'paid_at_clinic'`, `patient_type = 'walk_in'`, and `slot_time` is one of the doctor's REAL computed slots (e.g. `13:30`), not a raw clock reading.
4. Register a second walk-in for the same doctor. The banner now shows the NEXT open slot (e.g. `13:45`) - the first one is taken.

### B. Filling every slot — the next walk-in is refused a live token

1. Keep registering walk-ins for the same doctor until all four computed slots are full (four registrations, given `slot_capacity = 1`).
2. Open **+ Walk-in** again for the same doctor. The banner now reads **"No slot is free for this doctor right now"** in an amber panel, and the **Collect payment now** section disappears (nothing to collect yet). The submit button reads **"Add to waitlist"**.
3. Register anyway (name is enough). Result: **"No slot was free for [doctor] today - added to the waitlist instead"** with a waitlist place number, no token. Confirm:
   ```sql
   select * from waitlist where clinic_id = '<clinic id>' and date = current_date order by created_at;
   select status, token_number from appointments where member_id = '<that member id>' and date = current_date;
   ```
   A `waiting` row in `waitlist`, and no `appointments` row was created for today's visit at all (only the waitlist entry) - registering someone who can't be seated doesn't fabricate a booking.
4. Press **Check the next available day** in the banner - it walks the doctor's grid forward (up to 7 days) and names the soonest day with an open slot, reusing the same `findNextBestSlot()` a rejected booking's "next available slot" suggestion already uses.

### C. The race for the last seat is still safe

With one seat left in the doctor's grid, open **two SQL Editor tabs** and run in each (using two different patients' existing `member_id`s, or `find_family_member_by_phone`/MRN first):
```sql
begin;
insert into appointments (member_id, doctor_id, clinic_id, date, slot_time, status, payment_status, patient_type)
values ('<member id>', '<doctor id>', '<clinic id>', current_date, '14:15', 'booked', 'pay_at_clinic', 'walk_in');
-- pause here before committing
```
Commit one, then the other. One succeeds; the other raises `SLOT_FULL` - `doctor_slot_locks` (section 36.2) now serialises a walk-in's last seat exactly the way it already did for a scheduled booking, because `enforce_slot_capacity()` no longer exempts `patient_type = 'walk_in'`.

### D. The daily cap now also gates a walk-in, even at an allow_walkins clinic

With `daily_cap = 2` from setup, and a doctor with plenty of per-slot capacity left (so this refusal is clearly about the DAY, not the slot):

1. Register two walk-ins today (any doctor at this clinic) - both succeed.
2. Register a third. Refused with `FULL_DAY: ... is fully booked (2 of 2 seats taken).` - the banner shows **"Today is fully booked at this clinic (2/2)"** before you even fill in a name.
3. Confirm a SCHEDULED (advance) booking at this same `allow_walkins` clinic is NOT capped by this: book a future appointment through the patient app for tomorrow (or later today, if slots remain) - it succeeds regardless of the daily cap having been hit. Only the walk-in-at-the-desk path gained a ceiling; advance booking at an `allow_walkins` clinic is exactly as unlimited as before.
4. Free a seat - cancel one of today's walk-ins (`update appointments set status = 'cancelled' where id = '...'`) - and confirm the waitlist fires even though this clinic is `allow_walkins`, not `appointment_only`:
   ```sql
   select status, offered_at from waitlist where clinic_id = '<clinic id>' and date = current_date;
   ```
   `offered` - `notify_waitlist_on_free_seat()` (section 38.3) is no longer appointment-only-mode-gated.

### E. Finding an existing patient by MRN

1. Register a walk-in with a phone number, note their MRN from the result screen (or `select mrn from family_members where id = '<member id>'`).
2. Open **+ Walk-in** again (once a slot is free), leave the name blank, and type that MRN into the **MRN (if known)** field. Submit.
3. Result: **"Matched to an existing patient record - no duplicate created"**, and the MRN shown matches the one from step 1 exactly - `find_family_member_by_mrn()` (section 38.4) found them without touching the phone field at all.
4. Try an MRN that doesn't exist (`MRN-00000000`): refused with *"No patient found with MRN "MRN-00000000" - check the number, or clear it to register a new patient."* - unlike the phone lookup, an unmatched MRN is never treated as "register someone new."

### F. Collecting payment online

Register a walk-in into a free slot with **Collect payment now** set to **Online** instead of Cash. Confirm:
```sql
select payment_status from appointments where id = '<the new appointment id>';
select method, status from payments where appointment_id = '<the new appointment id>';
```
`payment_status = 'paid_online'`, and the payment row is `method = 'online'`, `status = 'captured'` - recorded immediately, the same shape a patient's own paid-online booking ends up in, just captured on the spot rather than held.
