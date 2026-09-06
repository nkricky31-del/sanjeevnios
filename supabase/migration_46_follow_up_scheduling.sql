-- ============================================================================
-- 46. FOLLOW-UP SCHEDULING
-- ============================================================================
-- Extends the visit/consultation flow (section 10) and the two-step booking
-- flow (sections 27, 39) with a structured follow-up, replacing the old
-- free-text visits.follow_up_date with something the app can actually act on:
--
--   * The clinic sets visits.follow_up_interval (none/7/15/30 days) when
--     completing a visit - VisitScreen.tsx's "Notes & diagnosis" card.
--     visits.follow_up_due_date is derived from it SERVER-SIDE (this visit's
--     own appointment date + the interval), never trusted from the client -
--     the same reasoning create_payment_with_coupon() already applies to
--     money now also applies to this date.
--   * appointments.follow_up_of links a follow-up booking back to the
--     ORIGINAL VISIT (not the original appointment), so a doctor opening
--     either appointment can trace the whole thread, and so
--     create_payment_with_coupon() below has everything it needs (the
--     original doctor + the due date) to decide whether this booking is free.
--   * FREE RE-CONSULT WINDOW: a follow-up appointment is free (payment_status
--     'free_followup', nothing held, no Razorpay order ever created) exactly
--     when it is booked with the SAME doctor, on or before the original
--     visit's follow_up_due_date. Booked later, or with a different doctor,
--     it is priced exactly like any other appointment - create_payment_with_
--     coupon() re-derives this itself from follow_up_of, never from anything
--     the client claims, exactly like it already re-derives the gross fee
--     from doctors.consultation_fee rather than trusting the client's figure.
--   * A day-before reminder (sweep_follow_up_reminders(), best-effort pg_cron
--     + a fallback sweep on MyBookings.tsx load, mirroring section 29.4's
--     no-show sweep) nudges a patient who has a due date tomorrow and hasn't
--     booked the follow-up yet - deduped the same way the three lifecycle
--     notices already are (migration 39), reusing appointment_id + type
--     rather than adding a new notifications column, since one visit has
--     exactly one appointment. Reusing appointment_id also means
--     NotificationsList.tsx's existing "tap a notice, jump to its
--     appointment" already lands the patient on exactly the completed visit
--     that carries the "Book follow-up" button - no new navigation needed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 46.1 visits.follow_up_interval / follow_up_due_date
-- ----------------------------------------------------------------------------
alter table visits add column if not exists follow_up_interval text not null default 'none';
alter table visits drop constraint if exists visits_follow_up_interval_check;
alter table visits add constraint visits_follow_up_interval_check
  check (follow_up_interval in ('none', '7', '15', '30'));

alter table visits add column if not exists follow_up_due_date date;

-- Derived from the VISIT'S OWN appointment date, never from the client - a
-- doctor changing the interval always recomputes off the real visit date,
-- even if the row is edited long after the appointment happened.
create or replace function public.set_visit_follow_up_due_date()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit_date date;
begin
  if new.follow_up_interval = 'none' then
    new.follow_up_due_date := null;
    return new;
  end if;

  select date into v_visit_date from appointments where id = new.appointment_id;
  new.follow_up_due_date := v_visit_date + (new.follow_up_interval || ' days')::interval;
  return new;
end;
$$;

drop trigger if exists on_visit_follow_up_due_date on visits;
create trigger on_visit_follow_up_due_date
  before insert or update on visits
  for each row execute function public.set_visit_follow_up_due_date();

-- ----------------------------------------------------------------------------
-- 46.2 appointments.follow_up_of - links a follow-up booking to the ORIGINAL
-- visit, and the new free-followup payment state.
-- ----------------------------------------------------------------------------
alter table appointments add column if not exists follow_up_of uuid references visits (id) on delete set null;
create index if not exists appointments_follow_up_of_idx on appointments (follow_up_of);

alter table appointments drop constraint if exists appointments_payment_status_check;
alter table appointments add constraint appointments_payment_status_check
  check (payment_status in ('pay_at_clinic', 'paid_online', 'paid_at_clinic', 'refunded', 'free_followup'));

-- ----------------------------------------------------------------------------
-- 46.3 create_payment_with_coupon() - re-derives free-followup eligibility
-- from follow_up_of, exactly like it already re-derives the gross fee from
-- the doctor's real consultation_fee. A client can set follow_up_of to
-- anything at booking time (appointments_insert already allows any column on
-- an own booking) - the worst that buys anyone is "not actually eligible",
-- never a wrong charge, because eligibility is re-checked here from the
-- ORIGINAL appointment's real doctor_id and the visit's own due date, not
-- from anything claimed earlier by the client.
--
-- Return shape gains is_free - drop first since CREATE OR REPLACE can't
-- change a function's return type.
-- ----------------------------------------------------------------------------
drop function if exists public.create_payment_with_coupon(uuid, text, uuid);

create or replace function public.create_payment_with_coupon(
  p_appointment_id uuid,
  p_method text,
  p_redemption_id uuid default null
)
returns table (payment_id uuid, gross_amount numeric, discount_amount numeric, net_amount numeric, is_free boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  v_fee numeric;
  v_convenience numeric;
  v_gross numeric;
  v_discount numeric := 0;
  v_net numeric;
  v_redemption coupon_redemptions;
  v_coupon coupons;
  v_funded_by text;
  v_coupon_code text;
  v_payment_id uuid;
  v_is_free boolean := false;
  v_orig_doctor uuid;
  v_due_date date;
  v_payment_status text;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  if not (public.is_admin() or public.is_own_member(a.member_id) or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your booking.';
  end if;
  if exists (select 1 from payments where appointment_id = p_appointment_id) then
    raise exception 'A payment already exists for this appointment.';
  end if;
  if p_method not in ('online', 'cod') then
    raise exception 'Invalid payment method.';
  end if;

  if a.follow_up_of is not null then
    select ap.doctor_id, v.follow_up_due_date into v_orig_doctor, v_due_date
    from visits v join appointments ap on ap.id = v.appointment_id
    where v.id = a.follow_up_of;

    if v_orig_doctor is not null and v_orig_doctor = a.doctor_id
       and v_due_date is not null and a.date <= v_due_date then
      v_is_free := true;
    end if;
  end if;

  select consultation_fee into v_fee from doctors where id = a.doctor_id;

  if v_is_free then
    -- Nothing held, nothing collected, no convenience fee (no gateway is
    -- ever involved) - gross/discount are recorded purely so the ledger
    -- shows what was waived, never so anything is actually charged.
    v_gross := v_fee;
    v_convenience := 0;
    v_discount := v_fee;
    v_net := 0;
    v_payment_status := 'waived';
  else
    v_convenience := case when p_method = 'online' then 10 else 0 end;
    v_gross := v_fee + v_convenience;
    v_payment_status := case when p_method = 'online' then 'hold' else 'pending' end;

    if p_redemption_id is not null then
      select * into v_redemption from coupon_redemptions where id = p_redemption_id;
      if v_redemption.id is null or v_redemption.patient_id <> auth.uid() or v_redemption.status <> 'reserved' then
        raise exception 'This coupon is no longer applied - please re-apply it.';
      end if;
      if v_redemption.reserved_at < now() - interval '15 minutes' then
        raise exception 'Your coupon reservation expired - please re-apply it.';
      end if;

      select * into v_coupon from coupons where id = v_redemption.coupon_id;
      if not v_coupon.active or (v_coupon.valid_to is not null and v_coupon.valid_to < now()) then
        raise exception 'This coupon is no longer valid.';
      end if;
      if v_gross < v_coupon.min_amount then
        raise exception 'This coupon needs a minimum order of Rs.%.', v_coupon.min_amount;
      end if;

      v_discount := case v_coupon.type
        when 'flat' then v_coupon.value
        else round(v_gross * v_coupon.value / 100.0)
      end;
      if v_coupon.type = 'percent' and v_coupon.max_discount is not null then
        v_discount := least(v_discount, v_coupon.max_discount);
      end if;
      v_discount := least(v_discount, v_gross - 1);
      v_coupon_code := v_coupon.code;
      v_funded_by := v_coupon.funded_by;

      update coupon_redemptions
      set appointment_id = p_appointment_id, discount_amount = v_discount
      where id = p_redemption_id;
    end if;

    v_net := v_gross - v_discount;
  end if;

  insert into payments (appointment_id, amount, method, status, gross_amount, coupon_code, discount_amount, net_amount, funded_by)
  values (
    p_appointment_id,
    v_net,
    p_method,
    v_payment_status,
    v_gross,
    v_coupon_code,
    v_discount,
    v_net,
    v_funded_by
  )
  returning id into v_payment_id;

  if v_is_free then
    update appointments set payment_status = 'free_followup' where id = p_appointment_id;
  end if;

  return query select v_payment_id, v_gross, v_discount, v_net, v_is_free;
end;
$$;

-- ----------------------------------------------------------------------------
-- 46.4 sweep_follow_up_reminders() - "remind the patient a day before, if
-- they haven't booked yet." Reuses the lifecycle notices' own dedup pattern
-- (migration 39): one partial unique index, one security-definer sweep that
-- can run as often as it likes without ever double-sending.
-- ----------------------------------------------------------------------------
create unique index if not exists notifications_follow_up_reminder_dedup_idx
  on notifications (appointment_id, type)
  where appointment_id is not null and type = 'follow_up_reminder';

create or replace function public.sweep_follow_up_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  with due as (
    select v.id as visit_id, a.id as appointment_id, fm.account_id, v.follow_up_due_date, d.name as doctor_name
    from visits v
    join appointments a on a.id = v.appointment_id
    join family_members fm on fm.id = a.member_id
    join doctors d on d.id = a.doctor_id
    where v.follow_up_due_date = current_date + 1
      and fm.account_id is not null
      and not exists (
        select 1 from appointments fu
        where fu.follow_up_of = v.id and fu.status not in ('cancelled', 'rejected')
      )
  )
  insert into notifications (user_id, appointment_id, type, message)
  select
    due.account_id,
    due.appointment_id,
    'follow_up_reminder',
    format('Your follow-up with %s was recommended for %s — book your slot before it passes.', due.doctor_name, to_char(due.follow_up_due_date, 'DD Mon'))
  from due
  on conflict (appointment_id, type) where appointment_id is not null and type = 'follow_up_reminder' do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Best-effort scheduling, exactly mirroring section 29.4's no-show sweep -
-- pg_cron may not be available/enabled on every project, and MyBookings.tsx
-- also calls this once when it loads, so the reminder still goes out either
-- way.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.unschedule('sanjeevni_follow_up_reminders');
    exception when others then
      null; -- no existing job to unschedule, or no permission - fall through
    end;
    begin
      perform cron.schedule('sanjeevni_follow_up_reminders', '0 9 * * *',
        $cron$select public.sweep_follow_up_reminders()$cron$);
    exception when others then
      raise notice 'pg_cron present but scheduling failed; the app will sweep on load instead.';
    end;
  else
    raise notice 'pg_cron unavailable; the app sweeps follow-up reminders when a patient loads My Appointments.';
  end if;
end $$;
