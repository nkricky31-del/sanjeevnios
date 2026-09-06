-- ============================================================================
-- 47. MULTI-MEMBER BOOKING FIX
-- ============================================================================
-- Booking has always been algorithmically PER MEMBER - appointments.member_id
-- already keys everything downstream (the queue, payments, MRNs, encounters)
-- - but nothing on the write path ever actually enforced that, and the
-- PATIENT APP layered its own account-wide assumption on top: the Home
-- screen's "next appointment" query looked for the soonest still-open
-- booking across EVERY family member on the account, then swapped its
-- primary "Book an appointment" button for Reschedule/View Details tied to
-- that ONE appointment - so once any single member had a live booking, the
-- app behaved as if the whole ACCOUNT could only ever have one at a time.
--
--   * appointments_member_clinic_day_active_unique - the one guard that was
--     actually missing: a given MEMBER can't hold two still-open bookings at
--     the SAME clinic on the SAME day (whichever doctor - two different
--     doctors at one clinic on one day for one person is a duplicate
--     registration, not two separate visits). Scoped to member_id, so a
--     second family member booking the same clinic on the same day is
--     completely untouched - that's the whole point of this fix. "Still-
--     open" excludes completed/cancelled/rejected/no_show, matching every
--     other status-scoped uniqueness rule already in this schema (e.g.
--     appointments_active_token_unique, section 27.4).
--   * This is a plain unique index, not a locked-counter trigger like
--     enforce_slot_capacity()/enforce_booking_policy() - a uniqueness check
--     on a single row is already atomic under Postgres, so there is no
--     read-then-write race to close here the way there is for a COUNT(*)
--     against a capacity limit.
--   * The client-side half of this fix (an explicit member picker before
--     date/slot selection, the Home screen always offering "Book an
--     appointment" regardless of any one member's status, and My Appointments
--     always labelling each row with its member) lives in the app repo, not
--     here - this migration is only the DB-level guarantee a client bug can
--     never bypass.
-- ============================================================================

create unique index if not exists appointments_member_clinic_day_active_unique
  on appointments (member_id, clinic_id, date)
  where status not in ('completed', 'cancelled', 'rejected', 'no_show');
