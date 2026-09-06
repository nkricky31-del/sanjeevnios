-- ============================================================================
-- 58. ONE PHONE, TWO ROLES - a clinic owner/staff member is ALSO a patient
-- ============================================================================
-- Supabase phone auth gives exactly one auth.users row (and so exactly one
-- profiles row) per phone number - there is no way to give one phone a
-- separate "patient account" and "clinic account". So "keep them separate"
-- can't mean two accounts; it means:
--
--   1. RLS access to clinic data must be a CAPABILITY of the account (do
--      they own or staff an approved clinic?), never a one-way, permanent
--      profiles.role flag - otherwise the moment a staff phone with an
--      existing patient history got added to clinic_staff_phones, it would
--      be locked out of ITS OWN patient app forever. is_clinic() (section 3)
--      is redefined below to just call my_clinic_id() (migration 57) - true
--      whenever the account owns or staffs a clinic, independent of
--      whatever profiles.role happens to say. This is the same shape
--      is_own_clinic() already used before this migration existed.
--   2. Nothing here still needs to WRITE profiles.role for a staff phone -
--      migration 57's handle_new_user() and sync_clinic_staff_role() both
--      did that (to make the OLD, role-based is_clinic() true for staff),
--      which is exactly the bug this section fixes: a staff-only phone
--      that already had a patient history would have been permanently
--      flipped to role = 'clinic', and (with App.tsx's role-based routing)
--      could never reach its own patient app again. Undone below.
--   3. WHICH app a dual-capable account currently sees is a per-SESSION
--      choice (src/lib/actingMode.ts), not a database fact - App.tsx reuses
--      the existing Part 50 route guard to enforce "one role open at a
--      time" exactly like it already enforces signed-in vs signed-out.
--      Nothing in this migration changes that; it's a frontend-only piece.
--
-- A clinic OWNER's profiles.role still flips to 'clinic' when they register
-- (register_clinic() / register_clinic_quick_start(), unchanged, several
-- migrations deep) - left alone deliberately. It's no longer load-bearing
-- for RLS (is_clinic() doesn't read it any more), but App.tsx still reads it
-- as the DEFAULT acting mode for a session that hasn't explicitly chosen one
-- yet, so an existing single-role clinic owner keeps landing straight in
-- their console exactly as before, without a behavior change.
-- ============================================================================

-- is_clinic() (schema.sql section 3) - was `current_role() = 'clinic'`, now
-- true for anyone who owns or staffs an approved... actually any clinic
-- (my_clinic_id() doesn't require 'approved' - staff access to a
-- draft/pending clinic's own dashboard is still staff access), independent
-- of profiles.role. Every policy that already calls is_clinic() (walk-in
-- availability in particular - see migrations 25/38) picks this up with no
-- further changes.
create or replace function public.is_clinic()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.my_clinic_id() is not null;
$$;

-- handle_new_user() (schema.sql section 2) - reverted to always starting a
-- brand new account as 'patient'. migration_57's version pre-promoted a
-- brand-new phone straight to 'clinic' if it was already in
-- clinic_staff_phones - harmless for someone who really is clinic-only, but
-- wrong the moment that same phone also wants its own patient history
-- (there was no way back once handle_new_user() was the one setting it).
-- is_clinic() above no longer needs this: clinic capability is read live
-- from clinic_staff_phones/owner_id on every check, not cached onto role at
-- signup time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, phone, role)
  values (new.id, new.phone, 'patient')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- sync_clinic_staff_role() (migration 57) no longer has anything correct to
-- do - is_clinic()/is_own_clinic() don't read profiles.role any more, so
-- there is nothing left to "sync". Dropped rather than left as dead code;
-- src/lib/AuthContext.tsx's call to it is removed in this same change.
drop function if exists public.sync_clinic_staff_role();
