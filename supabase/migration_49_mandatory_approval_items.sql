-- ============================================================================
-- 49. MANDATORY ITEMS BEFORE A CLINIC (OR DOCTOR) CAN BE APPROVED
-- ============================================================================
-- Today, approving a clinic or doctor (AdminConsole.tsx's Approve button) only
-- checks "no document is currently REJECTED" (clinicsWithRejection /
-- hasUnresolvedRejection in src/lib/documents.ts) - a clinic/doctor with ZERO
-- documents uploaded, or with everything sitting at 'pending' review, sails
-- through untouched. Separately, section 16's sync_verification_status()
-- computes the VERIFIED badge from its own hardcoded required-type arrays,
-- which have already drifted from src/lib/documentTypes.ts's
-- `requiredForVerification` flags (that function's clinic set omits
-- clinic_address_proof/clinic_license; its doctor set omits doctor_photo).
-- And neither axis has ever affected the other: rejecting a document could
-- drop is_verified to false while status stayed 'approved' forever.
--
--   * verification_requirements - the "required" flag becomes admin-owned
--     data, not a hardcoded array duplicated in two places (schema.sql and
--     documentTypes.ts). One row per (owner_type, doc_type), exactly the
--     conditions_ref pattern (section 24): readable by anyone authenticated,
--     writable only by public.is_admin(), no delete policy (flip the flag,
--     don't remove the row - src/lib/documentTypes.ts still needs every
--     doc_type's config regardless of whether it's currently required).
--     Seeded with the set actually asked for: clinic_registration_certificate
--     and map_location required for a clinic; government_id and
--     medical_registration_certificate required for a doctor (plus
--     written_consent, since that one is the platform agreement itself, not
--     a discretionary document). Everything else - clinic_address_proof,
--     clinic_license, degree_certificate, doctor_clinic_association_proof,
--     doctor_photo - starts optional; the admin can flip any of these live
--     from the new "Requirements" tab, no deploy needed.
--   * is_owner_approval_ready(owner_type, owner_id) - true iff every item
--     marked required for that owner_type has a LATEST documents row that is
--     'verified' and not expired. This is now the ONE place that answers
--     "can this be approved" - both the new server-side gate below and
--     sync_verification_status() call it, so "approved" and "verified" can
--     never drift the way status/is_verified used to.
--   * enforce_clinic_approval_requirements() / enforce_doctor_approval_requirements()
--     - two new BEFORE UPDATE triggers, firing only on old.status <> 'approved'
--     -> new.status = 'approved', raising if is_owner_approval_ready() is
--     false. This is the part that can't be bypassed by calling the API
--     directly - RLS already restricts the 'approved' transition to admin
--     sessions only, but said nothing about WHETHER the clinic/doctor was
--     actually ready. AdminConsole.tsx's disabled Approve button is now just
--     the UI reflection of this same rule, computed client-side from the
--     same documents + verification_requirements rows it already has to load
--     for the checklist - not a separate, potentially-drifting check.
--   * sync_verification_status() - rewritten to call is_owner_approval_ready()
--     instead of its own hardcoded arrays (closing the drift noted above),
--     and to ALSO drop status from 'approved' back to 'pending' the moment
--     all_ok flips false while it was previously true - "drop the clinic/
--     doctor out of approved state" the spec asks for. Since this only
--     changes anything inside the existing "did all_ok actually change"
--     guard, it fires exactly once, at exactly the moment a required item
--     gets rejected (or a fresh sync notices an expiry) - not on every
--     unrelated document event.
--   * is_currently_verified() (badge visibility) is UNCHANGED - it already
--     live-checks expiry_date on every read for display purposes ("hide the
--     VERIFIED badge" already just works, reusing Part 39 exactly as asked).
--     What's missing without a cron job (this app has none, by design - see
--     section 29's own note) is the STATUS actually flipping back to
--     'pending' purely because a calendar date passed with no other document
--     event to trigger a resync - sweep_expired_verifications() closes that
--     gap the same "sweep on load" way section 29.4's auto_mark_no_shows()
--     and section 46's sweep_follow_up_reminders() already do: AdminConsole.tsx
--     calls it once when the verification tab loads.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 49.1 verification_requirements - the admin-owned "required" flag
-- ----------------------------------------------------------------------------
create table if not exists verification_requirements (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('clinic', 'doctor')),
  doc_type text not null,
  required boolean not null default false,
  created_at timestamptz not null default now(),
  unique (owner_type, doc_type)
);

insert into verification_requirements (owner_type, doc_type, required) values
  ('clinic', 'clinic_registration_certificate', true),
  ('clinic', 'clinic_address_proof', false),
  ('clinic', 'clinic_license', false),
  ('clinic', 'map_location', true),
  ('doctor', 'government_id', true),
  ('doctor', 'medical_registration_certificate', true),
  ('doctor', 'degree_certificate', false),
  ('doctor', 'doctor_clinic_association_proof', false),
  ('doctor', 'doctor_photo', false),
  ('doctor', 'written_consent', true)
on conflict (owner_type, doc_type) do nothing;

alter table verification_requirements enable row level security;

drop policy if exists "verification_requirements_select" on verification_requirements;
create policy "verification_requirements_select" on verification_requirements for select
  to authenticated
  using (true);

drop policy if exists "verification_requirements_insert" on verification_requirements;
create policy "verification_requirements_insert" on verification_requirements for insert
  with check (public.is_admin());

drop policy if exists "verification_requirements_update" on verification_requirements;
create policy "verification_requirements_update" on verification_requirements for update
  using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 49.2 is_owner_approval_ready() - the one true "can this be approved" check
-- ----------------------------------------------------------------------------
create or replace function public.is_owner_approval_ready(p_owner_type text, p_owner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    bool_and(
      coalesce(latest.status, 'missing') = 'verified'
      and (latest.expiry_date is null or latest.expiry_date >= current_date)
    ),
    true -- no required items configured at all - nothing to block on
  )
  from verification_requirements vr
  left join lateral (
    select status, expiry_date from documents
    where owner_type = p_owner_type and owner_id = p_owner_id and documents.doc_type = vr.doc_type
    order by created_at desc
    limit 1
  ) latest on true
  where vr.owner_type = p_owner_type and vr.required = true;
$$;

-- ----------------------------------------------------------------------------
-- 49.3 The server-side approval gate - cannot be bypassed by calling the API
-- directly, since RLS already means only an admin session reaches this
-- UPDATE at all, and this now also has to be true.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_clinic_approval_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if not public.is_owner_approval_ready('clinic', new.id) then
      raise exception 'Cannot approve this clinic - every required item must be uploaded and verified first.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_clinic_approve_check on clinics;
create trigger on_clinic_approve_check
  before update on clinics
  for each row
  execute function public.enforce_clinic_approval_requirements();

create or replace function public.enforce_doctor_approval_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    if not public.is_owner_approval_ready('doctor', new.id) then
      raise exception 'Cannot approve this doctor - every required item must be uploaded and verified first.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_doctor_approve_check on doctors;
create trigger on_doctor_approve_check
  before update on doctors
  for each row
  execute function public.enforce_doctor_approval_requirements();

-- ----------------------------------------------------------------------------
-- 49.4 sync_verification_status() - now driven by is_owner_approval_ready(),
-- and now also drops status out of 'approved' the moment that flips false.
-- ----------------------------------------------------------------------------
create or replace function public.sync_verification_status(p_owner_type text, p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  all_ok boolean;
  was_verified boolean;
  owner_name text;
  owner_status text;
  notify_user_id uuid;
  dropped boolean;
begin
  if p_owner_type = 'clinic' then
    select is_verified, name, status, owner_id into was_verified, owner_name, owner_status, notify_user_id
    from clinics where id = p_owner_id;
  elsif p_owner_type = 'doctor' then
    select d.is_verified, d.name, d.status, c.owner_id into was_verified, owner_name, owner_status, notify_user_id
    from doctors d join clinics c on c.id = d.clinic_id
    where d.id = p_owner_id;
  else
    return;
  end if;

  if owner_name is null then
    return; -- owner row doesn't exist (shouldn't happen in normal flow)
  end if;

  all_ok := public.is_owner_approval_ready(p_owner_type, p_owner_id);

  if all_ok = was_verified then
    return; -- nothing changed
  end if;

  -- "Drop the clinic/doctor out of approved state" - only ever fires here,
  -- at the exact moment a required item that WAS satisfied stops being so
  -- (a rejection, or a resync noticing an expiry) - never on the way UP,
  -- re-approval after a drop is always the admin's own explicit decision.
  dropped := owner_status = 'approved' and not all_ok;

  perform set_config('sanjeevnios.verification_sync', 'true', true);

  if p_owner_type = 'clinic' then
    update clinics
    set is_verified = all_ok,
        verified_at = case when all_ok then now() else null end,
        verified_by = case when all_ok then auth.uid() else null end,
        status = case when dropped then 'pending' else status end
    where id = p_owner_id;
  else
    update doctors
    set is_verified = all_ok,
        verified_at = case when all_ok then now() else null end,
        verified_by = case when all_ok then auth.uid() else null end,
        status = case when dropped then 'pending' else status end
    where id = p_owner_id;
  end if;

  insert into audit_log (actor, action, target)
  values (
    auth.uid(),
    p_owner_type || (case when all_ok then '_verified' when dropped then '_dropped_from_approved' else '_verification_dropped' end),
    p_owner_id::text
  );

  if notify_user_id is not null then
    insert into notifications (user_id, type, message)
    values (
      notify_user_id,
      p_owner_type || (case when all_ok then '_verified' when dropped then '_dropped_from_approved' else '_verification_dropped' end),
      case
        when all_ok then format('%s "%s" is now VERIFIED on SanjeevniOS.', initcap(p_owner_type), owner_name)
        when dropped then format(
          '%s "%s" has been moved back to pending review - a required item is missing, rejected, or has expired. It is hidden from patients until an admin re-approves it.',
          initcap(p_owner_type), owner_name
        )
        else format('%s "%s" is no longer VERIFIED - a required item needs your attention.', initcap(p_owner_type), owner_name)
      end
    );
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 49.5 sweep_expired_verifications() - best-effort, no cron required (see
-- this migration's header) - mirrors auto_mark_no_shows()/
-- sweep_follow_up_reminders()'s own "the console sweeps on load" pattern.
-- ----------------------------------------------------------------------------
create or replace function public.sweep_expired_verifications()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
  r record;
begin
  for r in
    select distinct d.owner_type, d.owner_id
    from documents d
    where d.status = 'verified'
      and d.expiry_date is not null
      and d.expiry_date < current_date
      and (
        (d.owner_type = 'clinic' and exists (
          select 1 from clinics c where c.id = d.owner_id and (c.is_verified or c.status = 'approved')
        ))
        or (d.owner_type = 'doctor' and exists (
          select 1 from doctors doc where doc.id = d.owner_id and (doc.is_verified or doc.status = 'approved')
        ))
      )
  loop
    perform public.sync_verification_status(r.owner_type, r.owner_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
