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
