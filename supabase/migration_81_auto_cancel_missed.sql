-- ============================================================================
-- 81. AUTOMATIC CANCELLATION OF APPOINTMENTS NOBODY ATTENDED
-- ============================================================================
-- Two kinds of appointment can be left behind once their day has passed:
--
--   * 'booked'   - the patient asked, but the clinic never confirmed it. Nothing
--                  was ever promised, so it is CANCELLED. The existing status
--                  trigger marks an online payment as refunded, as it does for
--                  any cancellation.
--   * 'accepted' - confirmed, but the patient never arrived. This is what the
--                  clinic already calls a NO-SHOW (auto_mark_no_shows, migration
--                  29): the slot was held for them, so any payment is kept. The
--                  patient now sees it as "Cancelled - you did not arrive".
--
-- Migration 29 meant to run its sweep every 10 minutes with pg_cron, but that job
-- was never created in this project (only the clinic console triggered it, and
-- only when someone opened it). This creates the job, adds the unconfirmed
-- case, and tells the patient about each one with a notification.
--
-- Safe to run more than once. Switch it off with:
--     select cron.unschedule('sanjeevni_missed_sweep');
-- ============================================================================

create or replace function public.sweep_missed_appointments()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cancelled int := 0;
  v_missed    int := 0;
begin
  -- 1. Never confirmed, and the slot has now gone by -> cancelled.
  with due as (
    select a.id, fm.account_id, a.date, a.slot_time
    from appointments a
    join clinics c on c.id = a.clinic_id
    join family_members fm on fm.id = a.member_id
    where a.status = 'booked'
      and (a.date + a.slot_time) < (now() at time zone coalesce(c.timezone, 'Asia/Kolkata'))
  ), moved as (
    update appointments a set status = 'cancelled'
    from due where a.id = due.id
    returning a.id, due.account_id, due.date, due.slot_time
  ), told as (
    insert into notifications (user_id, type, message)
    select account_id, 'appointment_auto_cancelled',
           'Your appointment on ' || to_char(date, 'DD Mon YYYY') || ' at ' || to_char(slot_time, 'HH12:MI AM')
           || ' was cancelled because the clinic did not confirm it in time. Any online payment is refunded.'
    from moved
    returning 1
  )
  select count(*) into v_cancelled from moved;

  -- 2. Confirmed but never arrived -> no-show (existing rule), then tell them.
  with before as (
    select id from appointments where status = 'accepted'
  )
  select public.auto_mark_no_shows() into v_missed;

  insert into notifications (user_id, type, message)
  select fm.account_id, 'appointment_missed',
         'Your appointment on ' || to_char(a.date, 'DD Mon YYYY') || ' at ' || to_char(a.slot_time, 'HH12:MI AM')
         || ' was cancelled because you did not arrive. Please book again if you still need a visit.'
  from appointments a
  join family_members fm on fm.id = a.member_id
  where a.status = 'no_show'
    and a.no_show_auto
    and a.no_show_marked_at >= now() - interval '1 minute';

  return jsonb_build_object('cancelled_unconfirmed', v_cancelled, 'marked_no_show', v_missed);
end;
$$;

revoke all on function public.sweep_missed_appointments() from public, anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  begin
    perform cron.unschedule('sanjeevni_missed_sweep');
  exception when others then
    null; -- nothing to unschedule yet
  end;
  perform cron.schedule('sanjeevni_missed_sweep', '*/10 * * * *', 'select public.sweep_missed_appointments()');
exception when others then
  raise notice 'pg_cron unavailable (%). The clinic console still sweeps no-shows when it loads.', sqlerrm;
end $$;
