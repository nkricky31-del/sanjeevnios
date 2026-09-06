-- ============================================================================
-- 53. LOCK THE PATIENT NAME - request + admin-reviewed change only
-- ============================================================================
-- Refines the Profile screen (Profile.tsx) and family member records
-- (family_members, see schema.sql section 44/47): a patient's legal name -
-- their own (profiles.name) and every family member's (family_members.name)
-- - can no longer be changed by a plain client update, in either table.
--
-- Four things land together:
--
--   1. name_change_requests - the request itself: current_name +
--      requested_name (optional - the patient may leave the correction to
--      the admin reading their ID) + id_document_path (private storage) +
--      status. member_id null means "my own profiles.name"; set, it means
--      that family member's name.
--
--   2. The 'id-documents' private bucket the government ID is uploaded to -
--      same private-bucket-plus-folder-ownership pattern as
--      'verification-docs' (schema.sql section 45) and 'appointment-files'
--      (section pre-existing): folder = the uploader's own account id, admin
--      can read every folder.
--
--   3. guard_locked_name() - a BEFORE UPDATE trigger on both profiles and
--      family_members. Once a name is set, changing it directly is refused
--      unless app.name_change_write is set (the same "announce yourself"
--      pattern app.checkin_write/app.payment_write already use - see
--      guard_presence_columns(), section 30.5/52.3). A family member's name
--      is NOT NULL from the moment FamilyMemberForm.tsx creates it, so it is
--      locked immediately; profiles.name starts null and PatientOnboardingGate
--      still sets it once during onboarding (old.name is null then, so the
--      guard lets that one write through) - only a change AFTER that first
--      set is blocked. This is enforced in Postgres, not just hidden in the
--      UI: a direct PATCH to either table's name column is rejected same as
--      a UI edit would be.
--
--   4. request_name_change() / review_name_change_request() - the only two
--      doors in or out of that table. A patient calls the first to file a
--      request (never inserts the row directly - there is no insert policy
--      for it). Only an admin can call the second; approving it is the ONLY
--      way the locked name actually changes (it sets app.name_change_write
--      itself, writes the row, and notifies the patient either way -
--      approved or rejected).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 53.1 name_change_requests
-- ----------------------------------------------------------------------------
create table if not exists name_change_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references profiles (id) on delete cascade,
  -- null = this request is for the account holder's own profiles.name.
  -- set = for that family member's family_members.name.
  member_id uuid references family_members (id) on delete cascade,
  current_name text,
  requested_name text,
  id_document_path text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reject_reason text,
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table name_change_requests enable row level security;

-- Only the requesting patient (their own account_id) or an admin can see a
-- request. There is deliberately no insert/update policy for anyone - every
-- write goes through the two SECURITY DEFINER functions below, which run as
-- the table owner and so are unaffected by RLS either way.
drop policy if exists "name_change_requests_select" on name_change_requests;
create policy "name_change_requests_select" on name_change_requests for select
  using (account_id = auth.uid() or public.is_admin());

-- ----------------------------------------------------------------------------
-- 53.2 Private bucket for the government ID proof.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'id-documents', 'id-documents', false, 10485760,
  array['image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "id_documents_select" on storage.objects;
create policy "id_documents_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'id-documents'
    and (
      public.is_admin()
      or (storage.foldername(name))[1] = auth.uid()::text
    )
  );

drop policy if exists "id_documents_insert" on storage.objects;
create policy "id_documents_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'id-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ----------------------------------------------------------------------------
-- 53.3 The name lock itself.
-- ----------------------------------------------------------------------------
create or replace function public.guard_locked_name()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.name_change_write', true), '') = '1' then
    return new;  -- we're inside review_name_change_request()
  end if;

  if old.name is not null and new.name is distinct from old.name then
    raise exception 'This name is locked. Submit a name-change request with a government ID for an admin to review.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_profiles_name on profiles;
create trigger guard_profiles_name
  before update on profiles
  for each row
  execute function public.guard_locked_name();

drop trigger if exists guard_family_members_name on family_members;
create trigger guard_family_members_name
  before update on family_members
  for each row
  execute function public.guard_locked_name();

-- ----------------------------------------------------------------------------
-- 53.4 request_name_change() - the only way a patient can file one.
-- ----------------------------------------------------------------------------
create or replace function public.request_name_change(
  p_member_id uuid,
  p_requested_name text,
  p_id_document_path text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid := auth.uid();
  v_current_name text;
  v_id uuid;
begin
  if v_account_id is null then
    raise exception 'Not signed in.';
  end if;
  if p_id_document_path is null or length(trim(p_id_document_path)) = 0 then
    raise exception 'Upload a government ID document first.';
  end if;

  if p_member_id is null then
    select name into v_current_name from profiles where id = v_account_id;
  else
    if not public.is_own_member(p_member_id) then
      raise exception 'That family member does not belong to you.';
    end if;
    select name into v_current_name from family_members where id = p_member_id;
  end if;

  if exists (
    select 1 from name_change_requests
    where account_id = v_account_id
      and member_id is not distinct from p_member_id
      and status = 'pending'
  ) then
    raise exception 'A name-change request for this person is already pending review.';
  end if;

  insert into name_change_requests (account_id, member_id, current_name, requested_name, id_document_path)
  values (v_account_id, p_member_id, v_current_name, nullif(trim(p_requested_name), ''), p_id_document_path)
  returning id into v_id;

  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 53.5 review_name_change_request() - the only way the locked name actually
-- changes. p_final_name lets the admin correct/confirm the name straight off
-- the ID even when the patient left "requested_name" blank; it falls back to
-- whatever the patient typed.
-- ----------------------------------------------------------------------------
create or replace function public.review_name_change_request(
  p_request_id uuid,
  p_approve boolean,
  p_final_name text default null,
  p_reject_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r name_change_requests;
  v_final_name text;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can review a name-change request.';
  end if;

  select * into r from name_change_requests where id = p_request_id;
  if r.id is null then
    raise exception 'Request not found.';
  end if;
  if r.status <> 'pending' then
    raise exception 'This request has already been reviewed.';
  end if;

  if p_approve then
    v_final_name := coalesce(nullif(trim(p_final_name), ''), r.requested_name);
    if v_final_name is null or length(trim(v_final_name)) = 0 then
      raise exception 'Enter the corrected name to approve this request.';
    end if;

    perform set_config('app.name_change_write', '1', true);
    if r.member_id is null then
      update profiles set name = v_final_name where id = r.account_id;
    else
      update family_members set name = v_final_name where id = r.member_id;
    end if;
    perform set_config('app.name_change_write', '0', true);

    update name_change_requests
    set status = 'approved', requested_name = v_final_name, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_request_id;

    insert into notifications (user_id, type, message)
    values (
      r.account_id,
      'name_change_approved',
      'Your name change request has been approved. The name on file is now "' || v_final_name || '".'
    );
  else
    if p_reject_reason is null or length(trim(p_reject_reason)) = 0 then
      raise exception 'Enter a reason for rejecting this request.';
    end if;

    update name_change_requests
    set status = 'rejected', reject_reason = p_reject_reason, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_request_id;

    insert into notifications (user_id, type, message)
    values (
      r.account_id,
      'name_change_rejected',
      'Your name change request was rejected: "' || p_reject_reason || '"'
    );
  end if;

  insert into audit_log (actor, action, target)
  values (auth.uid(), case when p_approve then 'approve_name_change' else 'reject_name_change' end, p_request_id::text);
end;
$$;
