-- ============================================================================
-- SanjeevniOS database schema + Row-Level Security (RLS)
-- Paste this whole file into Supabase Dashboard -> SQL Editor -> Run.
-- Safe to re-run: it drops and recreates policies/functions, but NOT tables
-- (tables use "create table if not exists" so re-running won't wipe data).
-- ============================================================================

create extension if not exists "pgcrypto"; -- gives us gen_random_uuid()

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

-- One row per logged-in user. role decides what they can see everywhere else.
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'patient' check (role in ('patient', 'clinic', 'admin')),
  name text,
  phone text unique,
  created_at timestamptz not null default now()
);

-- Family members a patient books appointments for (including themselves).
create table if not exists family_members (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references profiles (id) on delete cascade,
  name text not null,
  relation text,
  dob date,
  guardian_consent boolean not null default false,
  created_at timestamptz not null default now()
);

-- Only these four relations are allowed.
alter table family_members drop constraint if exists family_relation_check;
alter table family_members
  add constraint family_relation_check
  check (relation in ('self', 'spouse', 'child', 'parent'));

-- The database itself refuses to save a family member under 18 without
-- guardian consent — this can't be bypassed by calling the API directly.
alter table family_members drop constraint if exists guardian_consent_required_for_minors;
alter table family_members
  add constraint guardian_consent_required_for_minors
  check (dob is null or dob <= (current_date - interval '18 years') or guardian_consent);

-- A clinic account. owner_id is the profile (role='clinic') that manages it.
create table if not exists clinics (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles (id) on delete cascade,
  name text not null,
  reg_no text,
  address text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  subscription_tier text not null default 'free',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Doctors that work at a clinic.
create table if not exists doctors (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  name text not null,
  reg_no text,
  specialty text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);

-- Weekly recurring working hours per doctor.
create table if not exists doctor_availability (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_time time not null,
  end_time time not null,
  max_patients_per_day int not null default 20
);

-- A booking. member_id links back to the patient's account via family_members.
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references family_members (id) on delete cascade,
  doctor_id uuid not null references doctors (id) on delete cascade,
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  slot_time time not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'cancelled', 'in_progress', 'done', 'no_show')),
  token_no int,
  payment_status text not null default 'unpaid',
  created_at timestamptz not null default now()
);

-- What happened during the visit for one appointment.
create table if not exists visits (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id) on delete cascade,
  notes text,
  diagnosis text,
  follow_up_date date,
  created_at timestamptz not null default now()
);

-- The prescription written for a visit.
create table if not exists prescriptions (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits (id) on delete cascade,
  items jsonb not null default '[]',
  file_url text,
  signed_by uuid references doctors (id),
  status text not null default 'draft',
  created_at timestamptz not null default now()
);

-- Uploaded documents (lab reports, ID proofs, etc.) linked to a member and/or visit.
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references family_members (id) on delete cascade,
  appointment_id uuid references appointments (id) on delete cascade,
  type text,
  storage_path text not null,
  created_at timestamptz not null default now()
);

-- Payment for one appointment.
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id) on delete cascade,
  amount numeric not null,
  method text not null check (method in ('online', 'cod')),
  status text not null default 'pending',
  payout_status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- Which billing plan a clinic is on, and this period's usage.
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  tier text not null default 'free',
  bookings_used int not null default 0,
  period_start date,
  period_end date
);

-- Platform-wide history of who did what (admin-only).
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references profiles (id),
  action text not null,
  target text,
  at timestamptz not null default now()
);

-- In-app notifications for a user.
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  type text,
  message text not null,
  read boolean not null default false,
  at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. AUTO-CREATE A PROFILE ROW WHEN SOMEONE SIGNS UP
--    Without this, a new user would have no profiles row, and every RLS
--    check (which reads profiles.role) would fail for them.
-- ----------------------------------------------------------------------------

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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop a patient from editing their own role to become 'admin' or 'clinic'.
-- Only an existing admin is allowed to change someone's role.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role <> old.role and public.current_role() <> 'admin' then
    raise exception 'Only an admin can change a role.';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. HELPER FUNCTIONS USED BY THE SECURITY RULES BELOW
--    "security definer" lets these look up profiles/clinics without
--    triggering RLS recursion on those tables.
-- ----------------------------------------------------------------------------

create or replace function public.current_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.current_role() = 'admin';
$$;

create or replace function public.is_clinic()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.current_role() = 'clinic';
$$;

-- True if the given clinic belongs to the logged-in clinic user.
create or replace function public.is_own_clinic(target_clinic_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from clinics where id = target_clinic_id and owner_id = auth.uid()
  );
$$;

-- True if the given family member belongs to the logged-in patient.
create or replace function public.is_own_member(target_member_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from family_members where id = target_member_id and account_id = auth.uid()
  );
$$;

-- Now that current_role() exists, attach the role-escalation guard.
drop trigger if exists guard_profile_role on profiles;
create trigger guard_profile_role
  before update on profiles
  for each row execute function public.prevent_role_escalation();

-- ----------------------------------------------------------------------------
-- 4. ROW-LEVEL SECURITY
--    Turn RLS on for every table, then say exactly who can read/write what.
-- ----------------------------------------------------------------------------

alter table profiles enable row level security;
alter table family_members enable row level security;
alter table clinics enable row level security;
alter table doctors enable row level security;
alter table doctor_availability enable row level security;
alter table appointments enable row level security;
alter table visits enable row level security;
alter table prescriptions enable row level security;
alter table files enable row level security;
alter table payments enable row level security;
alter table subscriptions enable row level security;
alter table audit_log enable row level security;
alter table notifications enable row level security;

-- profiles: you can see/edit your own profile; admin sees/edits everyone's.
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update" on profiles;
create policy "profiles_update" on profiles for update
  using (id = auth.uid() or public.is_admin());

-- family_members: the owning patient manages their own list.
-- A clinic can also view a member's basic info once that member has booked
-- an appointment at their clinic (needed to run the clinic's queue).
drop policy if exists "family_select" on family_members;
create policy "family_select" on family_members for select
  using (
    account_id = auth.uid()
    or public.is_admin()
    or (public.is_clinic() and exists (
      select 1 from appointments a
      where a.member_id = family_members.id and public.is_own_clinic(a.clinic_id)
    ))
  );

drop policy if exists "family_insert" on family_members;
create policy "family_insert" on family_members for insert
  with check (account_id = auth.uid() or public.is_admin());

drop policy if exists "family_update" on family_members;
create policy "family_update" on family_members for update
  using (account_id = auth.uid() or public.is_admin());

-- clinics: anyone logged in can browse approved & active clinics (needed to
-- book with them). The owning clinic account always sees its own row
-- regardless of status. Admin sees and approves/rejects everything.
drop policy if exists "clinics_select" on clinics;
create policy "clinics_select" on clinics for select
  using (
    (status = 'approved' and is_active)
    or owner_id = auth.uid()
    or public.is_admin()
  );

drop policy if exists "clinics_insert" on clinics;
create policy "clinics_insert" on clinics for insert
  with check (owner_id = auth.uid() or public.is_admin());

drop policy if exists "clinics_update" on clinics;
create policy "clinics_update" on clinics for update
  using (owner_id = auth.uid() or public.is_admin());

-- doctors: the owning clinic manages its doctors. Anyone can view doctors
-- at an approved, active clinic (needed to book).
drop policy if exists "doctors_select" on doctors;
create policy "doctors_select" on doctors for select
  using (
    public.is_own_clinic(clinic_id)
    or public.is_admin()
    or exists (
      select 1 from clinics c
      where c.id = doctors.clinic_id and c.status = 'approved' and c.is_active
    )
  );

drop policy if exists "doctors_insert" on doctors;
create policy "doctors_insert" on doctors for insert
  with check (public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "doctors_update" on doctors;
create policy "doctors_update" on doctors for update
  using (public.is_own_clinic(clinic_id) or public.is_admin());

-- doctor_availability: same pattern as doctors.
drop policy if exists "availability_select" on doctor_availability;
create policy "availability_select" on doctor_availability for select
  using (
    public.is_admin()
    or exists (select 1 from doctors d where d.id = doctor_availability.doctor_id and public.is_own_clinic(d.clinic_id))
    or exists (
      select 1 from doctors d join clinics c on c.id = d.clinic_id
      where d.id = doctor_availability.doctor_id and c.status = 'approved' and c.is_active
    )
  );

drop policy if exists "availability_write" on doctor_availability;
create policy "availability_write" on doctor_availability for all
  using (
    public.is_admin()
    or exists (select 1 from doctors d where d.id = doctor_availability.doctor_id and public.is_own_clinic(d.clinic_id))
  );

-- appointments: the booking patient and the clinic it's booked at can both
-- see/manage it. Admin sees everything.
drop policy if exists "appointments_select" on appointments;
create policy "appointments_select" on appointments for select
  using (public.is_own_member(member_id) or public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "appointments_insert" on appointments;
create policy "appointments_insert" on appointments for insert
  with check (public.is_own_member(member_id) or public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "appointments_update" on appointments;
create policy "appointments_update" on appointments for update
  using (public.is_own_member(member_id) or public.is_own_clinic(clinic_id) or public.is_admin());

-- visits: only the clinic that ran the visit writes it; the patient and
-- that clinic can both read it.
drop policy if exists "visits_select" on visits;
create policy "visits_select" on visits for select
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a
      where a.id = visits.appointment_id
        and (public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "visits_write" on visits;
create policy "visits_write" on visits for all
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a where a.id = visits.appointment_id and public.is_own_clinic(a.clinic_id)
    )
  );

-- prescriptions: same ownership chain as visits, via visit_id.
drop policy if exists "prescriptions_select" on prescriptions;
create policy "prescriptions_select" on prescriptions for select
  using (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id
        and (public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "prescriptions_write" on prescriptions;
create policy "prescriptions_write" on prescriptions for all
  using (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id and public.is_own_clinic(a.clinic_id)
    )
  );

-- files: the owning patient or the clinic tied to the appointment can access.
drop policy if exists "files_select" on files;
create policy "files_select" on files for select
  using (
    public.is_admin()
    or public.is_own_member(member_id)
    or exists (
      select 1 from appointments a where a.id = files.appointment_id and public.is_own_clinic(a.clinic_id)
    )
  );

drop policy if exists "files_insert" on files;
create policy "files_insert" on files for insert
  with check (
    public.is_admin()
    or public.is_own_member(member_id)
    or exists (
      select 1 from appointments a where a.id = files.appointment_id and public.is_own_clinic(a.clinic_id)
    )
  );

-- payments: same ownership chain as appointments.
drop policy if exists "payments_select" on payments;
create policy "payments_select" on payments for select
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a
      where a.id = payments.appointment_id
        and (public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "payments_write" on payments;
create policy "payments_write" on payments for all
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a
      where a.id = payments.appointment_id
        and (public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

-- subscriptions: only the owning clinic and admin can see billing info.
-- Only admin sets it (clinics don't self-upgrade in v0).
drop policy if exists "subscriptions_select" on subscriptions;
create policy "subscriptions_select" on subscriptions for select
  using (public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "subscriptions_write" on subscriptions;
create policy "subscriptions_write" on subscriptions for all
  using (public.is_admin());

-- audit_log: admin-only, platform-wide trail.
drop policy if exists "audit_select" on audit_log;
create policy "audit_select" on audit_log for select
  using (public.is_admin());

drop policy if exists "audit_insert" on audit_log;
create policy "audit_insert" on audit_log for insert
  with check (actor = auth.uid() or public.is_admin());

-- notifications: you only ever see your own.
drop policy if exists "notifications_select" on notifications;
create policy "notifications_select" on notifications for select
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "notifications_update" on notifications;
create policy "notifications_update" on notifications for update
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists "notifications_insert" on notifications;
create policy "notifications_insert" on notifications for insert
  with check (public.is_admin());

-- ============================================================================
-- 5. SEARCH & BOOK AN APPOINTMENT
--    Everything below supports: searching approved doctors/clinics, picking
--    a slot, booking, and the live queue counter.
-- ============================================================================

-- A doctor now needs to be individually approved (not just their clinic),
-- and needs a price so an online payment has an amount to hold.
alter table doctors add column if not exists consultation_fee numeric not null default 0;
alter table doctors drop constraint if exists doctors_status_check;
alter table doctors alter column status set default 'pending';
alter table doctors add constraint doctors_status_check check (status in ('pending', 'approved', 'rejected'));

-- Re-do doctor visibility: the public/booking branch now also requires the
-- doctor themself to be approved, not just their clinic.
drop policy if exists "doctors_select" on doctors;
create policy "doctors_select" on doctors for select
  using (
    public.is_own_clinic(clinic_id)
    or public.is_admin()
    or (
      status = 'approved'
      and exists (select 1 from clinics c where c.id = doctors.clinic_id and c.status = 'approved' and c.is_active)
    )
  );

-- Same fix for availability: only show slots for doctors who are approved.
drop policy if exists "availability_select" on doctor_availability;
create policy "availability_select" on doctor_availability for select
  using (
    public.is_admin()
    or exists (select 1 from doctors d where d.id = doctor_availability.doctor_id and public.is_own_clinic(d.clinic_id))
    or exists (
      select 1 from doctors d join clinics c on c.id = d.clinic_id
      where d.id = doctor_availability.doctor_id and d.status = 'approved' and c.status = 'approved' and c.is_active
    )
  );

-- SECURITY FIX: the original appointments_update policy let a patient set
-- their own booking's status to ANYTHING, including 'accepted' - meaning a
-- patient could self-approve their own booking and skip the clinic (and
-- the payment capture that's supposed to happen on real acceptance). Now:
-- a patient may only cancel their own still-pending/accepted booking;
-- every other transition (accept/reject/start/done/no_show) is clinic-only.
drop policy if exists "appointments_update" on appointments;
create policy "appointments_update" on appointments for update
  using (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (public.is_own_member(member_id) and status in ('pending', 'accepted'))
  )
  with check (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (public.is_own_member(member_id) and status = 'cancelled')
  );

-- Search clinics/doctors by name, specialty, or city (matched against the
-- clinic's address). Runs as the calling user (no "security definer"), so
-- it only ever returns what the existing RLS above already allows to be seen.
create or replace function public.search_doctors(search_term text default '')
returns table (
  doctor_id uuid,
  doctor_name text,
  specialty text,
  clinic_id uuid,
  clinic_name text,
  clinic_address text
)
language sql
stable
as $$
  select d.id, d.name, d.specialty, c.id, c.name, c.address
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

-- A patient waiting for their turn needs to see the queue MOVE, but RLS
-- correctly blocks them from reading other patients' appointment rows.
-- This function exposes only the two fields needed for the live counter
-- (token number + status) for every booking on a given doctor/date -
-- nothing that identifies which patient it belongs to.
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (token_no int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select a.token_no, a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.token_no is not null
  order by a.token_no;
$$;

-- A patient picking a slot needs to know which times are already taken by
-- OTHER patients on that doctor/date - but RLS correctly hides other
-- patients' appointment rows. This exposes only the slot_time, nothing else.
create or replace function public.get_taken_slots(p_doctor_id uuid, p_date date)
returns table (slot_time time)
language sql
stable
security definer
set search_path = public
as $$
  select a.slot_time
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status not in ('rejected', 'cancelled');
$$;

-- When the clinic ACCEPTS a booking: assign its queue token number, and
-- flip a held online payment to captured. When the clinic REJECTS (or a
-- booking is cancelled): release a held online payment back to refunded.
-- COD bookings have no "hold" to touch, so they're untouched here.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
declare
  next_token int;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    if new.token_no is null then
      select coalesce(max(token_no), 0) + 1 into next_token
      from appointments
      where doctor_id = new.doctor_id
        and date = new.date
        and status not in ('pending', 'rejected', 'cancelled');
      new.token_no := next_token;
    end if;
    if new.payment_status = 'hold' then
      new.payment_status := 'captured';
    end if;
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
  elsif new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'hold' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status = 'hold';
  end if;
  return new;
end;
$$;

drop trigger if exists on_appointment_status_change on appointments;
create trigger on_appointment_status_change
  before update on appointments
  for each row execute function public.handle_appointment_status_change();

-- Whenever a booking's status or queue position changes, ping anyone
-- watching that doctor's queue for that date, so their live counter
-- updates immediately instead of waiting for a manual refresh.
create or replace function public.broadcast_appointment_queue_change()
returns trigger
security definer
set search_path = public
language plpgsql
as $$
begin
  perform realtime.broadcast_changes(
    'queue:' || new.doctor_id::text || ':' || new.date::text,
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return new;
end;
$$;

drop trigger if exists on_appointment_queue_broadcast on appointments;
create trigger on_appointment_queue_broadcast
  after update on appointments
  for each row
  when (old.status is distinct from new.status or old.token_no is distinct from new.token_no)
  execute function public.broadcast_appointment_queue_change();

-- Let any logged-in user receive broadcasts on "queue:*" channels. Safe to
-- open up broadly because the payload only ever carries token_no + status
-- (see get_queue_status above) - never anything identifying a patient.
drop policy if exists "queue_broadcast_select" on realtime.messages;
create policy "queue_broadcast_select" on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() like 'queue:%'
  );

-- ============================================================================
-- 6. REMINDERS, FILE UPLOADS, HEALTH TIMELINE, CANCEL/RESCHEDULE
-- ============================================================================

-- A notification can now point at the booking it's about (nullable - not
-- every notification will be appointment-related).
alter table notifications add column if not exists appointment_id uuid references appointments(id);

-- The in-app "30 minutes away" / "you're next" reminders are written by the
-- patient's own browser as they happen, so a user now needs to be able to
-- insert a notification for THEMSELVES (previously admin-only).
drop policy if exists "notifications_insert" on notifications;
create policy "notifications_insert" on notifications for insert
  with check (public.is_admin() or user_id = auth.uid());

-- Cancelling now also has to respect a minimum notice window - re-declared
-- here with the added time check (everything else is unchanged from before).
drop policy if exists "appointments_update" on appointments;
create policy "appointments_update" on appointments for update
  using (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (public.is_own_member(member_id) and status in ('pending', 'accepted'))
  )
  with check (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (
      public.is_own_member(member_id)
      and status = 'cancelled'
      and (date + slot_time)::timestamp > now() + interval '2 hours'
    )
  );

-- Private bucket for appointment file uploads. Size/type limits are enforced
-- by Storage itself here, not just the app's UI - an oversized or wrong-type
-- file is rejected by the API before it's ever accepted, not just hidden by
-- a form validator that a direct API call could skip.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'appointment-files', 'appointment-files', false, 10485760,
  array['image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Files are stored as "{appointment_id}/{random}-{filename}", so access can
-- follow the exact same appointment-ownership rule as everything else: the
-- booking patient and the clinic that appointment belongs to. Note: this app
-- has no separate per-doctor login yet - "the assigned doctor" is
-- represented by their clinic's account, same as the rest of the clinic side.
drop policy if exists "appointment_files_select" on storage.objects;
create policy "appointment_files_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'appointment-files'
    and exists (
      select 1 from appointments a
      where a.id::text = (storage.foldername(name))[1]
        and (public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id) or public.is_admin())
    )
  );

drop policy if exists "appointment_files_insert" on storage.objects;
create policy "appointment_files_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'appointment-files'
    and exists (
      select 1 from appointments a
      where a.id::text = (storage.foldername(name))[1]
        and (public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id) or public.is_admin())
    )
  );

-- ============================================================================
-- 7. CLINIC SELF-SIGNUP
--    A logged-in patient can turn their own account into a clinic account by
--    registering a clinic. The clinic row starts 'pending' and every doctor
--    added under it starts 'pending' (see the doctors table default above) -
--    the existing doctors_select/availability_select policies from section 5
--    already keep both invisible to patient search until an admin approves
--    them, so nothing there needs to change.
-- ============================================================================

-- Previously ANY role change required an existing admin. That's still true
-- for anything involving 'admin', but a patient registering a clinic (see
-- register_clinic() below) needs to flip their own role from 'patient' to
-- 'clinic'. That specific transition is safe to self-serve: it doesn't grant
-- any extra visibility by itself - the new clinic is still 'pending' and
-- hidden from patient search/booking until an admin approves it.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role <> old.role
     and public.current_role() <> 'admin'
     and not (old.role = 'patient' and new.role = 'clinic')
  then
    raise exception 'Only an admin can change a role.';
  end if;
  return new;
end;
$$;

-- Registers a clinic for the calling user and flips their profile to the
-- 'clinic' role in one atomic call, so the UI never has to juggle a
-- half-finished signup (role flipped but no clinic row, or vice versa).
-- Deliberately NOT security definer: it runs as the calling user, so the
-- normal clinics_insert / profiles_update RLS policies (and the relaxed
-- prevent_role_escalation trigger above) apply exactly as if the client had
-- made both calls itself - this function only makes them one transaction.
create or replace function public.register_clinic(p_name text, p_reg_no text, p_address text)
returns clinics
language plpgsql
as $$
declare
  new_clinic clinics;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to register a clinic.';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Clinic name is required.';
  end if;

  if exists (select 1 from clinics where owner_id = auth.uid()) then
    raise exception 'This account already has a registered clinic.';
  end if;

  update profiles set role = 'clinic' where id = auth.uid() and role = 'patient';

  insert into clinics (owner_id, name, reg_no, address, status, is_active)
  values (
    auth.uid(),
    trim(p_name),
    nullif(trim(coalesce(p_reg_no, '')), ''),
    nullif(trim(coalesce(p_address, '')), ''),
    'pending',
    true
  )
  returning * into new_clinic;

  return new_clinic;
end;
$$;

-- ============================================================================
-- 8. CLINIC DAILY CONSOLE: inbox, live queue, reminders, walk-ins
-- ============================================================================

-- Rejecting an appointment now records why (shown to the patient), and each
-- appointment tracks how many "your turn is coming up" reminders the clinic
-- has sent it. The check constraint caps it at 5 at the DB level, so the
-- limit holds even if a client bug tries to send more.
alter table appointments add column if not exists reject_reason text;
alter table appointments add column if not exists reminder_count int not null default 0;
alter table appointments drop constraint if exists appointments_reminder_count_check;
alter table appointments add constraint appointments_reminder_count_check
  check (reminder_count between 0 and 5);

-- The live-queue broadcast (section 5) only fired on a status or token_no
-- change. Sending a reminder touches neither, so a patient sitting on their
-- booking status page wouldn't see it arrive live - widen the trigger to
-- also fire when reminder_count changes.
drop trigger if exists on_appointment_queue_broadcast on appointments;
create trigger on_appointment_queue_broadcast
  after update on appointments
  for each row
  when (
    old.status is distinct from new.status
    or old.token_no is distinct from new.token_no
    or old.reminder_count is distinct from new.reminder_count
  )
  execute function public.broadcast_appointment_queue_change();

-- A clinic needs to notify the PATIENT (not itself) on accept, on reject,
-- and when sending a reminder - previously notifications_insert only let you
-- write your own row. Widened to also allow a clinic to insert a
-- notification tied to an appointment at its own clinic - same
-- appointment-ownership chain visits/prescriptions/payments already use.
drop policy if exists "notifications_insert" on notifications;
create policy "notifications_insert" on notifications for insert
  with check (
    public.is_admin()
    or user_id = auth.uid()
    or (
      appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = notifications.appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  );

-- ============================================================================
-- 9. WALK-IN REGISTRATION: contact + demographics, and claiming that
--    history later once the same phone number does a real signup
-- ============================================================================

-- Walk-ins are registered as a family_members row owned by the CLINIC's own
-- account (see WalkInForm.tsx) - these extra fields let that registration
-- capture the same basics a real patient signup would.
alter table family_members add column if not exists phone text;
alter table family_members add column if not exists gender text;
alter table family_members drop constraint if exists family_members_gender_check;
alter table family_members add constraint family_members_gender_check
  check (gender is null or gender in ('male', 'female', 'other'));

-- When a walk-in's phone number later signs up for real (the normal OTP
-- login), this re-parents any family_members rows a CLINIC created under
-- that same phone number onto the new patient's own account - which is
-- enough to bring their whole visit history into view, since appointments
-- are keyed off family_members.id, not account_id, so nothing else needs to
-- move. Called automatically after every login (see AuthContext.tsx).
--
-- security definer, and reads the phone from auth.users itself rather than
-- any caller-supplied value - so this can only ever claim records filed
-- under a phone number the caller has actually verified via OTP, never one
-- they merely type in.
create or replace function public.claim_walk_in_records()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  my_phone text;
begin
  select phone into my_phone from auth.users where id = auth.uid();
  if my_phone is null then
    return;
  end if;

  update family_members
  set account_id = auth.uid()
  where phone = my_phone
    and account_id <> auth.uid()
    and account_id in (select owner_id from clinics);
end;
$$;

-- ============================================================================
-- 10. CONSULTATION: e-prescription completeness, full-day cancellation
-- ============================================================================

-- A visit isn't "done" until it either has an attached e-prescription or the
-- doctor has explicitly said none is needed - this flag is that explicit
-- opt-out (see VisitScreen.tsx / ClinicQueue.tsx's move-to-done gate).
alter table visits add column if not exists no_prescription boolean not null default false;

-- ============================================================================
-- 11. ADMIN VERIFICATION CONSOLE
-- ============================================================================

-- Reason shown to the clinic/doctor when rejected - same idea as
-- appointments.reject_reason above.
alter table clinics add column if not exists reject_reason text;
alter table doctors add column if not exists reject_reason text;

-- Optional registration document (certificate, license, etc.) uploaded at
-- signup, for the admin to review before approving. Nullable - not a hard
-- requirement in v0, a clinic/doctor can still be approved without one.
alter table clinics add column if not exists registration_doc_path text;
alter table doctors add column if not exists registration_doc_path text;

-- Private bucket for those documents.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'verification-docs', 'verification-docs', false, 10485760,
  array['image/jpeg', 'image/png', 'application/pdf']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- True if the given doctor belongs to a clinic the logged-in clinic user
-- owns. security definer, same reasoning as is_own_clinic/is_own_member
-- above: this is used INSIDE the storage policies below, and evaluating a
-- plain (non-security-definer) subquery against doctors from inside another
-- table's RLS policy is exactly the kind of thing that pattern exists to
-- avoid - so this gets the same treatment rather than an inline EXISTS.
create or replace function public.owns_doctor(target_doctor_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from doctors d
    join clinics c on c.id = d.clinic_id
    where d.id = target_doctor_id and c.owner_id = auth.uid()
  );
$$;

-- Uploaded as "clinics/{clinic_id}/{filename}" or "doctors/{doctor_id}/{filename}".
-- The owning clinic can upload/read its own; admin can read everyone's (to
-- actually review them before approving).
drop policy if exists "verification_docs_select" on storage.objects;
create policy "verification_docs_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'verification-docs'
    and (
      public.is_admin()
      or (
        (storage.foldername(name))[1] = 'clinics'
        and public.is_own_clinic(((storage.foldername(name))[2])::uuid)
      )
      or (
        (storage.foldername(name))[1] = 'doctors'
        and public.owns_doctor(((storage.foldername(name))[2])::uuid)
      )
    )
  );

drop policy if exists "verification_docs_insert" on storage.objects;
create policy "verification_docs_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'verification-docs'
    and (
      (
        (storage.foldername(name))[1] = 'clinics'
        and public.is_own_clinic(((storage.foldername(name))[2])::uuid)
      )
      or (
        (storage.foldername(name))[1] = 'doctors'
        and public.owns_doctor(((storage.foldername(name))[2])::uuid)
      )
    )
  );

-- ============================================================================
-- 12. ADMIN: SUBSCRIPTIONS, USAGE LIMITS, ACCESS CONTROL
-- ============================================================================

-- One subscription row per clinic - guarantees the "get or create" logic in
-- the trigger below (and the admin console's upsert-by-tier) always targets
-- exactly one row, never creates a duplicate.
alter table subscriptions drop constraint if exists subscriptions_clinic_id_unique;
alter table subscriptions add constraint subscriptions_clinic_id_unique unique (clinic_id);

alter table subscriptions drop constraint if exists subscriptions_tier_check;
alter table subscriptions add constraint subscriptions_tier_check
  check (tier in ('free', 'pro', 'premium'));

-- Blocks a new appointment outright if the clinic is inactive, or if it's on
-- the free tier and already at/over its booking limit for the current
-- period - applies uniformly to patient bookings AND clinic-entered
-- walk-ins, since both go through this same appointments table. Lazily
-- creates a clinic's subscription row (defaulting to free) the first time
-- it's needed, and lazily rolls the period over once it's expired, so no
-- scheduled job is required anywhere.
--
-- security definer: a plain patient booking an appointment has no RLS
-- access to read/write `subscriptions` (subscriptions_select/write are
-- admin+own-clinic only) - this needs to touch it regardless of who's
-- making the booking, so it runs with the function owner's privileges,
-- bypassing that RLS entirely (same reasoning as is_own_clinic() etc above).
--
-- The free-tier limit (50) is display-mirrored in src/lib/subscription.ts
-- for the admin/clinic UI - THIS is what's actually enforced.
create or replace function public.enforce_clinic_booking_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  clinic_is_active boolean;
  sub subscriptions;
  limit_val int;
begin
  select is_active into clinic_is_active from clinics where id = new.clinic_id;
  if clinic_is_active is false then
    raise exception 'This clinic isn''t currently accepting bookings.';
  end if;

  select * into sub from subscriptions where clinic_id = new.clinic_id;

  if sub.id is null then
    insert into subscriptions (clinic_id, tier, bookings_used, period_start, period_end)
    values (new.clinic_id, 'free', 0, current_date, (current_date + interval '1 month')::date)
    returning * into sub;
  elsif sub.period_end is null or sub.period_end < current_date then
    update subscriptions
    set bookings_used = 0, period_start = current_date, period_end = (current_date + interval '1 month')::date
    where id = sub.id
    returning * into sub;
  end if;

  limit_val := case sub.tier when 'free' then 50 else null end;

  if limit_val is not null and sub.bookings_used >= limit_val then
    raise exception 'This clinic has reached its booking limit for this period. Please try again later or contact the clinic.';
  end if;

  update subscriptions set bookings_used = bookings_used + 1 where id = sub.id;

  return new;
end;
$$;

drop trigger if exists on_appointment_enforce_subscription on appointments;
create trigger on_appointment_enforce_subscription
  before insert on appointments
  for each row
  execute function public.enforce_clinic_booking_limit();

-- ============================================================================
-- 13. ADMIN: MONITORING, PAYMENTS OVERSIGHT, ABUSE CONTROL
-- ============================================================================

-- Suspending a USER (patient or clinic owner) is a narrower, account-level
-- lock than clinics.is_active (which suspends a CLINIC's ability to take
-- bookings regardless of who's acting). A suspended account can't create
-- new appointments - whether they're a patient booking for themselves or a
-- clinic owner entering a walk-in - since both go through this same insert.
alter table profiles add column if not exists suspended boolean not null default false;

drop policy if exists "appointments_insert" on appointments;
create policy "appointments_insert" on appointments for insert
  with check (
    not exists (select 1 from profiles where id = auth.uid() and suspended)
    and (public.is_own_member(member_id) or public.is_own_clinic(clinic_id) or public.is_admin())
  );

-- ============================================================================
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

-- ============================================================================
-- 15. CLINIC MAP LOCATION
-- ============================================================================

-- No new RLS needed: clinics_select/clinics_update already govern these
-- exactly like every other clinic column (owner sees/edits their own;
-- patients see them once the clinic is approved+active).
alter table clinics add column if not exists lat double precision;
alter table clinics add column if not exists lng double precision;
alter table clinics add column if not exists formatted_address text;

-- Re-declared with clinic_lat/clinic_lng added to the result so the patient
-- search page can sort/filter by "nearest to me" - drop first since
-- CREATE OR REPLACE can't change a function's return row shape.
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
  clinic_lng double precision
)
language sql
stable
as $$
  select d.id, d.name, d.specialty, c.id, c.name, c.address, c.lat, c.lng
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

-- ============================================================================
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

-- ============================================================================
-- 17. PATIENT DECLARATION + PLATFORM DISCLAIMER
-- ============================================================================
-- Records a patient's acceptance of the plain-English "Sanjeevni is a
-- booking platform, not a care provider" declaration - shown once at signup
-- (PatientDeclarationGate.tsx, wraps the whole patient app in App.tsx) and
-- again on their first booking confirmation (BookingForm.tsx). "Latest row
-- wins" for version currency, same pattern as consents: accepting a new
-- declaration_version later is a new row, not an update, so the acceptance
-- history is never destroyed.
create table if not exists patient_declarations (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references profiles (id) on delete cascade,
  declaration_version text not null,
  accepted_at timestamptz not null default now(),
  ip text
);

alter table patient_declarations enable row level security;

drop policy if exists "patient_declarations_select" on patient_declarations;
create policy "patient_declarations_select" on patient_declarations for select
  using (patient_id = auth.uid() or public.is_admin());

drop policy if exists "patient_declarations_insert" on patient_declarations;
create policy "patient_declarations_insert" on patient_declarations for insert
  with check (patient_id = auth.uid());
-- No update/delete policy - an immutable acceptance record, same as consents.

-- Blocks booking at the DB level if the patient has never accepted any
-- version of the declaration - the hard version of the check
-- PatientDeclarationGate.tsx/BookingForm.tsx also do client-side. Checks
-- that a row EXISTS, not that it's the CURRENT version - "must be the
-- current version" stays a client-side/UX concern (re-prompted at signup
-- and at first booking on a version bump), the same tradeoff already made
-- for the doctor consent flow in enforce_doctor_submission_requirements().
--
-- Deliberately skipped for a clinic (or admin) creating the appointment:
-- walk-ins are booked BY the clinic on the patient's behalf, under a
-- family_members row owned by the CLINIC's own account (see
-- claim_walk_in_records() in section 9) - that's not a patient using the
-- self-service app, so the declaration doesn't apply there.
create or replace function public.enforce_patient_declaration_before_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_patient_id uuid;
  has_declaration boolean;
begin
  if public.is_own_clinic(new.clinic_id) or public.is_admin() then
    return new;
  end if;

  select account_id into booking_patient_id from family_members where id = new.member_id;
  select exists(
    select 1 from patient_declarations where patient_id = booking_patient_id
  ) into has_declaration;

  if not has_declaration then
    raise exception 'You must accept the platform declaration before booking.';
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_declaration_check on appointments;
create trigger on_appointment_declaration_check
  before insert on appointments
  for each row execute function public.enforce_patient_declaration_before_booking();

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

-- ============================================================================
-- 19. PATIENT PROFILE WITH ENCOUNTER LIST
-- ============================================================================
-- Three more optional fields on family_members, needed for the patient
-- profile header (see PatientProfile.tsx). No new RLS needed - governed by
-- the same family_select/family_update policies as every other column on
-- this table.
alter table family_members add column if not exists email text;
alter table family_members add column if not exists blood_group text;
alter table family_members add column if not exists city text;

-- ============================================================================
-- 20. ROLE-BASED ENCOUNTER ACCESS
-- ============================================================================
-- Replaces the single combined "encounters_select" policy from section 18
-- with three separate, individually-named policies - Postgres OR's together
-- every permissive policy that applies to a given SELECT, so this behaves
-- identically to one big OR'd condition, but each rule reads and audits on
-- its own exactly as specified:
--
--   Admin:   MRN = selected patient                    -> show all encounters
--   Patient: MRN = logged-in patient                    -> show all their encounters
--   Clinic:  MRN = selected patient AND clinic_id = my clinic -> show only that clinic's encounters
--
-- This is enforced entirely in the database - PatientProfile.tsx just runs
-- a plain `select * from encounters where mrn = ?` with no role branching
-- of its own, so a direct API call (bypassing the UI, or a bug in it)
-- cannot leak another clinic's rows: Postgres itself never returns them.
--
-- One real bug fixed here vs section 18's version: the old patient branch
-- matched `fm.id = patient_id` (the exact family_members row THIS
-- encounter happens to reference), not the patient's mrn. Since one human
-- can have several family_members rows sharing an mrn (see section 18 -
-- e.g. a walk-in row at a clinic they haven't logged into yet, alongside
-- their own self-registered row), that missed encounters filed under a
-- sibling row the patient doesn't directly own. Matching by mrn instead
-- correctly surfaces every encounter tied to their identity, regardless of
-- which specific row each one happens to reference.
drop policy if exists "encounters_select" on encounters;

create policy "encounters_select_admin" on encounters for select
  using (public.is_admin());

create policy "encounters_select_patient" on encounters for select
  using (
    exists (
      select 1 from family_members fm
      where fm.account_id = auth.uid() and fm.mrn = encounters.mrn
    )
  );

create policy "encounters_select_clinic" on encounters for select
  using (public.is_own_clinic(clinic_id));

-- ============================================================================
-- 21. CLOSE MRN CROSS-ROW READ GAP
-- ============================================================================
-- is_own_member(member_id) (section 3) only matches the EXACT family_members
-- row a booking references. Since one human can have several family_members
-- rows sharing an mrn (a walk-in row at a clinic they haven't logged into
-- yet, alongside their own self-registered row - see section 18), a patient
-- could see the ENCOUNTER for a visit filed under a sibling row (fixed for
-- encounters in section 20) but still get an empty appointment/visit/
-- prescription/files read for it, because those tables' own SELECT policies
-- were still keyed off the exact row, not the person.
--
-- is_own_mrn() closes that: true if the target family_members row's mrn
-- matches ANY family_members row the caller's own account owns. It's a
-- strict superset of is_own_member() (a row always shares its own mrn with
-- itself), so every SELECT policy below simply replaces one with the other.
-- INSERT/UPDATE policies are deliberately left alone - creating or
-- cancelling a booking should still only ever act on a row the caller
-- actually owns, not any row that happens to share their mrn (some of
-- which may be owned by a CLINIC's account, not the patient's).
create or replace function public.is_own_mrn(target_member_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from family_members target
    join family_members mine on mine.mrn = target.mrn
    where target.id = target_member_id and mine.account_id = auth.uid()
  );
$$;

drop policy if exists "appointments_select" on appointments;
create policy "appointments_select" on appointments for select
  using (public.is_own_mrn(member_id) or public.is_own_clinic(clinic_id) or public.is_admin());

drop policy if exists "visits_select" on visits;
create policy "visits_select" on visits for select
  using (
    public.is_admin()
    or exists (
      select 1 from appointments a
      where a.id = visits.appointment_id
        and (public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "prescriptions_select" on prescriptions;
create policy "prescriptions_select" on prescriptions for select
  using (
    public.is_admin()
    or exists (
      select 1 from visits v join appointments a on a.id = v.appointment_id
      where v.id = prescriptions.visit_id
        and (public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id))
    )
  );

drop policy if exists "files_select" on files;
create policy "files_select" on files for select
  using (
    public.is_admin()
    or public.is_own_mrn(member_id)
    or exists (
      select 1 from appointments a where a.id = files.appointment_id and public.is_own_clinic(a.clinic_id)
    )
  );

-- Same gap, same fix, for the actual file download (not just the files
-- table row) - otherwise a patient could see the file exists but not
-- open it.
drop policy if exists "appointment_files_select" on storage.objects;
create policy "appointment_files_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'appointment-files'
    and exists (
      select 1 from appointments a
      where a.id::text = (storage.foldername(name))[1]
        and (public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id) or public.is_admin())
    )
  );

-- ============================================================================
-- 22. DPDP DATA-CONSENT CHECKBOX
-- ============================================================================
-- A second, separate consent - handling the patient's personal/health data
-- under the DPDP Act - reusing patient_declarations' shape (patient_id,
-- version, accepted_at, ip) rather than a parallel table, since it's the
-- exact same kind of record. `consent_type` is the only new thing:
-- 'platform_disclaimer' is the existing declaration from section 17,
-- 'dpdp_data_consent' is this one - each tracked, versioned, and re-prompted
-- on a wording change entirely independently of the other (see
-- usePatientConsent.ts). Existing rows default to 'platform_disclaimer' so
-- nothing already accepted needs to be re-accepted under the old type.
alter table patient_declarations add column if not exists consent_type text not null default 'platform_disclaimer';

-- Redeclared to also require the DPDP consent before a self-service booking,
-- same "hard version of the rule" reasoning as the platform declaration -
-- still skipped for a clinic/admin creating the appointment (walk-ins,
-- see section 17's version of this function for why).
create or replace function public.enforce_patient_declaration_before_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_patient_id uuid;
  has_platform_declaration boolean;
  has_dpdp_consent boolean;
begin
  if public.is_own_clinic(new.clinic_id) or public.is_admin() then
    return new;
  end if;

  select account_id into booking_patient_id from family_members where id = new.member_id;

  select
    exists(select 1 from patient_declarations where patient_id = booking_patient_id and consent_type = 'platform_disclaimer'),
    exists(select 1 from patient_declarations where patient_id = booking_patient_id and consent_type = 'dpdp_data_consent')
  into has_platform_declaration, has_dpdp_consent;

  if not has_platform_declaration then
    raise exception 'You must accept the platform declaration before booking.';
  end if;
  if not has_dpdp_consent then
    raise exception 'You must accept the data-sharing consent before booking.';
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 23. REASON FOR VISIT
-- ============================================================================
-- encounters.reason (section 18) has had no way to ever be populated -
-- nothing in the booking or walk-in flow captured it. Adding it to
-- appointments (optional, filled in by the patient/clinic at booking time)
-- and copying it onto the encounter at creation, same snapshot pattern as
-- department/visit_type already use.
alter table appointments add column if not exists reason text;

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

  insert into encounters (encounter_no, mrn, patient_id, clinic_id, doctor_id, department, visit_datetime, reason)
  values (
    public.generate_encounter_no(),
    v_mrn,
    new.member_id,
    new.clinic_id,
    new.doctor_id,
    v_department,
    (new.date + new.slot_time)::timestamptz,
    new.reason
  )
  returning id into new_encounter_id;

  new.encounter_id := new_encounter_id;
  return new;
end;
$$;

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

-- ============================================================================
-- 25. WALK-IN FIXES: duplicate-patient linking, clinic holidays
-- ============================================================================
-- A clinic registering a walk-in needs to know if this phone number already
-- belongs to an existing patient (either their own real account, or a walk-in
-- stub created by ANY clinic) so it can attach the visit to that same
-- family_members row instead of creating a duplicate one. Plain RLS can't
-- support this lookup: family_select only lets a clinic see a member once
-- THAT clinic already has an appointment with them - which is exactly the
-- chicken-and-egg this function exists to break. security definer, and
-- gated to clinic/admin callers since it returns a name+mrn for a phone
-- number the caller didn't necessarily "own" the way an appointment implies.
-- Prefers a row owned by a genuine patient account over a clinic-created
-- stub (the real identity should win over a placeholder); among ties, the
-- oldest row (the original identity, not a later duplicate).
create or replace function public.find_family_member_by_phone(p_phone text)
returns table (id uuid, mrn text, name text)
language sql
stable
security definer
set search_path = public
as $$
  select fm.id, fm.mrn, fm.name
  from family_members fm
  join profiles p on p.id = fm.account_id
  where fm.phone = p_phone
    and (public.is_clinic() or public.is_admin())
  order by (p.role = 'patient') desc, fm.created_at asc
  limit 1;
$$;

-- Specific dates a clinic is closed (festival, doctor leave covering the
-- whole clinic, etc.) - on top of the existing weekly doctor_availability.
-- Deliberately clinic-scoped, not per-doctor: the ask ("respect the clinic's
-- ... holidays") and the walk-in flow's own framing are both clinic-level,
-- and a per-doctor version can be layered on later without a shape change
-- here if it turns out to be needed.
create table if not exists clinic_holidays (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (clinic_id, date)
);

alter table clinic_holidays enable row level security;

-- Readable by the owning clinic, admin, or anyone booking (needs to know
-- which dates to grey out) as long as the clinic is publicly visible -
-- same visibility rule doctors/availability already use.
drop policy if exists "clinic_holidays_select" on clinic_holidays;
create policy "clinic_holidays_select" on clinic_holidays for select
  using (
    public.is_own_clinic(clinic_id)
    or public.is_admin()
    or exists (
      select 1 from clinics c
      where c.id = clinic_holidays.clinic_id and c.status = 'approved' and c.is_active
    )
  );

drop policy if exists "clinic_holidays_write" on clinic_holidays;
create policy "clinic_holidays_write" on clinic_holidays for all
  using (public.is_own_clinic(clinic_id) or public.is_admin())
  with check (public.is_own_clinic(clinic_id) or public.is_admin());

-- ============================================================================
-- 26. QUEUE POSITIONS: token_no becomes a recomputed position, not a
--     stored-once identity assigned in booking order
-- ============================================================================
-- Previously handle_appointment_status_change() (section 5) assigned
-- token_no once, at accept time, as max(token_no)+1 over that doctor/date -
-- i.e. BOOKING order. That's what let a 4 PM booking get a lower token than
-- a 1 PM booking made later the same day. token_no is now a cached,
-- recomputed queue POSITION: the real ordering inputs (slot_time,
-- created_at, checked_in_at, patient_type) are stored, and
-- recompute_queue_positions() derives 1..N fresh from them every time the
-- active queue changes.

alter table appointments add column if not exists checked_in_at timestamptz;
-- 'walk_in' rows are, by construction, checked in the moment they're
-- created (see below) - no slot to hold, no grace period to wait out.
-- 'scheduled' is everything booked ahead of time (patient self-booking, or
-- a future appointment made through the walk-in desk flow).
alter table appointments add column if not exists patient_type text not null default 'scheduled'
  check (patient_type in ('scheduled', 'walk_in'));

-- Token assignment removed from the accept transition - a walk-in gets
-- checked_in_at stamped instead (their arrival IS their check-in), and
-- position gets computed by the trigger below, not here. Payment
-- hold/capture/refund logic is unchanged.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    if new.patient_type = 'walk_in' and new.checked_in_at is null then
      new.checked_in_at := now();
    end if;
    if new.payment_status = 'hold' then
      new.payment_status := 'captured';
    end if;
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
  elsif new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'hold' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status = 'hold';
  end if;
  return new;
end;
$$;

-- Recomputes 1..N over every currently-active (accepted/in_progress)
-- appointment for one doctor+date, ordering by an "effective time":
--   - checked in (walk-in or a scheduled patient who's arrived): their
--     check-in time, floored at their slot time (can't queue-jump by
--     checking in early for a later slot).
--   - not checked in, still within the grace window past their slot:
--     their slot time - holds the position they booked.
--   - not checked in, past the grace window: 'infinity' - sorted behind
--     every genuinely-present patient. The moment they DO check in (even
--     very late), they fall back into the first case at their real
--     check-in time, which is the "move to the next available position
--     behind checked-in patients" rule.
-- Ties (identical effective time - e.g. two patients booked the same slot,
-- neither checked in yet) break on created_at (earlier booking wins), then
-- id as a last-resort deterministic tiebreak.
--
-- Wrapped in a transaction-scoped advisory lock keyed on (doctor_id, date)
-- so two concurrent callers recomputing the SAME doctor's SAME day can't
-- interleave and derive positions from two different snapshots - the
-- second waits for the first to commit, then recomputes from the
-- now-current state. Combined with the partial unique index below, this is
-- the DB-level guarantee that two simultaneous bookings for the same slot
-- can't produce duplicate or lost positions.
create or replace function public.recompute_queue_positions(p_doctor_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  grace_minutes constant int := 15;
begin
  perform pg_advisory_xact_lock(hashtext(p_doctor_id::text || p_date::text));

  -- Two-phase reassignment, not one UPDATE. Reordering positions (e.g. a
  -- check-in swaps who holds #2 and #3) means two rows briefly need to swap
  -- values - and appointments_active_token_unique is checked per-row AS
  -- EACH ONE is written, not deferred to the end of the statement (a
  -- partial unique index can't be made DEFERRABLE the way a plain unique
  -- constraint can), so a single UPDATE that assigns row A the value row B
  -- currently holds - before B's own row gets processed - throws a
  -- duplicate-key error even though the FINAL state has no duplicates.
  -- Moving every active row to a disjoint negative value first guarantees
  -- no row's temporary value can ever equal another (still-positive) row's
  -- value, so this pass can't collide; the second pass then can't collide
  -- either, since row_number() gives every row a distinct target and
  -- nothing is left positive from before it runs.
  update appointments a
  set token_no = -ordered.new_position
  from (
    select
      id,
      row_number() over (
        order by
          case
            when checked_in_at is not null then greatest(checked_in_at, (date + slot_time)::timestamptz)
            when now() < (date + slot_time)::timestamptz + make_interval(mins => grace_minutes)
              then (date + slot_time)::timestamptz
            else 'infinity'::timestamptz
          end,
          created_at,
          id
      ) as new_position
    from appointments
    where doctor_id = p_doctor_id
      and date = p_date
      and status in ('accepted', 'in_progress')
  ) ordered
  where a.id = ordered.id;

  update appointments a
  set token_no = ordered.new_position
  from (
    select
      id,
      row_number() over (
        order by
          case
            when checked_in_at is not null then greatest(checked_in_at, (date + slot_time)::timestamptz)
            when now() < (date + slot_time)::timestamptz + make_interval(mins => grace_minutes)
              then (date + slot_time)::timestamptz
            else 'infinity'::timestamptz
          end,
          created_at,
          id
      ) as new_position
    from appointments
    where doctor_id = p_doctor_id
      and date = p_date
      and status in ('accepted', 'in_progress')
  ) ordered
  where a.id = ordered.id;
end;
$$;

-- Fires the recompute whenever a row enters, leaves, or changes position
-- within the active set for a doctor/date - or moves to a different
-- doctor/date while still active (a full-day reschedule), in which case
-- BOTH the old date's queue (which just lost a member) and the new date's
-- queue (which just gained one) need recomputing.
create or replace function public.trigger_recompute_queue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- recompute_queue_positions()'s own nested UPDATE fires this same
  -- trigger again (depth 2) for every row it touches. That pass would just
  -- re-derive the identical positions and find nothing left to change
  -- (recompute only writes rows whose position actually moved) - skip it
  -- outright instead of doing the redundant work.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if TG_OP = 'INSERT' then
    if new.status in ('accepted', 'in_progress') then
      perform public.recompute_queue_positions(new.doctor_id, new.date);
    end if;
    return new;
  end if;

  if old.status in ('accepted', 'in_progress')
     and (old.doctor_id is distinct from new.doctor_id or old.date is distinct from new.date)
  then
    perform public.recompute_queue_positions(old.doctor_id, old.date);
  end if;

  if new.status in ('accepted', 'in_progress') then
    perform public.recompute_queue_positions(new.doctor_id, new.date);
  elsif old.status in ('accepted', 'in_progress') then
    -- Left the active set entirely (done/no_show/rejected/cancelled) -
    -- recompute what's left so everyone shifts up. Its own token_no is
    -- left untouched, frozen at whatever position it last held, as a
    -- historical snapshot (RxPendingWorklist etc. still show it).
    perform public.recompute_queue_positions(new.doctor_id, new.date);
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_recompute_queue on appointments;
create trigger on_appointment_recompute_queue
  after insert or update on appointments
  for each row execute function public.trigger_recompute_queue();

-- DB-level backstop (not just app-level discipline): two active
-- appointments for the same doctor+date can never share a position. Partial
-- (scoped to accepted/in_progress only) so it doesn't collide with frozen
-- historical values left on done/no_show/rejected/cancelled rows.
drop index if exists appointments_active_token_unique;
create unique index appointments_active_token_unique
  on appointments (doctor_id, date, token_no)
  where status in ('accepted', 'in_progress');

-- get_queue_status() (section 5) fed the live "now serving" counter off
-- EVERY row with a non-null token_no - under the old model that was always
-- exactly the active set, since token_no was assigned once and never
-- touched again. Under the new model, done/no_show rows keep a frozen
-- historical token_no forever, which would otherwise show up mixed in with
-- freshly recomputed live positions and could numerically collide with
-- them (a done patient frozen at "3" alongside a live patient freshly
-- recomputed to "3"). Restricting to the active statuses is what the
-- unique index above assumes callers do.
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (token_no int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select a.token_no, a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('accepted', 'in_progress')
  order by a.token_no;
$$;

-- ============================================================================
-- 27. ARRIVAL CHECK-IN + LIVE TOKEN
-- ============================================================================
-- Replaces section 26's model. There, token_no was a queue POSITION derived
-- from slot time and recomputed on every change. Here the token is a real,
-- permanent number handed out at the door: nobody holds a token until they
-- physically arrive and are checked in, and the number is issued in strict
-- ARRIVAL ORDER, per clinic, per day. A patient who booked 10:00 and never
-- turns up simply never takes a number, so they can't hold up the people
-- standing in the waiting room.
--
-- See TESTING.md "Test 7" for how to exercise this.

-- ----------------------------------------------------------------------------
-- 27.0 Retire section 26's recompute machinery - FIRST, before anything else
-- ----------------------------------------------------------------------------
-- This has to happen before the column rename and before the status backfill
-- below, for two reasons:
--   * recompute_queue_positions()'s body is stored as TEXT and refers to
--     token_no. A column rename does NOT rewrite it, so the moment 27.2
--     renames token_no -> token_number that function is broken.
--   * its trigger fires on any UPDATE of an accepted/in_progress row - which
--     is exactly what 27.3's status backfill does. Leaving it attached means
--     the backfill runs the now-broken function and the whole migration dies
--     with 'column "token_no" ... does not exist'.
-- Positions are no longer derived at all under this model - the token is
-- assigned once, at the door, and never moves - so nothing here should keep
-- rewriting token numbers.

drop trigger if exists on_appointment_recompute_queue on appointments;
drop function if exists public.trigger_recompute_queue();
drop function if exists public.recompute_queue_positions(uuid, date);
drop index if exists appointments_active_token_unique;

-- The section 5 broadcast trigger's WHEN clause also names token_no, but a
-- trigger's WHEN expression is stored parsed (by attribute number), so it
-- follows the rename by itself. It gets rebuilt in 27.8 regardless.

-- ----------------------------------------------------------------------------
-- 27.1 Clinic-level settings the check-in window depends on
-- ----------------------------------------------------------------------------

-- How long after a slot has finished the desk may still check someone in.
alter table clinics add column if not exists checkin_grace_minutes int not null default 30;

-- Every date/time in this app is clinic-local wall-clock (todayISO() on the
-- client is the browser's local calendar date, and slot_time is a plain
-- time). Supabase runs Postgres in UTC, so comparing those against now()
-- directly is wrong by the UTC offset - which matters a great deal for a
-- window like "60 minutes before the slot". Storing the clinic's timezone
-- lets the check-in guard below compare local wall-clock to local
-- wall-clock instead.
alter table clinics add column if not exists timezone text not null default 'Asia/Kolkata';

-- ----------------------------------------------------------------------------
-- 27.2 Appointment columns
-- ----------------------------------------------------------------------------

-- token_no (section 26) becomes token_number - same column, renamed to the
-- name the arrival-token model uses. Guarded so the migration is re-runnable
-- and so a database built fresh from schema.sql (which already declares
-- token_number) isn't disturbed.
do $$
begin
  if exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments' and column_name = 'token_no'
      )
     and not exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'appointments' and column_name = 'token_number'
      )
  then
    alter table appointments rename column token_no to token_number;
  end if;
end $$;

alter table appointments add column if not exists token_number int;
-- The day a token belongs to. Kept explicitly rather than inferred from
-- `date` so a token always carries the day it was actually issued, even if
-- an appointment's date is later corrected.
alter table appointments add column if not exists token_date date;
-- The raw per-clinic-per-day arrival counter. token_number is what gets
-- shown/called; arrival_seq is the ordinal it was issued from. They're
-- identical today - they're separate so a clinic can later renumber or
-- prefix displayed tokens without disturbing the record of who arrived in
-- what order.
alter table appointments add column if not exists arrival_seq int;
-- checked_in_at already exists from section 26; the rest are new.
alter table appointments add column if not exists checked_in_by uuid references profiles (id);
alter table appointments add column if not exists check_in_method text;

alter table appointments drop constraint if exists appointments_check_in_method_check;
alter table appointments add constraint appointments_check_in_method_check
  check (check_in_method is null or check_in_method in ('clinic_scan', 'patient_scan', 'manual'));

-- ----------------------------------------------------------------------------
-- 27.3 Status lifecycle
-- ----------------------------------------------------------------------------
-- booked -> accepted -> checked_in -> called -> in_consultation -> completed
-- plus cancelled / no_show, and rejected (the clinic declining a booking,
-- which the reject flow in the app has always had).
--
-- Renames of the three existing states are applied to live rows first, with
-- the constraint dropped, then the new constraint goes on.

alter table appointments drop constraint if exists appointments_status_check;

update appointments set status = 'booked' where status = 'pending';
update appointments set status = 'in_consultation' where status = 'in_progress';
update appointments set status = 'completed' where status = 'done';

alter table appointments alter column status set default 'booked';
alter table appointments add constraint appointments_status_check
  check (status in (
    'booked', 'accepted', 'checked_in', 'called',
    'in_consultation', 'completed', 'cancelled', 'rejected', 'no_show'
  ));

-- Every token in the table right now predates this model. Section 26 issued
-- them as per-DOCTOR queue positions, so the same number legitimately repeats
-- across two doctors at one clinic on one day - which the per-CLINIC unique
-- index in 27.4 then (correctly) rejects. They were never arrival tokens, so
-- rather than renumber them into a history that didn't happen, clear them.
-- Completed visits keep their encounter, visit notes and prescriptions; they
-- just stop claiming a token number that was never issued at a door.
--
-- checked_in_at goes with them, deliberately. This model's invariant is
-- "checked_in_at is set exactly when a token has been issued" - leaving a
-- stale timestamp behind with no number would make check_in_appointment()
-- take its already-checked-in branch forever and hand back a null token.
-- Anyone mid-flow simply gets checked in again at the desk, which is what
-- actually draws them a real number.
update appointments
set token_number = null,
    arrival_seq = null,
    token_date = null,
    checked_in_at = null,
    checked_in_by = null,
    check_in_method = null;

-- Nothing can be mid-arrival either: section 26 had no checked_in/called
-- states, so any row that survived the rename as one of those came from a
-- re-run, and the cleared timestamps above mean it holds no token. Send it
-- back to 'accepted' so the desk re-checks it in properly.
update appointments set status = 'accepted' where status in ('checked_in', 'called');

-- ----------------------------------------------------------------------------
-- 27.4 One token per clinic per day
-- ----------------------------------------------------------------------------
-- (The section 26 machinery this replaces was already dropped up in 27.0.)
--
-- One token per clinic per day, full stop. This is the DB-level guarantee
-- that two receptionists checking people in at the same instant can't hand
-- out the same number - the counter below serialises them, and this catches
-- anything that ever slipped past it.
drop index if exists appointments_clinic_token_unique;
create unique index appointments_clinic_token_unique
  on appointments (clinic_id, token_date, token_number)
  where token_number is not null;

-- ----------------------------------------------------------------------------
-- 27.5 The per-clinic-per-day token counter
-- ----------------------------------------------------------------------------
-- A single row per (clinic, day) holding the last number issued. The
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING in check_in_appointment()
-- takes a row lock, so concurrent check-ins queue behind each other and each
-- one comes away with its own number - no max()+1 read-then-write race.
create table if not exists clinic_token_counters (
  clinic_id uuid not null references clinics (id) on delete cascade,
  token_date date not null,
  last_seq int not null default 0,
  primary key (clinic_id, token_date)
);

-- No policies: this table is reached ONLY through the security-definer
-- function below, never directly by a client.
alter table clinic_token_counters enable row level security;

-- ----------------------------------------------------------------------------
-- 27.6 Slot length helper
-- ----------------------------------------------------------------------------
-- The same "window divided by daily capacity" arithmetic computeSlots() uses
-- on the client, so the server's idea of when a slot ends matches the one the
-- patient was shown when booking. Falls back to 15 minutes when the doctor
-- has no availability configured for that weekday.
create or replace function public.slot_minutes_for(p_doctor_id uuid, p_date date)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select greatest(
        1,
        floor(
          (extract(epoch from (da.end_time - da.start_time)) / 60)
          / nullif(da.max_patients_per_day, 0)
        )::int
      )
      from doctor_availability da
      where da.doctor_id = p_doctor_id
        and da.weekday = extract(dow from p_date)::int
      order by da.start_time
      limit 1
    ),
    15
  );
$$;

-- ----------------------------------------------------------------------------
-- 27.7 check_in_appointment(): the only way a token is ever issued
-- ----------------------------------------------------------------------------
-- Guardrails, in order:
--   * caller must be the owning clinic, an admin, or the patient themselves
--     (the patient_scan case),
--   * a second check-in is not an error - it just returns the token already
--     held, so a double scan at the desk is harmless,
--   * status must be 'accepted' (a booking the clinic hasn't confirmed, or
--     one already cancelled/rejected, can't take a number),
--   * the appointment must be for today in the CLINIC's timezone,
--   * now must be inside [slot - 60 min, slot end + clinic grace].
-- Only then does it draw the next number.
create or replace function public.check_in_appointment(
  p_appointment_id uuid,
  p_method text default 'manual'
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean)
language plpgsql
security definer
set search_path = public
as $$
-- The RETURNS TABLE names above are also plpgsql variables, and three of
-- them are real column names on `appointments`. Every reference below is
-- either qualified (a.token_number) or an unambiguous SET/INSERT target, and
-- every local is p_/v_ prefixed - this directive makes the intent explicit
-- so a bare identifier can never silently resolve to the OUT variable.
#variable_conflict use_column
declare
  a appointments;
  v_tz text;
  v_grace int;
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
begin
  if p_method is null or p_method not in ('clinic_scan', 'patient_scan', 'manual') then
    raise exception 'Unknown check-in method: %', p_method;
  end if;

  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  if not (
    public.is_admin()
    or public.is_own_clinic(a.clinic_id)
    or public.is_own_mrn(a.member_id)
  ) then
    raise exception 'You are not allowed to check in this appointment.';
  end if;

  -- Idempotent by design: "a second scan just shows the existing token".
  -- Requires a token to actually be there, not merely a timestamp - a row
  -- with checked_in_at set but no number (only reachable from legacy data)
  -- must fall through and draw a real one rather than return null forever.
  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true;
    return;
  end if;

  if a.status <> 'accepted' then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata'), coalesce(c.checkin_grace_minutes, 30)
    into v_tz, v_grace
  from clinics c where c.id = a.clinic_id;

  v_now_local := now() at time zone v_tz;

  if a.date <> v_now_local::date then
    raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
  end if;

  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  if v_now_local < v_slot_start - interval '60 minutes' then
    raise exception 'Too early - check-in opens 60 minutes before the % slot.',
      to_char(v_slot_start, 'HH12:MI AM');
  end if;

  if v_now_local > v_slot_end + make_interval(mins => v_grace) then
    raise exception 'Too late - check-in for the % slot closed % minutes after it ended.',
      to_char(v_slot_start, 'HH12:MI AM'), v_grace;
  end if;

  -- Draw the next arrival number for this clinic, this day. The row lock
  -- taken by ON CONFLICT DO UPDATE is what makes concurrent check-ins safe.
  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, a.date, 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  update appointments
  set status = 'checked_in',
      checked_in_at = now(),
      checked_in_by = auth.uid(),
      check_in_method = p_method,
      token_number = v_seq,
      arrival_seq = v_seq,
      token_date = a.date
  where id = a.id;

  return query select v_seq, v_seq, a.date, false;
end;
$$;

-- ----------------------------------------------------------------------------
-- 27.8 Status-driven side effects, updated for the new names
-- ----------------------------------------------------------------------------
-- Token assignment is gone from here entirely (it lives in
-- check_in_appointment above). What's left is the payment hold/capture/refund
-- behaviour, unchanged except for the renamed statuses.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    if new.payment_status = 'hold' then
      new.payment_status := 'captured';
    end if;
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
  elsif new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'hold' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status = 'hold';
  end if;
  return new;
end;
$$;

-- The live-queue broadcast fired on token_no; that column is token_number now.
drop trigger if exists on_appointment_queue_broadcast on appointments;
create trigger on_appointment_queue_broadcast
  after update on appointments
  for each row
  when (old.status is distinct from new.status or old.token_number is distinct from new.token_number)
  execute function public.broadcast_appointment_queue_change();

-- ----------------------------------------------------------------------------
-- 27.9 Queries the app reads the live queue through
-- ----------------------------------------------------------------------------
-- The waiting room for one doctor on one day: everyone who has actually
-- arrived and not yet finished. Tokens are issued per CLINIC, so these
-- numbers won't be contiguous when a clinic runs two doctors at once - they
-- stay correctly ordered, which is all the "who's next" logic needs.
--
-- Dropped rather than replaced: this function's OUT column was token_no and
-- is now token_number, and CREATE OR REPLACE cannot rename OUT parameters
-- ("cannot change return type of existing function"). Nothing in the
-- database depends on it - it's called over RPC from the client - so
-- dropping it is safe.
drop function if exists public.get_queue_status(uuid, date);
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (token_number int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select a.token_number, a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
    and a.token_number is not null
  order by a.token_number;
$$;

-- Slots are taken by any booking that hasn't been called off - the renamed
-- statuses don't change which those are, but this is re-declared so a fresh
-- run of the file leaves no reference to the old vocabulary.
create or replace function public.get_taken_slots(p_doctor_id uuid, p_date date)
returns table (slot_time time)
language sql
stable
security definer
set search_path = public
as $$
  select a.slot_time
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status not in ('rejected', 'cancelled');
$$;

-- ----------------------------------------------------------------------------
-- 27.10 RLS, updated for the renamed statuses
-- ----------------------------------------------------------------------------
-- Unchanged in substance: a patient may only cancel their own booking, and
-- only while it's still 'booked'/'accepted' and more than two hours out.
-- Once they're checked in, the desk owns the record.
drop policy if exists "appointments_update" on appointments;
create policy "appointments_update" on appointments for update
  using (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (public.is_own_member(member_id) and status in ('booked', 'accepted'))
  )
  with check (
    public.is_admin()
    or public.is_own_clinic(clinic_id)
    or (
      public.is_own_member(member_id)
      and status = 'cancelled'
      and (date + slot_time)::timestamp > now() + interval '2 hours'
    )
  );

-- ============================================================================
-- 28. SIGNED BOOKING QR + OPTIONAL SELF CHECK-IN
-- ============================================================================
-- Two things, both about making arrival trustworthy:
--
--   1. The patient's booking QR is now SIGNED and short-lived. Section 27's
--      code was just the appointment id in plain text - anyone who learned an
--      id (a screenshot, a shared link, a log line) could reproduce a valid
--      code. Now the code carries an HMAC over (appointment, expiry) taken
--      with a server-side secret, so it can only be minted by the database,
--      for a patient who actually owns that booking, and it goes stale within
--      minutes so an old photo is worthless.
--
--   2. Optional SELF check-in, off unless a clinic turns it on. The patient
--      scans a rotating code shown on a screen at reception. Because that
--      code changes every few minutes and is verified server-side, a photo of
--      it taken yesterday - or sent to a friend at home - won't work. A clinic
--      can additionally require the phone to be physically near the clinic.
--
-- See TESTING.md "Test 9" for how to exercise these.

-- ----------------------------------------------------------------------------
-- 28.1 The signing secret
-- ----------------------------------------------------------------------------
-- One row, one secret, reachable ONLY through the security-definer functions
-- below. RLS is enabled with no policy at all, which means no client - not
-- even an admin's session - can select it. If this ever leaks, delete the row
-- and it regenerates on the next call, invalidating every outstanding code.
create table if not exists app_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

alter table app_secrets enable row level security;

-- Fetches the QR signing secret, creating it on first use. gen_random_bytes
-- comes from pgcrypto, which on Supabase lives in the `extensions` schema -
-- hence the search_path on every function in this file that touches it.
create or replace function public.qr_secret()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
begin
  select value into v_secret from app_secrets where name = 'qr_signing_key';
  if v_secret is null then
    insert into app_secrets (name, value)
    values ('qr_signing_key', encode(gen_random_bytes(32), 'hex'))
    on conflict (name) do nothing;
    select value into v_secret from app_secrets where name = 'qr_signing_key';
  end if;
  return v_secret;
end;
$$;

-- Truncated to 16 hex characters (64 bits): plenty against forgery for a code
-- that also has to name a real appointment and expires in minutes, and short
-- enough to keep the QR sparse and quick to scan across a reception desk.
create or replace function public.sign_qr_payload(p_payload text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return left(encode(hmac(p_payload, public.qr_secret(), 'sha256'), 'hex'), 16);
end;
$$;

-- ----------------------------------------------------------------------------
-- 28.2 The patient's signed booking QR
-- ----------------------------------------------------------------------------
-- Format: sanjeevni:appt:v2:<appointment uuid>:<expiry epoch>:<signature>
-- Only the owning patient (or the clinic/admin, e.g. to reprint a slip) can
-- mint one, and it lives for 10 minutes - the app re-issues it while the
-- screen is open, so the patient always has a fresh one to show.
create or replace function public.issue_booking_qr(p_appointment_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  a appointments;
  v_exp timestamptz;
  v_payload text;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  if not (public.is_admin() or public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  v_exp := now() + interval '10 minutes';
  v_payload := a.id::text || '|' || extract(epoch from v_exp)::bigint::text;

  return query
  select
    'sanjeevni:appt:v2:' || a.id::text || ':' ||
      extract(epoch from v_exp)::bigint::text || ':' || public.sign_qr_payload(v_payload),
    v_exp;
end;
$$;

-- Verifies a scanned booking code and returns the appointment id it names.
-- Returns null rather than raising, so the scanner can tell "not one of our
-- codes / expired / tampered" apart from a database error.
create or replace function public.verify_booking_qr(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  v_id uuid;
  v_exp bigint;
  v_sig text;
begin
  -- sanjeevni : appt : v2 : <uuid> : <exp> : <sig>
  parts := string_to_array(coalesce(p_code, ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'appt' or parts[3] <> 'v2'
  then
    return null;
  end if;

  begin
    v_id := parts[4]::uuid;
    v_exp := parts[5]::bigint;
  exception when others then
    return null;
  end;
  v_sig := parts[6];

  if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> v_sig then
    return null; -- forged or tampered
  end if;
  if to_timestamp(v_exp) < now() then
    return null; -- stale screenshot
  end if;

  return v_id;
end;
$$;

-- What the clinic's scanner actually calls. Verifies the signature first,
-- then hands off to the same check_in_appointment() every other path uses -
-- so the arrival-order counter, the window guardrails and the clinic
-- ownership check are all exactly the same code.
create or replace function public.check_in_with_qr(p_code text)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  v_id := public.verify_booking_qr(p_code);
  if v_id is null then
    raise exception 'This code is not valid or has expired. Ask the patient to refresh their screen.';
  end if;
  return query select * from public.check_in_appointment(v_id, 'clinic_scan');
end;
$$;

-- ----------------------------------------------------------------------------
-- 28.3 Clinic settings for self check-in
-- ----------------------------------------------------------------------------
-- Off by default: a clinic opts in, because it changes who is allowed to move
-- an appointment into the queue.
alter table clinics add column if not exists self_checkin_enabled boolean not null default false;
-- Additionally require the phone to be physically near the clinic. Belt and
-- braces on top of the rotating code, for clinics that want it.
alter table clinics add column if not exists self_checkin_require_location boolean not null default false;
alter table clinics add column if not exists self_checkin_radius_m int not null default 150;

-- ----------------------------------------------------------------------------
-- 28.4 The rotating reception code
-- ----------------------------------------------------------------------------
-- Format: sanjeevni:clinic:v1:<clinic uuid>:<window>:<signature>
-- `window` is the number of whole rotation periods since the epoch, so the
-- code changes on its own every ROTATE_SECONDS and a photograph of it is
-- worthless within minutes. Displayed on a screen/tablet at reception - a
-- genuinely printed poster is deliberately NOT supported here, because a
-- static code is exactly the thing an old photo defeats.
create or replace function public.clinic_checkin_window(p_at timestamptz default now())
returns bigint
language sql
immutable
as $$
  select floor(extract(epoch from p_at) / 180)::bigint;  -- rotates every 3 minutes
$$;

create or replace function public.issue_clinic_checkin_code(p_clinic_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_window bigint;
  v_payload text;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  v_window := public.clinic_checkin_window();
  v_payload := p_clinic_id::text || '|' || v_window::text;

  return query
  select
    'sanjeevni:clinic:v1:' || p_clinic_id::text || ':' || v_window::text || ':'
      || public.sign_qr_payload(v_payload),
    to_timestamp((v_window + 1) * 180);
end;
$$;

-- ----------------------------------------------------------------------------
-- 28.5 Distance helper for the optional geofence
-- ----------------------------------------------------------------------------
-- Plain haversine rather than PostGIS: one point-to-point check at check-in
-- time doesn't justify the extension, and this mirrors haversineKm() the
-- client already uses for "clinics near me".
create or replace function public.distance_metres(
  p_lat1 double precision, p_lng1 double precision,
  p_lat2 double precision, p_lng2 double precision
)
returns double precision
language sql
immutable
as $$
  select 2 * 6371000 * asin(
    sqrt(
      sin(radians(p_lat2 - p_lat1) / 2) ^ 2
      + cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(radians(p_lng2 - p_lng1) / 2) ^ 2
    )
  );
$$;

-- ----------------------------------------------------------------------------
-- 28.6 Self check-in
-- ----------------------------------------------------------------------------
-- The patient scans reception's rotating code from their own app. Everything
-- that makes this safe is checked here, server-side:
--   * the clinic has switched self check-in on at all,
--   * the scanned code is a real, correctly-signed, CURRENT code for that
--     clinic (the previous window is also accepted, so a scan that lands a
--     second after the code rotates doesn't fail for no visible reason),
--   * the caller genuinely has an accepted appointment at that clinic today,
--   * optionally, the phone is within the clinic's radius,
-- and then the ordinary check_in_appointment() applies the time-window rules
-- and draws the token. A patient sitting at home cannot satisfy the second
-- condition, which is the whole point.
create or replace function public.self_check_in(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  v_clinic_id uuid;
  v_window bigint;
  v_now_window bigint;
  c clinics;
  v_appt_id uuid;
  v_distance double precision;
begin
  parts := string_to_array(coalesce(p_code, ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'clinic' or parts[3] <> 'v1'
  then
    raise exception 'That is not a clinic check-in code.';
  end if;

  begin
    v_clinic_id := parts[4]::uuid;
    v_window := parts[5]::bigint;
  exception when others then
    raise exception 'That is not a clinic check-in code.';
  end;

  if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> parts[6] then
    raise exception 'That check-in code is not valid.';
  end if;

  -- Current window, or the one just before it. Anything older is a photo.
  v_now_window := public.clinic_checkin_window();
  if v_window <> v_now_window and v_window <> v_now_window - 1 then
    raise exception 'That check-in code has expired - please scan the code on the screen at reception.';
  end if;

  select * into c from clinics where id = v_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  if not c.self_checkin_enabled then
    raise exception 'This clinic does not offer self check-in - please see the reception desk.';
  end if;

  if c.self_checkin_require_location then
    if p_lat is null or p_lng is null then
      raise exception 'Location is required to check yourself in here. Allow location access and try again.';
    end if;
    if c.lat is null or c.lng is null then
      raise exception 'This clinic has not set its location yet - please see the reception desk.';
    end if;
    v_distance := public.distance_metres(p_lat, p_lng, c.lat, c.lng);
    if v_distance > c.self_checkin_radius_m then
      raise exception 'You appear to be about %m from the clinic. Self check-in only works at the clinic.',
        round(v_distance)::int;
    end if;
  end if;

  -- The caller's own accepted appointment at this clinic, today. is_own_mrn()
  -- rather than a plain account match so this still works for a person whose
  -- identity spans more than one family_members row (see section 21).
  select a.id into v_appt_id
  from appointments a
  where a.clinic_id = v_clinic_id
    and a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
    and a.status = 'accepted'
    and public.is_own_mrn(a.member_id)
  order by a.slot_time
  limit 1;

  if v_appt_id is null then
    raise exception 'No confirmed appointment found for you at this clinic today.';
  end if;

  return query select * from public.check_in_appointment(v_appt_id, 'patient_scan');
end;
$$;

-- ============================================================================
-- 29. LATE ARRIVALS, NO-SHOWS, AND SKIPPING
-- ============================================================================
-- What happens around arrival time:
--
--   * LATE: checking in after your slot but still inside the window is
--     completely normal - you join the live queue at the position your
--     arrival earns, exactly like everyone else. It's only flagged so the
--     clinic can see it, never penalised.
--   * NO-SHOW: never arriving. The clinic can mark it by hand, or the system
--     sweeps it automatically once the cut-off the clinic sets has passed.
--     A no-show holds no token - it never had one.
--   * TURNING UP ANYWAY: a no-show who walks in later can still be admitted
--     by the desk, which draws them the next token like a walk-in.
--   * SKIPPING: a patient who was called and didn't come forward, after the
--     clinic's set number of reminders, can be pushed to the back of the
--     queue with a fresh token rather than being written off.
--
-- See TESTING.md "Test 10".

-- ----------------------------------------------------------------------------
-- 29.1 Clinic-set thresholds
-- ----------------------------------------------------------------------------
-- How long after the check-in window closes before an unarrived patient is
-- automatically written off.
alter table clinics add column if not exists no_show_cutoff_minutes int not null default 30;
-- How many unanswered reminders before the desk may skip someone.
alter table clinics add column if not exists reminder_limit int not null default 3;

-- ----------------------------------------------------------------------------
-- 29.2 Appointment columns
-- ----------------------------------------------------------------------------
-- Purely informational: the token was still issued in arrival order.
alter table appointments add column if not exists was_late boolean not null default false;
alter table appointments add column if not exists no_show_marked_at timestamptz;
-- Distinguishes the automatic sweep from a receptionist's decision, which
-- matters when someone asks why a booking was written off.
alter table appointments add column if not exists no_show_auto boolean not null default false;
-- How many times this patient has been pushed to the back after being called
-- and not coming forward.
alter table appointments add column if not exists skip_count int not null default 0;

-- ----------------------------------------------------------------------------
-- 29.3 check_in_appointment(), now with a late/no-show override
-- ----------------------------------------------------------------------------
-- The 2-argument version has to go first: adding a defaulted third parameter
-- alongside it would leave two candidate functions and PostgREST could not
-- tell which one a call meant.
drop function if exists public.check_in_appointment(uuid, text);

-- p_allow_late lets the DESK (never a patient self-scan) admit somebody whose
-- window has closed, or who has already been written off as a no-show. It
-- skips the timing guards only - the clinic-ownership check, the arrival
-- counter and the one-token-per-person rule all still apply, so an override
-- still produces an ordinary next-in-line token.
create or replace function public.check_in_appointment(
  p_appointment_id uuid,
  p_method text default 'manual',
  p_allow_late boolean default false
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_tz text;
  v_grace int;
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
  v_late boolean := false;
  v_is_desk boolean;
begin
  if p_method is null or p_method not in ('clinic_scan', 'patient_scan', 'manual') then
    raise exception 'Unknown check-in method: %', p_method;
  end if;

  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  v_is_desk := public.is_admin() or public.is_own_clinic(a.clinic_id);

  if not (v_is_desk or public.is_own_mrn(a.member_id)) then
    raise exception 'You are not allowed to check in this appointment.';
  end if;

  -- Only the desk may override the timing rules. A patient scanning the
  -- reception code can never let themselves in late.
  if p_allow_late and not v_is_desk then
    raise exception 'Only the clinic can admit a late or no-show patient.';
  end if;

  -- Idempotent: "a second scan just shows the existing token".
  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true, a.was_late;
    return;
  end if;

  -- A no-show holds no token, and can only re-enter through an explicit
  -- desk override - which is exactly the "they turned up after all" case.
  if a.status = 'no_show' and not p_allow_late then
    raise exception 'This patient was marked as a no-show. Use "Check in anyway" to admit them.';
  end if;

  if a.status not in ('accepted', 'no_show') then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata'), coalesce(c.checkin_grace_minutes, 30)
    into v_tz, v_grace
  from clinics c where c.id = a.clinic_id;

  v_now_local := now() at time zone v_tz;
  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  -- Arriving after your slot is "late", not "refused" - the flag is recorded
  -- either way, and the token is drawn in arrival order regardless.
  v_late := v_now_local > v_slot_end;

  if not p_allow_late then
    if a.date <> v_now_local::date then
      raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
    end if;
    if v_now_local < v_slot_start - interval '60 minutes' then
      raise exception 'Too early - check-in opens 60 minutes before the % slot.',
        to_char(v_slot_start, 'HH12:MI AM');
    end if;
    if v_now_local > v_slot_end + make_interval(mins => v_grace) then
      raise exception 'Too late - check-in for the % slot closed % minutes after it ended.',
        to_char(v_slot_start, 'HH12:MI AM'), v_grace;
    end if;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, a.date, 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  update appointments
  set status = 'checked_in',
      checked_in_at = now(),
      checked_in_by = auth.uid(),
      check_in_method = p_method,
      token_number = v_seq,
      arrival_seq = v_seq,
      token_date = a.date,
      was_late = v_late,
      -- Re-admitting a no-show clears the write-off.
      no_show_marked_at = null,
      no_show_auto = false
  where id = a.id;

  return query select v_seq, v_seq, a.date, false, v_late;
end;
$$;

-- These two call through to it, so they have to be redeclared for the new
-- return shape. Neither ever passes the override - a scan is never a
-- late-admission decision.
--
-- Dropped rather than replaced, for the same reason as the 2-arg check-in
-- above: they now return an extra `was_late` column, and CREATE OR REPLACE
-- cannot change a function's OUT parameters ("cannot change return type of
-- existing function"). Both are only ever called over RPC from the client,
-- so nothing in the database depends on them.
drop function if exists public.check_in_with_qr(text);
drop function if exists public.self_check_in(text, double precision, double precision);

create or replace function public.check_in_with_qr(p_code text)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  v_id := public.verify_booking_qr(p_code);
  if v_id is null then
    raise exception 'This code is not valid or has expired. Ask the patient to refresh their screen.';
  end if;
  return query select * from public.check_in_appointment(v_id, 'clinic_scan', false);
end;
$$;

create or replace function public.self_check_in(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  v_clinic_id uuid;
  v_window bigint;
  v_now_window bigint;
  c clinics;
  v_appt_id uuid;
  v_distance double precision;
begin
  parts := string_to_array(coalesce(p_code, ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'clinic' or parts[3] <> 'v1'
  then
    raise exception 'That is not a clinic check-in code.';
  end if;

  begin
    v_clinic_id := parts[4]::uuid;
    v_window := parts[5]::bigint;
  exception when others then
    raise exception 'That is not a clinic check-in code.';
  end;

  if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> parts[6] then
    raise exception 'That check-in code is not valid.';
  end if;

  v_now_window := public.clinic_checkin_window();
  if v_window <> v_now_window and v_window <> v_now_window - 1 then
    raise exception 'That check-in code has expired - please scan the code on the screen at reception.';
  end if;

  select * into c from clinics where id = v_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  if not c.self_checkin_enabled then
    raise exception 'This clinic does not offer self check-in - please see the reception desk.';
  end if;

  if c.self_checkin_require_location then
    if p_lat is null or p_lng is null then
      raise exception 'Location is required to check yourself in here. Allow location access and try again.';
    end if;
    if c.lat is null or c.lng is null then
      raise exception 'This clinic has not set its location yet - please see the reception desk.';
    end if;
    v_distance := public.distance_metres(p_lat, p_lng, c.lat, c.lng);
    if v_distance > c.self_checkin_radius_m then
      raise exception 'You appear to be about %m from the clinic. Self check-in only works at the clinic.',
        round(v_distance)::int;
    end if;
  end if;

  select a.id into v_appt_id
  from appointments a
  where a.clinic_id = v_clinic_id
    and a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
    and a.status = 'accepted'
    and public.is_own_mrn(a.member_id)
  order by a.slot_time
  limit 1;

  if v_appt_id is null then
    raise exception 'No confirmed appointment found for you at this clinic today.';
  end if;

  return query select * from public.check_in_appointment(v_appt_id, 'patient_scan', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 29.4 Automatic no-show sweep
-- ----------------------------------------------------------------------------
-- Writes off every accepted appointment nobody ever arrived for, once the
-- clinic's cut-off has passed. Deliberately touches ONLY status='accepted':
-- anyone who checked in holds a token and is the queue's problem, not this
-- function's. Also sweeps up stragglers from previous days, which otherwise
-- sit as "expected" forever.
--
-- Returns how many it marked, so the caller can say something useful.
-- p_clinic_id null = every clinic the caller is allowed to sweep (admin, or
-- a scheduled job running as the definer).
create or replace function public.auto_mark_no_shows(p_clinic_id uuid default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  if p_clinic_id is not null and not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  with due as (
    select a.id
    from appointments a
    join clinics c on c.id = a.clinic_id
    where a.status = 'accepted'
      and (p_clinic_id is null or a.clinic_id = p_clinic_id)
      and (
        -- A day that has already ended, in the clinic's own timezone.
        a.date < (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
        -- ...or today, once slot end + grace + cut-off has gone by.
        or (
          a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
          and (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))
              > (a.date + a.slot_time)
                + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date))
                + make_interval(mins => coalesce(c.checkin_grace_minutes, 30))
                + make_interval(mins => coalesce(c.no_show_cutoff_minutes, 30))
        )
      )
  )
  update appointments a
  set status = 'no_show',
      no_show_marked_at = now(),
      no_show_auto = true
  from due
  where a.id = due.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Best-effort scheduling. pg_cron isn't guaranteed to be available (or
-- enabled) on every project, and the clinic console also calls
-- auto_mark_no_shows() when it loads - so the sweep still happens either way,
-- and this block never breaks the migration if the extension isn't there.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.unschedule('sanjeevni_auto_no_shows');
    exception when others then
      null; -- no existing job to unschedule, or no permission - fall through
    end;
    begin
      perform cron.schedule('sanjeevni_auto_no_shows', '*/10 * * * *',
        $cron$select public.auto_mark_no_shows()$cron$);
    exception when others then
      raise notice 'pg_cron present but scheduling failed; the console will sweep on load instead.';
    end;
  else
    raise notice 'pg_cron unavailable; the clinic console sweeps no-shows when it loads.';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 29.5 Skipping a called patient to the back
-- ----------------------------------------------------------------------------
-- The patient was called and didn't come forward. Rather than writing them
-- off, the desk can draw them a FRESH token - they keep their place in the
-- day, just at the back of it. Their original number is gone, which is the
-- honest outcome: the queue moved on without them.
create or replace function public.skip_to_back(p_appointment_id uuid)
returns table (token_number int, arrival_seq int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_seq int;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  if a.status not in ('checked_in', 'called') then
    raise exception 'Only a waiting or called patient can be skipped (this one is "%").', a.status;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, coalesce(a.token_date, a.date), 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  update appointments
  set token_number = v_seq,
      arrival_seq = v_seq,
      status = 'checked_in',
      skip_count = a.skip_count + 1
  where id = a.id;

  return query select v_seq, v_seq;
end;
$$;

-- ============================================================================
-- 30. FAIR QUEUE - DATA: PAYMENT AND PRESENCE ARE SEPARATE FACTS
-- ============================================================================
-- Two facts about an appointment that must never be conflated:
--
--   payment_status  - has the money been dealt with?
--                     pay_at_clinic / paid_online / paid_at_clinic / refunded
--   checked_in_at   - is the patient PHYSICALLY here?
--
-- Paying online does NOT check anyone in and buys NO queue priority. Someone
-- who paid online from their sofa is not in the live queue at all; they hold
-- no token until they walk through the door, exactly like everyone else. All
-- online payment buys is a faster tap at the desk, because there's no cash to
-- count.
--
-- This file makes that separation structural rather than merely intended:
-- section 30.5 stops presence columns being written by anything other than
-- the check-in path, so no amount of updating payment_status can manufacture
-- a token.
--
-- See TESTING.md "Test 11".

-- ----------------------------------------------------------------------------
-- 30.1 payment_status vocabulary
-- ----------------------------------------------------------------------------
-- The old values came from the demo payment flow: 'unpaid' (nothing decided),
-- 'cod' (pay cash on the day), 'hold' (money authorised online), 'captured'
-- (taken online). They collapse cleanly onto the four states that actually
-- matter to a receptionist.
alter table appointments drop constraint if exists appointments_payment_status_check;

update appointments set payment_status = 'pay_at_clinic'
where payment_status in ('unpaid', 'cod');

-- A hold is money already committed by the patient online; for this app's
-- purposes that is "paid online" - the desk has nothing to collect.
update appointments set payment_status = 'paid_online'
where payment_status in ('hold', 'captured');

alter table appointments alter column payment_status set default 'pay_at_clinic';
alter table appointments add constraint appointments_payment_status_check
  check (payment_status in ('pay_at_clinic', 'paid_online', 'paid_at_clinic', 'refunded'));

-- ----------------------------------------------------------------------------
-- 30.2 grace_minutes
-- ----------------------------------------------------------------------------
-- The clinic-wide setting already exists (clinics.checkin_grace_minutes, from
-- section 27). This adds an optional PER-APPOINTMENT override for the
-- occasional "this patient warned us they'd be late" case; null means "use
-- the clinic's setting", which is the normal state of the world.
alter table appointments add column if not exists grace_minutes int;

create or replace function public.effective_grace_minutes(p_appointment_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(a.grace_minutes, c.checkin_grace_minutes, 30)
  from appointments a
  join clinics c on c.id = a.clinic_id
  where a.id = p_appointment_id;
$$;

-- ----------------------------------------------------------------------------
-- 30.3 effective_order_time
-- ----------------------------------------------------------------------------
-- What the queue will actually sort on. The full fairness formula (weighing
-- the booked slot against real arrival, so a punctual 3PM booking isn't
-- overtaken by a 4PM booking who merely walked in first) lands in the NEXT
-- step. For now it is stamped with the arrival moment, which is exactly what
-- the queue orders by today - so the column is already true, just not yet
-- clever.
alter table appointments add column if not exists effective_order_time timestamptz;

-- Backfill the rows that already have a real arrival.
update appointments
set effective_order_time = checked_in_at
where checked_in_at is not null and effective_order_time is null;

-- ----------------------------------------------------------------------------
-- 30.4 Status changes no longer touch payment except to refund
-- ----------------------------------------------------------------------------
-- Accepting a booking used to flip 'hold' to 'captured'. Under the new
-- vocabulary there is nothing to flip: money paid online is already
-- paid_online, and a pay_at_clinic booking stays pay_at_clinic until someone
-- actually hands over cash (see mark_paid_at_clinic below). The only
-- automatic transition left is a refund when a booking is called off.
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded'
    where appointment_id = new.id and status in ('hold', 'captured', 'pending');
  end if;
  return new;
end;
$$;

-- Collecting cash at the counter. Deliberately its own function, and
-- deliberately says nothing about presence: marking someone paid does not
-- check them in, and checking someone in does not mark them paid.
create or replace function public.mark_paid_at_clinic(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  if a.payment_status = 'paid_online' then
    raise exception 'This appointment was already paid online - there is nothing to collect.';
  end if;
  if a.payment_status = 'refunded' then
    raise exception 'This appointment has been refunded.';
  end if;

  update appointments set payment_status = 'paid_at_clinic' where id = a.id;
  update payments set status = 'captured' where appointment_id = a.id and status = 'pending';
end;
$$;

-- ----------------------------------------------------------------------------
-- 30.5 Presence cannot be forged
-- ----------------------------------------------------------------------------
-- appointments_update lets a clinic update its own rows, which until now
-- included checked_in_at, token_number and arrival_seq - so a determined
-- client could hand itself a token straight from the API, bypassing the
-- arrival counter entirely. Since this whole part rests on "presence is a
-- fact, not a claim", those columns are now writable ONLY from inside the
-- check-in functions, which announce themselves with a transaction-local
-- flag before they write.
--
-- Clearing a value back to null is still allowed: undoing a mistaken
-- check-in is a legitimate desk correction, and it grants nobody a place in
-- the queue.
create or replace function public.guard_presence_columns()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.checkin_write', true), '') = '1' then
    return new;  -- we're inside check_in_appointment()/skip_to_back()
  end if;

  if new.checked_in_at is not null and new.checked_in_at is distinct from old.checked_in_at then
    raise exception 'checked_in_at is set by checking a patient in, not by writing to it directly.';
  end if;
  if new.token_number is not null and new.token_number is distinct from old.token_number then
    raise exception 'token_number is issued by the arrival counter, not by writing to it directly.';
  end if;
  if new.arrival_seq is not null and new.arrival_seq is distinct from old.arrival_seq then
    raise exception 'arrival_seq is issued by the arrival counter, not by writing to it directly.';
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_guard_presence on appointments;
create trigger on_appointment_guard_presence
  before update on appointments
  for each row execute function public.guard_presence_columns();

-- ----------------------------------------------------------------------------
-- 30.6 The check-in path, re-declared to set the flag
-- ----------------------------------------------------------------------------
-- Same behaviour as section 29, plus: it announces itself to the guard above,
-- and it stamps effective_order_time. Note what it still does NOT do - it
-- never reads or writes payment_status. Presence and payment stay strangers.
create or replace function public.check_in_appointment(
  p_appointment_id uuid,
  p_method text default 'manual',
  p_allow_late boolean default false
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_tz text;
  v_grace int;
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
  v_late boolean := false;
  v_is_desk boolean;
  v_now timestamptz := now();
begin
  if p_method is null or p_method not in ('clinic_scan', 'patient_scan', 'manual') then
    raise exception 'Unknown check-in method: %', p_method;
  end if;

  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  v_is_desk := public.is_admin() or public.is_own_clinic(a.clinic_id);

  if not (v_is_desk or public.is_own_mrn(a.member_id)) then
    raise exception 'You are not allowed to check in this appointment.';
  end if;

  if p_allow_late and not v_is_desk then
    raise exception 'Only the clinic can admit a late or no-show patient.';
  end if;

  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true, a.was_late;
    return;
  end if;

  if a.status = 'no_show' and not p_allow_late then
    raise exception 'This patient was marked as a no-show. Use "Check in anyway" to admit them.';
  end if;

  if a.status not in ('accepted', 'no_show') then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata') into v_tz from clinics c where c.id = a.clinic_id;
  v_grace := public.effective_grace_minutes(a.id);

  v_now_local := v_now at time zone v_tz;
  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  v_late := v_now_local > v_slot_end;

  if not p_allow_late then
    if a.date <> v_now_local::date then
      raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
    end if;
    if v_now_local < v_slot_start - interval '60 minutes' then
      raise exception 'Too early - check-in opens 60 minutes before the % slot.',
        to_char(v_slot_start, 'HH12:MI AM');
    end if;
    if v_now_local > v_slot_end + make_interval(mins => v_grace) then
      raise exception 'Too late - check-in for the % slot closed % minutes after it ended.',
        to_char(v_slot_start, 'HH12:MI AM'), v_grace;
    end if;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, a.date, 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  perform set_config('app.checkin_write', '1', true);

  update appointments
  set status = 'checked_in',
      checked_in_at = v_now,
      checked_in_by = auth.uid(),
      check_in_method = p_method,
      token_number = v_seq,
      arrival_seq = v_seq,
      token_date = a.date,
      was_late = v_late,
      -- Placeholder until the fairness formula arrives: arrival time is what
      -- the queue orders by today.
      effective_order_time = v_now,
      no_show_marked_at = null,
      no_show_auto = false
  where id = a.id;

  perform set_config('app.checkin_write', '0', true);

  return query select v_seq, v_seq, a.date, false, v_late;
end;
$$;

create or replace function public.skip_to_back(p_appointment_id uuid)
returns table (token_number int, arrival_seq int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_seq int;
  v_now timestamptz := now();
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;
  if a.status not in ('checked_in', 'called') then
    raise exception 'Only a waiting or called patient can be skipped (this one is "%").', a.status;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, coalesce(a.token_date, a.date), 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  perform set_config('app.checkin_write', '1', true);

  update appointments
  set token_number = v_seq,
      arrival_seq = v_seq,
      status = 'checked_in',
      skip_count = a.skip_count + 1,
      effective_order_time = v_now
  where id = a.id;

  perform set_config('app.checkin_write', '0', true);

  return query select v_seq, v_seq;
end;
$$;

-- ============================================================================
-- 31. FAIR QUEUE - THE ORDER RULE
-- ============================================================================
-- Who gets served first. Two ideas, held together:
--
--   1. Only patients who are CHECKED IN can be called at all. Someone who
--      hasn't walked through the door is not in the running, however early
--      their slot and however they paid.
--
--   2. Among those present, order by:
--          effective_order_time ASC, then checked_in_at ASC
--      where effective_order_time is
--        * the patient's SLOT time, if they arrived on time (checked in at
--          or before slot + grace) - so the earlier appointment wins, which
--          is the whole point of booking one; or
--        * their ACTUAL arrival time, if they were more than grace late -
--          so a 9AM booking wandering in at 2PM can't leapfrog everyone who
--          turned up when they said they would.
--
-- Payment is not consulted anywhere in this file. It cannot be: nothing here
-- reads payment_status.
--
-- Worked example (see TESTING.md "Test 12"):
--   A - 4PM slot, paid online, checks in 2:45 -> on time  -> effective 16:00
--   B - 3PM slot, paid at desk, checks in 2:55 -> on time -> effective 15:00
--   B is called first, despite A having arrived ten minutes earlier and paid
--   online. The earlier APPOINTMENT wins among punctual patients.

-- ----------------------------------------------------------------------------
-- 31.1 The rule itself, as one function
-- ----------------------------------------------------------------------------
-- Kept separate so check-in, the backfill below, and anyone reasoning about
-- the queue are all using literally the same arithmetic.
--
-- Everything is computed in the clinic's own wall-clock: slot_time is a plain
-- local time, so comparing it against a UTC now() would be wrong by the
-- offset. The result is converted back to timestamptz for storage.
create or replace function public.compute_effective_order_time(
  p_date date,
  p_slot_time time,
  p_checked_in_at timestamptz,
  p_grace_minutes int,
  p_timezone text default 'Asia/Kolkata'
)
returns timestamptz
language sql
immutable
as $$
  select case
    when p_checked_in_at is null then null
    -- On time (or early): the booked slot is what orders them.
    when (p_checked_in_at at time zone p_timezone)
         <= (p_date + p_slot_time) + make_interval(mins => p_grace_minutes)
      then ((p_date + p_slot_time) at time zone p_timezone)
    -- More than grace late: they forfeit slot priority and are ordered by
    -- when they actually turned up.
    else p_checked_in_at
  end;
$$;

-- ----------------------------------------------------------------------------
-- 31.2 Stamp it at check-in
-- ----------------------------------------------------------------------------
-- Identical to section 30's version except for the effective_order_time line,
-- which now applies the rule instead of always using the arrival moment.
create or replace function public.check_in_appointment(
  p_appointment_id uuid,
  p_method text default 'manual',
  p_allow_late boolean default false
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  a appointments;
  v_tz text;
  v_grace int;
  v_now_local timestamp;
  v_slot_start timestamp;
  v_slot_end timestamp;
  v_seq int;
  v_late boolean := false;
  v_is_desk boolean;
  v_now timestamptz := now();
begin
  if p_method is null or p_method not in ('clinic_scan', 'patient_scan', 'manual') then
    raise exception 'Unknown check-in method: %', p_method;
  end if;

  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  v_is_desk := public.is_admin() or public.is_own_clinic(a.clinic_id);

  if not (v_is_desk or public.is_own_mrn(a.member_id)) then
    raise exception 'You are not allowed to check in this appointment.';
  end if;

  if p_allow_late and not v_is_desk then
    raise exception 'Only the clinic can admit a late or no-show patient.';
  end if;

  if a.checked_in_at is not null and a.token_number is not null then
    return query select a.token_number, a.arrival_seq, a.token_date, true, a.was_late;
    return;
  end if;

  if a.status = 'no_show' and not p_allow_late then
    raise exception 'This patient was marked as a no-show. Use "Check in anyway" to admit them.';
  end if;

  if a.status not in ('accepted', 'no_show') then
    raise exception 'Only an accepted appointment can be checked in (this one is "%").', a.status;
  end if;

  select coalesce(c.timezone, 'Asia/Kolkata') into v_tz from clinics c where c.id = a.clinic_id;
  v_grace := public.effective_grace_minutes(a.id);

  v_now_local := v_now at time zone v_tz;
  v_slot_start := (a.date + a.slot_time);
  v_slot_end := v_slot_start + make_interval(mins => public.slot_minutes_for(a.doctor_id, a.date));

  v_late := v_now_local > v_slot_end;

  if not p_allow_late then
    if a.date <> v_now_local::date then
      raise exception 'This appointment is for %, not today.', to_char(a.date, 'DD Mon YYYY');
    end if;
    if v_now_local < v_slot_start - interval '60 minutes' then
      raise exception 'Too early - check-in opens 60 minutes before the % slot.',
        to_char(v_slot_start, 'HH12:MI AM');
    end if;
    if v_now_local > v_slot_end + make_interval(mins => v_grace) then
      raise exception 'Too late - check-in for the % slot closed % minutes after it ended.',
        to_char(v_slot_start, 'HH12:MI AM'), v_grace;
    end if;
  end if;

  insert into clinic_token_counters (clinic_id, token_date, last_seq)
  values (a.clinic_id, a.date, 1)
  on conflict (clinic_id, token_date)
  do update set last_seq = clinic_token_counters.last_seq + 1
  returning clinic_token_counters.last_seq into v_seq;

  perform set_config('app.checkin_write', '1', true);

  update appointments
  set status = 'checked_in',
      checked_in_at = v_now,
      checked_in_by = auth.uid(),
      check_in_method = p_method,
      token_number = v_seq,
      arrival_seq = v_seq,
      token_date = a.date,
      was_late = v_late,
      effective_order_time =
        public.compute_effective_order_time(a.date, a.slot_time, v_now, v_grace, v_tz),
      no_show_marked_at = null,
      no_show_auto = false
  where id = a.id;

  perform set_config('app.checkin_write', '0', true);

  return query select v_seq, v_seq, a.date, false, v_late;
end;
$$;

-- Bring existing checked-in rows onto the rule (section 30 stamped them with
-- the plain arrival time).
update appointments a
set effective_order_time = public.compute_effective_order_time(
      a.date, a.slot_time, a.checked_in_at,
      coalesce(a.grace_minutes, c.checkin_grace_minutes, 30),
      coalesce(c.timezone, 'Asia/Kolkata'))
from clinics c
where c.id = a.clinic_id and a.checked_in_at is not null;

-- ----------------------------------------------------------------------------
-- 31.3 The ordered queue, for the clinic
-- ----------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: ordinary RLS applies, so a clinic sees exactly
-- its own appointments and nobody else's. Because a clinic can see ALL of its
-- own rows for that doctor/day, the position computed here is the true one.
create or replace function public.get_clinic_queue(p_doctor_id uuid, p_date date)
returns table (
  queue_position int,
  id uuid,
  token_number int,
  status text,
  slot_time time,
  checked_in_at timestamptz,
  effective_order_time timestamptz,
  was_late boolean,
  reminder_count int,
  skip_count int,
  payment_status text,
  patient_name text,
  account_id uuid,
  phone text,
  gender text,
  dob date
)
language sql
stable
as $$
  select
    row_number() over (order by a.effective_order_time asc, a.checked_in_at asc)::int,
    a.id, a.token_number, a.status, a.slot_time, a.checked_in_at, a.effective_order_time,
    a.was_late, a.reminder_count, a.skip_count, a.payment_status,
    f.name, f.account_id, f.phone, f.gender, f.dob
  from appointments a
  join family_members f on f.id = a.member_id
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
  order by a.effective_order_time asc, a.checked_in_at asc;
$$;

-- ----------------------------------------------------------------------------
-- 31.4 The ordered queue, for patients
-- ----------------------------------------------------------------------------
-- Same ordering, but carrying nothing that identifies anybody - just the
-- position, the token being called, and the state. A patient finds their own
-- row by their own token number. security definer because a patient cannot
-- (and must not) read other patients' appointment rows directly.
--
-- Dropped rather than replaced: it gains a `position` column, and OUT
-- parameters are part of a function's return type.
drop function if exists public.get_queue_status(uuid, date);
create or replace function public.get_queue_status(p_doctor_id uuid, p_date date)
returns table (queue_position int, token_number int, status text)
language sql
stable
security definer
set search_path = public
as $$
  select
    row_number() over (order by a.effective_order_time asc, a.checked_in_at asc)::int,
    a.token_number,
    a.status
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status in ('checked_in', 'called', 'in_consultation')
    and a.token_number is not null
  order by a.effective_order_time asc, a.checked_in_at asc;
$$;

-- ----------------------------------------------------------------------------
-- 31.5 Calling the next patient
-- ----------------------------------------------------------------------------
-- Server-side so the order rule can't be reinterpreted by a client.
--
-- No preemption: if somebody is already called or in consultation, this
-- refuses rather than pulling the doctor off them.
--
-- No idling: the candidate set is only ever patients who are physically here,
-- so the doctor is never held waiting for someone who hasn't arrived. An
-- earlier-slot patient who turns up within grace simply sorts to the front
-- and takes the NEXT free turn - never the current one.
create or replace function public.call_next_patient(p_doctor_id uuid, p_date date)
returns table (id uuid, token_number int, queue_position int, patient_name text, account_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_clinic_id uuid;
  v_busy uuid;
  v_next appointments;
begin
  select a.clinic_id into v_clinic_id
  from appointments a where a.doctor_id = p_doctor_id limit 1;

  if v_clinic_id is null then
    raise exception 'No appointments for this doctor.';
  end if;
  if not (public.is_admin() or public.is_own_clinic(v_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select a.id into v_busy
  from appointments a
  where a.doctor_id = p_doctor_id and a.date = p_date
    and a.status in ('called', 'in_consultation')
  limit 1;

  if v_busy is not null then
    raise exception 'Someone is already being seen - finish or skip them first.';
  end if;

  select * into v_next
  from appointments a
  where a.doctor_id = p_doctor_id and a.date = p_date and a.status = 'checked_in'
  order by a.effective_order_time asc, a.checked_in_at asc
  limit 1;

  if v_next.id is null then
    raise exception 'Nobody is checked in and waiting.';
  end if;

  update appointments set status = 'called' where id = v_next.id;

  return query
  select v_next.id, v_next.token_number, 1, f.name, f.account_id
  from family_members f where f.id = v_next.member_id;
end;
$$;

-- ============================================================================
-- 32. REWARDING ONLINE PAYMENT - WITH CONVENIENCE, NEVER PRIORITY
-- ============================================================================
-- Paying online may buy a patient a faster, calmer arrival. It may never buy
-- them an earlier turn.
--
-- Everything in this file is about the DOOR, not the QUEUE:
--   * skip the counter - check in by self-scan instead of queueing to pay,
--   * a guaranteed confirmed slot - the booking is accepted without waiting
--     on the clinic's inbox,
--   * a gentler rescheduling window.
--
-- Note what is absent, deliberately and permanently: nothing here touches
-- effective_order_time, checked_in_at, token_number or arrival_seq. The order
-- rule in section 31 reads none of these settings and never reads
-- payment_status at all, so no combination of them can move a paid patient
-- ahead of an earlier-slot one. Section 30.5's guard trigger keeps the
-- presence columns unwritable from outside the check-in path regardless.
--
-- All three perks are opt-in per clinic - they change how a clinic runs its
-- front desk, which is the clinic's call, not the platform's.
--
-- See TESTING.md "Test 13".

-- ----------------------------------------------------------------------------
-- 32.1 Clinic settings
-- ----------------------------------------------------------------------------

-- Skip the counter: a patient who has already paid online may self-scan
-- reception's rotating code even at a clinic that hasn't opened self check-in
-- to everyone. Presence is still proven exactly as in section 28 - the code
-- rotates every few minutes and is verified server-side, plus the optional
-- geofence. This shortens the QUEUE AT THE COUNTER, not the queue for the
-- doctor.
alter table clinics add column if not exists fast_checkin_paid_online boolean not null default false;

-- Guaranteed confirmed slot: a booking paid online is accepted on the spot
-- rather than waiting in the clinic's approval inbox.
alter table clinics add column if not exists auto_confirm_paid_online boolean not null default false;

-- Easier rescheduling: how close to the appointment a patient may still
-- cancel or move it. The paid-online window is allowed to be shorter (i.e.
-- more forgiving) - it is never used to grant queue position.
alter table clinics add column if not exists reschedule_window_hours int not null default 2;
alter table clinics add column if not exists reschedule_window_hours_paid_online int not null default 1;

-- ----------------------------------------------------------------------------
-- 32.2 Guaranteed confirmed slot
-- ----------------------------------------------------------------------------
-- Fires on insert, before the booking ever reaches the clinic's inbox. Only
-- for a clinic that has switched it on, and only for money actually taken
-- online. It sets status - never a presence column - so the patient still
-- holds no token and must still physically arrive.
create or replace function public.auto_confirm_paid_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto boolean;
begin
  if new.payment_status = 'paid_online' and new.status = 'booked' then
    select auto_confirm_paid_online into v_auto from clinics where id = new.clinic_id;
    if coalesce(v_auto, false) then
      new.status := 'accepted';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_appointment_auto_confirm on appointments;
create trigger on_appointment_auto_confirm
  before insert on appointments
  for each row execute function public.auto_confirm_paid_booking();

-- ----------------------------------------------------------------------------
-- 32.3 Skip-the-counter self check-in
-- ----------------------------------------------------------------------------
-- Same function as section 28/29, with one clause widened: the clinic gate
-- now passes if self check-in is open to everyone OR this particular patient
-- paid online and the clinic offers the fast lane. Every anti-fraud check is
-- untouched - correctly signed CURRENT reception code, an accepted
-- appointment at this clinic today, optional geofence - and it still ends in
-- the ordinary check_in_appointment(), which draws an ordinary token.
drop function if exists public.self_check_in(text, double precision, double precision);
create or replace function public.self_check_in(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null
)
returns table (token_number int, arrival_seq int, token_date date, already_checked_in boolean, was_late boolean)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  v_clinic_id uuid;
  v_window bigint;
  v_now_window bigint;
  c clinics;
  v_appt_id uuid;
  v_paid boolean;
  v_distance double precision;
begin
  parts := string_to_array(coalesce(p_code, ''), ':');
  if array_length(parts, 1) <> 6
     or parts[1] <> 'sanjeevni' or parts[2] <> 'clinic' or parts[3] <> 'v1'
  then
    raise exception 'That is not a clinic check-in code.';
  end if;

  begin
    v_clinic_id := parts[4]::uuid;
    v_window := parts[5]::bigint;
  exception when others then
    raise exception 'That is not a clinic check-in code.';
  end;

  if public.sign_qr_payload(parts[4] || '|' || parts[5]) <> parts[6] then
    raise exception 'That check-in code is not valid.';
  end if;

  v_now_window := public.clinic_checkin_window();
  if v_window <> v_now_window and v_window <> v_now_window - 1 then
    raise exception 'That check-in code has expired - please scan the code on the screen at reception.';
  end if;

  select * into c from clinics where id = v_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  -- The caller's own accepted appointment at this clinic, today.
  select a.id, (a.payment_status = 'paid_online')
    into v_appt_id, v_paid
  from appointments a
  where a.clinic_id = v_clinic_id
    and a.date = (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date
    and a.status = 'accepted'
    and public.is_own_mrn(a.member_id)
  order by a.slot_time
  limit 1;

  if v_appt_id is null then
    raise exception 'No confirmed appointment found for you at this clinic today.';
  end if;

  -- The widened gate. Either the clinic lets everyone self check in, or this
  -- patient has already paid online and the clinic offers the fast lane.
  if not (c.self_checkin_enabled or (c.fast_checkin_paid_online and coalesce(v_paid, false))) then
    raise exception 'This clinic does not offer self check-in - please see the reception desk.';
  end if;

  if c.self_checkin_require_location then
    if p_lat is null or p_lng is null then
      raise exception 'Location is required to check yourself in here. Allow location access and try again.';
    end if;
    if c.lat is null or c.lng is null then
      raise exception 'This clinic has not set its location yet - please see the reception desk.';
    end if;
    v_distance := public.distance_metres(p_lat, p_lng, c.lat, c.lng);
    if v_distance > c.self_checkin_radius_m then
      raise exception 'You appear to be about %m from the clinic. Self check-in only works at the clinic.',
        round(v_distance)::int;
    end if;
  end if;

  return query select * from public.check_in_appointment(v_appt_id, 'patient_scan', false);
end;
$$;

-- ----------------------------------------------------------------------------
-- 32.4 What the patient's app needs to know
-- ----------------------------------------------------------------------------
-- The pass screen has to explain the right thing to the right patient - "tap
-- to check in" versus "check in at the counter when you pay" - which means
-- knowing the clinic's settings for THIS booking. A patient can already read
-- the clinic row, but not the columns that matter here, so this hands back
-- exactly the four facts the screen needs and nothing else.
create or replace function public.get_checkin_options(p_appointment_id uuid)
returns table (
  can_self_check_in boolean,
  requires_location boolean,
  paid_online boolean,
  reschedule_window_hours int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a appointments;
  c clinics;
  v_paid boolean;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select * into c from clinics where id = a.clinic_id;
  v_paid := (a.payment_status = 'paid_online');

  return query select
    (c.self_checkin_enabled or (c.fast_checkin_paid_online and v_paid)),
    c.self_checkin_require_location,
    v_paid,
    case when v_paid then c.reschedule_window_hours_paid_online else c.reschedule_window_hours end;
end;
$$;

-- ============================================================================
-- 33. ADVANCE-ONLY BOOKING WITH A DAILY CAP (a clinic MODE)
-- ============================================================================
-- Some clinics don't want a waiting room full of hopefuls. They take a fixed
-- number of patients per day, booked in advance only, and that's that.
--
-- This is a MODE, not a rewrite: a clinic runs either
--   'allow_walkins'     - everything as before (the default; nothing changes
--                         for existing clinics), or
--   'appointment_only'  - no same-day booking, no walk-ins from anyone
--                         (patient app OR front desk), bookings limited to a
--                         horizon of N days ahead, and a hard daily cap.
--
-- In appointment_only mode a booking inside the cap is auto-confirmed - there
-- is nothing for the clinic to approve when the only question was "is there a
-- seat". The clinic can still cancel an individual booking with a reason.
--
-- When a day is full the patient is offered the waitlist for that day and/or
-- the next day that still has room.
--
-- See TESTING.md "Test 14".

-- ----------------------------------------------------------------------------
-- 33.1 Clinic settings
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists mode text not null default 'allow_walkins';
alter table clinics drop constraint if exists clinics_mode_check;
alter table clinics add constraint clinics_mode_check
  check (mode in ('allow_walkins', 'appointment_only'));

-- How far ahead patients may book. 1 = tomorrow only, which is the default
-- for this mode's archetype.
alter table clinics add column if not exists booking_horizon_days int not null default 1;
alter table clinics add column if not exists daily_cap int not null default 100;

-- ----------------------------------------------------------------------------
-- 33.2 The per-day lock
-- ----------------------------------------------------------------------------
-- One row per (clinic, day), used purely as a mutex. Two patients racing for
-- the last seat both try to take this row; the second waits for the first to
-- commit and then counts again, so it sees the seat gone.
--
-- Deliberately NOT a stored seat count. A cached number drifts the moment a
-- booking is cancelled, rescheduled or moved by the full-day tool, and a
-- capacity limit that quietly drifts is worse than none. The row is the lock;
-- the count is always taken live from `appointments`.
create table if not exists clinic_day_locks (
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, date)
);

alter table clinic_day_locks enable row level security;
-- No policies: reached only from the security-definer functions below.

-- ----------------------------------------------------------------------------
-- 33.3 How full is a day?
-- ----------------------------------------------------------------------------
-- Cancelled and rejected bookings free their seat. A no-show does NOT - that
-- seat was held all day by someone who simply didn't come, and the day is
-- over by the time it matters.
create or replace function public.day_availability(p_clinic_id uuid, p_date date)
returns table (seats_taken int, daily_cap int, seats_left int, is_full boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    taken.n::int,
    c.daily_cap,
    greatest(c.daily_cap - taken.n, 0)::int,
    (taken.n >= c.daily_cap)
  from clinics c
  cross join lateral (
    select count(*) as n
    from appointments a
    where a.clinic_id = c.id
      and a.date = p_date
      and a.status not in ('cancelled', 'rejected')
  ) taken
  where c.id = p_clinic_id;
$$;

-- The soonest day inside the horizon that still has room. Used to offer a
-- patient somewhere to go when their preferred day is full.
create or replace function public.next_available_day(p_clinic_id uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_day date;
  v_full boolean;
  i int;
begin
  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    return null;
  end if;

  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  -- appointment_only starts at tomorrow; allow_walkins can still use today.
  for i in (case when c.mode = 'appointment_only' then 1 else 0 end)..c.booking_horizon_days loop
    v_day := v_today + i;
    if exists (select 1 from clinic_holidays h where h.clinic_id = c.id and h.date = v_day) then
      continue;
    end if;
    select is_full into v_full from public.day_availability(c.id, v_day);
    if not coalesce(v_full, false) then
      return v_day;
    end if;
  end loop;

  return null;
end;
$$;

-- ----------------------------------------------------------------------------
-- 33.4 The policy, enforced on insert
-- ----------------------------------------------------------------------------
-- Named to sort FIRST among this table's BEFORE INSERT triggers (Postgres
-- fires them in alphabetical order). It has to beat
-- on_appointment_create_encounter, or a booking that's about to be refused
-- would burn an encounter number on its way out.
create or replace function public.enforce_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_taken int;
  v_full boolean;
begin
  select * into c from clinics where id = new.clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  -- Everything below is this mode's contract. Other clinics are untouched.
  if c.mode <> 'appointment_only' then
    return new;
  end if;

  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  if new.patient_type = 'walk_in' then
    raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
  end if;

  if new.date <= v_today then
    raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
      to_char(v_today + 1, 'DD Mon YYYY');
  end if;

  if new.date > v_today + c.booking_horizon_days then
    raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
      c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
  end if;

  -- Take the day's lock BEFORE counting. Two patients going for the last seat
  -- serialise here: the second one waits, then counts a day that is now full.
  insert into clinic_day_locks (clinic_id, date)
  values (new.clinic_id, new.date)
  on conflict (clinic_id, date) do update set updated_at = now();

  select seats_taken, is_full into v_taken, v_full
  from public.day_availability(new.clinic_id, new.date);

  if coalesce(v_full, false) then
    raise exception 'FULL_DAY: % is fully booked (% of % seats taken).',
      to_char(new.date, 'DD Mon YYYY'), v_taken, c.daily_cap;
  end if;

  -- Inside the cap, so there is nothing to approve: the only question this
  -- clinic asks of a booking is whether a seat exists.
  if new.status = 'booked' then
    new.status := 'accepted';
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_aa_booking_policy on appointments;
create trigger on_appointment_aa_booking_policy
  before insert on appointments
  for each row execute function public.enforce_booking_policy();

-- ----------------------------------------------------------------------------
-- 33.5 Waitlist
-- ----------------------------------------------------------------------------
create table if not exists waitlist (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete cascade,
  doctor_id uuid references doctors (id) on delete set null,
  date date not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'offered', 'converted', 'cancelled')),
  offered_at timestamptz,
  created_at timestamptz not null default now(),
  -- One entry per person per clinic per day; asking twice doesn't buy a
  -- better place.
  unique (clinic_id, member_id, date)
);

alter table waitlist enable row level security;

drop policy if exists "waitlist_select" on waitlist;
create policy "waitlist_select" on waitlist for select
  using (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_mrn(member_id));

drop policy if exists "waitlist_insert" on waitlist;
create policy "waitlist_insert" on waitlist for insert
  with check (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_mrn(member_id));

drop policy if exists "waitlist_update" on waitlist;
create policy "waitlist_update" on waitlist for update
  using (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_mrn(member_id));

create index if not exists waitlist_clinic_date_idx on waitlist (clinic_id, date, created_at);

-- When a seat frees on a full day, tell the person who has been waiting
-- longest. It only NOTIFIES - it never books on their behalf, because a seat
-- silently allocated to someone who has since made other plans is worse than
-- no seat at all.
create or replace function public.notify_waitlist_on_free_seat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w waitlist;
  v_clinic clinics;
begin
  if new.status not in ('cancelled', 'rejected') or old.status = new.status then
    return new;
  end if;

  select * into v_clinic from clinics where id = new.clinic_id;
  if v_clinic.mode <> 'appointment_only' then
    return new;
  end if;

  select * into w
  from waitlist
  where clinic_id = new.clinic_id and date = new.date and status = 'waiting'
  order by created_at
  limit 1;

  if w.id is null then
    return new;
  end if;

  update waitlist set status = 'offered', offered_at = now() where id = w.id;

  insert into notifications (user_id, type, message)
  select f.account_id, 'waitlist_seat',
         'A seat has opened up at ' || v_clinic.name || ' on '
           || to_char(new.date, 'DD Mon YYYY') || '. Book now - it is first come, first served.'
  from family_members f
  where f.id = w.member_id;

  return new;
end;
$$;

drop trigger if exists on_appointment_free_seat on appointments;
create trigger on_appointment_free_seat
  after update on appointments
  for each row execute function public.notify_waitlist_on_free_seat();

-- Joining the waitlist. Idempotent: asking again returns the existing entry
-- rather than creating a second one or moving anybody up.
create or replace function public.join_waitlist(
  p_clinic_id uuid,
  p_member_id uuid,
  p_date date,
  p_doctor_id uuid default null
)
returns table (id uuid, already_waiting boolean, place int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing waitlist;
  v_id uuid;
begin
  if not (public.is_admin() or public.is_own_mrn(p_member_id) or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select * into v_existing
  from waitlist
  where clinic_id = p_clinic_id and member_id = p_member_id and date = p_date;

  if v_existing.id is not null then
    if v_existing.status = 'cancelled' then
      update waitlist set status = 'waiting', created_at = now() where id = v_existing.id;
    end if;
    v_id := v_existing.id;
  else
    insert into waitlist (clinic_id, member_id, doctor_id, date)
    values (p_clinic_id, p_member_id, p_doctor_id, p_date)
    returning waitlist.id into v_id;
  end if;

  return query
  select v_id,
         (v_existing.id is not null),
         (select count(*)::int
          from waitlist w2
          where w2.clinic_id = p_clinic_id and w2.date = p_date
            and w2.status in ('waiting', 'offered')
            and w2.created_at <= (select w3.created_at from waitlist w3 where w3.id = v_id));
end;
$$;

-- ============================================================================
-- 34. PUBLISH THE DAY SCHEDULE (the night-before batch)
-- ============================================================================
-- This is SCHEDULING, not check-in. The evening before (or whenever the
-- clinic opens), the desk publishes the running order for that day's booked
-- patients in ONE action. For every booked patient that day, publishing:
--
--   * assigns a sequence number - their place in the day's order, 1..N,
--   * works out an estimated appointment time, walking forward from the
--     clinic's day-start time in fixed per-patient minutes, and
--   * notifies the patient that their number and time are now available.
--
-- Publishing does NOT check anyone in and does NOT touch token_number - that
-- stays exactly what section 27 made it: a real number handed out at the
-- door, in arrival order, the moment a patient is actually checked in. A
-- published sequence number is a plan; the arrival token is what actually
-- happened. Being CALLED still requires check-in on arrival, which is what
-- keeps a no-show from stalling the queue - see check_in_appointment().
--
-- Ordering follows booked slot time (every appointment has one), falling
-- back to booking time (created_at) only to break a tie between two
-- identical slot times. The clinic can override that order, or block out a
-- break, before publishing - see 34.3 and 34.4.
--
-- See TESTING.md "Test 15".

-- ----------------------------------------------------------------------------
-- 34.1 Clinic settings the estimate is built from
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists publish_start_time time not null default '09:00:00';

alter table clinics drop constraint if exists clinics_avg_minutes_per_patient_check;
alter table clinics add column if not exists avg_minutes_per_patient int not null default 10;
alter table clinics add constraint clinics_avg_minutes_per_patient_check check (avg_minutes_per_patient > 0);

-- ----------------------------------------------------------------------------
-- 34.2 Appointment columns
-- ----------------------------------------------------------------------------
-- The published running-order number. Deliberately a separate column from
-- token_number (section 27): this one is assigned the night before, to
-- EVERY booked patient, in booking order; token_number is assigned at the
-- door, only to patients who actually showed up, in arrival order. Mixing
-- the two would silently reintroduce the "a punctual booking loses its place
-- to whoever happens to arrive first" problem section 27 was written to fix.
alter table appointments add column if not exists sequence_no int;
alter table appointments add column if not exists estimated_time time;
-- Null until the first publish for this appointment's day; set on every
-- publish/republish after that. Read by the client purely to decide whether
-- to show "your number will be published" or the number itself - it isn't
-- used in check-in.
alter table appointments add column if not exists schedule_published_at timestamptz;
-- The clinic's manual reorder, set directly (appointments RLS already lets
-- the owning clinic update its own rows). A plain rank rather than an
-- integer position: to move a patient between two neighbours, the clinic
-- sets this to the midpoint of their two ranks, so reordering one patient
-- never requires renumbering everyone else. Null means "no override - use
-- slot time".
alter table appointments add column if not exists day_order_override double precision;

-- One published sequence number per clinic per day. Catches a bug in
-- compute_day_schedule() rather than silently handing two patients the same
-- slip.
drop index if exists appointments_clinic_day_sequence_unique;
create unique index appointments_clinic_day_sequence_unique
  on appointments (clinic_id, date, sequence_no)
  where sequence_no is not null;

-- ----------------------------------------------------------------------------
-- 34.3 Breaks the clinic blocks out before publishing
-- ----------------------------------------------------------------------------
-- "Insert a `minutes`-long gap before whoever ends up as the `before_seq`th
-- patient." Kept as a position in the FINAL order rather than a clock time,
-- because the whole point of a break is to hold regardless of how the
-- clinic reorders people around it - a lunch break "before patient 15" stays
-- before patient 15 even if patient 15 changes.
create table if not exists clinic_schedule_breaks (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  date date not null,
  before_seq int not null check (before_seq > 0),
  minutes int not null check (minutes > 0),
  label text,
  created_at timestamptz not null default now()
);

alter table clinic_schedule_breaks enable row level security;

drop policy if exists "clinic_schedule_breaks_all" on clinic_schedule_breaks;
create policy "clinic_schedule_breaks_all" on clinic_schedule_breaks for all
  using (public.is_own_clinic(clinic_id) or public.is_admin())
  with check (public.is_own_clinic(clinic_id) or public.is_admin());

create index if not exists clinic_schedule_breaks_day_idx on clinic_schedule_breaks (clinic_id, date);

-- ----------------------------------------------------------------------------
-- 34.4 compute_day_schedule(): the ordering, shared by preview and publish
-- ----------------------------------------------------------------------------
-- Everyone with a live reservation for the day - booked, accepted, or
-- already further along (a republish mid-day must not drop someone who has
-- since been checked in). Cancelled/rejected/completed/no_show hold no
-- place in a running order.
--
-- Order: the clinic's manual rank if it set one, else booking-time-derived
-- rank (slot_time, then created_at to break a tie). Read-only - this never
-- writes anything, so calling it twice in the same publish (once to find
-- who fell out, once to write) is cheap and always consistent.
create or replace function public.compute_day_schedule(p_clinic_id uuid, p_date date)
returns table (appointment_id uuid, seq int, estimated_time time)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c clinics;
  v_clock time;
  v_minutes int;
  v_seq int := 0;
  v_break_minutes int;
  r record;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  v_clock := c.publish_start_time;
  v_minutes := greatest(c.avg_minutes_per_patient, 1);

  for r in (
    with base as (
      select a.id,
             row_number() over (order by a.slot_time, a.created_at) as base_rank,
             a.day_order_override
      from appointments a
      where a.clinic_id = p_clinic_id
        and a.date = p_date
        and a.status in ('booked', 'accepted', 'checked_in', 'called', 'in_consultation')
    )
    select id
    from base
    order by coalesce(day_order_override, base_rank), base_rank
  ) loop
    v_seq := v_seq + 1;

    -- Any break(s) the clinic placed right before this position push the
    -- clock forward before this patient's time is set.
    select coalesce(sum(b.minutes), 0) into v_break_minutes
    from clinic_schedule_breaks b
    where b.clinic_id = p_clinic_id and b.date = p_date and b.before_seq = v_seq;
    v_clock := v_clock + make_interval(mins => v_break_minutes);

    appointment_id := r.id;
    seq := v_seq;
    estimated_time := v_clock;
    return next;

    v_clock := v_clock + make_interval(mins => v_minutes);
  end loop;
end;
$$;

-- Read-only look at what publishing WOULD do, so the clinic can review the
-- order (and add breaks / drag people around) before committing to it.
-- Touches nothing.
create or replace function public.preview_day_schedule(p_clinic_id uuid, p_date date)
returns table (
  appointment_id uuid,
  seq int,
  estimated_time time,
  member_name text,
  doctor_name text,
  slot_time time,
  status text,
  patient_type text,
  day_order_override double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select c.appointment_id, c.seq, c.estimated_time, fm.name, d.name, a.slot_time, a.status, a.patient_type,
         a.day_order_override
  from public.compute_day_schedule(p_clinic_id, p_date) c
  join appointments a on a.id = c.appointment_id
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  order by c.seq;
$$;

-- ----------------------------------------------------------------------------
-- 34.5 publish_day_schedule(): the one action
-- ----------------------------------------------------------------------------
-- Writes sequence_no/estimated_time/schedule_published_at onto every
-- appointment compute_day_schedule() names, notifies each patient, and hands
-- back the published list (with the patient's permanent visit id - the
-- encounter_no every booking already carries, see section 18 - so the
-- clinic/patient screens have something stable to print or scan against).
-- Nothing here sets checked_in_at, status, or token_number: this function
-- never makes anyone "present".
create or replace function public.publish_day_schedule(p_clinic_id uuid, p_date date)
returns table (
  appointment_id uuid,
  seq int,
  estimated_time time,
  member_name text,
  encounter_no text,
  doctor_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  c clinics;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  -- Anyone who has fallen out of today's run since the last publish
  -- (cancelled, rejected, written off as a no-show) loses their stale number
  -- rather than go on showing a slip for a place that no longer exists.
  update appointments a
  set sequence_no = null, estimated_time = null
  where a.clinic_id = p_clinic_id and a.date = p_date
    and a.sequence_no is not null
    and not exists (
      select 1 from public.compute_day_schedule(p_clinic_id, p_date) comp where comp.appointment_id = a.id
    );

  update appointments a
  set sequence_no = comp.seq,
      estimated_time = comp.estimated_time,
      schedule_published_at = v_now
  from public.compute_day_schedule(p_clinic_id, p_date) comp
  where a.id = comp.appointment_id;

  -- Tell every patient in this run their place and time. Sent on every
  -- publish, including a republish after a reorder - the point is that the
  -- number on the patient's phone always matches what's on file, not that it
  -- is announced exactly once.
  insert into notifications (user_id, appointment_id, type, message)
  select fm.account_id, a.id, 'schedule_published',
    'Your number for ' || to_char(p_date, 'DD Mon YYYY') || ' at ' || c.name || ' is #' || a.sequence_no
      || ', expected around ' || to_char(a.estimated_time, 'HH12:MI AM')
      || '. This is your place in the day''s order, not a check-in - you will still need to check in when you arrive.'
  from appointments a
  join family_members fm on fm.id = a.member_id
  where a.clinic_id = p_clinic_id and a.date = p_date and a.schedule_published_at = v_now;

  return query
  select a.id, a.sequence_no, a.estimated_time, fm.name, e.encounter_no, d.name
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  left join encounters e on e.id = a.encounter_id
  where a.clinic_id = p_clinic_id and a.date = p_date and a.schedule_published_at = v_now
  order by a.sequence_no;
end;
$$;

-- ============================================================================
-- 35. ON-THE-DAY CHECK-IN: SCAN OR PATIENT ID, AND THE LIVE QUEUE
-- ============================================================================
-- The reception-desk screen for the day itself: scan the patient's QR (or
-- type their patient ID - their MRN, see section 18) and see, in one look,
-- who they are, their photo, their PRE-ASSIGNED number and time from the
-- night-before publish (section 34), and what's owed - before committing to
-- anything. Only pressing "Check in" actually does something.
--
-- Nothing about arrival order, no-idle, no-preemption or the grace window is
-- reimplemented here. Those rules already exist, already tested (see
-- TESTING.md "Test 7" and "Test 12"), and this migration deliberately reuses
-- them exactly as they stand:
--   * check_in_appointment() / check_in_with_qr()  (sections 27, 28, 30.6, 31)
--     are what actually marks a patient present and puts them on the live
--     board. This migration does not touch them.
--   * get_clinic_queue() / call_next_patient() / get_queue_status()
--     (section 31) are what serves the live board in order, skipping anyone
--     not checked in, never preempting, and applying the grace-period rule to
--     a late arrival. Also untouched.
--   * mark_paid_at_clinic() (section 30.4) is what the "Mark paid" button
--     calls. Also untouched.
--
-- What this migration adds is the piece in front of all of that: a single
-- read-only lookup that resolves "this QR" or "this patient ID" to the one
-- appointment it means, for TODAY at THIS clinic, and hands back everything
-- the scan card needs to show - without checking anyone in. The "sequence
-- number" a patient is quoted here is the one publish_day_schedule() (section
-- 34) already assigned the night before; it stays a distinct fact from
-- token_number by the same reasoning section 34.2 already gives - this is
-- what the desk shows as "your expected number" right up until the patient
-- is actually standing at the door, at which point checking them in is what
-- puts them on the live board, ordered by the existing fair-queue rule.
--
-- Also new: a patient photo, shown on the scan card so the desk can match
-- face to name at a glance. Stored the same way every other upload in this
-- app is - a private bucket, a path column, and a signed URL fetched on
-- demand.
--
-- See TESTING.md "Test 16".

-- ----------------------------------------------------------------------------
-- 35.1 Patient photo
-- ----------------------------------------------------------------------------
alter table family_members add column if not exists photo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'patient-photos', 'patient-photos', false, 5242880,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Stored as "{member_id}/{random}-{filename}". Readable by the owning
-- account (to preview their own upload) and by any clinic that has an
-- appointment with this patient (so the check-in scan card can show it) -
-- the same "has this clinic ever seen this patient" reach get_clinic_queue()
-- already relies on via family_members. Writable only by the owning account.
drop policy if exists "patient_photos_select" on storage.objects;
create policy "patient_photos_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1]
        and (
          public.is_own_member(fm.id)
          or public.is_admin()
          or exists (
            select 1 from appointments a
            where a.member_id = fm.id and public.is_own_clinic(a.clinic_id)
          )
        )
    )
  );

drop policy if exists "patient_photos_insert" on storage.objects;
create policy "patient_photos_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1] and public.is_own_member(fm.id)
    )
  );

drop policy if exists "patient_photos_update" on storage.objects;
create policy "patient_photos_update" on storage.objects for update
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1] and public.is_own_member(fm.id)
    )
  );

drop policy if exists "patient_photos_delete" on storage.objects;
create policy "patient_photos_delete" on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'patient-photos'
    and exists (
      select 1 from family_members fm
      where fm.id::text = (storage.foldername(name))[1] and public.is_own_member(fm.id)
    )
  );

-- ----------------------------------------------------------------------------
-- 35.2 lookup_checkin(): resolve a scan or a patient ID to today's
-- appointment, read-only
-- ----------------------------------------------------------------------------
-- Exactly one of p_qr_code / p_mrn is supplied by the caller. Raises rather
-- than returning an empty set, so the scan card can show one clear reason
-- ("not found", "not your clinic", "no appointment today") instead of a
-- silent blank.
--
-- The QR branch trusts verify_booking_qr() (section 28.2) for identity and
-- does not itself re-check the date - check_in_with_qr() still enforces the
-- arrival window when the desk actually presses "Check in", so scanning a
-- code for the wrong day surfaces as an error at that point, same as it
-- always has.
--
-- The patient-ID branch is scoped to TODAY in the CLINIC's own timezone
-- (same reasoning as check_in_appointment()'s date guard, section 27.7) and
-- to appointments actually live for the desk to act on: confirmed but not
-- yet arrived, marked no-show but possibly walking in anyway, or already on
-- the live board (so re-scanning/re-typing after check-in just shows the
-- same patient again rather than an error).
create or replace function public.lookup_checkin(
  p_clinic_id uuid,
  p_qr_code text default null,
  p_mrn text default null
)
returns table (
  appointment_id uuid,
  member_id uuid,
  patient_name text,
  photo_path text,
  mrn text,
  dob date,
  gender text,
  status text,
  already_checked_in boolean,
  token_number int,
  sequence_no int,
  estimated_time time,
  slot_time time,
  doctor_name text,
  payment_status text,
  amount_due numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_appt_id uuid;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;
  v_today := (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))::date;

  if p_qr_code is not null and trim(p_qr_code) <> '' then
    v_appt_id := public.verify_booking_qr(p_qr_code);
    if v_appt_id is null then
      raise exception 'This code is not valid or has expired. Ask the patient to refresh their screen.';
    end if;
  elsif p_mrn is not null and trim(p_mrn) <> '' then
    select a.id into v_appt_id
    from appointments a
    join family_members fm on fm.id = a.member_id
    where fm.mrn = trim(p_mrn)
      and a.clinic_id = p_clinic_id
      and a.date = v_today
      and a.status in ('accepted', 'no_show', 'checked_in', 'called', 'in_consultation')
    order by (a.status = 'accepted') desc, a.slot_time
    limit 1;
    if v_appt_id is null then
      raise exception 'No appointment found for patient ID "%" today at this clinic.', trim(p_mrn);
    end if;
  else
    raise exception 'Scan a QR code or enter a patient ID.';
  end if;

  if not exists (select 1 from appointments a where a.id = v_appt_id and a.clinic_id = p_clinic_id) then
    raise exception 'This booking is not at your clinic.';
  end if;

  return query
  select
    a.id, fm.id, fm.name, fm.photo_path, fm.mrn, fm.dob, fm.gender,
    a.status, (a.checked_in_at is not null), a.token_number,
    a.sequence_no, a.estimated_time, a.slot_time, d.name,
    a.payment_status, p.amount
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  left join payments p on p.appointment_id = a.id
  where a.id = v_appt_id;
end;
$$;

-- ============================================================================
-- 36. SLOT-BASED BOOKING: CAPACITY & AVAILABILITY
-- ============================================================================
-- Until now a "slot" was never a real thing in the database - DoctorPage and
-- WalkInForm compute the day's slot TIMES on the client (see computeSlots()
-- in time.ts) and get_taken_slots() just says which of those exact times
-- already has ANY active booking. That is a capacity of exactly 1, silently,
-- with no server-side atomicity: two patients whose inserts land in the same
-- moment can both succeed at the same slot_time, because nothing ever locks
-- or re-checks between "is it free" and "take it".
--
-- This migration makes a slot a real capacity concept and closes that race,
-- for BOTH advance bookings and same-day walk-ins booked ahead:
--   * Each weekly availability window (doctor_availability) now carries a
--     slot_capacity - how many patients ONE of its computed time slots can
--     hold. Defaults to 1, so every existing clinic behaves exactly as
--     before until someone raises it.
--   * A slot is full when the number of active (not cancelled/rejected)
--     bookings at that exact (doctor, date, slot_time) reaches its capacity.
--   * Taking the last seat in a slot is enforced atomically on the server,
--     the same way section 33.2's clinic_day_locks makes the daily-cap check
--     race-proof: a per-slot lock row is taken BEFORE counting, so the
--     second of two simultaneous inserts for the last seat waits, then
--     counts a slot that is now full and is refused.
--   * The existing daily cap (section 33, "Part 44" in the product spec)
--     is untouched and still only applies in appointment_only mode - a day
--     is full when THAT cap is reached OR every one of the doctor's slots
--     for the day is full, whichever comes first. The second half of that
--     is simply what happens once every computed slot_time has hit its own
--     capacity: get_taken_slots() (redeclared below) reports all of them
--     taken, and the picker has nothing left to offer.
--
-- Deliberately NOT a stored, independently-maintained booked_count column -
-- see clinic_day_locks' own comment (section 33.2) for why a cached tally
-- that has to be kept in sync by hand (insert here, decrement there, don't
-- forget the reject path...) drifts the moment anyone misses a spot, and a
-- capacity limit that quietly drifts is worse than none. A slot's booked
-- count is always taken live from `appointments`, exactly like the daily
-- cap already is; doctor_slot_locks is the lock, not the ledger.
--
-- See TESTING.md "Test 17".

-- ----------------------------------------------------------------------------
-- 36.1 Capacity per slot
-- ----------------------------------------------------------------------------
-- How many patients ONE computed slot in this window can hold. Distinct from
-- max_patients_per_day, which decides how many slots the window is divided
-- into in the first place (see computeSlots() in time.ts) - that number times
-- this one is the window's true total capacity for the day.
alter table doctor_availability add column if not exists slot_capacity int not null default 1;
alter table doctor_availability drop constraint if exists doctor_availability_slot_capacity_check;
alter table doctor_availability add constraint doctor_availability_slot_capacity_check
  check (slot_capacity > 0);

-- ----------------------------------------------------------------------------
-- 36.2 The per-slot lock
-- ----------------------------------------------------------------------------
-- One row per (doctor, day, slot_time), used purely as a mutex - same shape
-- and purpose as clinic_day_locks (section 33.2), one level more specific.
-- Two patients racing for the last seat in one slot both try to take this
-- row; the second waits for the first to commit, then re-counts a slot that
-- is now full. Not a stored seat count - see the migration header above.
create table if not exists doctor_slot_locks (
  doctor_id uuid not null references doctors (id) on delete cascade,
  date date not null,
  slot_time time not null,
  updated_at timestamptz not null default now(),
  primary key (doctor_id, date, slot_time)
);

alter table doctor_slot_locks enable row level security;
-- No policies: reached only from the security-definer functions below.

-- ----------------------------------------------------------------------------
-- 36.3 Resolving a slot's capacity
-- ----------------------------------------------------------------------------
-- Which weekly window a given (doctor, date, slot_time) falls in, and that
-- window's slot_capacity. Falls back to 1 for a slot_time that doesn't land
-- inside any current window (e.g. a walk-in's "right now" timestamp, or a
-- window since removed) - the same conservative default the column itself
-- uses, so an unmatched slot is never silently treated as unlimited.
create or replace function public.slot_capacity_for(p_doctor_id uuid, p_date date, p_slot_time time)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select da.slot_capacity
      from doctor_availability da
      where da.doctor_id = p_doctor_id
        and da.weekday = extract(dow from p_date)::smallint
        and da.start_time <= p_slot_time
        and p_slot_time < da.end_time
      order by da.start_time
      limit 1
    ),
    1
  );
$$;

-- ----------------------------------------------------------------------------
-- 36.4 Enforced atomically on insert
-- ----------------------------------------------------------------------------
-- Named to sort right after on_appointment_aa_booking_policy (section 33.4)
-- and before every other BEFORE INSERT trigger on this table, so a booking
-- that's about to be refused for a full slot doesn't burn a subscription
-- booking, an encounter number, or an auto-confirm - same reasoning as why
-- the daily-cap gate sorts first.
--
-- Only genuine scheduled slot bookings claim a seat: patient_type = 'walk_in'
-- is a patient standing at the desk right now, whose slot_time is just the
-- clock at check-in (see createAndAcceptAppointment() in WalkInForm.tsx) -
-- not a claim on one of the doctor's bookable times, so it never contends
-- for slot capacity. A future visit booked in that same walk-in flow IS
-- patient_type = 'scheduled' and goes through exactly like a patient
-- self-booking one.
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity int;
  v_booked int;
begin
  if new.patient_type <> 'scheduled' then
    return new;
  end if;

  -- Take the slot lock BEFORE counting - see 36.2.
  insert into doctor_slot_locks (doctor_id, date, slot_time)
  values (new.doctor_id, new.date, new.slot_time)
  on conflict (doctor_id, date, slot_time) do update set updated_at = now();

  v_capacity := public.slot_capacity_for(new.doctor_id, new.date, new.slot_time);

  select count(*) into v_booked
  from appointments
  where doctor_id = new.doctor_id
    and date = new.date
    and slot_time = new.slot_time
    and status not in ('cancelled', 'rejected');

  if v_booked >= v_capacity then
    raise exception 'SLOT_FULL: % on % is full (% of % taken) - pick another slot.',
      to_char(new.slot_time, 'HH12:MI AM'), to_char(new.date, 'DD Mon YYYY'), v_booked, v_capacity;
  end if;

  return new;
end;
$$;

drop trigger if exists on_appointment_ab_slot_capacity on appointments;
create trigger on_appointment_ab_slot_capacity
  before insert on appointments
  for each row execute function public.enforce_slot_capacity();

-- ----------------------------------------------------------------------------
-- 36.5 get_taken_slots(), made capacity-aware
-- ----------------------------------------------------------------------------
-- Re-declared: a slot_time now reports as taken only once its ACTIVE booking
-- count reaches its capacity, not the instant it has one booking. For every
-- clinic still on the default slot_capacity = 1 this returns exactly what it
-- always did. Every existing caller (SlotPicker, WalkInForm's future-slot
-- picker, queue.ts's findNextBestSlot/findNextNSlots used by the waitlist and
-- RejectAppointmentForm's "next available slot" suggestion) treats this as
-- "times to exclude from the picker", so all of them gain capacity-aware
-- behaviour with no caller-side change.
create or replace function public.get_taken_slots(p_doctor_id uuid, p_date date)
returns table (slot_time time)
language sql
stable
security definer
set search_path = public
as $$
  select a.slot_time
  from appointments a
  where a.doctor_id = p_doctor_id
    and a.date = p_date
    and a.status not in ('rejected', 'cancelled')
  group by a.slot_time
  having count(*) >= public.slot_capacity_for(p_doctor_id, p_date, a.slot_time);
$$;

-- ----------------------------------------------------------------------------
-- 36.6 Index
-- ----------------------------------------------------------------------------
-- Both the trigger's live count and get_taken_slots() filter/group on
-- exactly this shape.
create index if not exists appointments_doctor_date_slot_idx
  on appointments (doctor_id, date, slot_time)
  where status not in ('cancelled', 'rejected');

-- ============================================================================
-- 37. SAME-DAY BOOKING FOR APPOINTMENT-ONLY CLINICS
-- ============================================================================
-- Section 33 ("Part 44" in the product spec) gave an appointment_only clinic
-- a hard rule: no same-day booking, no walk-ins, from anyone. That's still
-- the default. This migration lets a clinic running that mode OPT IN to
-- same-day booking on top of it, without touching allow_walkins clinics at
-- all - they already accept same-day bookings and walk-ins today, unchanged.
--
-- Three new clinic settings, all off by default so no existing clinic's
-- behaviour changes until it turns them on:
--   * same_day_booking_enabled  - the switch itself.
--   * same_day_cutoff_minutes   - how close to a slot same-day booking still
--                                  works. A scheduled slot inside this window
--                                  (or already passed) is refused - a walk-in
--                                  is exempt, since its "slot" is just the
--                                  clock at the desk, not a future promise.
--   * auto_checkin_verified_same_day - see below.
--
-- A same-day booking still goes through every existing gate once its date is
-- allowed at all: the daily cap and per-day lock (section 33.3/33.4) and, for
-- a genuine scheduled slot, the slot capacity check (section 36.4, "Prompt 1"
-- - is this slot still free). Nothing about those is touched here.
--
-- Token timing - the reason this is its own migration and not a one-line
-- relaxation of the date check:
--   * A walk-in registered at the desk is, as it always has been, standing
--     right there - WalkInForm already checks that patient in immediately
--     and draws their token the moment it accepts the booking (see
--     WalkInForm.tsx / check_in_appointment()). Lifting the walk-in block
--     below for a same-day-enabled clinic is all that's needed; nothing else
--     changes for that path.
--   * A same-day booking made through the PATIENT'S OWN APP, while their
--     device can verifiably place them at the clinic (the same geofence
--     idea section 28 already uses for self check-in), is treated the same
--     way - checked in immediately, token drawn right away. See 37.3.
--   * A same-day booking made remotely - from home, for a slot later today,
--     with no location fix or one outside the clinic's radius - gets NONE of
--     that. It is accepted exactly like an advance booking and collects its
--     token only when the patient actually arrives and checks in, through
--     the ordinary check_in_appointment() path. This is the whole point: a
--     token is never held by someone who is not, in fact, there.
--
-- See TESTING.md "Test 18".

-- ----------------------------------------------------------------------------
-- 37.1 Clinic settings
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists same_day_booking_enabled boolean not null default false;

alter table clinics add column if not exists same_day_cutoff_minutes int not null default 30;
alter table clinics drop constraint if exists clinics_same_day_cutoff_minutes_check;
alter table clinics add constraint clinics_same_day_cutoff_minutes_check
  check (same_day_cutoff_minutes >= 0);

-- Off by default, same reasoning as self_checkin_enabled (section 28.3): this
-- changes who can walk away with a live token, which is the clinic's call.
alter table clinics add column if not exists auto_checkin_verified_same_day boolean not null default false;

-- A separate radius from self_checkin_radius_m (section 28.3) rather than
-- reusing it - a clinic may want self check-in off (or a tighter/looser
-- radius for it) while still trusting this narrower, booking-time check, or
-- vice versa. Same default as that column's.
alter table clinics add column if not exists same_day_checkin_radius_m int not null default 150;
alter table clinics drop constraint if exists clinics_same_day_checkin_radius_m_check;
alter table clinics add constraint clinics_same_day_checkin_radius_m_check
  check (same_day_checkin_radius_m > 0);

-- ----------------------------------------------------------------------------
-- 37.2 Appointment columns: the booking-time location fix
-- ----------------------------------------------------------------------------
-- Optional, set only by a same-day booking made from the patient's own app
-- that could get a fix - never by a walk-in (the desk already knows they're
-- present) and never by an advance booking (irrelevant until the day of).
-- Kept as real columns rather than passed-and-discarded, both so 37.3 below
-- can read them from NEW inside the same INSERT and so there's a record of
-- what the auto-check-in decision (or non-decision) was actually based on.
alter table appointments add column if not exists booking_lat double precision;
alter table appointments add column if not exists booking_lng double precision;

-- ----------------------------------------------------------------------------
-- 37.3 The policy, extended - same trigger function, same trigger name
-- ----------------------------------------------------------------------------
-- Re-declared rather than layered as a second trigger: the date/patient-type
-- gate is one contiguous decision, and splitting it across two triggers would
-- mean re-deriving "is this clinic even in appointment_only mode" twice and
-- risking the two disagreeing about what "today" is. Everything from section
-- 33.4 is preserved for a clinic that leaves same_day_booking_enabled off -
-- same messages, same order, same behaviour (see TESTING.md "Test 14",
-- untouched by this migration).
create or replace function public.enforce_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_now_local timestamp;
  v_same_day boolean;
  v_taken int;
  v_full boolean;
begin
  select * into c from clinics where id = new.clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  -- Everything below is this mode's contract. Other clinics are untouched.
  if c.mode <> 'appointment_only' then
    return new;
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_today := v_now_local::date;
  v_same_day := (new.date = v_today);

  if new.date < v_today then
    raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
      to_char(case when c.same_day_booking_enabled then v_today else v_today + 1 end, 'DD Mon YYYY');
  end if;

  if v_same_day then
    if not c.same_day_booking_enabled then
      raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
        to_char(v_today + 1, 'DD Mon YYYY');
    end if;

    -- A walk-in's "slot" is just the clock at the desk (see migration 36's
    -- enforce_slot_capacity, which never counts a walk-in against slot
    -- capacity either) - not a claim on a future time - so the cutoff, which
    -- exists to stop a SPECIFIC slot being grabbed moments before it starts,
    -- only applies to a genuine scheduled booking.
    if new.patient_type = 'scheduled'
       and (new.date + new.slot_time)::timestamp < v_now_local + make_interval(mins => c.same_day_cutoff_minutes)
    then
      raise exception 'SAME_DAY_CUTOFF: the % slot has already passed or is too soon - same-day booking closes % minutes before a slot starts.',
        to_char(new.slot_time, 'HH12:MI AM'), c.same_day_cutoff_minutes;
    end if;
    -- Walk-ins fall through from here exactly like any other same-day
    -- booking - the daily cap below still applies to them.
  else
    if new.patient_type = 'walk_in' then
      raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
    end if;

    if new.date > v_today + c.booking_horizon_days then
      raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
        c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
    end if;
  end if;

  -- Take the day's lock BEFORE counting. Two patients going for the last seat
  -- serialise here: the second one waits, then counts a day that is now full.
  insert into clinic_day_locks (clinic_id, date)
  values (new.clinic_id, new.date)
  on conflict (clinic_id, date) do update set updated_at = now();

  select seats_taken, is_full into v_taken, v_full
  from public.day_availability(new.clinic_id, new.date);

  if coalesce(v_full, false) then
    raise exception 'FULL_DAY: % is fully booked (% of % seats taken).',
      to_char(new.date, 'DD Mon YYYY'), v_taken, c.daily_cap;
  end if;

  -- Inside the cap, so there is nothing to approve: the only question this
  -- clinic asks of a booking is whether a seat exists.
  if new.status = 'booked' then
    new.status := 'accepted';
  end if;

  return new;
end;
$$;

-- Trigger itself is unchanged (still named/sorted to fire first) - only the
-- function body above changed, so no drop/create needed here.

-- ----------------------------------------------------------------------------
-- 37.4 Confirmed-present same-day bookings get their token immediately
-- ----------------------------------------------------------------------------
-- AFTER INSERT, not folded into 37.3's BEFORE INSERT trigger, and deliberately
-- calling check_in_appointment() rather than re-implementing any part of it:
-- the row needs a real id first, and this way the arrival-window rule, the
-- token counter and the effective_order_time stamp are exactly the same code
-- every other check-in path uses (sections 27/31) - not a second copy that
-- could drift from it.
--
-- Wrapped in its own sub-transaction (the BEGIN/EXCEPTION block) so a
-- check-in that check_in_appointment() would refuse anyway - most likely
-- because the slot is still more than 60 minutes out - never fails the
-- booking itself. The patient walks away with a valid accepted appointment
-- either way; they just collect their token at the door instead of this
-- instant, like any other same-day booking made without a location fix.
create or replace function public.auto_checkin_verified_same_day()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_now_local timestamp;
begin
  -- Only a genuine scheduled same-day booking is in scope. A walk-in is
  -- already checked in by the time its row exists (WalkInForm calls
  -- check_in_appointment() itself right after accepting it); an advance
  -- booking for a future date has nothing to verify yet.
  if new.patient_type <> 'scheduled' or new.status <> 'accepted' then
    return new;
  end if;

  select * into c from clinics where id = new.clinic_id;
  if c.id is null
     or c.mode <> 'appointment_only'
     or not c.same_day_booking_enabled
     or not c.auto_checkin_verified_same_day
  then
    return new;
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  if new.date <> v_now_local::date then
    return new;
  end if;

  -- No location fix to check against, or the clinic hasn't set its own
  -- location yet - either way, presence is simply unverified, which is the
  -- same as "not confirmed present". Falls through to a normal check-in
  -- later, same as a booking made from home.
  if new.booking_lat is null or new.booking_lng is null or c.lat is null or c.lng is null then
    return new;
  end if;

  if public.distance_metres(new.booking_lat, new.booking_lng, c.lat, c.lng) > c.same_day_checkin_radius_m then
    return new;
  end if;

  begin
    -- 'patient_scan' - the same method self_check_in() (section 28.6) uses
    -- for its own location-verified path; this is that same idea, just
    -- confirmed at booking time instead of a separate scan afterwards.
    perform public.check_in_appointment(new.id, 'patient_scan', false);
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists on_appointment_auto_checkin_same_day on appointments;
create trigger on_appointment_auto_checkin_same_day
  after insert on appointments
  for each row execute function public.auto_checkin_verified_same_day();

-- ============================================================================
-- 38. WALK-IN REGISTRATION: ONLY INTO A FREE SLOT
-- ============================================================================
-- Until now a walk-in was never actually checked against availability at
-- all: enforce_slot_capacity() (section 36.4) explicitly skipped
-- patient_type = 'walk_in', and the daily cap (section 33) only ever applied
-- in appointment_only mode. A clinic's front desk could always add "one
-- more" walk-in, no matter how full the doctor's slot grid or the day's cap
-- already was - deliberately, at the time (see section 36.4's own comment:
-- a walk-in's slot_time was just the clock at check-in, "not a claim on one
-- of the doctor's bookable times").
--
-- This migration reverses that: registering a walk-in now has to claim a
-- REAL open slot from the doctor's grid, at ANY clinic, in ANY mode -
-- exactly like an advance booking - and is refused when nothing is free,
-- the same "day full" / "slot full" way an advance booking already is:
--   * The daily cap (day_availability(), section 33.3) now also gates a
--     WALK-IN at an allow_walkins clinic, not just every booking at an
--     appointment_only one. An advance/scheduled booking at an
--     allow_walkins clinic is untouched - still unlimited, exactly as
--     before. Only the walk-in-at-the-desk path gained a ceiling.
--   * Slot capacity (enforce_slot_capacity(), section 36.4) now applies to a
--     walk-in's booking too - the client picks the current-or-next open
--     slot from the doctor's real grid (see findWalkInSlot() in
--     src/lib/queue.ts) instead of stamping the literal clock, and the
--     existing per-slot lock (doctor_slot_locks) makes the last-seat race
--     just as safe for a walk-in as it already was for a scheduled booking.
--   * The waitlist notification (section 33.5) is no longer appointment-only
--     - ANY clinic's waitlist entries now hear about a freed seat, since a
--     walk-in can now genuinely be turned away with "join the waitlist" as
--     the offer, not just an appointment_only patient.
--
-- Everything else about a walk-in is unchanged: found by phone or MRN (MRN
-- lookup is new below - phone lookup already existed, section 25), a new
-- patient still gets an MRN exactly as before (section 18, "Part 40" in the
-- product spec), and the moment the booking is accepted the desk still
-- checks them in immediately and draws their token right there
-- (WalkInForm.tsx's checkInNow - untouched, section 27).
--
-- Supersedes TESTING.md "Test 17" section F's old guarantee ("walk-ins
-- never contend for slot capacity") - see "Test 19" for the new behaviour.

-- ----------------------------------------------------------------------------
-- 38.1 Slot capacity now applies to a walk-in too
-- ----------------------------------------------------------------------------
-- Identical to section 36.4 except the patient_type exemption is gone. A
-- walk-in's slot_time is no longer the raw clock (see WalkInForm.tsx) - it's
-- a real computed slot from the doctor's grid, so counting it here means
-- exactly what it means for a scheduled booking: this exact slot_time's
-- active bookings have reached its capacity.
create or replace function public.enforce_slot_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity int;
  v_booked int;
begin
  -- Take the slot lock BEFORE counting - see 36.2.
  insert into doctor_slot_locks (doctor_id, date, slot_time)
  values (new.doctor_id, new.date, new.slot_time)
  on conflict (doctor_id, date, slot_time) do update set updated_at = now();

  v_capacity := public.slot_capacity_for(new.doctor_id, new.date, new.slot_time);

  select count(*) into v_booked
  from appointments
  where doctor_id = new.doctor_id
    and date = new.date
    and slot_time = new.slot_time
    and status not in ('cancelled', 'rejected');

  if v_booked >= v_capacity then
    raise exception 'SLOT_FULL: % on % is full (% of % taken) - pick another slot.',
      to_char(new.slot_time, 'HH12:MI AM'), to_char(new.date, 'DD Mon YYYY'), v_booked, v_capacity;
  end if;

  return new;
end;
$$;

-- Trigger itself is unchanged (still named/sorted the same) - only the
-- function body above changed, so no drop/create needed here.

-- ----------------------------------------------------------------------------
-- 38.2 The daily cap now also gates a walk-in, at any clinic
-- ----------------------------------------------------------------------------
-- Identical to section 37.3 except the daily-cap block's guard widens from
-- "appointment_only mode" to "appointment_only mode, OR this is a walk-in
-- anywhere". Everything about appointment_only mode's own contract (the
-- date-range gate, same-day cutoff, auto-accept) is completely unchanged -
-- it still only runs when c.mode = 'appointment_only', so an allow_walkins
-- clinic's SCHEDULED/advance bookings stay exactly as unlimited as before.
create or replace function public.enforce_booking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c clinics;
  v_today date;
  v_now_local timestamp;
  v_same_day boolean;
  v_taken int;
  v_full boolean;
begin
  select * into c from clinics where id = new.clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_today := v_now_local::date;

  if c.mode = 'appointment_only' then
    v_same_day := (new.date = v_today);

    if new.date < v_today then
      raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
        to_char(case when c.same_day_booking_enabled then v_today else v_today + 1 end, 'DD Mon YYYY');
    end if;

    if v_same_day then
      if not c.same_day_booking_enabled then
        raise exception 'This clinic takes advance bookings only - the earliest you can book is %.',
          to_char(v_today + 1, 'DD Mon YYYY');
      end if;

      if new.patient_type = 'scheduled'
         and (new.date + new.slot_time)::timestamp < v_now_local + make_interval(mins => c.same_day_cutoff_minutes)
      then
        raise exception 'SAME_DAY_CUTOFF: the % slot has already passed or is too soon - same-day booking closes % minutes before a slot starts.',
          to_char(new.slot_time, 'HH12:MI AM'), c.same_day_cutoff_minutes;
      end if;
    else
      if new.patient_type = 'walk_in' then
        raise exception 'This clinic is appointment-only - walk-ins are not accepted.';
      end if;

      if new.date > v_today + c.booking_horizon_days then
        raise exception 'This clinic accepts bookings up to % day(s) ahead - the latest you can book is %.',
          c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
      end if;
    end if;
  end if;

  -- The daily cap: always enforced in appointment_only mode (as before, any
  -- booking), and now ALSO for a walk-in at any clinic - see this
  -- migration's header. A scheduled/advance booking at an allow_walkins
  -- clinic never reaches this block, so stays uncapped exactly as before;
  -- it still counts toward the total the way it always has, for whichever
  -- OTHER booking (a walk-in) does check the cap.
  if c.mode = 'appointment_only' or new.patient_type = 'walk_in' then
    -- Take the day's lock BEFORE counting - see 33.2.
    insert into clinic_day_locks (clinic_id, date)
    values (new.clinic_id, new.date)
    on conflict (clinic_id, date) do update set updated_at = now();

    select seats_taken, is_full into v_taken, v_full
    from public.day_availability(new.clinic_id, new.date);

    if coalesce(v_full, false) then
      raise exception 'FULL_DAY: % is fully booked (% of % seats taken).',
        to_char(new.date, 'DD Mon YYYY'), v_taken, c.daily_cap;
    end if;
  end if;

  -- Inside the cap, so there is nothing to approve - but only appointment_only
  -- mode auto-accepts. A walk-in at an allow_walkins clinic still goes
  -- through the desk's explicit accept step, exactly as before.
  if c.mode = 'appointment_only' and new.status = 'booked' then
    new.status := 'accepted';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 38.3 The waitlist is no longer appointment-only
-- ----------------------------------------------------------------------------
-- Identical to section 33.5's version except the mode gate is gone - a
-- walk-in can now genuinely be turned away from ANY clinic with "join the
-- waitlist" as the offer (see WalkInForm.tsx), so that clinic's waitlist
-- needs to actually fire when a seat frees up, the same way an
-- appointment_only clinic's always has.
create or replace function public.notify_waitlist_on_free_seat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w waitlist;
  v_clinic clinics;
begin
  if new.status not in ('cancelled', 'rejected') or old.status = new.status then
    return new;
  end if;

  select * into v_clinic from clinics where id = new.clinic_id;
  if v_clinic.id is null then
    return new;
  end if;

  select * into w
  from waitlist
  where clinic_id = new.clinic_id and date = new.date and status = 'waiting'
  order by created_at
  limit 1;

  if w.id is null then
    return new;
  end if;

  update waitlist set status = 'offered', offered_at = now() where id = w.id;

  insert into notifications (user_id, type, message)
  select f.account_id, 'waitlist_seat',
         'A seat has opened up at ' || v_clinic.name || ' on '
           || to_char(new.date, 'DD Mon YYYY') || '. Book now - it is first come, first served.'
  from family_members f
  where f.id = w.member_id;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 38.4 Finding an existing patient by MRN, for the walk-in desk
-- ----------------------------------------------------------------------------
-- Mirrors find_family_member_by_phone() (section 25) exactly, for the other
-- half of "find the patient by phone / MRN" - a receptionist who already
-- knows the patient's medical record number (from a card, a past visit
-- slip) shouldn't have to fall back to a phone-number guess. Unlike the
-- phone lookup, this is NOT "create if not found" from the caller's side -
-- an MRN is supposed to name one specific existing patient, so the desk
-- form treats "not found" as an error to fix (typo?) rather than a cue to
-- register a new one under a number that was never actually theirs.
create or replace function public.find_family_member_by_mrn(p_mrn text)
returns table (id uuid, mrn text, name text, phone text)
language sql
stable
security definer
set search_path = public
as $$
  select fm.id, fm.mrn, fm.name, fm.phone
  from family_members fm
  where fm.mrn = trim(p_mrn)
    and (public.is_clinic() or public.is_admin());
$$;

-- ============================================================================
-- 39. TWO-STEP CONFIRMATION: PATIENT NOTIFICATIONS
-- ============================================================================
-- A booking is a REQUEST until the clinic accepts it. Until now the two
-- halves of that were only half-wired:
--   * BookingForm.tsx already inserted a payments row with status = 'hold'
--     for an online payment (or 'pending' for COD) the moment a booking was
--     created - but nothing ever told the patient that had happened, and
--     nothing ever moved that hold to 'captured'. handle_appointment_status_
--     change() used to do the capture on accept (see its very first version,
--     section 5), but section 30.4 removed that step on the theory that
--     appointments.payment_status already said 'paid_online' from booking
--     time, so "there was nothing left to flip." That left the payments
--     ledger - the thing payouts.ts and AdminPayments.tsx actually sum over -
--     permanently stuck on 'hold' for every online booking, captured or not.
--   * Rejecting a booking already auto-refunded a real hold via the same
--     trigger, but the message shown to the patient (RejectAppointmentForm.tsx)
--     never said so, and the refund step also fired for a COD payment that
--     was still sitting at 'pending' - i.e. never actually collected - which
--     would misrepresent an uncollected desk payment as one that was taken
--     back.
--
-- This migration:
--   1. Restores capture-on-accept, but ONLY on the payments ledger (status:
--      'hold' -> 'captured') - appointments.payment_status is left exactly
--      as section 30.4 set it, since same-day auto-checkin, fast-checkin and
--      the extended reschedule window (sections 32, 37) all key off it
--      staying 'paid_online' from the moment of booking and none of that
--      changes here.
--   2. Narrows the auto-refund-on-reject/cancel step to real money movements
--      only (hold/captured), leaving an untouched COD 'pending' row alone.
--   3. Adds a `channel` column to notifications (in_app / whatsapp / sms) -
--      the SAME table every existing notice already uses, just able to now
--      record which wire a message actually went out on.
--   4. Adds a partial unique index + a log_notification() RPC that upserts
--      against it, so the three one-shot lifecycle notices this flow sends
--      (booking_received, appointment_confirmed, appointment_rejected) can
--      never be duplicated - by a double-tap on Accept/Reject, a retried
--      request, or two clinic staff acting on the same booking at once -
--      while every other existing notification type (reminders, check-in,
--      queue alerts) is untouched and keeps inserting normally.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 39.1 Capture on accept, refund only real holds
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update payments set status = 'captured'
    where appointment_id = new.id and status = 'hold';
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    -- 'pending' (an uncollected COD payment) is deliberately excluded here -
    -- see this migration's header.
    update payments set status = 'refunded'
    where appointment_id = new.id and status in ('hold', 'captured');
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 39.2 notifications.channel - which wire a message went out on
-- ----------------------------------------------------------------------------
alter table notifications add column if not exists channel text not null default 'in_app';
alter table notifications drop constraint if exists notifications_channel_check;
alter table notifications add constraint notifications_channel_check
  check (channel in ('in_app', 'whatsapp', 'sms'));

-- ----------------------------------------------------------------------------
-- 39.3 De-duplication for the three one-shot lifecycle notices
-- ----------------------------------------------------------------------------
-- Only these three types are covered - a reminder or queue alert can (and
-- should) still fire more than once per appointment.
create unique index if not exists notifications_lifecycle_dedup_idx
  on notifications (appointment_id, type, channel)
  where appointment_id is not null
    and type in ('booking_received', 'appointment_confirmed', 'appointment_rejected');

-- security definer so a clinic can log a notice addressed to the patient
-- (same ownership chain notifications_insert already allows), and so the
-- caller - clinic or patient - never needs SELECT access to someone else's
-- notifications row just to learn whether its own insert was new or a
-- duplicate skipped by the index above.
create or replace function public.log_notification(
  p_user_id uuid,
  p_appointment_id uuid,
  p_type text,
  p_channel text,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if not (
    public.is_admin()
    or p_user_id = auth.uid()
    or (
      p_appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = p_appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  ) then
    raise exception 'Not allowed to notify this user.';
  end if;

  insert into notifications (user_id, appointment_id, type, channel, message)
  values (p_user_id, p_appointment_id, p_type, p_channel, p_message)
  on conflict (appointment_id, type, channel)
    where appointment_id is not null
      and type in ('booking_received', 'appointment_confirmed', 'appointment_rejected')
  do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ============================================================================
-- 40. REPORTING TIME
-- ============================================================================
-- Every accepted appointment now carries a reporting time - when the patient
-- should aim to reach the clinic, distinct from the slot time itself. It is
-- guidance only: the token is still assigned at check-in, in arrival order
-- (check_in_appointment(), section 27), and served in fair order (section
-- 31). Arriving at the reporting time does not by itself create a token, and
-- nothing here changes when check-in is allowed to happen.
--
--   1. clinics.report_before_minutes - a per-clinic setting, default 30.
--   2. get_checkin_options() (section 32.4) now also returns reporting_time,
--      computed as slot_time - least(report_before_minutes, 60). The clamp
--      to 60 keeps the reporting time from ever falling before check-in
--      even opens (check_in_appointment() refuses check-in earlier than
--      slot_time - 60 minutes, hardcoded there - see this migration's
--      header). A clinic that sets report_before_minutes above 60 still
--      sees its own setting reflected honestly wherever it's edited; only
--      the derived reporting time is capped.
--   3. notifications' one-shot dedup (migration 39) is widened to cover a
--      fourth type, reporting_time_reminder - the single "reporting time is
--      approaching" nudge (src/pages/BookingStatus.tsx), so it can never be
--      sent more than once per appointment either.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 40.1 The clinic setting
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists report_before_minutes int not null default 30;
alter table clinics drop constraint if exists clinics_report_before_minutes_check;
alter table clinics add constraint clinics_report_before_minutes_check
  check (report_before_minutes > 0);

-- ----------------------------------------------------------------------------
-- 40.2 get_checkin_options() - hand back the derived, clamped reporting time
-- ----------------------------------------------------------------------------
-- A new OUT column changes the function's row type, which create-or-replace
-- refuses outright ("cannot change return type of existing function") - drop
-- it first. Safe here: nothing else in the database calls this function (it
-- has no triggers depending on it, and callers below are only ever the app,
-- which re-resolves the function by name on its next call).
drop function if exists public.get_checkin_options(uuid);
create function public.get_checkin_options(p_appointment_id uuid)
returns table (
  can_self_check_in boolean,
  requires_location boolean,
  paid_online boolean,
  reschedule_window_hours int,
  reporting_time time
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a appointments;
  c clinics;
  v_paid boolean;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_mrn(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;

  select * into c from clinics where id = a.clinic_id;
  v_paid := (a.payment_status = 'paid_online');

  return query select
    (c.self_checkin_enabled or (c.fast_checkin_paid_online and v_paid)),
    c.self_checkin_require_location,
    v_paid,
    case when v_paid then c.reschedule_window_hours_paid_online else c.reschedule_window_hours end,
    a.slot_time - make_interval(mins => least(c.report_before_minutes, 60));
end;
$$;

-- ----------------------------------------------------------------------------
-- 40.3 Widen the lifecycle dedup to cover the reporting-time reminder too
-- ----------------------------------------------------------------------------
drop index if exists notifications_lifecycle_dedup_idx;
create unique index notifications_lifecycle_dedup_idx
  on notifications (appointment_id, type, channel)
  where appointment_id is not null
    and type in (
      'booking_received', 'appointment_confirmed', 'appointment_rejected', 'reporting_time_reminder'
    );

create or replace function public.log_notification(
  p_user_id uuid,
  p_appointment_id uuid,
  p_type text,
  p_channel text,
  p_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if not (
    public.is_admin()
    or p_user_id = auth.uid()
    or (
      p_appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = p_appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  ) then
    raise exception 'Not allowed to notify this user.';
  end if;

  insert into notifications (user_id, appointment_id, type, channel, message)
  values (p_user_id, p_appointment_id, p_type, p_channel, p_message)
  on conflict (appointment_id, type, channel)
    where appointment_id is not null
      and type in (
        'booking_received', 'appointment_confirmed', 'appointment_rejected', 'reporting_time_reminder'
      )
  do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ============================================================================
-- 41. PATIENT PAYMENT AT CHECKOUT - COUPONS + REAL RAZORPAY (authorize/capture)
-- ============================================================================
-- Two things land together because they touch the exact same money path:
--
-- COUPONS
--   * coupons - the catalog. Never directly readable by the app (RLS locks
--     it to admin) - a patient can only ever learn whether a code works
--     through reserve_coupon() below, which is the literal "validate on the
--     server, never in the app" requirement.
--   * coupon_redemptions - a reserve -> confirm/release ledger, exactly
--     mirroring the hold -> captured/refunded lifecycle payments already has:
--       - reserve_coupon() inserts a 'reserved' row the moment the patient
--         taps Apply, appointment_id still null (no booking exists yet).
--       - create_payment_with_coupon() links appointment_id once the
--         booking is actually created, and independently RE-DERIVES the
--         discount from the doctor's real fee - the reservation's own
--         figure (computed from whatever gross the client claimed at Apply
--         time) is a preview only, never trusted for the real charge.
--       - handle_appointment_status_change() confirms it on accept
--         (payment captured) or releases it on reject/cancel, same trigger
--         that already drives the payment hold's own capture/refund.
--       - An unlinked reservation (appointment_id still null) simply stops
--         counting toward "already used" / the global cap after 15 minutes
--         - the "abandoned" case releases itself with no cron job needed.
--
-- RAZORPAY (authorize now, capture on Accept, per Part 46's hold model)
--   * payments gains gross_amount / coupon_code / discount_amount /
--     net_amount / funded_by / razorpay_order_id / razorpay_payment_id.
--     `amount` keeps meaning exactly what it always has (the real
--     transactional figure - equal to net_amount) so payouts.ts and
--     AdminPayments.tsx keep working unmodified.
--   * The actual "hold" is a Razorpay order created with payment_capture: 0
--     (authorize-only) - see supabase/functions/razorpay-create-order. The
--     "capture" is a real Razorpay API call the clinic's Accept action makes
--     (supabase/functions/razorpay-capture-payment) BEFORE this trigger ever
--     flips payments.status locally - see ClinicQueue.tsx's acceptAppointment.
--   * Reject needs no Razorpay API call at all: an authorized-but-never-
--     captured payment auto-releases on Razorpay's side within days on its
--     own, which is functionally a refund from the patient's perspective -
--     the existing local "flip payments.status to refunded" bookkeeping
--     already reflects that correctly without a network call.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 41.1 Coupons catalog + redemption ledger
-- ----------------------------------------------------------------------------
create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  discount_type text not null check (discount_type in ('flat', 'percent')),
  discount_value numeric not null check (discount_value > 0),
  -- Caps a percent discount's rupee value; meaningless (and ignored) for a
  -- flat discount.
  max_discount_amount numeric check (max_discount_amount is null or max_discount_amount > 0),
  min_order_amount numeric not null default 0,
  -- Total number of successful uses this code will ever grant; null = unlimited.
  max_redemptions int check (max_redemptions is null or max_redemptions > 0),
  one_per_patient boolean not null default true,
  -- Who eats the discount - see payouts.ts: 'platform' leaves the clinic's
  -- payout on the full gross fee (the platform's own margin absorbs it);
  -- 'clinic' reduces what the clinic is owed by the discount amount.
  funded_by text not null default 'platform' check (funded_by in ('platform', 'clinic')),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references coupons (id) on delete cascade,
  -- Null from the moment reserve_coupon() creates this row (Apply time) until
  -- create_payment_with_coupon() links it to the real booking.
  appointment_id uuid references appointments (id) on delete cascade,
  patient_account_id uuid not null references profiles (id) on delete cascade,
  discount_amount numeric not null,
  status text not null default 'reserved' check (status in ('reserved', 'confirmed', 'released')),
  reserved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists coupon_redemptions_coupon_patient_idx
  on coupon_redemptions (coupon_id, patient_account_id, status);

alter table coupons enable row level security;
alter table coupon_redemptions enable row level security;

-- coupons: nobody reads this from the app directly - see this migration's
-- header. Only admin manages the catalog (via SQL for now, same as several
-- other clinic-level settings in this project).
drop policy if exists "coupons_select" on coupons;
create policy "coupons_select" on coupons for select using (public.is_admin());
drop policy if exists "coupons_write" on coupons;
create policy "coupons_write" on coupons for all using (public.is_admin());

-- coupon_redemptions: same ownership chain as payments - the patient who
-- holds it, the clinic once it's linked to one of their appointments, admin.
-- No insert/update/delete policy at all: every write goes through a
-- security-definer function below (or the trigger), which is deliberate -
-- a coupon's discount must never be something the client can just insert.
drop policy if exists "coupon_redemptions_select" on coupon_redemptions;
create policy "coupon_redemptions_select" on coupon_redemptions for select
  using (
    public.is_admin()
    or patient_account_id = auth.uid()
    or (
      appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = coupon_redemptions.appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 41.2 payments - the extra accounting columns
-- ----------------------------------------------------------------------------
alter table payments add column if not exists gross_amount numeric;
alter table payments add column if not exists coupon_code text;
alter table payments add column if not exists discount_amount numeric not null default 0;
alter table payments add column if not exists net_amount numeric;
alter table payments add column if not exists funded_by text check (funded_by is null or funded_by in ('platform', 'clinic'));
alter table payments add column if not exists razorpay_order_id text;
alter table payments add column if not exists razorpay_payment_id text;

-- ----------------------------------------------------------------------------
-- 41.3 reserve_coupon() - the Apply button. Validates AND reserves in one
-- atomic step (the spec's "reserve the coupon use when applied").
-- ----------------------------------------------------------------------------
create or replace function public.reserve_coupon(p_code text, p_gross_amount numeric)
returns table (valid boolean, reason text, discount_amount numeric, net_amount numeric, redemption_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon coupons;
  v_uid uuid := auth.uid();
  v_discount numeric;
  v_confirmed_count int;
  v_live_count int;
  v_global_live_count int;
  v_redemption_id uuid;
begin
  if v_uid is null then
    return query select false, 'You must be signed in to apply a coupon.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  select * into v_coupon from coupons where code = upper(trim(p_code));
  if v_coupon.id is null or not v_coupon.active then
    return query select false, 'This code is not valid.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
    return query select false, 'This code has expired.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if p_gross_amount < v_coupon.min_order_amount then
    return query select false,
      format('This code needs a minimum order of Rs.%s.', v_coupon.min_order_amount)::text,
      0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  if v_coupon.one_per_patient then
    select count(*) into v_confirmed_count
    from coupon_redemptions
    where coupon_id = v_coupon.id and patient_account_id = v_uid and status = 'confirmed';
    if v_confirmed_count > 0 then
      return query select false, 'You have already used this code.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;

    -- A still-live reservation (linked to a real booking, or unlinked but
    -- inside the 15-minute abandonment window) blocks a second Apply of the
    -- same code while the first is still in flight.
    select count(*) into v_live_count
    from coupon_redemptions
    where coupon_id = v_coupon.id and patient_account_id = v_uid and status = 'reserved'
      and (appointment_id is not null or reserved_at > now() - interval '15 minutes');
    if v_live_count > 0 then
      return query select false, 'This code is already applied to a booking you have in progress.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;
  end if;

  if v_coupon.max_redemptions is not null then
    select count(*) into v_global_live_count
    from coupon_redemptions
    where coupon_id = v_coupon.id
      and (
        status = 'confirmed'
        or (status = 'reserved' and (appointment_id is not null or reserved_at > now() - interval '15 minutes'))
      );
    if v_global_live_count >= v_coupon.max_redemptions then
      return query select false, 'This code has already been fully used.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;
  end if;

  v_discount := case v_coupon.discount_type
    when 'flat' then v_coupon.discount_value
    else round(p_gross_amount * v_coupon.discount_value / 100.0, 2)
  end;
  if v_coupon.max_discount_amount is not null then
    v_discount := least(v_discount, v_coupon.max_discount_amount);
  end if;
  v_discount := least(v_discount, p_gross_amount - 1); -- never discount to zero or negative

  insert into coupon_redemptions (coupon_id, patient_account_id, discount_amount, status)
  values (v_coupon.id, v_uid, v_discount, 'reserved')
  returning id into v_redemption_id;

  return query select true, null::text, v_discount, (p_gross_amount - v_discount), v_redemption_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 41.4 release_coupon_redemption() - "Remove" in the UI, and BookingForm's
-- own cleanup path when a reservation was made but the booking never went
-- through (slot filled, payment insert failed, Razorpay checkout abandoned).
-- ----------------------------------------------------------------------------
create or replace function public.release_coupon_redemption(p_redemption_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update coupon_redemptions
  set status = 'released'
  where id = p_redemption_id and patient_account_id = auth.uid() and status = 'reserved';
end;
$$;

-- ----------------------------------------------------------------------------
-- 41.5 create_payment_with_coupon() - the actual charge. Replaces
-- BookingForm.tsx's old plain `insert into payments`: this is where the
-- gross amount is looked up server-side (the doctor's real consultation_fee
-- - never trusted from the client) and the coupon math is independently
-- re-run against it, so nothing a client claimed at Apply time is ever
-- trusted for the real total.
-- ----------------------------------------------------------------------------
create or replace function public.create_payment_with_coupon(
  p_appointment_id uuid,
  p_method text,
  p_redemption_id uuid default null
)
returns table (payment_id uuid, gross_amount numeric, discount_amount numeric, net_amount numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  v_fee numeric;
  v_convenience numeric;
  v_gross numeric;
  v_discount numeric := 0;
  v_net numeric;
  v_redemption coupon_redemptions;
  v_coupon coupons;
  v_funded_by text;
  v_coupon_code text;
  v_payment_id uuid;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;
  if exists (select 1 from payments where appointment_id = p_appointment_id) then
    raise exception 'A payment already exists for this appointment.';
  end if;
  if p_method not in ('online', 'cod') then
    raise exception 'Invalid payment method.';
  end if;

  select consultation_fee into v_fee from doctors where id = a.doctor_id;
  -- Flat platform convenience fee, online payments only (there is no
  -- gateway to charge a fee for on a cash-at-clinic booking). Kept as a
  -- literal here rather than a table so it stays a single, obvious number -
  -- see src/lib/billing.ts's PLATFORM_CONVENIENCE_FEE, which this must match.
  v_convenience := case when p_method = 'online' then 10 else 0 end;
  v_gross := v_fee + v_convenience;

  if p_redemption_id is not null then
    select * into v_redemption from coupon_redemptions where id = p_redemption_id;
    if v_redemption.id is null or v_redemption.patient_account_id <> auth.uid() or v_redemption.status <> 'reserved' then
      raise exception 'This coupon is no longer applied - please re-apply it.';
    end if;
    if v_redemption.reserved_at < now() - interval '15 minutes' then
      raise exception 'Your coupon reservation expired - please re-apply it.';
    end if;

    select * into v_coupon from coupons where id = v_redemption.coupon_id;
    -- Defense in depth: re-check the facts that could have changed, or been
    -- misrepresented by the client's gross_amount, since reserve_coupon() ran.
    if not v_coupon.active or (v_coupon.expires_at is not null and v_coupon.expires_at < now()) then
      raise exception 'This coupon is no longer valid.';
    end if;
    if v_gross < v_coupon.min_order_amount then
      raise exception 'This coupon needs a minimum order of Rs.%.', v_coupon.min_order_amount;
    end if;

    v_discount := case v_coupon.discount_type
      when 'flat' then v_coupon.discount_value
      else round(v_gross * v_coupon.discount_value / 100.0, 2)
    end;
    if v_coupon.max_discount_amount is not null then
      v_discount := least(v_discount, v_coupon.max_discount_amount);
    end if;
    v_discount := least(v_discount, v_gross - 1);
    v_coupon_code := v_coupon.code;
    v_funded_by := v_coupon.funded_by;

    update coupon_redemptions
    set appointment_id = p_appointment_id, discount_amount = v_discount
    where id = p_redemption_id;
  end if;

  v_net := v_gross - v_discount;

  insert into payments (appointment_id, amount, method, status, gross_amount, coupon_code, discount_amount, net_amount, funded_by)
  values (
    p_appointment_id,
    v_net,
    p_method,
    case when p_method = 'online' then 'hold' else 'pending' end,
    v_gross,
    v_coupon_code,
    v_discount,
    v_net,
    v_funded_by
  )
  returning id into v_payment_id;

  return query select v_payment_id, v_gross, v_discount, v_net;
end;
$$;

-- ----------------------------------------------------------------------------
-- 41.6 Confirm/release the coupon redemption on the same status change that
-- already captures/refunds the payment.
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
    update coupon_redemptions set status = 'confirmed' where appointment_id = new.id and status = 'reserved';
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status in ('hold', 'captured');
    update coupon_redemptions set status = 'released' where appointment_id = new.id and status = 'reserved';
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 42. COUPON ENGINE - DATA + VALIDATION
-- ============================================================================
-- Evolves the coupons/coupon_redemptions tables and reserve_coupon() from
-- migration 41 into the richer shape asked for here, in place - not a
-- second, parallel coupon system. Existing rows (including any coupon
-- already created and used while testing migration 41/42) carry forward:
-- column renames preserve data, and times_used is backfilled from the real
-- redemption history rather than starting back at zero.
--
--   * coupons gains: description, valid_from (valid_to is the renamed
--     expires_at), per_user_limit (replaces the one_per_patient boolean -
--     a real number now, not just yes/no), total_limit (renamed from
--     max_redemptions) + a maintained times_used counter, applies_to (only
--     'app_booking' is ever produced by this app today - see
--     validate_and_price()'s own comment on why it's still checked), and
--     clinic_id (null = valid at every clinic; set = restricted to one).
--   * coupon_redemptions.patient_account_id is renamed to patient_id -
--     still profiles(id), the ACCOUNT holder, not a specific family member.
--     Tying a limit to the account rather than to whichever dependent is
--     being booked for is deliberate: otherwise "one per patient" could be
--     defeated just by adding another family member under the same login.
--   * validate_and_price(code, patient_id, clinic_id, gross_amount) replaces
--     reserve_coupon() as the ONE entry point: validates AND reserves in the
--     same atomic step, returning a machine-readable reason_code (plus a
--     human `reason`) instead of only a sentence. It takes an explicit
--     patient_id/clinic_id (rather than assuming auth.uid()) so a clinic can
--     apply a coupon on a patient's behalf later (e.g. a desk-assisted
--     booking), while still requiring the caller be that patient, an admin,
--     or that clinic.
--   * Concurrency: a `select ... for update` locks the coupon's own row for
--     the duration of the check-and-reserve, serializing every reservation
--     attempt against THAT coupon - the only mechanism that works for an
--     arbitrary per_user_limit/total_limit (a unique index can only ever
--     enforce "at most one", not "at most N"), so it's the one used here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 42.1 coupons: rename to the new shape, add the new columns
-- ----------------------------------------------------------------------------
alter table coupons rename column discount_type to type;
alter table coupons rename column discount_value to value;
alter table coupons rename column max_discount_amount to max_discount;
alter table coupons rename column min_order_amount to min_amount;
alter table coupons rename column expires_at to valid_to;
alter table coupons rename column max_redemptions to total_limit;

alter table coupons add column if not exists description text;
alter table coupons add column if not exists valid_from timestamptz;
alter table coupons add column if not exists per_user_limit int;
alter table coupons add column if not exists times_used int not null default 0;
alter table coupons add column if not exists applies_to text not null default 'app_booking';
alter table coupons add column if not exists clinic_id uuid references clinics (id) on delete cascade;

-- one_per_patient boolean -> per_user_limit int (null = unlimited per user,
-- matching total_limit's own "null = unlimited" convention).
update coupons set per_user_limit = 1 where one_per_patient and per_user_limit is null;
alter table coupons drop column if exists one_per_patient;

-- Switching times_used from "count the rows every time" to a maintained
-- counter must not silently forget usage that already happened.
update coupons c
set times_used = coalesce(
  (select count(*) from coupon_redemptions r where r.coupon_id = c.id and r.status in ('reserved', 'confirmed')),
  0
);

alter table coupons drop constraint if exists coupons_code_uppercase_check;
alter table coupons add constraint coupons_code_uppercase_check check (code = upper(code));

alter table coupons drop constraint if exists coupons_percent_max_check;
alter table coupons add constraint coupons_percent_max_check check (type <> 'percent' or value <= 100);

alter table coupons drop constraint if exists coupons_per_user_limit_check;
alter table coupons add constraint coupons_per_user_limit_check check (per_user_limit is null or per_user_limit > 0);

-- Only value this app ever produces today - see validate_and_price()'s note
-- on why this is still worth enforcing even with a single allowed value.
alter table coupons drop constraint if exists coupons_applies_to_check;
alter table coupons add constraint coupons_applies_to_check check (applies_to in ('app_booking'));

-- ----------------------------------------------------------------------------
-- 42.2 coupon_redemptions: patient_account_id -> patient_id
-- ----------------------------------------------------------------------------
alter table coupon_redemptions rename column patient_account_id to patient_id;

drop policy if exists "coupon_redemptions_select" on coupon_redemptions;
create policy "coupon_redemptions_select" on coupon_redemptions for select
  using (
    public.is_admin()
    or patient_id = auth.uid()
    or (
      appointment_id is not null
      and exists (
        select 1 from appointments a
        where a.id = coupon_redemptions.appointment_id and public.is_own_clinic(a.clinic_id)
      )
    )
  );

-- ----------------------------------------------------------------------------
-- 42.3 validate_and_price() - replaces reserve_coupon()
-- ----------------------------------------------------------------------------
drop function if exists public.reserve_coupon(text, numeric);

create or replace function public.validate_and_price(
  p_code text,
  p_patient_id uuid,
  p_clinic_id uuid,
  p_gross_amount numeric
)
returns table (
  valid boolean,
  reason_code text,
  reason text,
  discount_amount numeric,
  net_amount numeric,
  redemption_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon coupons;
  v_discount numeric;
  v_per_user_count int;
  v_redemption_id uuid;
begin
  if not (auth.uid() = p_patient_id or public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    return query select false, 'NOT_AUTHORIZED'::text, 'You are not allowed to apply a coupon for this patient.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  -- The row lock - see this migration's header for why it's the right tool
  -- here. Held until this function's transaction commits (the caller's own
  -- RPC call), so two fast taps of Apply can never both pass every check
  -- below before either has actually recorded its reservation.
  select * into v_coupon from coupons where code = upper(trim(p_code)) for update;

  if v_coupon.id is null then
    return query select false, 'NOT_FOUND'::text, 'This code is not valid.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if not v_coupon.active then
    return query select false, 'INACTIVE'::text, 'This code is not active.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  -- 'app_booking' is the only value this app has ever produced, but the
  -- column exists precisely so a future non-booking use of a coupon can't
  -- accidentally be accepted here just because nothing checked it.
  if v_coupon.applies_to <> 'app_booking' then
    return query select false, 'NOT_APPLICABLE'::text, 'This code cannot be used for a booking.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.clinic_id is not null and v_coupon.clinic_id <> p_clinic_id then
    return query select false, 'WRONG_CLINIC'::text, 'This code is not valid at this clinic.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.valid_from is not null and now() < v_coupon.valid_from then
    return query select false, 'NOT_STARTED'::text, 'This code is not active yet.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if v_coupon.valid_to is not null and now() > v_coupon.valid_to then
    return query select false, 'EXPIRED'::text, 'This code has expired.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;
  if p_gross_amount < v_coupon.min_amount then
    return query select false, 'MIN_AMOUNT_NOT_MET'::text,
      format('This code needs a minimum order of Rs.%s.', v_coupon.min_amount)::text,
      0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  if v_coupon.per_user_limit is not null then
    select count(*) into v_per_user_count
    from coupon_redemptions
    where coupon_id = v_coupon.id and patient_id = p_patient_id and status in ('reserved', 'confirmed');
    if v_per_user_count >= v_coupon.per_user_limit then
      return query select false, 'PER_USER_LIMIT_REACHED'::text, 'You have already used this code.'::text, 0::numeric, p_gross_amount, null::uuid;
      return;
    end if;
  end if;

  if v_coupon.total_limit is not null and v_coupon.times_used >= v_coupon.total_limit then
    return query select false, 'TOTAL_LIMIT_REACHED'::text, 'This code has already been fully used.'::text, 0::numeric, p_gross_amount, null::uuid;
    return;
  end if;

  v_discount := case v_coupon.type
    when 'flat' then v_coupon.value
    else round(p_gross_amount * v_coupon.value / 100.0)
  end;
  if v_coupon.type = 'percent' and v_coupon.max_discount is not null then
    v_discount := least(v_discount, v_coupon.max_discount);
  end if;
  v_discount := least(v_discount, p_gross_amount - 1); -- never discount to zero or negative

  insert into coupon_redemptions (coupon_id, patient_id, discount_amount, status)
  values (v_coupon.id, p_patient_id, v_discount, 'reserved')
  returning id into v_redemption_id;

  update coupons set times_used = times_used + 1 where id = v_coupon.id;

  return query select true, null::text, null::text, v_discount, (p_gross_amount - v_discount), v_redemption_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 42.4 release_coupon_redemption() - now also gives the slot back
-- ----------------------------------------------------------------------------
create or replace function public.release_coupon_redemption(p_redemption_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_coupon_id uuid;
begin
  update coupon_redemptions
  set status = 'released'
  where id = p_redemption_id and patient_id = auth.uid() and status = 'reserved'
  returning coupon_id into v_coupon_id;

  if v_coupon_id is not null then
    update coupons set times_used = greatest(times_used - 1, 0) where id = v_coupon_id;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 42.5 create_payment_with_coupon() - renamed columns, whole-rupee rounding
-- ----------------------------------------------------------------------------
create or replace function public.create_payment_with_coupon(
  p_appointment_id uuid,
  p_method text,
  p_redemption_id uuid default null
)
returns table (payment_id uuid, gross_amount numeric, discount_amount numeric, net_amount numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  v_fee numeric;
  v_convenience numeric;
  v_gross numeric;
  v_discount numeric := 0;
  v_net numeric;
  v_redemption coupon_redemptions;
  v_coupon coupons;
  v_funded_by text;
  v_coupon_code text;
  v_payment_id uuid;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;
  if exists (select 1 from payments where appointment_id = p_appointment_id) then
    raise exception 'A payment already exists for this appointment.';
  end if;
  if p_method not in ('online', 'cod') then
    raise exception 'Invalid payment method.';
  end if;

  select consultation_fee into v_fee from doctors where id = a.doctor_id;
  v_convenience := case when p_method = 'online' then 10 else 0 end;
  v_gross := v_fee + v_convenience;

  if p_redemption_id is not null then
    select * into v_redemption from coupon_redemptions where id = p_redemption_id;
    if v_redemption.id is null or v_redemption.patient_id <> auth.uid() or v_redemption.status <> 'reserved' then
      raise exception 'This coupon is no longer applied - please re-apply it.';
    end if;
    if v_redemption.reserved_at < now() - interval '15 minutes' then
      raise exception 'Your coupon reservation expired - please re-apply it.';
    end if;

    select * into v_coupon from coupons where id = v_redemption.coupon_id;
    if not v_coupon.active or (v_coupon.valid_to is not null and v_coupon.valid_to < now()) then
      raise exception 'This coupon is no longer valid.';
    end if;
    if v_gross < v_coupon.min_amount then
      raise exception 'This coupon needs a minimum order of Rs.%.', v_coupon.min_amount;
    end if;

    v_discount := case v_coupon.type
      when 'flat' then v_coupon.value
      else round(v_gross * v_coupon.value / 100.0)
    end;
    if v_coupon.type = 'percent' and v_coupon.max_discount is not null then
      v_discount := least(v_discount, v_coupon.max_discount);
    end if;
    v_discount := least(v_discount, v_gross - 1);
    v_coupon_code := v_coupon.code;
    v_funded_by := v_coupon.funded_by;

    update coupon_redemptions
    set appointment_id = p_appointment_id, discount_amount = v_discount
    where id = p_redemption_id;
  end if;

  v_net := v_gross - v_discount;

  insert into payments (appointment_id, amount, method, status, gross_amount, coupon_code, discount_amount, net_amount, funded_by)
  values (
    p_appointment_id,
    v_net,
    p_method,
    case when p_method = 'online' then 'hold' else 'pending' end,
    v_gross,
    v_coupon_code,
    v_discount,
    v_net,
    v_funded_by
  )
  returning id into v_payment_id;

  return query select v_payment_id, v_gross, v_discount, v_net;
end;
$$;

-- ----------------------------------------------------------------------------
-- 42.6 handle_appointment_status_change() - give the slot back on release too
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
    update coupon_redemptions set status = 'confirmed' where appointment_id = new.id and status = 'reserved';
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status in ('hold', 'captured');

    with released as (
      update coupon_redemptions set status = 'released'
      where appointment_id = new.id and status = 'reserved'
      returning coupon_id
    )
    update coupons set times_used = greatest(times_used - 1, 0)
    where id in (select coupon_id from released);
  end if;

  return new;
end;
$$;

-- ============================================================================
-- 43. CLINIC-TO-ADMIN BILLING - how the platform earns
-- ============================================================================
-- Two revenue lines, both settled through Razorpay, both trusting only
-- signed webhooks for anything that actually changes billing state:
--
--   1. SUBSCRIPTIONS - a clinic pays a recurring monthly fee to stay listed.
--      plans (name/monthly_price/booking_limit/per_booking_commission)
--      replaces the hardcoded TIERS constant in src/lib/subscription.ts as
--      the source of truth for booking limits - enforce_clinic_booking_limit()
--      below now reads plans.booking_limit instead of a hardcoded 50. The
--      existing `subscriptions` table (already one row per clinic, already
--      carrying a period) is where "subscribe on the clinic" naturally
--      lands - not a new table - it gains plan_id, razorpay_subscription_id,
--      current_period_end and billing_status.
--      A Razorpay subscription is created with a fixed retry schedule on
--      Razorpay's own side; subscription.pending (a charge failed, Razorpay
--      is retrying) marks billing_status = 'past_due' immediately, and only
--      subscription.halted (Razorpay has exhausted every retry) sets
--      clinics.is_active = false - i.e. Razorpay's own retry window IS the
--      "short grace period" the spec asks for; no cron job invents a second
--      one. subscription.charged (any successful charge, first or renewal)
--      always reactivates and records an invoice.
--   2. COMMISSION - a per-booking cut of the appointment's own net_amount,
--      recorded once an appointment is marked completed, for later
--      settlement (this only RECORDS the fee - it does not attempt to
--      auto-collect it via a second Razorpay charge).
--
-- IMPORTANT FIX bundled in here: handle_appointment_status_change() has been
-- missing `security definer` since migration 39 first started writing to
-- coupon_redemptions from inside it. A plain clinic/patient action has no
-- RLS write access to coupon_redemptions (by design - see migration 41's
-- header), so every one of those writes has been silently matching zero
-- rows this whole time instead of erroring. Section 43.7 repairs the one
-- reservation this has already left stranded; section 43.6 fixes the
-- function itself so it stops happening (and is a matching risk for the
-- new commission_ledger write this migration adds to the same trigger).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 43.1 plans
-- ----------------------------------------------------------------------------
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  monthly_price numeric not null check (monthly_price >= 0),
  -- null = unlimited bookings/month.
  booking_limit int check (booking_limit is null or booking_limit > 0),
  -- Fraction of an appointment's net_amount taken as platform commission
  -- once it's completed - 0 to 1 (e.g. 0.02 = 2%). Optional: 0 is valid and
  -- is the default.
  per_booking_commission numeric not null default 0 check (per_booking_commission >= 0 and per_booking_commission <= 1),
  -- Set once a matching Razorpay Plan exists (created lazily, on first
  -- subscribe - see razorpay-create-subscription) - null until then.
  razorpay_plan_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table plans enable row level security;
drop policy if exists "plans_select" on plans;
create policy "plans_select" on plans for select using (active or public.is_admin());
drop policy if exists "plans_write" on plans;
create policy "plans_write" on plans for all using (public.is_admin());

-- Basic mirrors the old 'free' tier exactly (50 bookings/month, no cost) so
-- every existing clinic's behaviour is unchanged the moment this runs.
-- Standard/Premium mirror old 'pro'/'premium' (unlimited) with example
-- prices/commissions an admin can edit directly in the table (or via SQL -
-- there's no plans-admin CRUD screen yet, matching how several other
-- clinic-level settings in this project start out SQL-managed).
insert into plans (name, monthly_price, booking_limit, per_booking_commission)
values
  ('Basic', 0, 50, 0),
  ('Standard', 999, null, 0),
  ('Premium', 2499, null, 0.02)
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- 43.2 subscriptions - extended, not replaced
-- ----------------------------------------------------------------------------
alter table subscriptions add column if not exists plan_id uuid references plans (id);
alter table subscriptions add column if not exists razorpay_subscription_id text;
-- Distinct from the existing period_start/period_end (date - the monthly
-- USAGE-count reset window, lazily rolled by enforce_clinic_booking_limit()).
-- This is the actual Razorpay BILLING cycle's end, a real instant in time.
alter table subscriptions add column if not exists current_period_end timestamptz;
alter table subscriptions add column if not exists billing_status text not null default 'active';
alter table subscriptions drop constraint if exists subscriptions_billing_status_check;
alter table subscriptions add constraint subscriptions_billing_status_check
  check (billing_status in ('active', 'past_due'));
alter table subscriptions add column if not exists past_due_since timestamptz;

update subscriptions set plan_id = (select id from plans where name = 'Basic') where tier = 'free' and plan_id is null;
update subscriptions set plan_id = (select id from plans where name = 'Standard') where tier = 'pro' and plan_id is null;
update subscriptions set plan_id = (select id from plans where name = 'Premium') where tier = 'premium' and plan_id is null;

-- ----------------------------------------------------------------------------
-- 43.3 invoices - one row per billing cycle attempt (paid or failed)
-- ----------------------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  amount numeric not null,
  status text not null check (status in ('paid', 'failed')),
  razorpay_invoice_id text,
  razorpay_payment_id text,
  created_at timestamptz not null default now()
);

alter table invoices enable row level security;
drop policy if exists "invoices_select" on invoices;
create policy "invoices_select" on invoices for select
  using (public.is_admin() or public.is_own_clinic(clinic_id));
-- No insert/update policy for plain users at all - only razorpay-webhook
-- (service role, bypasses RLS as table owner) ever writes an invoice.

-- ----------------------------------------------------------------------------
-- 43.4 commission_ledger - one row per completed appointment, for later
-- settlement (this records the fee; it does not collect it automatically).
-- ----------------------------------------------------------------------------
create table if not exists commission_ledger (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  appointment_id uuid not null references appointments (id) on delete cascade,
  net_amount numeric not null,
  commission_rate numeric not null,
  platform_fee numeric not null,
  created_at timestamptz not null default now()
);
alter table commission_ledger add constraint commission_ledger_appointment_id_unique unique (appointment_id);

alter table commission_ledger enable row level security;
drop policy if exists "commission_ledger_select" on commission_ledger;
create policy "commission_ledger_select" on commission_ledger for select using (public.is_admin());
-- No write policy for plain users - only handle_appointment_status_change()
-- (security definer as of 43.6) ever inserts a row.

-- ----------------------------------------------------------------------------
-- 43.5 enforce_clinic_booking_limit() - reads plans.booking_limit now,
-- instead of a hardcoded "50 if tier = free".
-- ----------------------------------------------------------------------------
create or replace function public.enforce_clinic_booking_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  clinic_is_active boolean;
  sub subscriptions;
  limit_val int;
begin
  select is_active into clinic_is_active from clinics where id = new.clinic_id;
  if clinic_is_active is false then
    raise exception 'This clinic isn''t currently accepting bookings.';
  end if;

  select * into sub from subscriptions where clinic_id = new.clinic_id;

  if sub.id is null then
    insert into subscriptions (clinic_id, tier, bookings_used, period_start, period_end, plan_id)
    values (new.clinic_id, 'free', 0, current_date, (current_date + interval '1 month')::date, (select id from plans where name = 'Basic'))
    returning * into sub;
  elsif sub.period_end is null or sub.period_end < current_date then
    update subscriptions
    set bookings_used = 0, period_start = current_date, period_end = (current_date + interval '1 month')::date
    where id = sub.id
    returning * into sub;
  end if;

  select booking_limit into limit_val from plans where id = sub.plan_id;

  if limit_val is not null and sub.bookings_used >= limit_val then
    raise exception 'This clinic has reached its booking limit for this period. Please try again later or contact the clinic.';
  end if;

  update subscriptions set bookings_used = bookings_used + 1 where id = sub.id;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 43.6 handle_appointment_status_change() - the security definer fix, plus
-- commission recording on completed.
-- ----------------------------------------------------------------------------
create or replace function public.handle_appointment_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update payments set status = 'captured' where appointment_id = new.id and status = 'hold';
    update coupon_redemptions set status = 'confirmed' where appointment_id = new.id and status = 'reserved';
  end if;

  if new.status in ('rejected', 'cancelled') and old.status is distinct from new.status then
    if new.payment_status = 'paid_online' then
      new.payment_status := 'refunded';
    end if;
    update payments set status = 'refunded' where appointment_id = new.id and status in ('hold', 'captured');

    with released as (
      update coupon_redemptions set status = 'released'
      where appointment_id = new.id and status = 'reserved'
      returning coupon_id
    )
    update coupons set times_used = greatest(times_used - 1, 0)
    where id in (select coupon_id from released);
  end if;

  if new.status = 'completed' and old.status is distinct from 'completed' then
    insert into commission_ledger (clinic_id, appointment_id, net_amount, commission_rate, platform_fee)
    select
      new.clinic_id,
      new.id,
      coalesce(p.net_amount, p.amount, 0),
      coalesce(pl.per_booking_commission, 0),
      coalesce(p.net_amount, p.amount, 0) * coalesce(pl.per_booking_commission, 0)
    from payments p
    left join subscriptions s on s.clinic_id = new.clinic_id
    left join plans pl on pl.id = s.plan_id
    where p.appointment_id = new.id
      and coalesce(p.net_amount, p.amount, 0) * coalesce(pl.per_booking_commission, 0) > 0
    on conflict (appointment_id) do nothing;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 43.7 One-time repair for the dormant bug described in this migration's
-- header - fixes any reservation the missing security definer left stranded.
-- ----------------------------------------------------------------------------
update coupon_redemptions cr
set status = 'confirmed'
from appointments a
where a.id = cr.appointment_id
  and cr.status = 'reserved'
  and a.status = 'accepted';

with stuck as (
  update coupon_redemptions cr
  set status = 'released'
  from appointments a
  where a.id = cr.appointment_id
    and cr.status = 'reserved'
    and a.status in ('rejected', 'cancelled')
  returning cr.coupon_id
)
update coupons c
set times_used = greatest(times_used - 1, 0)
where id in (select coupon_id from stuck);

-- ============================================================================
-- 44. PATIENT ONBOARDING PROFILE
-- ============================================================================
-- Runs once, right after a new phone sign-up, before any other patient
-- screen - see PatientOnboardingGate.tsx, which wraps the whole patient app
-- in App.tsx OUTSIDE PatientDeclarationGate (the existing platform
-- declaration + DPDP consent gate). The onboarding form itself records the
-- platform declaration acceptance as part of its own submit (reusing
-- usePatientDeclarationStatus() - the same hook/table PatientDeclarationGate
-- already reads), so by the time a new patient reaches that gate, only the
-- DPDP consent (untouched, not mentioned in this spec) is left to show, if
-- anything.
--
--   * profiles.onboarding_complete - the gate flag. Backfilled to true for
--     every existing patient who already has at least one family member (a
--     brand new column defaulting to false would otherwise force every
--     current user back through onboarding on their next login).
--   * family_members gains address/pincode/emergency_contact_name/
--     emergency_contact_phone - the fields the spec requires that didn't
--     already exist (name, dob, gender, email, blood_group, city, photo_path
--     all already did, from earlier migrations).
-- No new RLS is needed: profiles_update already lets a patient write their
-- own row, and family_insert/family_update already let them write their own
-- family_members rows - the same policies FamilyMemberForm.tsx and the
-- Profile screen's "Personal Details" panel already rely on.
-- ============================================================================

alter table profiles add column if not exists onboarding_complete boolean not null default false;

update profiles set onboarding_complete = true
where role = 'patient'
  and onboarding_complete = false
  and exists (select 1 from family_members where account_id = profiles.id);

-- Never gated for a clinic/admin account - App.tsx only ever renders
-- PatientOnboardingGate for the patient branch, but this keeps the column
-- honest for anyone who queries it directly (e.g. the admin console).
update profiles set onboarding_complete = true where role in ('clinic', 'admin') and onboarding_complete = false;

alter table family_members add column if not exists address text;
alter table family_members add column if not exists pincode text;
alter table family_members add column if not exists emergency_contact_name text;
alter table family_members add column if not exists emergency_contact_phone text;

-- ============================================================================
-- 45. CLINIC REGISTRATION WITH UPLOADS
-- ============================================================================
-- Wires the existing documents/agreement infrastructure (sections 14, and
-- the doctor-onboarding-gate added alongside section 15's map location work)
-- into the CLINIC's own registration, exactly mirroring the pattern a doctor
-- already goes through - not a new, parallel system:
--
--   * clinics.status gains 'draft', the same way doctors.status did:
--     register_clinic() now creates a clinic as 'draft' (invisible to
--     admin/search, same as 'pending' already was to patients) instead of
--     immediately 'pending'. A clinic reaches the admin's queue only once it
--     explicitly submits - see ClinicOnboardingScreen.tsx - mirroring
--     DoctorOnboardingScreen.tsx exactly. Existing clinics are untouched:
--     they're already 'pending' or later, never retroactively 'draft'.
--   * enforce_clinic_submission_requirements() is the hard version of that
--     gate (draft -> pending blocked unless every required clinic document
--     has an on-file, non-rejected upload), exactly mirroring
--     enforce_doctor_submission_requirements() - a client-side check can be
--     bypassed by calling the API directly, this can't.
--   * clinics.contact_phone - the "contact" field the registration form now
--     also collects, alongside name/reg_no/address (map location was
--     already collected separately via ClinicLocationPicker.tsx - section
--     15 - now surfaced as part of the same onboarding flow instead of a
--     disconnected dashboard tab).
--   * Two new clinic document types (clinic_address_proof, clinic_license)
--     and one new doctor one (doctor_photo) in src/lib/documentTypes.ts -
--     AdminDocumentReview.tsx and DocumentChecklist.tsx need zero changes
--     for this, since both already render entirely from that list.
--
-- Deliberately NOT combined into one gate: a clinic's own submission and
-- each doctor's submission stay independent, exactly as they already were
-- for doctors-vs-each-other (each doctor already has its own draft/pending
-- lifecycle, reviewed independently by admin) - "the agreement" the spec's
-- combined sentence refers to is the per-doctor one (consents.doctor_id),
-- since a clinic itself signs nothing. Testing this therefore means
-- submitting the clinic AND its doctor as two related but separate steps -
-- see TESTING.md.
-- ============================================================================

alter table clinics add column if not exists contact_phone text;

alter table clinics alter column status set default 'draft';
alter table clinics drop constraint if exists clinics_status_check;
alter table clinics add constraint clinics_status_check
  check (status in ('draft', 'pending', 'approved', 'rejected'));

-- Mirrors doctors_update's own fix exactly: the owning clinic may only move
-- itself between draft and pending - approved/rejected stays admin-only.
drop policy if exists "clinics_update" on clinics;
create policy "clinics_update" on clinics for update
  using (owner_id = auth.uid() or public.is_admin())
  with check (
    public.is_admin()
    or (owner_id = auth.uid() and status in ('draft', 'pending'))
  );

-- The required-doc-type list here must be kept in sync with the `required:
-- true` entries for ownerType 'clinic' in src/lib/documentTypes.ts.
create or replace function public.enforce_clinic_submission_requirements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  missing_required int;
begin
  if new.status = 'pending' and old.status = 'draft' then
    select count(*) into missing_required
    from unnest(array[
      'clinic_registration_certificate',
      'clinic_address_proof',
      'clinic_license'
    ]) as t(required_type)
    where not exists (
      select 1 from (
        select distinct on (doc_type) doc_type, status
        from documents
        where owner_type = 'clinic' and owner_id = new.id
        order by doc_type, created_at desc
      ) latest
      where latest.doc_type = t.required_type and latest.status <> 'rejected'
    );

    if missing_required > 0 then
      raise exception 'All required documents must be uploaded before submitting this clinic for review.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_clinic_submit_check on clinics;
create trigger on_clinic_submit_check
  before update on clinics
  for each row
  execute function public.enforce_clinic_submission_requirements();

-- register_clinic() now starts a clinic at 'draft' (not 'pending') and takes
-- a contact phone number. p_contact_phone is optional at the RPC level (the
-- registration FORM enforces it as required, same "DB permissive, UI
-- enforces required" split already used for name/address elsewhere in this
-- function).
--
-- A trailing parameter with a default is allowed by CREATE OR REPLACE, but
-- Postgres still treats the old 3-argument signature as a DIFFERENT
-- overload rather than something this replaces - both would otherwise stay
-- callable side by side, and the stale 3-arg one still creates a clinic as
-- 'pending' with no contact_phone, silently defeating this whole migration
-- for any caller that happens to invoke it. Drop it explicitly first.
drop function if exists public.register_clinic(text, text, text);

create or replace function public.register_clinic(p_name text, p_reg_no text, p_address text, p_contact_phone text default null)
returns clinics
language plpgsql
as $$
declare
  new_clinic clinics;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to register a clinic.';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Clinic name is required.';
  end if;

  if exists (select 1 from clinics where owner_id = auth.uid()) then
    raise exception 'This account already has a registered clinic.';
  end if;

  update profiles set role = 'clinic' where id = auth.uid() and role = 'patient';

  insert into clinics (owner_id, name, reg_no, address, contact_phone, status, is_active)
  values (
    auth.uid(),
    trim(p_name),
    nullif(trim(coalesce(p_reg_no, '')), ''),
    nullif(trim(coalesce(p_address, '')), ''),
    nullif(trim(coalesce(p_contact_phone, '')), ''),
    'draft',
    true
  )
  returning * into new_clinic;

  return new_clinic;
end;
$$;
