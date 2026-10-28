-- ============================================================================
-- 87. LAUNCH HARDENING: queue updates carry no patient data; indexes for scale
-- ============================================================================
-- 1. PRIVACY FIX. broadcast_appointment_queue_change() used
--    realtime.broadcast_changes(), which sends the WHOLE appointment row (old
--    and new) to the channel "queue:<doctor>:<date>". Any signed-in user may
--    listen on any queue channel (queue_broadcast_select), so another patient
--    could receive someone's reason for visit, booking location, payment
--    status and more. Every screen only uses these messages as a "something
--    changed - reload" signal, so the message now says exactly that and
--    nothing else. A booking moved to another day/doctor also tells the queue
--    it left.
-- 2. INDEXES for the lookups the app and the access rules make on every
--    request (bookings by doctor/day, by clinic/day and by patient, a user's
--    notifications, a visit's prescription and files, a patient's account and
--    MRN, ...). Each is created on its own so one unexpected column can't
--    stop the rest.
-- 3. AVERAGE CONSULTATION TIME reads the doctor's latest 200 timed visits
--    instead of every visit they have ever had. Every open queue screen asks
--    for it whenever the queue moves, so it has to stay cheap as history grows
--    (and recent visits are the better guide to today's pace anyway).
-- 4. RATE LIMITER (migration 74) fixes:
--    a. Signed-in requests are limited per ACCOUNT only; the per-address
--       limit now applies to signed-out traffic. Mobile carriers put many
--       people behind one internet address, so counting signed-in users per
--       address meant 40 different patients checking in or booking in the
--       same minute from one carrier address locked EVERYONE on it out for
--       two minutes - and all their writes queued behind one counter row.
--    b. A read-only request (every GET, every STABLE function) cannot write
--       the counters, so it was never actually counted - the counter write
--       failed and the guard let it through. It now skips those openly
--       instead of failing on each one.
-- 5. DOCTOR SEARCH returned every approved doctor on the platform (checking
--    verification and averaging reviews for each) and the app sorted them by
--    distance itself - past 1,000 doctors the list was cut off alphabetically
--    first, so "Nearest to me" could miss the nearest ones. The database now
--    sorts by distance (when given a location) and returns the best 100.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 87.1 Queue updates: a signal, not the row
-- ----------------------------------------------------------------------------
create or replace function public.broadcast_appointment_queue_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_topic text;
  v_old_topic text;
begin
  if tg_op <> 'DELETE' then
    v_new_topic := 'queue:' || new.doctor_id::text || ':' || new.date::text;
    perform realtime.send(jsonb_build_object('changed', true), tg_op, v_new_topic, true);
  end if;
  if tg_op <> 'INSERT' then
    v_old_topic := 'queue:' || old.doctor_id::text || ':' || old.date::text;
    if v_old_topic is distinct from v_new_topic then
      perform realtime.send(jsonb_build_object('changed', true), 'UPDATE', v_old_topic, true);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

-- It also fires now for a NEW booking (the clinic's waiting list already
-- listens for INSERT but nothing ever sent one), when a booking moves to
-- another date, time or doctor (reschedule), and when the clinic presses
-- Remind (so the patient's open screen shows the reminder at once) - not
-- only on status, token and payment changes.
drop trigger if exists on_appointment_queue_broadcast on appointments;
create trigger on_appointment_queue_broadcast
  after update on appointments
  for each row
  when (
    old.status is distinct from new.status
    or old.token_number is distinct from new.token_number
    or old.payment_status is distinct from new.payment_status
    or old.date is distinct from new.date
    or old.slot_time is distinct from new.slot_time
    or old.doctor_id is distinct from new.doctor_id
    or old.reminder_count is distinct from new.reminder_count
  )
  execute function public.broadcast_appointment_queue_change();

drop trigger if exists on_appointment_queue_broadcast_insert on appointments;
create trigger on_appointment_queue_broadcast_insert
  after insert on appointments
  for each row
  execute function public.broadcast_appointment_queue_change();

-- ----------------------------------------------------------------------------
-- 87.2 Indexes
-- ----------------------------------------------------------------------------
do $$
declare
  stmt text;
begin
  foreach stmt in array array[
    -- bookings (doctor+day: every live queue, the token board, slot counts)
    'create index if not exists appointments_doctor_date_idx on appointments (doctor_id, date)',
    'create index if not exists appointments_clinic_date_idx on appointments (clinic_id, date)',
    'create index if not exists appointments_member_date_idx on appointments (member_id, date desc)',
    'create index if not exists appointments_clinic_member_idx on appointments (clinic_id, member_id)',
    'create index if not exists appointments_status_date_idx on appointments (status, date)',
    'create index if not exists appointments_encounter_idx on appointments (encounter_id) where encounter_id is not null',
    -- notifications (the bell asks on every screen)
    'create index if not exists notifications_user_at_idx on notifications (user_id, at desc)',
    'create index if not exists notifications_user_unread_idx on notifications (user_id) where not read',
    -- a visit, its prescription, files and payment
    'create index if not exists visits_appointment_idx on visits (appointment_id)',
    'create index if not exists prescriptions_visit_idx on prescriptions (visit_id)',
    'create index if not exists files_appointment_idx on files (appointment_id)',
    'create index if not exists files_member_idx on files (member_id)',
    'create index if not exists payments_appointment_idx on payments (appointment_id)',
    'create index if not exists coupon_redemptions_appointment_idx on coupon_redemptions (appointment_id)',
    'create index if not exists settlements_clinic_status_idx on settlements (clinic_id, status)',
    -- patients (is_own_member / is_own_mrn / walk-in and claim lookups)
    'create index if not exists family_members_account_idx on family_members (account_id)',
    'create index if not exists family_members_mrn_idx on family_members (mrn, account_id)',
    'create index if not exists family_members_phone_idx on family_members (phone) where phone is not null',
    'create index if not exists profiles_phone_idx on profiles (phone)',
    'create index if not exists encounters_mrn_idx on encounters (mrn, visit_datetime desc)',
    'create index if not exists encounters_clinic_idx on encounters (clinic_id, visit_datetime desc)',
    -- clinics and doctors (is_own_clinic / my_clinic_id / booking pages)
    'create index if not exists clinics_owner_idx on clinics (owner_id)',
    'create index if not exists clinic_staff_phones_phone_idx on clinic_staff_phones (phone)',
    'create index if not exists clinic_staff_phones_clinic_idx on clinic_staff_phones (clinic_id)',
    'create index if not exists doctors_clinic_idx on doctors (clinic_id)',
    'create index if not exists doctor_availability_doctor_idx on doctor_availability (doctor_id, weekday)',
    'create index if not exists documents_owner_idx on documents (owner_type, owner_id, created_at desc)'
  ] loop
    begin
      execute stmt;
    exception when others then
      raise notice 'Skipped (%): %', sqlerrm, stmt;
    end;
  end loop;
end $$;

-- Fresh statistics so the planner uses the new indexes straight away.
analyze appointments;
analyze notifications;
analyze family_members;

-- ----------------------------------------------------------------------------
-- 87.3 Average consultation time: the latest 200 timed visits
-- ----------------------------------------------------------------------------
-- Same answer as before for a doctor with up to 200 timed visits. Walks the
-- doctor's bookings newest first on appointments_doctor_date_idx and stops at
-- 200, so the cost no longer grows with years of history.
create or replace function public.get_doctor_avg_consultation_minutes(p_doctor_id uuid)
returns table (avg_minutes numeric, sample_size int)
language sql
security definer
stable
set search_path = public
as $$
  select round(avg(recent.duration_minutes)), count(*)::int
  from (
    select v.duration_minutes
    from appointments a
    join visits v on v.appointment_id = a.id
    where a.doctor_id = p_doctor_id
      and v.duration_minutes is not null
      and not v.needs_review
    order by a.date desc, a.slot_time desc
    limit 200
  ) recent;
$$;

-- ----------------------------------------------------------------------------
-- 87.4 Rate limiter: per account when signed in, per address when not
-- ----------------------------------------------------------------------------
-- Everything else is as in migration 74: same rules table, same classes, same
-- kill switch (guard.settings 'rate_limit' = enforce | log | off), still fails
-- open on any unexpected error.
create or replace function guard.evaluate()
returns int
language plpgsql
security definer
set search_path = guard, pg_temp
as $$
declare
  v_mode    text;
  v_headers json;
  v_claims  json;
  v_path    text;
  v_method  text;
  v_ip      text;
  v_acct    text;
  v_klass   text;
  v_rule    guard.rate_rules;
  v_bucket  text;
  v_limit   int;
  v_retry   int;
  v_blocked boolean;
begin
  -- A read-only request (GET, HEAD, or a STABLE/IMMUTABLE function) runs in a
  -- read-only transaction, where the counters cannot be written.
  if current_setting('transaction_read_only', true) = 'on' then
    return null;
  end if;

  select value into v_mode from guard.settings where key = 'rate_limit';
  if coalesce(v_mode, 'enforce') = 'off' then
    return null;
  end if;

  v_headers := nullif(current_setting('request.headers', true), '')::json;
  v_claims  := nullif(current_setting('request.jwt.claims', true), '')::json;
  v_path    := current_setting('request.path', true);
  v_method  := coalesce(current_setting('request.method', true), v_headers ->> 'x-http-method', 'GET');

  -- CORS preflights never carry data; don't count them.
  if upper(v_method) = 'OPTIONS' then
    return null;
  end if;

  v_klass := guard.classify(v_path, v_method);
  select * into v_rule from guard.rate_rules where klass = v_klass;
  if not found then
    return null;
  end if;

  v_acct := case when v_claims ->> 'role' = 'authenticated' then v_claims ->> 'sub' end;
  if v_acct is not null and v_rule.per_account is not null then
    -- Signed in: the account is who is asking, whatever address it uses.
    v_bucket := v_klass || '|acct|' || v_acct;
    v_limit  := v_rule.per_account;
  else
    -- Signed out: all we know is the address. Supabase sits behind
    -- Cloudflare, which sets cf-connecting-ip itself (a client cannot forge
    -- it). Fall back to the first x-forwarded-for hop.
    v_ip := coalesce(
      nullif(v_headers ->> 'cf-connecting-ip', ''),
      nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), ''),
      'unknown'
    );
    v_bucket := v_klass || '|ip|' || trim(v_ip);
    v_limit  := v_rule.per_ip;
  end if;

  -- Already serving a penalty before this request? Then a refusal now is not
  -- a new breach.
  v_blocked := exists (select 1 from guard.penalties p where p.bucket = v_bucket and p.blocked_until > now());
  v_retry := guard.count_and_check(v_bucket, v_limit, v_rule.window_seconds, v_rule.penalty_seconds);
  -- Log only the moment of breach - the request that started the penalty -
  -- not every blocked request after it, so an attack can't amplify into
  -- writes on rate_events. (Comparing the seconds left with the full penalty
  -- also matched every request in the first second after.)
  if v_retry is not null and not v_blocked then
    insert into guard.rate_events (bucket, klass, path, mode)
      values (v_bucket, v_klass, v_path, v_mode);
  end if;

  if v_mode = 'log' then
    return null;           -- observe only
  end if;
  return v_retry;
exception when others then
  return null;             -- FAIL OPEN: a guard bug must never take the API down
end;
$$;

revoke all on function guard.evaluate() from public;
grant execute on function guard.evaluate() to anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 87.5 Doctor search: nearest first, at most 100 results
-- ----------------------------------------------------------------------------
-- Same filters and columns as before (migration 62) plus distance_km. Called
-- with just search_term it behaves as before, apart from the 100-row cap.
-- Verification and ratings are worked out only for the rows returned.
drop function if exists public.search_doctors(text);
drop function if exists public.search_doctors(text, double precision, double precision, int);
create function public.search_doctors(
  search_term text default '',
  p_lat double precision default null,
  p_lng double precision default null,
  p_limit int default 100
)
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
  clinic_verified boolean,
  doctor_avg_rating numeric,
  doctor_review_count int,
  doctor_percent_positive int,
  distance_km double precision
)
language sql
stable
as $$
  with matches as (
    select
      d.id as m_doctor_id, d.name as m_doctor_name, d.specialty as m_specialty,
      c.id as m_clinic_id, c.name as m_clinic_name, c.address as m_clinic_address,
      c.lat as m_lat, c.lng as m_lng,
      case
        when p_lat is null or p_lng is null or c.lat is null or c.lng is null then null
        else 6371 * 2 * asin(least(1, sqrt(
          power(sin(radians(c.lat - p_lat) / 2), 2)
          + cos(radians(p_lat)) * cos(radians(c.lat)) * power(sin(radians(c.lng - p_lng) / 2), 2)
        )))
      end as m_distance
    from doctors d
    join clinics c on c.id = d.clinic_id
    where d.status = 'approved'
      and d.is_active
      and c.status = 'approved'
      and c.is_active
      and (
        coalesce(search_term, '') = ''
        or d.name ilike '%' || search_term || '%'
        or d.specialty ilike '%' || search_term || '%'
        or c.name ilike '%' || search_term || '%'
        or c.address ilike '%' || search_term || '%'
      )
    order by m_distance asc nulls last, c.name, d.name
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  )
  select
    m.m_doctor_id, m.m_doctor_name, m.m_specialty, m.m_clinic_id, m.m_clinic_name, m.m_clinic_address, m.m_lat, m.m_lng,
    public.is_currently_verified('doctor', m.m_doctor_id),
    public.is_currently_verified('clinic', m.m_clinic_id),
    dr.avg_rating, coalesce(dr.review_count, 0), dr.percent_positive,
    m.m_distance
  from matches m
  left join lateral (
    select
      round(avg(r.rating)::numeric, 1) as avg_rating,
      count(*)::int as review_count,
      round(100.0 * count(*) filter (where r.rating >= 4) / nullif(count(*), 0))::int as percent_positive
    from reviews r
    where r.doctor_id = m.m_doctor_id and r.status = 'visible'
  ) dr on true
  order by m.m_distance asc nulls last, m.m_clinic_name, m.m_doctor_name;
$$;
