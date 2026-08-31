# Testing: MRN cross-row fix, DPDP consent, notifications + reason for visit, known conditions

Covers four fixes/features built together:

1. MRN cross-row read gap (appointments/visits/prescriptions/files RLS)
2. DPDP data-consent checkbox
3. Notifications list page + reason-for-visit field
4. Known conditions (patient-declared health conditions)

## Setup (do this first)

Run these four files, **in order**, in the Supabase SQL Editor:

1. `supabase/migration_21_mrn_cross_row_read_fix.sql`
2. `supabase/migration_22_dpdp_consent.sql`
3. `supabase/migration_23_reason_for_visit.sql`
4. `supabase/migration_24_known_conditions.sql`

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
