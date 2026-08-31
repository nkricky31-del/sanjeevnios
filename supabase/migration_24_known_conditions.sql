
-- ============================================================================
-- 24. KNOWN CONDITIONS - DATA
-- ============================================================================
-- conditions_ref: a small admin-managed catalog of known-condition options.
-- Names aren't sensitive on their own (it's just a picklist) - readable by
-- anyone logged in, writable only by admin.
create table if not exists conditions_ref (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true
);

insert into conditions_ref (name) values
  ('Diabetes'),
  ('Hypertension (high BP)'),
  ('Asthma/respiratory'),
  ('Thyroid'),
  ('Heart disease'),
  ('Liver disease'),
  ('Kidney disease'),
  ('Cancer'),
  ('Epilepsy'),
  ('Mental-health'),
  ('Pregnancy (current)')
on conflict (name) do nothing;

alter table conditions_ref enable row level security;

drop policy if exists "conditions_ref_select" on conditions_ref;
create policy "conditions_ref_select" on conditions_ref for select
  to authenticated
  using (true);

drop policy if exists "conditions_ref_insert" on conditions_ref;
create policy "conditions_ref_insert" on conditions_ref for insert
  with check (public.is_admin());

drop policy if exists "conditions_ref_update" on conditions_ref;
create policy "conditions_ref_update" on conditions_ref for update
  using (public.is_admin());

-- has_known_conditions is a genuine 3-state answer, not "unset means no" -
-- 'not_answered' is the explicit default until the patient actually
-- answers the question either way.
alter table family_members add column if not exists has_known_conditions text not null default 'not_answered';
alter table family_members drop constraint if exists family_members_has_known_conditions_check;
alter table family_members add constraint family_members_has_known_conditions_check
  check (has_known_conditions in ('yes', 'no', 'not_answered'));
alter table family_members add column if not exists known_conditions_other text;
alter table family_members add column if not exists conditions_updated_at timestamptz;

-- The chosen conditions themselves - a plain many-to-many join, one row per
-- (person, condition). Deliberately not a "latest row wins" history table
-- like documents/consents: a condition list is a SET, so the UI replaces it
-- by deleting the rows that got unchecked and inserting the ones that got
-- checked, rather than layering new rows over old ones.
create table if not exists patient_conditions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references family_members (id) on delete cascade,
  condition_id uuid not null references conditions_ref (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (patient_id, condition_id)
);

alter table patient_conditions enable row level security;

-- Part 40 rule: only the patient themselves, a clinic that has actually
-- seen them (an appointment exists), or admin may read this. is_own_mrn()
-- (section 21) rather than is_own_member() so this correctly covers a
-- person whose identity spans more than one family_members row.
drop policy if exists "patient_conditions_select" on patient_conditions;
create policy "patient_conditions_select" on patient_conditions for select
  using (
    public.is_admin()
    or public.is_own_mrn(patient_id)
    or exists (
      select 1 from appointments a
      where a.member_id = patient_conditions.patient_id and public.is_own_clinic(a.clinic_id)
    )
  );

-- Insert/delete deliberately narrower than select: only the patient
-- themselves (any row sharing their mrn) or admin may WRITE this - a
-- clinic can read it (above) but not edit it, matching family_members'
-- own has_known_conditions/known_conditions_other, which family_update
-- already restricts to the owning account or admin.
drop policy if exists "patient_conditions_insert" on patient_conditions;
create policy "patient_conditions_insert" on patient_conditions for insert
  with check (public.is_admin() or public.is_own_mrn(patient_id));

drop policy if exists "patient_conditions_delete" on patient_conditions;
create policy "patient_conditions_delete" on patient_conditions for delete
  using (public.is_admin() or public.is_own_mrn(patient_id));

-- "log every change": has_known_conditions/known_conditions_other changing
-- on family_members, and every patient_conditions add/remove, each write
-- their own audit_log row. BEFORE UPDATE so it can also stamp
-- conditions_updated_at server-side (not trusting a client-supplied value).
create or replace function public.log_known_conditions_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.has_known_conditions is distinct from old.has_known_conditions
     or new.known_conditions_other is distinct from old.known_conditions_other
  then
    new.conditions_updated_at := now();
    insert into audit_log (actor, action, target)
    values (auth.uid(), 'update_known_conditions', new.id::text);
  end if;
  return new;
end;
$$;

drop trigger if exists on_family_member_conditions_change on family_members;
create trigger on_family_member_conditions_change
  before update on family_members
  for each row execute function public.log_known_conditions_change();

create or replace function public.log_patient_condition_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    insert into audit_log (actor, action, target)
    values (auth.uid(), 'add_patient_condition', new.patient_id::text || ':' || new.condition_id::text);
    return new;
  elsif TG_OP = 'DELETE' then
    insert into audit_log (actor, action, target)
    values (auth.uid(), 'remove_patient_condition', old.patient_id::text || ':' || old.condition_id::text);
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists on_patient_condition_change on patient_conditions;
create trigger on_patient_condition_change
  after insert or delete on patient_conditions
  for each row execute function public.log_patient_condition_change();
