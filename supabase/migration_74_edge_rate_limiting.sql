-- ============================================================================
-- 74. GLOBAL API RATE LIMITING (per IP, per account, per endpoint class)
-- ============================================================================
-- WHY HERE: the browser calls Supabase (PostgREST) directly, so a CDN in front
-- of the website never sees API traffic. The one place EVERY data request
-- passes through is PostgREST, and it lets us run a function before each
-- request ("pre-request hook", pgrst.db_pre_request). That function counts the
-- request and, over the limit, raises SQLSTATE 'PGRST' with a status of 429 -
-- PostgREST turns that into a real HTTP 429 + Retry-After header.
--
-- WHAT IT COVERS: every REST table call and every /rpc call (search, booking,
-- patient/clinic reads, everything). NOT covered here: Supabase Auth (OTP) -
-- see SECURITY_EDGE.md for its dashboard rate limits + CAPTCHA; Edge
-- Functions - rate-limited in supabase/functions/_shared/authorize.ts via
-- public.edge_rate_limit() below.
--
-- SAFETY:
--   * FAILS OPEN: any unexpected error inside the counter is swallowed so a bug
--     here can never take the API down. Only a deliberate "over limit" blocks.
--   * KILL SWITCH:  update guard.settings set value='off' where key='rate_limit';
--                   (modes: 'enforce' | 'log' | 'off'; 'log' records breaches in
--                   guard.rate_events without blocking - use it to tune limits.)
--   * Limits are rows in guard.rate_rules - change them with plain UPDATEs, no
--     redeploy.
--   * India's mobile carriers share one public IP across many users (CGNAT),
--     so per-IP limits are deliberately generous and per-ACCOUNT limits are the
--     tight ones. Tune from guard.rate_events.
-- ============================================================================

create schema if not exists guard;   -- NOT in the API's exposed schemas, so not reachable via REST
revoke all on schema guard from public;
grant usage on schema guard to anon, authenticated, service_role;

create table if not exists guard.settings (
  key   text primary key,
  value text not null
);
insert into guard.settings (key, value) values ('rate_limit', 'enforce')
  on conflict (key) do nothing;

-- One row per endpoint class. A NULL per_account means "IP limit only".
create table if not exists guard.rate_rules (
  klass           text primary key,
  per_ip          int  not null,
  per_account     int,
  window_seconds  int  not null default 60,
  penalty_seconds int  not null default 60   -- how long a breaching caller is blocked
);

insert into guard.rate_rules (klass, per_ip, per_account, window_seconds, penalty_seconds) values
  ('booking',   40,  15,  60, 120),  -- creating appointments / waitlist / payments
  ('search',   240, 120,  60,  60),  -- listing clinics + doctors (the scrape target)
  ('sensitive',120,  90,  60, 300),  -- patient / member / visit / record tables and RPCs
  ('rpc',      300, 240,  60,  60),  -- every other RPC
  ('write',    200, 120,  60,  60),  -- every other insert/update/delete
  ('default',  600, 400,  60,  60)   -- everything else (reads)
on conflict (klass) do nothing;

-- Fixed-window counters. UNLOGGED = no WAL, fast; losing them in a crash only
-- resets everyone's counters, which is harmless.
create unlogged table if not exists guard.rate_counters (
  bucket       text        not null,   -- '<klass>|ip|1.2.3.4' or '<klass>|acct|<uuid>'
  window_start timestamptz not null,
  hits         int         not null default 0,
  primary key (bucket, window_start)
);

-- Callers currently serving a penalty (blocked until blocked_until).
create unlogged table if not exists guard.penalties (
  bucket        text primary key,
  blocked_until timestamptz not null
);

create table if not exists guard.rate_events (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  bucket     text not null,
  klass      text not null,
  path       text,
  mode       text not null
);

alter table guard.settings      enable row level security;
alter table guard.rate_rules    enable row level security;
alter table guard.rate_counters enable row level security;
alter table guard.penalties     enable row level security;
alter table guard.rate_events   enable row level security;
-- No policies: nobody but the table owner / service role can read or write them
-- directly; the security-definer functions below are the only way in.

-- ---------------------------------------------------------------------------
-- classify(): path + method -> endpoint class
-- ---------------------------------------------------------------------------
create or replace function guard.classify(p_path text, p_method text)
returns text
language sql
immutable
as $$
  with n as (
    select regexp_replace(coalesce(p_path, ''), '^/(rest/v1/)?', '') as p,
           upper(coalesce(p_method, 'GET')) as m
  )
  select case
    when p ~ '^rpc/(create_payment_with_coupon|join_waitlist|validate_and_price|check_in_appointment|issue_booking_qr)$'
      or (p = 'appointments' and m = 'POST')                              then 'booking'
    when p ~ '^(clinics|doctors|doctor_availability|clinic_holidays)(\?|/|$)' and m = 'GET'
      or p ~ '^rpc/(get_taken_slots|day_availability|next_available_day|get_doctor_rating|get_public_stats|get_doctor_avg_consultation_minutes)$'
                                                                          then 'search'
    when p ~ '^(patients|family_members|members|visits|encounters|prescriptions|patient_files|patient_conditions|appointments)(\?|/|$)'
      or p ~ '^rpc/(open_patient_health_record|open_encounter_health_record|authorize_patient_file_download|find_family_member_by_mrn|find_family_member_by_phone)$'
                                                                          then 'sensitive'
    when p like 'rpc/%'                                                   then 'rpc'
    when m <> 'GET' and m <> 'HEAD'                                       then 'write'
    else 'default'
  end
  from n;
$$;

-- ---------------------------------------------------------------------------
-- count_and_check(): +1 on a bucket; returns seconds to wait if over the limit
-- ---------------------------------------------------------------------------
create or replace function guard.count_and_check(
  p_bucket text, p_limit int, p_window int, p_penalty int
) returns int
language plpgsql
security definer
set search_path = guard, pg_temp
as $$
declare
  v_start   timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window) * p_window);
  v_hits    int;
  v_blocked timestamptz;
begin
  select blocked_until into v_blocked from guard.penalties where bucket = p_bucket;
  if v_blocked is not null and v_blocked > now() then
    return greatest(1, ceil(extract(epoch from (v_blocked - now())))::int);
  end if;

  insert into guard.rate_counters as c (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1
  returning hits into v_hits;

  if v_hits > p_limit then
    insert into guard.penalties (bucket, blocked_until)
    values (p_bucket, now() + make_interval(secs => p_penalty))
    on conflict (bucket) do update set blocked_until = excluded.blocked_until;
    return p_penalty;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- evaluate(): the decision. Returns retry-after seconds, or NULL to allow.
-- Fails open on ANY error.
-- ---------------------------------------------------------------------------
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
  v_retry   int;
  v_retry2  int;
begin
  select value into v_mode from guard.settings where key = 'rate_limit';
  if coalesce(v_mode, 'enforce') = 'off' then
    return null;
  end if;

  v_headers := nullif(current_setting('request.headers', true), '')::json;
  v_claims  := nullif(current_setting('request.jwt.claims', true), '')::json;
  v_path    := current_setting('request.path', true);
  v_method  := coalesce(current_setting('request.method', true), v_headers ->> 'x-http-method', 'GET');

  -- Supabase sits behind Cloudflare, which sets cf-connecting-ip itself (a
  -- client cannot forge it). Fall back to the first x-forwarded-for hop.
  v_ip := coalesce(
    nullif(v_headers ->> 'cf-connecting-ip', ''),
    nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), ''),
    'unknown'
  );
  v_acct := case when v_claims ->> 'role' = 'authenticated' then v_claims ->> 'sub' end;

  -- CORS preflights never carry data; don't count them.
  if upper(v_method) = 'OPTIONS' then
    return null;
  end if;

  v_klass := guard.classify(v_path, v_method);
  select * into v_rule from guard.rate_rules where klass = v_klass;
  if not found then
    return null;
  end if;

  v_retry := guard.count_and_check(v_klass || '|ip|' || trim(v_ip), v_rule.per_ip,
                                   v_rule.window_seconds, v_rule.penalty_seconds);
  -- Log only the moment of breach (retry == full penalty), not every blocked
  -- request, so an attack can't amplify into writes on rate_events.
  if v_retry is not null and v_retry >= v_rule.penalty_seconds then
    insert into guard.rate_events (bucket, klass, path, mode)
      values (v_klass || '|ip|' || trim(v_ip), v_klass, v_path, v_mode);
  end if;

  if v_acct is not null and v_rule.per_account is not null then
    v_retry2 := guard.count_and_check(v_klass || '|acct|' || v_acct, v_rule.per_account,
                                      v_rule.window_seconds, v_rule.penalty_seconds);
    if v_retry2 is not null and v_retry2 >= v_rule.penalty_seconds then
      insert into guard.rate_events (bucket, klass, path, mode)
        values (v_klass || '|acct|' || v_acct, v_klass, v_path, v_mode);
    end if;
    if v_retry2 is not null then
      v_retry := greatest(coalesce(v_retry, 0), v_retry2);
    end if;
  end if;

  if v_mode = 'log' then
    return null;           -- observe only
  end if;
  return v_retry;
exception when others then
  return null;             -- FAIL OPEN: a guard bug must never take the API down
end;
$$;

-- ---------------------------------------------------------------------------
-- pre_request(): the PostgREST hook. The raise is OUTSIDE evaluate()'s
-- exception block, so it is the only thing that can ever block a request.
-- ---------------------------------------------------------------------------
create or replace function guard.pre_request()
returns void
language plpgsql
set search_path = guard, pg_temp
as $$
declare
  v_retry int;
begin
  v_retry := guard.evaluate();
  if v_retry is not null then
    raise sqlstate 'PGRST' using
      message = json_build_object(
        'message', 'Too many requests. Please slow down and try again shortly.',
        'code', 'RATE_LIMITED', 'hint', null, 'details', null)::text,
      detail  = json_build_object(
        'status', 429,
        'headers', json_build_object('Retry-After', v_retry::text))::text;
  end if;
end;
$$;

revoke all on function guard.classify(text, text)                 from public;
revoke all on function guard.count_and_check(text, int, int, int) from public;
revoke all on function guard.evaluate()                           from public;
revoke all on function guard.pre_request()                        from public;
grant execute on function guard.classify(text, text)  to anon, authenticated, service_role;
grant execute on function guard.evaluate()            to anon, authenticated, service_role;
grant execute on function guard.pre_request()         to anon, authenticated, service_role;
grant execute on function guard.count_and_check(text, int, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Edge Functions: same counters, called with the service role.
--   select public.edge_rate_limit('fn:<user id>', 60, 60)  -> NULL ok / seconds to wait
-- ---------------------------------------------------------------------------
create or replace function public.edge_rate_limit(p_bucket text, p_limit int, p_window int default 60)
returns int
language sql
security definer
set search_path = guard, pg_temp
as $$
  select guard.count_and_check('edge|' || p_bucket, p_limit, p_window, p_window);
$$;
revoke all on function public.edge_rate_limit(text, int, int) from public, anon, authenticated;
grant execute on function public.edge_rate_limit(text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Housekeeping: counters older than 10 minutes, expired penalties, old events.
-- ---------------------------------------------------------------------------
create or replace function guard.cleanup()
returns void
language sql
security definer
set search_path = guard, pg_temp
as $$
  delete from guard.rate_counters where window_start < now() - interval '10 minutes';
  delete from guard.penalties     where blocked_until < now();
  delete from guard.rate_events   where at < now() - interval '14 days';
$$;
revoke all on function guard.cleanup() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('guard-cleanup', '*/5 * * * *', 'select guard.cleanup()');
exception when others then
  raise notice 'pg_cron not available (%). Enable it under Database > Extensions, then run: select cron.schedule(''guard-cleanup'', ''*/5 * * * *'', ''select guard.cleanup()'');', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- Turn the hook on. (To turn it OFF without touching data:
--   alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';)
-- ---------------------------------------------------------------------------
alter role authenticator set pgrst.db_pre_request = 'guard.pre_request';
notify pgrst, 'reload config';
