-- ============================================================================
-- 51. FIX: AN APPROVED CLINIC/DOCTOR CAN'T UPDATE ITS OWN SETTINGS
-- ============================================================================
-- Found while testing section 50's new past_slot_buffer_minutes setting:
-- saving it from ClinicBookingMode.tsx failed with "new row violates row-
-- level security policy for table 'clinics'" - for ANY already-approved
-- clinic, on ANY field, not just this new one.
--
-- clinics_update's WITH CHECK (section 45) reads:
--   is_admin() or (owner_id = auth.uid() and status in ('draft', 'pending'))
-- doctors_update's (section 14) has the identical shape, one level down.
-- The stated intent (section 45's own comment) was narrower than what got
-- written: "the owning clinic may only move itself between draft and
-- pending - approved/rejected stays admin-only." But a WITH CHECK clause
-- only ever sees the proposed NEW row, with no way to compare it to the OLD
-- one - so this ended up gating every column, on every update, by the FINAL
-- status value alone. The moment a clinic (or doctor) is approved, its own
-- owner can no longer save ANYTHING on it - booking mode, cap, cutoffs, map
-- location, a doctor's fee or specialty, nothing - because the row's own
-- status is 'approved', which fails that check regardless of which column
-- was actually being changed.
--
-- Fixed the same way this schema already fixes exactly this class of
-- problem elsewhere (prevent_self_verification(), section 16 - "some
-- columns need a rule WITH CHECK can't express because it can't see the OLD
-- row"): relax both WITH CHECKs to plain ownership, and move the actual
-- status-transition restriction into a trigger, which CAN compare
-- OLD.status to NEW.status. A clinic/doctor can now freely edit its own
-- settings at any status; only actually changing status TO 'approved' or
-- 'rejected' still requires an admin - exactly the original intent, now
-- correctly expressed.
-- ============================================================================

drop policy if exists "clinics_update" on clinics;
create policy "clinics_update" on clinics for update
  using (owner_id = auth.uid() or public.is_admin())
  with check (owner_id = auth.uid() or public.is_admin());

create or replace function public.prevent_self_clinic_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved', 'rejected')
     and not public.is_admin()
  then
    raise exception 'Only an admin can approve or reject a clinic.';
  end if;
  return new;
end;
$$;

drop trigger if exists on_clinic_prevent_self_approval on clinics;
create trigger on_clinic_prevent_self_approval
  before update on clinics
  for each row
  execute function public.prevent_self_clinic_approval();

drop policy if exists "doctors_update" on doctors;
create policy "doctors_update" on doctors for update
  using (public.is_own_clinic(clinic_id) or public.is_admin())
  with check (public.is_own_clinic(clinic_id) or public.is_admin());

create or replace function public.prevent_self_doctor_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and new.status in ('approved', 'rejected')
     and not public.is_admin()
  then
    raise exception 'Only an admin can approve or reject a doctor.';
  end if;
  return new;
end;
$$;

drop trigger if exists on_doctor_prevent_self_approval on doctors;
create trigger on_doctor_prevent_self_approval
  before update on doctors
  for each row
  execute function public.prevent_self_doctor_approval();
