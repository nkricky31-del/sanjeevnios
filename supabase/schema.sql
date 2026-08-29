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
