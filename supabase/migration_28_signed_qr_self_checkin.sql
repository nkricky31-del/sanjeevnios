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
