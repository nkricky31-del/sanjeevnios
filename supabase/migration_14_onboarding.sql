-- 14. CLINIC/DOCTOR ONBOARDING: written consent and documents
-- ============================================================================

-- Every document a clinic or a doctor uploads for verification - one row per
-- upload. A re-upload after a rejection is a NEW row rather than an update
-- to the old one (same "latest row wins" pattern already used for
-- visits/prescriptions), so the review history isn't destroyed - the
-- checklist UI always reads the most recent row per (owner_type, owner_id,
-- doc_type).
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('clinic', 'doctor')),
  owner_id uuid not null,
  doc_type text not null,
  storage_path text,
  number text,
  expiry_date date,
  not_applicable boolean not null default false,
  not_applicable_note text,
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  review_note text,
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
-- owner_id is polymorphic (a clinics.id or a doctors.id depending on
-- owner_type) so it can't carry a normal foreign key - ownership is instead
-- enforced entirely through the RLS policies below.

-- The doctor's written consent to the "Agreement to join Sanjeevni" - one
-- row per signature. A newer agreement_version being signed again is a new
-- row, not an update, preserving the full consent history.
create table if not exists consents (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors (id) on delete cascade,
  agreement_version text not null,
  signature_name text not null,
  agreed_at timestamptz not null default now(),
  ip text,
  file_url text
);

alter table documents enable row level security;
alter table consents enable row level security;

-- True if the calling clinic owns the given (owner_type, owner_id) pair -
-- i.e. it's either their own clinic-level documents, or one of their own
-- doctors' documents. security definer for the same reason is_own_clinic
-- and owns_doctor already are (avoids RLS-recursion pitfalls when used
-- inside another table's policy).
create or replace function public.owns_document_owner(p_owner_type text, p_owner_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case p_owner_type
    when 'clinic' then public.is_own_clinic(p_owner_id)
    when 'doctor' then public.owns_doctor(p_owner_id)
    else false
  end;
$$;

drop policy if exists "documents_select" on documents;
create policy "documents_select" on documents for select
  using (public.is_admin() or public.owns_document_owner(owner_type, owner_id));

drop policy if exists "documents_insert" on documents;
create policy "documents_insert" on documents for insert
  with check (public.owns_document_owner(owner_type, owner_id));

-- Only admin sets status/review fields - the clinic re-uploading is always a
-- fresh INSERT (see the table comment above), never an UPDATE.
drop policy if exists "documents_update" on documents;
create policy "documents_update" on documents for update
  using (public.is_admin());

drop policy if exists "consents_select" on consents;
create policy "consents_select" on consents for select
  using (public.is_admin() or public.owns_doctor(doctor_id));

drop policy if exists "consents_insert" on consents;
create policy "consents_insert" on consents for insert
  with check (public.owns_doctor(doctor_id));

-- A new doctor now starts as 'draft' (invisible to admin, same as 'pending'
-- already was to patients) until the clinic actually finishes onboarding
-- them - see enforce_doctor_submission_requirements() below for what
-- "finished" means. Existing rows already satisfy this constraint (draft is
-- purely an added option, not a replacement for any existing value).
alter table doctors alter column status set default 'draft';
alter table doctors drop constraint if exists doctors_status_check;
alter table doctors add constraint doctors_status_check
  check (status in ('draft', 'pending', 'approved', 'rejected'));

-- Previously a clinic could set its own doctor's status to ANYTHING,
-- including 'approved' - reaffirming this spec's own rule ("nothing goes
-- live until admin approves it"), a clinic may now only move its doctor
-- between draft and pending itself; approved/rejected stays admin-only.
drop policy if exists "doctors_update" on doctors;
create policy "doctors_update" on doctors for update
  using (public.is_own_clinic(clinic_id) or public.is_admin())
  with check (
    public.is_admin()
    or (public.is_own_clinic(clinic_id) and status in ('draft', 'pending'))
  );

-- Blocks a doctor from moving out of 'draft' unless the onboarding
-- agreement has been signed AND every required document has an on-file
-- upload whose latest attempt wasn't rejected. This is the hard version of
-- the rule the onboarding screen also checks client-side before showing
-- "Submit for review" - this trigger is what actually can't be bypassed by
-- calling the API directly.
--
-- The required-doc-type list here must be kept in sync with the `required:
-- true` entries for ownerType 'doctor' in src/lib/documentTypes.ts.
create or replace function public.enforce_doctor_submission_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  has_consent boolean;
  missing_required int;
begin
  if new.status = 'pending' and old.status = 'draft' then
    select exists(select 1 from consents where doctor_id = new.id) into has_consent;
    if not has_consent then
      raise exception 'This doctor has not signed the onboarding agreement yet.';
    end if;

    select count(*) into missing_required
    from unnest(array[
      'government_id',
      'medical_registration_certificate',
      'degree_certificate',
      'doctor_clinic_association_proof'
    ]) as t(required_type)
    where not exists (
      select 1 from (
        select distinct on (doc_type) doc_type, status
        from documents
        where owner_type = 'doctor' and owner_id = new.id
        order by doc_type, created_at desc
      ) latest
      where latest.doc_type = t.required_type and latest.status <> 'rejected'
    );

    if missing_required > 0 then
      raise exception 'All required documents must be uploaded before submitting this doctor for review.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_doctor_submit_check on doctors;
create trigger on_doctor_submit_check
  before update on doctors
  for each row
  execute function public.enforce_doctor_submission_requirements();
