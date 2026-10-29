-- ============================================================================
-- 93. PUSH NOTIFICATIONS FOR PATIENTS
-- ============================================================================
-- Patients now get their alerts on their phone even when the app is closed
-- (design: docs/superpowers/specs/2026-10-30-push-notifications-design.md).
--
--   93.1  The phones: push_devices, and how the app registers one
--   93.2  Which alerts go to phones (patients only)
--   93.3  Handing new alerts to the send-push function
--   93.4  Queue alerts, written by the database: almost your turn, you're
--         next, it's your turn (after a skip, the patient is told again)
--   93.5  The arrival reminder, written by a job every 5 minutes
--   93.6  The rate limiter no longer counts the project's own functions
--
-- Every alert is still written to the notification list (the bell) first.
-- Sending it to phones happens after the change that wrote it has been saved,
-- and can never fail or slow that change: if anything about sending goes
-- wrong, the alert is simply only in the app.
--
-- Needs the pg_net and pg_cron extensions (Database > Extensions). Without
-- them this still runs; alerts then stay in the app only, and the notice
-- below says what to enable.
--
-- Safe to run more than once. Switch sending off with:
--     update push_settings set enabled = false;
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 93.1 The phones
-- ----------------------------------------------------------------------------
-- One row per phone that has alerts set up. token is the phone's Firebase
-- address; it is unique, so a phone belongs to one account at a time (signing
-- in with another account on the same phone moves it). enabled is the
-- "Alerts on this phone" switch in Profile. The rows go with the login when
-- the account is deleted.
create table if not exists public.push_devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  token        text not null unique check (length(token) between 20 and 4096),
  platform     text not null check (platform in ('android', 'ios')),
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_devices_user_idx on public.push_devices (user_id);

alter table public.push_devices enable row level security;

-- Each person sees only their own phones. Changes go through the functions
-- below (there is no insert, update or delete policy).
drop policy if exists "push_devices_select" on public.push_devices;
create policy "push_devices_select" on public.push_devices for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.push_devices from anon, authenticated;
grant select on public.push_devices to authenticated;

-- Called by the app when alerts are turned on, and again whenever Firebase
-- gives the phone a new token. p_enabled: true when the patient has just
-- turned alerts on; left out, a phone already on this account keeps its
-- switch as it is. A phone registered by another account moves to this one,
-- switched on.
create or replace function public.register_push_device(p_token text, p_platform text, p_enabled boolean default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) not between 20 and 4096 then
    raise exception 'That is not a valid phone token.' using errcode = '22023';
  end if;
  if p_platform is null or p_platform not in ('android', 'ios') then
    raise exception 'Unknown phone type.' using errcode = '22023';
  end if;

  insert into push_devices as d (user_id, token, platform, enabled)
  values (auth.uid(), p_token, p_platform, coalesce(p_enabled, true))
  on conflict (token) do update
    set user_id      = excluded.user_id,
        platform     = excluded.platform,
        enabled      = case
                         when d.user_id = excluded.user_id then coalesce(p_enabled, d.enabled)
                         else coalesce(p_enabled, true)
                       end,
        last_seen_at = now();
end;
$$;

-- Called by every Sign out button before signing out: this phone stops
-- getting this account's alerts.
create or replace function public.unregister_push_device(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  delete from push_devices where token = p_token and user_id = auth.uid();
end;
$$;

-- The "Alerts on this phone" switch. Returns false if this phone isn't
-- registered to the caller (the app then registers it).
create or replace function public.set_push_enabled(p_token text, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  update push_devices
  set enabled = coalesce(p_enabled, enabled), last_seen_at = now()
  where token = p_token and user_id = auth.uid();
  return found;
end;
$$;

revoke all on function public.register_push_device(text, text, boolean) from public, anon;
revoke all on function public.unregister_push_device(text)              from public, anon;
revoke all on function public.set_push_enabled(text, boolean)           from public, anon;
grant execute on function public.register_push_device(text, text, boolean) to authenticated;
grant execute on function public.unregister_push_device(text)              to authenticated;
grant execute on function public.set_push_enabled(text, boolean)           to authenticated;

-- ----------------------------------------------------------------------------
-- 93.2 Which alerts go to phones
-- ----------------------------------------------------------------------------
-- The patient alerts. An alert is sent to phones only if its type is here,
-- it is an in-app alert, and it is addressed to the patient: the account
-- the appointment's family member belongs to, or - for alerts without an
-- appointment (missed visits, name changes, a waitlist seat) - the account
-- itself, since those are only ever written to patients. A clinic owner who
-- is also a patient gets only their own patient alerts.
--
-- Nothing medical goes on the lock screen: these texts carry the clinic,
-- doctor, times, tokens and queue counts. send-push replaces the text of
-- report_added (it names the kind of report) with a general one.
create or replace function public.push_alert_types()
returns text[]
language sql
immutable
as $$
  select array[
    -- the booking
    'booking_received', 'appointment_confirmed', 'appointment_rejected',
    'appointment_rescheduled', 'appointment_cancelled_by_clinic', 'full_day_reschedule',
    'waitlist_seat', 'schedule_published', 'appointment_missed', 'appointment_auto_cancelled',
    'follow_up_reminder', 'reporting_time_reminder',
    -- the day of the visit
    'checked_in', 'queue_almost', 'queue_next', 'token_called', 'clinic_reminder', 'queue_skip',
    -- after the visit
    'visit_completed', 'prescription_ready', 'report_added',
    -- the account
    'name_change_approved', 'name_change_rejected'
  ]::text[];
$$;

create or replace function public.is_patient_push_alert(p_type text, p_channel text, p_user_id uuid, p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_channel, 'in_app') = 'in_app'
     and p_type = any (public.push_alert_types())
     and p_user_id is not null
     and (
       p_appointment_id is null
       or exists (
         select 1
         from appointments a
         join family_members fm on fm.id = a.member_id
         where a.id = p_appointment_id
           and fm.account_id = p_user_id
       )
     );
$$;

revoke all on function public.is_patient_push_alert(text, text, uuid, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 93.3 Handing new alerts to send-push
-- ----------------------------------------------------------------------------
-- When an alert went to the patient's phones (set even when the patient has
-- no phone left to send it to, so it is never tried twice).
alter table public.notifications add column if not exists pushed_at timestamptz;

-- Only the database sets pushed_at; the app can't change it on its own rows.
create or replace function public.keep_pushed_at()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.pushed_at := old.pushed_at;
  end if;
  return new;
end;
$$;

drop trigger if exists keep_pushed_at on public.notifications;
create trigger keep_pushed_at
  before update on public.notifications
  for each row execute function public.keep_pushed_at();

-- Where send-push lives (a test project points this at its own functions),
-- and the switch for all sending.
create table if not exists public.push_settings (
  id            boolean primary key default true check (id),
  send_push_url text not null,
  enabled       boolean not null default true,
  updated_at    timestamptz not null default now()
);
insert into public.push_settings (send_push_url)
values ('https://maqnfncrqtdbjqrsibyq.supabase.co/functions/v1/send-push')
on conflict (id) do nothing;

alter table public.push_settings enable row level security; -- no policies: server only
revoke all on public.push_settings from anon, authenticated;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable (%). Enable it under Database > Extensions; until then alerts stay in the app only.', sqlerrm;
end $$;

-- Once per statement that wrote alerts: one call to send-push with the ids of
-- the patient alerts whose patient has a phone with alerts on. The call is
-- made only once the change is saved (pg_net sends after commit), and only
-- ids are sent - send-push reads everything else from here itself.
create or replace function public.dispatch_patient_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids  uuid[];
  v_url  text;
  v_from int;
begin
  begin
    select array_agg(n.id) into v_ids
    from new_rows n
    where public.is_patient_push_alert(n.type, n.channel, n.user_id, n.appointment_id)
      and exists (select 1 from push_devices d where d.user_id = n.user_id and d.enabled);
    if v_ids is null then
      return null;
    end if;

    select s.send_push_url into v_url from push_settings s where s.id and s.enabled;
    if coalesce(v_url, '') = '' then
      return null;
    end if;

    for v_from in select generate_series(1, array_length(v_ids, 1), 500) loop
      perform net.http_post(
        url                  := v_url,
        body                 := jsonb_build_object('ids', to_jsonb(v_ids[v_from : v_from + 499])),
        headers              := jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 30000
      );
    end loop;
  exception when others then
    -- Sending is a convenience on top of the bell: never fail the change.
    raise warning 'push not sent: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.dispatch_patient_push() from public, anon, authenticated;

drop trigger if exists zz_dispatch_patient_push on public.notifications;
create trigger zz_dispatch_patient_push
  after insert on public.notifications
  referencing new table as new_rows
  for each statement execute function public.dispatch_patient_push();

-- send-push, step 1: claim the alerts it was given, and get what to send.
-- Claims only patient alerts written in the last 10 minutes that haven't
-- gone to phones yet, and marks them at once - so nothing is ever sent twice
-- (a second call for the same ids gets nothing), a late alert is dropped
-- rather than sent late, and a stray call can only deliver real alerts to
-- their own patients. One row per phone with alerts on.
create or replace function public.claim_push_batch(p_ids uuid[])
returns table (
  notification_id uuid,
  appointment_id  uuid,
  type            text,
  title           text,
  message         text,
  token           text,
  platform        text
)
language sql
security definer
set search_path = public
as $$
  with claimed as (
    update notifications n
    set pushed_at = now()
    where n.id = any (p_ids[1:500])
      and n.pushed_at is null
      and n.at > now() - interval '10 minutes'
      and public.is_patient_push_alert(n.type, n.channel, n.user_id, n.appointment_id)
    returning n.id, n.user_id, n.type, n.message, n.appointment_id
  )
  select c.id, c.appointment_id, c.type, coalesce(cl.name, 'SanjeevniOS'), c.message, d.token, d.platform
  from claimed c
  join push_devices d on d.user_id = c.user_id and d.enabled
  left join appointments a on a.id = c.appointment_id
  left join clinics cl on cl.id = a.clinic_id;
$$;

-- send-push, step 2: forget phones Firebase says are gone (app deleted,
-- token replaced).
create or replace function public.forget_push_tokens(p_tokens text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  delete from push_devices where token = any (p_tokens);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.claim_push_batch(uuid[])   from public, anon, authenticated;
revoke all on function public.forget_push_tokens(text[]) from public, anon, authenticated;
grant execute on function public.claim_push_batch(uuid[])   to service_role;
grant execute on function public.forget_push_tokens(text[]) to service_role;

-- ----------------------------------------------------------------------------
-- 93.4 Queue alerts
-- ----------------------------------------------------------------------------
-- Which queue alerts each appointment has had. round is the appointment's
-- skip_count at the time: a skipped patient gets a new token at the back of
-- the queue (skip_to_back), so they are told again as they come up again,
-- and when they are called again. Server only.
create table if not exists public.queue_alert_log (
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  kind           text not null check (kind in ('queue_almost', 'queue_next', 'token_called')),
  round          int  not null,
  sent_at        timestamptz not null default now(),
  primary key (appointment_id, kind, round)
);
alter table public.queue_alert_log enable row level security; -- no policies
revoke all on public.queue_alert_log from anon, authenticated;

-- Recounts one doctor's queue for today and tells the patients who have
-- just come within reach: "2 people ahead of you (about 12 min)" when one or
-- two are ahead, "You're next" when nobody is. "Ahead" is counted exactly as
-- the clinic's queue and the patient's booking screen count it
-- (get_queue_status: checked in, called and in consultation, in fair-queue
-- order). The wait is the number ahead times the doctor's average
-- consultation time, or the slot length while there's no history.
create or replace function public.queue_alerts_for(p_doctor_id uuid, p_date date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz    text;
  v_per   numeric;
  v_count int;
begin
  select coalesce(c.timezone, 'Asia/Kolkata') into v_tz
  from doctors d join clinics c on c.id = d.clinic_id
  where d.id = p_doctor_id;
  if v_tz is null or p_date is distinct from (now() at time zone v_tz)::date then
    return 0; -- queue alerts are for today's queue only
  end if;

  select s.avg_minutes into v_per from public.get_doctor_avg_consultation_minutes(p_doctor_id) s;
  if v_per is null or v_per <= 0 then
    v_per := public.slot_minutes_for(p_doctor_id, p_date);
  end if;
  if v_per is null or v_per <= 0 then
    v_per := 15;
  end if;

  with q as (
    select a.id, a.member_id, a.status, a.skip_count,
           (row_number() over (order by a.effective_order_time asc, a.checked_in_at asc))::int - 1 as ahead
    from appointments a
    where a.doctor_id = p_doctor_id
      and a.date = p_date
      and a.status in ('checked_in', 'called', 'in_consultation')
      and a.token_number is not null
  ), due as (
    select q.*, case when q.ahead = 0 then 'queue_next' else 'queue_almost' end as kind
    from q
    where q.status = 'checked_in' and q.ahead <= 2
  ), logged as (
    insert into queue_alert_log (appointment_id, kind, round)
    select due.id, due.kind, coalesce(due.skip_count, 0) from due
    order by due.id -- the same order in every transaction: two desks at once never deadlock here
    on conflict do nothing
    returning queue_alert_log.appointment_id, queue_alert_log.kind
  )
  insert into notifications (user_id, appointment_id, type, message)
  select fm.account_id, d.id, d.kind,
         case
           when d.kind = 'queue_next' then 'You''re next. Please be ready.'
           else d.ahead || case when d.ahead = 1 then ' person' else ' people' end
                || ' ahead of you (about ' || greatest(1, round(d.ahead * v_per))::int
                || ' min). Please be at the clinic.'
         end
  from logged l
  join due d on d.id = l.appointment_id and d.kind = l.kind
  join family_members fm on fm.id = d.member_id
  where fm.account_id is not null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- "It's your turn", whenever an appointment's status becomes "called" - by
-- the Call next button or any other route.
create or replace function public.token_called_alert(p_appointment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  v_doctor  text;
  v_account uuid;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null or a.status <> 'called' then
    return false;
  end if;
  select fm.account_id into v_account from family_members fm where fm.id = a.member_id;
  if v_account is null then
    return false;
  end if;

  insert into queue_alert_log (appointment_id, kind, round)
  values (a.id, 'token_called', coalesce(a.skip_count, 0))
  on conflict do nothing;
  if not found then
    return false; -- already told for this call
  end if;

  select nullif(btrim(d.name), '') into v_doctor from doctors d where d.id = a.doctor_id;
  insert into notifications (user_id, appointment_id, type, message)
  values (
    v_account, a.id, 'token_called',
    'It''s your turn. Please go in'
      || coalesce(' to see ' || v_doctor, '')
      || coalesce(' (token #' || a.token_number || ')', '')
      || '.'
  );
  return true;
end;
$$;

revoke all on function public.queue_alerts_for(uuid, date)  from public, anon, authenticated;
revoke all on function public.token_called_alert(uuid)       from public, anon, authenticated;

-- After any change to who is in a doctor's queue, or in what order. Runs
-- inside the clinic's action but can never fail it.
create or replace function public.appointments_queue_alerts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_queue   constant text[] := array['checked_in', 'called', 'in_consultation'];
  v_called  boolean := false; -- the status has just become "called"
  v_recount boolean := false; -- someone joined, left or moved in a queue
  v_moved   boolean := false; -- ...and it was another doctor's or day's queue before
begin
  -- First the cheap question - does this change matter to a queue at all? -
  -- so that most changes to appointments (payments, bookings, reminders) do
  -- nothing more.
  if tg_op = 'INSERT' then
    v_called  := new.status = 'called';
    v_recount := new.status = any (v_queue);
  elsif tg_op = 'DELETE' then
    v_recount := old.status = any (v_queue);
  else
    v_called  := new.status = 'called' and old.status is distinct from 'called';
    v_recount := (old.status = any (v_queue) or new.status = any (v_queue))
                 and (old.status, old.checked_in_at, old.effective_order_time, old.token_number, old.doctor_id, old.date)
                     is distinct from
                     (new.status, new.checked_in_at, new.effective_order_time, new.token_number, new.doctor_id, new.date);
    v_moved   := v_recount and (old.doctor_id, old.date) is distinct from (new.doctor_id, new.date);
  end if;
  if not (v_called or v_recount) then
    return null;
  end if;

  begin
    if v_called then
      perform public.token_called_alert(new.id);
    end if;
    if v_recount then
      if tg_op = 'DELETE' then
        perform public.queue_alerts_for(old.doctor_id, old.date);
      else
        perform public.queue_alerts_for(new.doctor_id, new.date);
      end if;
      if v_moved then
        perform public.queue_alerts_for(old.doctor_id, old.date);
      end if;
    end if;
  exception when others then
    -- The clinic's action always goes through; at worst an alert is missed.
    raise warning 'queue alerts not written: %', sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.appointments_queue_alerts() from public, anon, authenticated;

drop trigger if exists appointments_queue_alerts on public.appointments;
create trigger appointments_queue_alerts
  after insert or update or delete on public.appointments
  for each row execute function public.appointments_queue_alerts();

-- The queue alerts are the database's alone now. The app used to write
-- token_called itself (Call next) and queue_reminder (the booking screen);
-- an app still open from before this change would write a second copy, so
-- those rows are dropped when the app writes them.
create or replace function public.server_only_alerts()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated')
     and new.type in ('queue_almost', 'queue_next', 'token_called', 'queue_reminder') then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists ab_server_only_alerts on public.notifications;
create trigger ab_server_only_alerts
  before insert on public.notifications
  for each row execute function public.server_only_alerts();

-- ----------------------------------------------------------------------------
-- 93.5 The arrival reminder
-- ----------------------------------------------------------------------------
-- For a confirmed booking today that hasn't checked in: from 60 minutes
-- before its reporting time (the time get_checkin_options gives the app)
-- until its slot time. Not for a booking made after that window opened - its
-- confirmation has just said when to come. One per booking (the existing
-- notifications_lifecycle_dedup_idx). The check-in line follows the clinic's
-- own setting, as get_checkin_options decides it.
create or replace function public.sweep_reporting_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into notifications (user_id, appointment_id, type, channel, message)
  select fm.account_id, a.id, 'reporting_time_reminder', 'in_app',
         'Please reach ' || c.name || ' by ' || to_char(a.date + r.reporting, 'FMHH12:MI AM')
           || ' for your ' || to_char(a.date + a.slot_time, 'FMHH12:MI AM') || ' visit, and '
           || case
                when c.self_checkin_enabled or (c.fast_checkin_paid_online and a.payment_status = 'paid_online')
                  then 'scan the clinic''s QR to check in.'
                else 'check in at the reception desk.'
              end
  from appointments a
  join clinics c on c.id = a.clinic_id
  join family_members fm on fm.id = a.member_id
  cross join lateral (
    select a.slot_time - make_interval(mins => least(c.report_before_minutes, coalesce(c.checkin_open_before_minutes, 60))) as reporting,
           coalesce(c.timezone, 'Asia/Kolkata') as tz
  ) r
  cross join lateral (
    select (now() at time zone r.tz) as local_now,
           (a.date + r.reporting) - interval '60 minutes' as opens
  ) w
  where a.status = 'accepted'
    and a.date between current_date - 1 and current_date + 1
    and a.date = w.local_now::date
    and fm.account_id is not null
    and w.local_now >= w.opens
    and w.local_now < a.date + a.slot_time
    and a.created_at < (w.opens at time zone r.tz)
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.sweep_reporting_reminders() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  begin
    perform cron.unschedule('sanjeevni_reporting_reminders');
  exception when others then
    null; -- nothing to unschedule yet
  end;
  perform cron.schedule('sanjeevni_reporting_reminders', '*/5 * * * *', 'select public.sweep_reporting_reminders()');
exception when others then
  raise notice 'pg_cron unavailable (%). Enable it under Database > Extensions, then run this migration again; until then there is no arrival reminder.', sqlerrm;
end $$;

-- ----------------------------------------------------------------------------
-- 93.6 The rate limiter no longer counts the project's own functions
-- ----------------------------------------------------------------------------
-- send-push (and the other functions) reach the database with the service
-- key from Supabase's own machines, which share a handful of addresses, so
-- they would use up one another's allowance on a busy day. The service key
-- can already do anything, so limiting it protects nothing. Otherwise as in
-- migration 87.
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

  -- The project's own functions (migration 93).
  if v_claims ->> 'role' = 'service_role' then
    return null;
  end if;

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
  -- writes on rate_events.
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
