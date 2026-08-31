
-- ============================================================================
-- 18. MRN + ENCOUNTER NUMBERS
-- ============================================================================
-- MRN: one permanent, unique number per treatable PERSON (an account
-- holder or any of their family members - each is its own family_members
-- row, so mrn lives there). Generated once, on first insert, server-side
-- from a sequence - never reassigned, never reused (see
-- assign_family_member_mrn() below). Before minting a new one, an insert
-- reuses an existing mrn found by matching phone or govt_id against ANY
-- other family_members row platform-wide, so the same human walking into
-- two different clinics (two different family_members rows, since this app
-- doesn't otherwise merge records across clinics/accounts) still ends up
-- with one shared MRN.
--
-- Encounter: one number per VISIT (per appointment), no matter which
-- clinic/doctor. Generated automatically the moment an appointment is
-- created - see create_encounter_for_appointment() below - so nothing in
-- the booking or walk-in UI needs to change to get one.
create sequence if not exists mrn_seq start 1;
create sequence if not exists encounter_seq start 1;

create or replace function public.generate_mrn()
returns text
language sql
as $$
  select 'MRN-' || lpad(nextval('mrn_seq')::text, 8, '0');
$$;

create or replace function public.generate_encounter_no()
returns text
language sql
as $$
  select 'E-' || lpad(nextval('encounter_seq')::text, 8, '0');
$$;

alter table family_members add column if not exists mrn text;
-- Optional match key for MRN reuse alongside phone - not collected anywhere
-- else in this app (no KYC concept for patients), so this stays a plain
-- free-text field the patient/clinic may optionally provide.
alter table family_members add column if not exists govt_id text;

-- BEFORE INSERT so it can set new.mrn directly rather than a follow-up
-- UPDATE. security definer: family_select's RLS only lets a session see
-- its OWN family_members (or, for a clinic, ones tied to its own
-- appointments) - the phone/govt_id search below must see every row
-- platform-wide to do its job, which a plain (non-definer) query couldn't.
create or replace function public.assign_family_member_mrn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_mrn text;
begin
  if new.mrn is not null then
    return new; -- already set (e.g. by the backfill below) - never overwritten
  end if;

  if new.phone is not null then
    select mrn into existing_mrn from family_members
    where phone = new.phone and mrn is not null
    order by created_at asc limit 1;
  end if;

  if existing_mrn is null and new.govt_id is not null then
    select mrn into existing_mrn from family_members
    where govt_id = new.govt_id and mrn is not null
    order by created_at asc limit 1;
  end if;

  new.mrn := coalesce(existing_mrn, public.generate_mrn());
  return new;
end;
$$;

drop trigger if exists on_family_member_assign_mrn on family_members;
create trigger on_family_member_assign_mrn
  before insert on family_members
  for each row execute function public.assign_family_member_mrn();

-- One-time backfill: family_members rows created before this migration
-- have no mrn yet (the trigger above only fires on future inserts) - give
-- them one now, same phone-dedup logic, so mrn can go NOT NULL below
-- without breaking every existing patient's next booking (encounters.mrn
-- is not null, and every future appointment for an existing patient
-- creates one).
do $$
declare
  r record;
  v_mrn text;
begin
  for r in select id, phone from family_members where mrn is null order by created_at asc loop
    v_mrn := null;
    if r.phone is not null then
      select mrn into v_mrn from family_members where phone = r.phone and mrn is not null limit 1;
    end if;
    if v_mrn is null then
      v_mrn := public.generate_mrn();
    end if;
    update family_members set mrn = v_mrn where id = r.id;
  end loop;
end $$;

alter table family_members alter column mrn set not null;
-- Deliberately NOT a unique constraint: mrn is unique per HUMAN, not per
-- row - the whole point of assign_family_member_mrn()'s phone/govt_id
-- lookup above is to let two different family_members rows (e.g. the same
-- person walk-in-registered at two different clinics, each its own row
-- owned by that clinic's account - see claim_walk_in_records() in section
-- 9) legitimately share one mrn. A unique constraint here would reject
-- exactly the reuse this feature is supposed to do.
alter table family_members drop constraint if exists family_members_mrn_key;

-- Every visit, at every clinic, gets its own encounter and encounter_no -
-- tied to exactly one mrn (the patient) and one clinic_id (where it
-- happened). department is a snapshot of the doctor's specialty at the
-- time of the visit (not a live join), same historical-record reasoning as
-- the "latest row wins" pattern used for documents/consents elsewhere.
-- visit_type has no real signal to infer it from at insert time (a walk-in
-- and a same-day online booking look identical on the appointments row),
-- so it defaults to 'OPD' - the only visit type this app actually has.
create table if not exists encounters (
  id uuid primary key default gen_random_uuid(),
  encounter_no text not null unique,
  mrn text not null,
  patient_id uuid not null references family_members (id) on delete cascade,
  clinic_id uuid not null references clinics (id) on delete cascade,
  doctor_id uuid not null references doctors (id) on delete cascade,
  department text,
  visit_datetime timestamptz not null default now(),
  visit_type text not null default 'OPD',
  reason text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

alter table appointments add column if not exists encounter_id uuid references encounters (id);

alter table encounters enable row level security;

drop policy if exists "encounters_select" on encounters;
create policy "encounters_select" on encounters for select
  using (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or exists (select 1 from family_members fm where fm.id = patient_id and fm.account_id = auth.uid())
  );
-- No insert/update/delete policy for any role - encounters are only ever
-- created by the trigger below (security definer, bypasses RLS), matching
-- the same "server-generated, can't be forged by the client" requirement
-- as mrn/encounter_no themselves.

-- BEFORE INSERT on appointments so it can set new.encounter_id directly.
-- security definer: needs to read family_members.mrn/doctors.specialty and
-- write encounters regardless of the calling session's own RLS scope (a
-- patient booking for themselves has no write access to encounters at
-- all, by design above).
create or replace function public.create_encounter_for_appointment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mrn text;
  v_department text;
  new_encounter_id uuid;
begin
  select mrn into v_mrn from family_members where id = new.member_id;
  select specialty into v_department from doctors where id = new.doctor_id;

  insert into encounters (encounter_no, mrn, patient_id, clinic_id, doctor_id, department, visit_datetime)
  values (
    public.generate_encounter_no(),
    v_mrn,
    new.member_id,
    new.clinic_id,
    new.doctor_id,
    v_department,
    (new.date + new.slot_time)::timestamptz
  )
  returning id into new_encounter_id;

  new.encounter_id := new_encounter_id;
  return new;
end;
$$;

drop trigger if exists on_appointment_create_encounter on appointments;
create trigger on_appointment_create_encounter
  before insert on appointments
  for each row execute function public.create_encounter_for_appointment();
