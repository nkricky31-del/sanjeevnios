-- 16. ADMIN VERIFICATION + VERIFIED BADGE
-- ============================================================================
-- A clinic/doctor becomes "is_verified" only once every REQUIRED checklist
-- item has its LATEST documents row at status = 'verified' (and, if it has
-- an expiry_date, not yet expired). Two checklist items - "written consent
-- signed" and "map location set" - aren't file uploads, so rather than
-- inventing a parallel review mechanism for them, they're modelled as
-- ordinary `documents` rows too (doc_type 'written_consent' / 'map_location',
-- storage_path left null), auto-inserted by the triggers below whenever the
-- underlying fact becomes true. That means the existing admin checklist UI
-- (AdminDocumentReview.tsx, driven by src/lib/documentTypes.ts) needs no new
-- review mechanism to cover them - they just show up as one more row with
-- the same Verify/Reject buttons as any uploaded document.

alter table clinics add column if not exists is_verified boolean not null default false;
alter table clinics add column if not exists verified_at timestamptz;
alter table clinics add column if not exists verified_by uuid references profiles (id);

alter table doctors add column if not exists is_verified boolean not null default false;
alter table doctors add column if not exists verified_at timestamptz;
alter table doctors add column if not exists verified_by uuid references profiles (id);

-- Only an admin - or the verification system itself (sync_verification_status
-- below, which sets this session-local flag right before it writes) - may
-- change is_verified/verified_at/verified_by. Without this, clinics_update
-- and doctors_update's existing policies (which already let an owner update
-- most of their own row) would let a clinic simply set its own
-- is_verified = true directly.
create or replace function public.prevent_self_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    new.is_verified is distinct from old.is_verified
    or new.verified_at is distinct from old.verified_at
    or new.verified_by is distinct from old.verified_by
  )
  and not public.is_admin()
  and coalesce(current_setting('sanjeevnios.verification_sync', true), 'false') <> 'true'
  then
    raise exception 'Verification status can only be changed by an admin.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_clinic_verification on clinics;
create trigger guard_clinic_verification
  before update on clinics
  for each row execute function public.prevent_self_verification();

drop trigger if exists guard_doctor_verification on doctors;
create trigger guard_doctor_verification
  before update on doctors
  for each row execute function public.prevent_self_verification();

-- Recomputes and (if changed) writes is_verified/verified_at/verified_by for
-- one clinic or doctor, from the latest row per required doc_type, logging
-- the change to audit_log and notifying the owner. Called automatically by
-- the documents/consents/clinics triggers below - never called directly by
-- the client. security definer so it can write is_verified regardless of who
-- caused the underlying change (e.g. a clinic re-uploading a document that
-- used to be verified, which must be able to drop verification even though
-- the clinic itself has no direct write access to is_verified).
--
-- The required-type lists here must be kept in sync with the
-- `requiredForVerification: true` entries in src/lib/documentTypes.ts.
create or replace function public.sync_verification_status(p_owner_type text, p_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  required_types text[];
  all_ok boolean;
  was_verified boolean;
  owner_name text;
  notify_user_id uuid;
begin
  if p_owner_type = 'clinic' then
    required_types := array['clinic_registration_certificate', 'map_location'];
    select is_verified, name, owner_id into was_verified, owner_name, notify_user_id
    from clinics where id = p_owner_id;
  elsif p_owner_type = 'doctor' then
    required_types := array[
      'written_consent',
      'government_id',
      'medical_registration_certificate',
      'degree_certificate',
      'doctor_clinic_association_proof'
    ];
    select d.is_verified, d.name, c.owner_id into was_verified, owner_name, notify_user_id
    from doctors d join clinics c on c.id = d.clinic_id
    where d.id = p_owner_id;
  else
    return;
  end if;

  if owner_name is null then
    return; -- owner row doesn't exist (shouldn't happen in normal flow)
  end if;

  select coalesce(bool_and(
    coalesce(latest.status, 'missing') = 'verified'
    and (latest.expiry_date is null or latest.expiry_date >= current_date)
  ), false)
  into all_ok
  from unnest(required_types) as t(doc_type)
  left join lateral (
    select status, expiry_date from documents
    where owner_type = p_owner_type and owner_id = p_owner_id and documents.doc_type = t.doc_type
    order by created_at desc
    limit 1
  ) latest on true;

  if all_ok = was_verified then
    return; -- nothing changed
  end if;

  perform set_config('sanjeevnios.verification_sync', 'true', true);

  if p_owner_type = 'clinic' then
    update clinics
    set is_verified = all_ok,
        verified_at = case when all_ok then now() else null end,
        verified_by = case when all_ok then auth.uid() else null end
    where id = p_owner_id;
  else
    update doctors
    set is_verified = all_ok,
        verified_at = case when all_ok then now() else null end,
        verified_by = case when all_ok then auth.uid() else null end
    where id = p_owner_id;
  end if;

  insert into audit_log (actor, action, target)
  values (
    auth.uid(),
    p_owner_type || (case when all_ok then '_verified' else '_verification_dropped' end),
    p_owner_id::text
  );

  if notify_user_id is not null then
    insert into notifications (user_id, type, message)
    values (
      notify_user_id,
      p_owner_type || (case when all_ok then '_verified' else '_verification_dropped' end),
      case when all_ok
        then format('%s "%s" is now VERIFIED on SanjeevniOS.', initcap(p_owner_type), owner_name)
        else format('%s "%s" is no longer VERIFIED - a required item needs your attention.', initcap(p_owner_type), owner_name)
      end
    );
  end if;
end;
$$;

-- Pure read, live-computed "is this owner's badge currently earned" check -
-- used everywhere a patient sees a clinic/doctor (search, doctor page,
-- booking screen). Deliberately does NOT just trust the stored is_verified
-- flag: this app has no cron/scheduled jobs (every time-based rule
-- elsewhere is computed lazily too - see the subscription period rollover),
-- so a document expiring only flips the STORED flag the next time
-- sync_verification_status happens to run for that owner (a re-upload, or
-- an admin re-reviewing) - not the instant the calendar date passes. This
-- function closes that gap for DISPLAY purposes by also checking expiry
-- live, so the hard rule ("never show the badge to anyone not fully
-- verified") always holds even for an owner nobody has touched since a
-- certificate lapsed.
--
-- security definer: a plain patient session can't read another owner's
-- `documents` rows (documents_select is admin/owner-only), so without this
-- the expiry re-check below would silently see zero rows and always pass.
-- This only ever exposes a single boolean, never the underlying documents.
create or replace function public.is_currently_verified(p_owner_type text, p_owner_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    coalesce(
      (select is_verified from clinics where id = p_owner_id and p_owner_type = 'clinic'),
      (select is_verified from doctors where id = p_owner_id and p_owner_type = 'doctor'),
      false
    )
    and not exists (
      select 1 from (
        select distinct on (doc_type) doc_type, status, expiry_date
        from documents
        where owner_type = p_owner_type and owner_id = p_owner_id
        order by doc_type, created_at desc
      ) latest
      where latest.status = 'verified'
        and latest.expiry_date is not null
        and latest.expiry_date < current_date
    );
$$;

-- Any insert or status change on documents can change whether an owner's
-- required checklist is fully satisfied - recompute after every one.
create or replace function public.on_document_change_sync_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_verification_status(new.owner_type, new.owner_id);
  return new;
end;
$$;

drop trigger if exists on_document_change_sync on documents;
create trigger on_document_change_sync
  after insert or update on documents
  for each row execute function public.on_document_change_sync_verification();

-- Signing a (new) consent auto-creates a pending "written_consent" checklist
-- item for admin to review - re-signing (a newer agreement_version) inserts
-- another pending row too, correctly re-opening review of a doctor who was
-- already verified under an older agreement.
create or replace function public.sync_written_consent_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into documents (owner_type, owner_id, doc_type, status)
  values ('doctor', new.doctor_id, 'written_consent', 'pending');
  return new;
end;
$$;

drop trigger if exists on_consent_signed on consents;
create trigger on_consent_signed
  after insert on consents
  for each row execute function public.sync_written_consent_document();

-- Saving (or moving) the clinic's map pin auto-creates a pending
-- "map_location" checklist item for admin to review. Firing again on every
-- future move is intentional: it naturally re-opens review (and, via the
-- documents trigger above, drops is_verified) if a verified clinic's
-- location is changed later.
create or replace function public.sync_map_location_document()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into documents (owner_type, owner_id, doc_type, status)
  values ('clinic', new.id, 'map_location', 'pending');
  return new;
end;
$$;

drop trigger if exists on_clinic_location_saved on clinics;
create trigger on_clinic_location_saved
  after update on clinics
  for each row
  when (
    new.lat is not null and new.lng is not null
    and (old.lat is distinct from new.lat or old.lng is distinct from new.lng)
  )
  execute function public.sync_map_location_document();

-- One-time backfill: clinics/doctors that already had their location set or
-- consent signed before this migration ran won't have picked up a
-- written_consent/map_location document from the triggers above (those only
-- fire on future changes) - give them a pending one now so there's
-- something for admin to review.
insert into documents (owner_type, owner_id, doc_type, status)
select 'clinic', c.id, 'map_location', 'pending'
from clinics c
where c.lat is not null and c.lng is not null
  and not exists (
    select 1 from documents dd
    where dd.owner_type = 'clinic' and dd.owner_id = c.id and dd.doc_type = 'map_location'
  );

insert into documents (owner_type, owner_id, doc_type, status)
select 'doctor', d.id, 'written_consent', 'pending'
from doctors d
where exists (select 1 from consents cs where cs.doctor_id = d.id)
  and not exists (
    select 1 from documents dd
    where dd.owner_type = 'doctor' and dd.owner_id = d.id and dd.doc_type = 'written_consent'
  );

-- Re-declared again with doctor_verified/clinic_verified added, computed
-- live via is_currently_verified() so search results are never stale (see
-- that function's comment re: expiry). Drop first since CREATE OR REPLACE
-- can't change a function's return row shape.
drop function if exists public.search_doctors(text);
create function public.search_doctors(search_term text default '')
returns table (
  doctor_id uuid,
  doctor_name text,
  specialty text,
  clinic_id uuid,
  clinic_name text,
  clinic_address text,
  clinic_lat double precision,
  clinic_lng double precision,
  doctor_verified boolean,
  clinic_verified boolean
)
language sql
stable
as $$
  select
    d.id, d.name, d.specialty, c.id, c.name, c.address, c.lat, c.lng,
    public.is_currently_verified('doctor', d.id),
    public.is_currently_verified('clinic', c.id)
  from doctors d
  join clinics c on c.id = d.clinic_id
  where d.status = 'approved'
    and c.status = 'approved'
    and c.is_active
    and (
      search_term = ''
      or d.name ilike '%' || search_term || '%'
      or d.specialty ilike '%' || search_term || '%'
      or c.name ilike '%' || search_term || '%'
      or c.address ilike '%' || search_term || '%'
    )
  order by c.name, d.name;
$$;
