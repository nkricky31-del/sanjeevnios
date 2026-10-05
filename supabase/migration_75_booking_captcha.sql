-- ============================================================================
-- 75. BOT CHECK ON BOOKING (Cloudflare Turnstile, verified server-side)
-- ============================================================================
-- Supabase Auth verifies Turnstile itself for signup/login/OTP (dashboard
-- setting, see SECURITY_EDGE.md). Booking is a plain table insert, which
-- Supabase does not verify, so:
--   1. the browser solves Turnstile and sends the token to the edge function
--      `verify-captcha`, which checks it with Cloudflare using the SECRET key;
--   2. the function records a "pass" for that user (guard.captcha_passes);
--   3. this trigger refuses an appointment INSERT from a patient who has no
--      unexpired pass.
-- A script that skips the widget gets no pass, so it cannot book.
--
-- Clinic staff and admins (walk-ins) and server-side inserts (no auth.uid())
-- are exempt. SHIPS DISABLED so deploying this migration changes nothing until
-- the new frontend + function are live:
--   update guard.settings set value = 'on'  where key = 'captcha_booking';  -- enforce
--   update guard.settings set value = 'off' where key = 'captcha_booking';  -- kill switch
-- ============================================================================

insert into guard.settings (key, value) values ('captcha_booking', 'off')
  on conflict (key) do nothing;
insert into guard.settings (key, value) values ('captcha_pass_minutes', '30')
  on conflict (key) do nothing;

create table if not exists guard.captcha_passes (
  user_id    uuid primary key,
  expires_at timestamptz not null
);
alter table guard.captcha_passes enable row level security;  -- no policies: service role only

-- Called by the verify-captcha edge function (service role) after Cloudflare
-- confirms the token.
create or replace function public.record_captcha_pass(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = guard, pg_temp
as $$
declare
  v_minutes int := coalesce((select value::int from guard.settings where key = 'captcha_pass_minutes'), 30);
  v_until   timestamptz := now() + make_interval(mins => v_minutes);
begin
  insert into guard.captcha_passes (user_id, expires_at) values (p_user_id, v_until)
  on conflict (user_id) do update set expires_at = excluded.expires_at;
  return v_until;
end;
$$;
revoke all on function public.record_captcha_pass(uuid) from public, anon, authenticated;
grant execute on function public.record_captcha_pass(uuid) to service_role;

create or replace function public.require_captcha_pass()
returns trigger
language plpgsql
security definer
set search_path = public, guard, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if coalesce((select value from guard.settings where key = 'captcha_booking'), 'off') <> 'on' then
    return new;
  end if;
  if v_uid is null then
    return new;                              -- server-side / service role insert
  end if;
  if public.is_admin() or public.my_clinic_id() is not null then
    return new;                              -- clinic staff booking walk-ins
  end if;
  if exists (select 1 from guard.captcha_passes where user_id = v_uid and expires_at > now()) then
    return new;
  end if;
  raise exception 'CAPTCHA_REQUIRED: please complete the bot check and try again.'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_require_captcha_pass on public.appointments;
create trigger trg_require_captcha_pass
  before insert on public.appointments
  for each row execute function public.require_captcha_pass();
