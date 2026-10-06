-- ============================================================================
-- 78. INSIDER PROTECTION: staff roles, break-glass access, MFA gate, de-identified analytics
-- ============================================================================
-- ADDITIVE and SAFE TO RUN ON ITS OWN: nothing here removes anyone's existing
-- access. migration_79 is the one that closes routine admin read access to
-- patient health data - run it only after you have tested break-glass.
--
--   78.1 staff_roles        One role per internal person (ops | support |
--                           security_approver). Separation of duties is
--                           structural: one row per user, and a
--                           security_approver is NOT an is_admin() - they approve
--                           access and manage roles but cannot do daily operations.
--   78.2 MFA                is_aal2() + guard.settings 'mfa_required_admin'.
--                           Every break-glass and role function ALWAYS needs an
--                           authenticator-app (TOTP) session. When the setting is
--                           'on', is_admin() itself needs it, so every admin
--                           action does.
--   78.3 Break-glass        request -> a DIFFERENT person approves -> time-boxed
--                           (5-60 min) -> expires by itself -> every read
--                           logged (who, why, which section, how many rows).
--                           Reads happen ONLY through breakglass_open_patient();
--                           there is no table policy that lets an internal
--                           account read health data.
--   78.4 Analytics          analytics schema of aggregate materialized views
--                           (groups under 5 are suppressed) + a read-only role
--                           that can see nothing else.
--
-- BOOTSTRAP (run once in the SQL Editor as the project owner - see
-- SECURITY_INTERNAL.md): give yourself/your lead 'security_approver' and the
-- rest of the team 'ops' / 'support'. Until a person has a row in staff_roles
-- they have NO break-glass capability (fail closed).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 78.1 Roles
-- ----------------------------------------------------------------------------
create table if not exists public.staff_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,  -- one role per person
  role       text not null check (role in ('ops', 'support', 'security_approver')),
  granted_by uuid,
  granted_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;

create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.staff_roles where user_id = auth.uid();
$$;
revoke all on function public.staff_role() from public, anon;
grant execute on function public.staff_role() to authenticated;

drop policy if exists "staff_roles_select" on public.staff_roles;
create policy "staff_roles_select" on public.staff_roles for select
  using (user_id = auth.uid() or public.staff_role() = 'security_approver');
-- No insert/update/delete policies: roles change only through set_staff_role().

-- ----------------------------------------------------------------------------
-- 78.2 MFA
-- ----------------------------------------------------------------------------
create schema if not exists guard;
create table if not exists guard.settings (key text primary key, value text not null);
insert into guard.settings (key, value) values ('mfa_required_admin', 'off')
  on conflict (key) do nothing;

create or replace function public.is_aal2()
returns boolean
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;
grant execute on function public.is_aal2() to authenticated;

-- is_admin() keeps meaning "platform operations admin" with two changes:
--   * a security_approver is NOT an operations admin (separation of duties);
--   * when guard.settings.mfa_required_admin = 'on', it needs an MFA (aal2) session.
-- Flip the switch only after every admin has enrolled an authenticator app:
--   update guard.settings set value = 'on' where key = 'mfa_required_admin';
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(public.current_role() = 'admin', false)
    and not exists (
      select 1 from public.staff_roles s
      where s.user_id = auth.uid() and s.role = 'security_approver'
    )
    and (
      coalesce((select value from guard.settings where key = 'mfa_required_admin'), 'off') <> 'on'
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    );
$$;

-- ----------------------------------------------------------------------------
-- Audit helper for the functions below (audit_log is append-only; migration 70).
-- ----------------------------------------------------------------------------
create or replace function public.bg_audit(
  p_action text, p_member_id uuid, p_details jsonb, p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into audit_log (action, target, resource_type, resource_id, details, reason, actor_role)
  values (p_action, p_member_id::text, 'patient', p_member_id::text,
          coalesce(p_details, '{}'::jsonb), p_reason,
          coalesce('staff:' || public.staff_role(), 'system'));
end;
$$;
revoke all on function public.bg_audit(text, uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.require_mfa()
returns void
language plpgsql
stable
as $$
begin
  if not public.is_aal2() then
    raise exception 'MFA_REQUIRED: sign in with your authenticator app (second step) first.' using errcode = '42501';
  end if;
end;
$$;
grant execute on function public.require_mfa() to authenticated;

-- ----------------------------------------------------------------------------
-- 78.1b Managing roles (security_approver only, MFA, never yourself, audited)
-- ----------------------------------------------------------------------------
create or replace function public.set_staff_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  perform public.require_mfa();
  if public.staff_role() is distinct from 'security_approver' then
    raise exception 'Only a security approver can change staff roles.' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own role.' using errcode = '42501';
  end if;
  if p_role is not null and p_role not in ('ops', 'support', 'security_approver') then
    raise exception 'Unknown role.' using errcode = '22023';
  end if;
  if p_role is not null and not exists (select 1 from profiles where id = p_user_id and role = 'admin') then
    raise exception 'That account is not an internal (admin) account.' using errcode = '22023';
  end if;

  select role into v_old from staff_roles where user_id = p_user_id;
  if p_role is null then
    delete from staff_roles where user_id = p_user_id;
  else
    insert into staff_roles (user_id, role, granted_by) values (p_user_id, p_role, auth.uid())
    on conflict (user_id) do update set role = excluded.role, granted_by = auth.uid(), granted_at = now();
  end if;

  insert into audit_log (action, target, resource_type, resource_id, details, actor_role)
  values ('staff.role_change', p_user_id::text, 'staff', p_user_id::text,
          jsonb_build_object('old', v_old, 'new', p_role), 'staff:security_approver');
end;
$$;
revoke all on function public.set_staff_role(uuid, text) from public, anon;
grant execute on function public.set_staff_role(uuid, text) to authenticated;

create or replace function public.list_staff_roles()
returns table (user_id uuid, name text, phone_last4 text, role text, granted_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.user_id, p.name, right(coalesce(p.phone, ''), 4), s.role, s.granted_at
  from staff_roles s join profiles p on p.id = s.user_id
  where public.staff_role() = 'security_approver'
  order by s.granted_at;
$$;
revoke all on function public.list_staff_roles() from public, anon;
grant execute on function public.list_staff_roles() to authenticated;

-- ----------------------------------------------------------------------------
-- 78.3 Break-glass
-- ----------------------------------------------------------------------------
create table if not exists public.breakglass_requests (
  id                 uuid primary key default gen_random_uuid(),
  requester          uuid not null references auth.users (id),
  member_id          uuid not null references public.family_members (id) on delete cascade,
  reason             text not null check (length(btrim(reason)) between 20 and 1000),
  ticket_ref         text not null check (length(btrim(ticket_ref)) between 3 and 100),
  minutes            int  not null check (minutes between 5 and 60),
  status             text not null default 'pending'
                       check (status in ('pending', 'approved', 'denied', 'revoked', 'expired', 'lapsed')),
  requested_at       timestamptz not null default now(),
  pending_expires_at timestamptz not null default now() + interval '24 hours', -- unapproved requests die
  decided_by         uuid references auth.users (id),
  decided_at         timestamptz,
  decision_note      text,
  expires_at         timestamptz,                     -- set on approval: now() + minutes
  constraint breakglass_no_self_approval check (decided_by is null or decided_by <> requester)
);
create index if not exists breakglass_requests_status_idx on public.breakglass_requests (status, requested_at desc);
alter table public.breakglass_requests enable row level security;
-- No policies: read through list_breakglass_requests(); write through the functions.

create table if not exists public.breakglass_access_log (
  id         bigserial primary key,
  request_id uuid not null references public.breakglass_requests (id),
  actor      uuid not null,
  member_id  uuid not null,
  section    text not null,
  row_count  int  not null,
  at         timestamptz not null default now()
);
alter table public.breakglass_access_log enable row level security;
revoke all on public.breakglass_access_log from anon, authenticated;

-- Append-only, like audit_log (reuses migration 70's refusing trigger).
drop trigger if exists breakglass_log_no_change on public.breakglass_access_log;
create trigger breakglass_log_no_change
  before update or delete on public.breakglass_access_log
  for each row execute function public.audit_log_immutable();
drop trigger if exists breakglass_log_no_truncate on public.breakglass_access_log;
create trigger breakglass_log_no_truncate
  before truncate on public.breakglass_access_log
  for each statement execute function public.audit_log_immutable();

revoke all on public.breakglass_requests from anon, authenticated;

-- --- request ---------------------------------------------------------------
create or replace function public.request_breakglass(
  p_mrn text, p_reason text, p_ticket text, p_minutes int
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member uuid;
  v_id uuid;
begin
  perform public.require_mfa();
  if coalesce(public.staff_role(), '') not in ('ops', 'support') then
    raise exception 'Your role cannot request break-glass access.' using errcode = '42501';
  end if;
  if (select count(*) from breakglass_requests
      where requester = auth.uid() and status = 'pending' and pending_expires_at > now()) >= 3 then
    raise exception 'You already have 3 pending requests.' using errcode = '53400';
  end if;

  select id into v_member from family_members where mrn = upper(btrim(p_mrn));
  if v_member is null then
    raise exception 'No patient with that MRN.' using errcode = 'P0002';
  end if;

  insert into breakglass_requests (requester, member_id, reason, ticket_ref, minutes)
  values (auth.uid(), v_member, btrim(p_reason), btrim(p_ticket), p_minutes)
  returning id into v_id;

  perform public.bg_audit('breakglass.request', v_member,
    jsonb_build_object('request_id', v_id, 'ticket', btrim(p_ticket), 'minutes', p_minutes), btrim(p_reason));
  return v_id;
end;
$$;
revoke all on function public.request_breakglass(text, text, text, int) from public, anon;
grant execute on function public.request_breakglass(text, text, text, int) to authenticated;

-- --- approve / deny (a DIFFERENT person) --------------------------------------
create or replace function public.decide_breakglass(p_id uuid, p_approve boolean, p_note text default null)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  r breakglass_requests;
  v_until timestamptz;
begin
  perform public.require_mfa();
  if public.staff_role() is distinct from 'security_approver' then
    raise exception 'Only a security approver can decide break-glass requests.' using errcode = '42501';
  end if;
  select * into r from breakglass_requests where id = p_id for update;
  if r.id is null then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if r.requester = auth.uid() then
    raise exception 'You cannot decide your own request.' using errcode = '42501';
  end if;
  if r.status <> 'pending' or r.pending_expires_at <= now() then
    raise exception 'This request is no longer pending.' using errcode = '22023';
  end if;
  if not p_approve and length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'Say why you are denying it.' using errcode = '22023';
  end if;

  if p_approve then
    v_until := now() + make_interval(mins => r.minutes);
    update breakglass_requests
       set status = 'approved', decided_by = auth.uid(), decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), ''), expires_at = v_until
     where id = p_id;
  else
    update breakglass_requests
       set status = 'denied', decided_by = auth.uid(), decided_at = now(),
           decision_note = btrim(p_note)
     where id = p_id;
  end if;

  perform public.bg_audit(case when p_approve then 'breakglass.approve' else 'breakglass.deny' end,
    r.member_id,
    jsonb_build_object('request_id', p_id, 'requester', r.requester, 'expires_at', v_until),
    p_note);
  return v_until;
end;
$$;
revoke all on function public.decide_breakglass(uuid, boolean, text) from public, anon;
grant execute on function public.decide_breakglass(uuid, boolean, text) to authenticated;

-- --- revoke early (the approver, or the requester when done) --------------------
create or replace function public.revoke_breakglass(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r breakglass_requests;
begin
  perform public.require_mfa();
  select * into r from breakglass_requests where id = p_id for update;
  if r.id is null then
    raise exception 'Request not found.' using errcode = 'P0002';
  end if;
  if r.requester <> auth.uid() and public.staff_role() is distinct from 'security_approver' then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if r.status = 'approved' and r.expires_at > now() then
    update breakglass_requests set status = 'revoked', expires_at = now() where id = p_id;
    perform public.bg_audit('breakglass.revoke', r.member_id, jsonb_build_object('request_id', p_id));
  elsif r.status = 'pending' then
    update breakglass_requests set status = 'revoked' where id = p_id;
    perform public.bg_audit('breakglass.cancel', r.member_id, jsonb_build_object('request_id', p_id));
  end if;
end;
$$;
revoke all on function public.revoke_breakglass(uuid) from public, anon;
grant execute on function public.revoke_breakglass(uuid) to authenticated;

-- --- list (requesters see their own; approvers see all). No health data here. ----
create or replace function public.list_breakglass_requests()
returns table (
  id uuid, requester uuid, requester_name text, mrn text, reason text, ticket_ref text,
  minutes int, state text, requested_at timestamptz, decided_by uuid, decided_at timestamptz,
  decision_note text, expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.requester, coalesce(nullif(p.name, ''), 'user ' || right(coalesce(p.phone, ''), 4)),
         fm.mrn, r.reason, r.ticket_ref, r.minutes,
         case
           when r.status = 'approved' and r.expires_at <= now() then 'expired'
           when r.status = 'pending'  and r.pending_expires_at <= now() then 'lapsed'
           else r.status
         end,
         r.requested_at, r.decided_by, r.decided_at, r.decision_note, r.expires_at
  from breakglass_requests r
  join family_members fm on fm.id = r.member_id
  left join profiles p on p.id = r.requester
  where public.staff_role() is not null
    and (r.requester = auth.uid() or public.staff_role() = 'security_approver')
  order by r.requested_at desc
  limit 200;
$$;
revoke all on function public.list_breakglass_requests() from public, anon;
grant execute on function public.list_breakglass_requests() to authenticated;

create or replace function public.list_breakglass_access(p_request_id uuid)
returns table (section text, row_count int, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select l.section, l.row_count, l.at
  from breakglass_access_log l
  join breakglass_requests r on r.id = l.request_id
  where l.request_id = p_request_id
    and (r.requester = auth.uid() or public.staff_role() = 'security_approver')
  order by l.at;
$$;
revoke all on function public.list_breakglass_access(uuid) from public, anon;
grant execute on function public.list_breakglass_access(uuid) to authenticated;

-- --- THE ONLY READ PATH -------------------------------------------------------
-- Valid only for the requester, while the approval is live (status approved AND
-- expires_at in the future, checked at the moment of the call), with MFA, and
-- only while they still hold ops/support. Every call is logged twice: in
-- breakglass_access_log (what, how many rows) and in audit_log.
create or replace function public.breakglass_open_patient(p_request_id uuid, p_section text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r breakglass_requests;
  v_result jsonb;
  v_rows int;
begin
  perform public.require_mfa();
  if coalesce(public.staff_role(), '') not in ('ops', 'support') then
    raise exception 'Your role cannot read patient data.' using errcode = '42501';
  end if;
  select * into r from breakglass_requests where id = p_request_id;
  if r.id is null or r.requester <> auth.uid() then
    raise exception 'Break-glass request not found.' using errcode = 'P0002';
  end if;
  if r.status <> 'approved' or r.expires_at is null or r.expires_at <= now() then
    raise exception 'BREAKGLASS_EXPIRED: this access has not been approved or has expired.' using errcode = '42501';
  end if;

  if p_section = 'profile' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', fm.id, 'name', fm.name, 'relation', fm.relation, 'dob', fm.dob, 'gender', fm.gender,
             'phone', fm.phone, 'mrn', fm.mrn,
             'govt_id_last4', right(coalesce(public.field_decrypt(fm.govt_id), ''), 4))), '[]'::jsonb)
      into v_result from family_members fm where fm.id = r.member_id;

  elsif p_section = 'encounters' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'encounter_no', e.encounter_no, 'at', e.visit_datetime, 'type', e.visit_type,
             'department', e.department, 'reason', e.reason, 'status', e.status)
             order by e.visit_datetime desc), '[]'::jsonb)
      into v_result from encounters e where e.patient_id = r.member_id;

  elsif p_section = 'visits' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'visit_id', v.id, 'date', a.date,
             'notes', public.field_decrypt(v.notes), 'diagnosis', public.field_decrypt(v.diagnosis),
             'follow_up_date', v.follow_up_date) order by a.date desc), '[]'::jsonb)
      into v_result
      from visits v join appointments a on a.id = v.appointment_id where a.member_id = r.member_id;

  elsif p_section = 'prescriptions' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'visit_id', rx.visit_id, 'items', rx.items, 'status', rx.status, 'created_at', rx.created_at)
             order by rx.created_at desc), '[]'::jsonb)
      into v_result
      from prescriptions rx
      join visits v on v.id = rx.visit_id join appointments a on a.id = v.appointment_id
     where a.member_id = r.member_id;

  elsif p_section = 'conditions' then
    select coalesce(jsonb_agg(jsonb_build_object('condition', c.name)), '[]'::jsonb)
      into v_result
      from patient_conditions pc join conditions_ref c on c.id = pc.condition_id
     where pc.patient_id = r.member_id;

  elsif p_section = 'files' then
    -- Names and types only. File CONTENTS are not served through break-glass.
    select coalesce(jsonb_agg(jsonb_build_object('type', f.type, 'uploaded_at', f.created_at)), '[]'::jsonb)
      into v_result from files f where f.member_id = r.member_id;

  else
    raise exception 'Unknown section.' using errcode = '22023';
  end if;

  v_rows := jsonb_array_length(v_result);
  insert into breakglass_access_log (request_id, actor, member_id, section, row_count)
  values (r.id, auth.uid(), r.member_id, p_section, v_rows);
  perform public.bg_audit('breakglass.read', r.member_id,
    jsonb_build_object('request_id', r.id, 'section', p_section, 'rows', v_rows, 'access_until', r.expires_at),
    r.reason);
  return v_result;
end;
$$;
revoke all on function public.breakglass_open_patient(uuid, text) from public, anon;
grant execute on function public.breakglass_open_patient(uuid, text) to authenticated;

-- --- Tidy-up. Expiry itself is enforced by the timestamp check above on every
-- read; this only fixes the stored status and writes the audit line. -------------
create or replace function public.breakglass_expire()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    update breakglass_requests
       set status = 'expired'
     where status = 'approved' and expires_at <= now()
    returning id, member_id
  loop
    insert into audit_log (action, target, resource_type, resource_id, details, actor_role)
    values ('breakglass.expire', r.member_id::text, 'patient', r.member_id::text,
            jsonb_build_object('request_id', r.id), 'system');
  end loop;
  update breakglass_requests set status = 'lapsed'
   where status = 'pending' and pending_expires_at <= now();
end;
$$;
revoke all on function public.breakglass_expire() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('breakglass-expire', '* * * * *', 'select public.breakglass_expire()');
exception when others then
  raise notice 'pg_cron unavailable (%). Access still expires by timestamp; only the stored status is not tidied.', sqlerrm;
end $$;

-- ----------------------------------------------------------------------------
-- 78.4 De-identified analytics
-- ----------------------------------------------------------------------------
-- Materialized views, refreshed on a schedule: the analytics login never has a
-- live path to any raw table. No names, phones, MRNs, member ids or free text;
-- groups smaller than 5 are dropped (k-anonymity), so a tiny clinic-day can't
-- point at one patient.
create schema if not exists analytics;

drop materialized view if exists analytics.daily_bookings;
create materialized view analytics.daily_bookings as
select a.date, a.status, a.payment_status, count(*)::int as bookings
from public.appointments a
group by a.date, a.status, a.payment_status
having count(*) >= 5;

drop materialized view if exists analytics.clinic_monthly;
create materialized view analytics.clinic_monthly as
select a.clinic_id, date_trunc('month', a.date)::date as month, count(*)::int as bookings
from public.appointments a
group by a.clinic_id, date_trunc('month', a.date)
having count(*) >= 5;

revoke all on schema analytics from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'analytics_ro') then
    create role analytics_ro nologin;  -- enable with: alter role analytics_ro login password '...';
  end if;
end $$;
alter role analytics_ro set statement_timeout = '15s';
alter role analytics_ro set default_transaction_read_only = on;
grant usage on schema analytics to analytics_ro;
grant select on all tables in schema analytics to analytics_ro;
revoke all on schema public from analytics_ro;

create or replace function public.refresh_analytics()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view analytics.daily_bookings;
  refresh materialized view analytics.clinic_monthly;
end;
$$;
revoke all on function public.refresh_analytics() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('analytics-refresh', '15 * * * *', 'select public.refresh_analytics()');
exception when others then
  raise notice 'pg_cron unavailable (%). Run select public.refresh_analytics() manually.', sqlerrm;
end $$;
