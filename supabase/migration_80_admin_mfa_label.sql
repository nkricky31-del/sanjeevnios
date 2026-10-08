-- ============================================================================
-- 80. LET PHONE-ONLY ADMINS ENROL AN AUTHENTICATOR APP
-- ============================================================================
-- Supabase Auth labels a TOTP secret with the user's EMAIL. This project signs in
-- by phone number only, so no account has an email, and enrolling an authenticator
-- fails with "Error generating QR Code" - which locks an admin out of the console
-- now that the console requires the two-step screen (AdminMfaGate).
--
-- Fix: give every admin account a PLACEHOLDER email on the reserved ".invalid"
-- domain. It is never deliverable (RFC 2606), so it cannot receive a sign-in link
-- or password reset and creates no new way in; it only gives the authenticator app
-- a label. A trigger does the same for any account that later becomes an admin.
-- ============================================================================

create or replace function public.ensure_admin_mfa_label()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.role = 'admin' then
    update auth.users u
       set email = 'staff-' || replace(u.id::text, '-', '') || '@admin.sanjeevnios.invalid',
           email_confirmed_at = coalesce(u.email_confirmed_at, now())
     where u.id = new.id and (u.email is null or u.email = '');
  end if;
  return new;
end;
$$;
revoke all on function public.ensure_admin_mfa_label() from public, anon, authenticated;

drop trigger if exists trg_admin_mfa_label on public.profiles;
create trigger trg_admin_mfa_label
  after insert or update of role on public.profiles
  for each row when (new.role = 'admin')
  execute function public.ensure_admin_mfa_label();

-- Backfill the admins that already exist.
update auth.users u
   set email = 'staff-' || replace(u.id::text, '-', '') || '@admin.sanjeevnios.invalid',
       email_confirmed_at = coalesce(u.email_confirmed_at, now())
  from public.profiles p
 where p.id = u.id and p.role = 'admin' and (u.email is null or u.email = '');
