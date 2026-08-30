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
