-- ============================================================================
-- 86. RESCHEDULE AN APPOINTMENT (move it, don't cancel and rebook)
-- ============================================================================
-- Until now "Reschedule" in the app cancelled the booking (refunding an online
-- payment and releasing its coupon) and sent the patient off to book again.
-- reschedule_appointment() moves the SAME booking to a new date/time instead,
-- so its booking ID, payment, coupon, encounter and reason all stay with it.
-- The new time has to pass the same rules as a new booking.
--
-- Also closes a gap: nothing stopped a patient's app from rewriting an
-- appointment's date/slot directly (skipping slot capacity and the booking
-- rules). Patients now have to go through reschedule_appointment(); clinic
-- staff (e.g. the full-day reschedule) are unaffected.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 86.1 The doctor's real slot times on a day - the same maths as
--      computeSlots() in src/lib/time.ts, so "a time from the list" means the
--      same thing on both sides.
-- ----------------------------------------------------------------------------
create or replace function public.doctor_slot_times(p_doctor_id uuid, p_date date)
returns table (slot_time time)
language sql
stable
security definer
set search_path = public
as $$
  select distinct s.t
  from (
    -- set by patients per hour (migration 85): every slot_minutes from the
    -- start, the last one ending by end_time
    select (da.start_time + make_interval(mins => g * da.slot_minutes))::time as t
    from doctor_availability da
    cross join lateral generate_series(
      0,
      floor(extract(epoch from (da.end_time - da.start_time)) / 60 / da.slot_minutes)::int - 1
    ) g
    where da.doctor_id = p_doctor_id
      and da.weekday = extract(dow from p_date)::int
      and da.slot_minutes is not null and da.slot_minutes > 0
      and da.end_time > da.start_time
    union all
    -- older windows: max_patients_per_day evenly spaced starts, to the minute
    select (
      da.start_time
      + make_interval(mins => round(g * (extract(epoch from (da.end_time - da.start_time)) / 60.0) / da.max_patients_per_day)::int)
    )::time
    from doctor_availability da
    cross join lateral generate_series(0, da.max_patients_per_day - 1) g
    where da.doctor_id = p_doctor_id
      and da.weekday = extract(dow from p_date)::int
      and da.slot_minutes is null
      and da.max_patients_per_day > 0
      and da.end_time > da.start_time
  ) s;
$$;

-- ----------------------------------------------------------------------------
-- 86.2 Move a booking
-- ----------------------------------------------------------------------------
create or replace function public.reschedule_appointment(p_appointment_id uuid, p_date date, p_slot_time time)
returns table (appointment_id uuid, new_date date, new_slot_time time)
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  c clinics;
  w waitlist;
  v_by_clinic boolean;
  v_now_local timestamp;
  v_today date;
  v_window_hours int;
  v_cutoff int;
  v_capacity int;
  v_booked int;
  v_taken int;
begin
  select * into a from appointments where id = p_appointment_id for update;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;

  v_by_clinic := public.is_admin() or public.is_own_clinic(a.clinic_id);
  if not (v_by_clinic or public.is_own_mrn(a.member_id)) then
    raise exception 'This is not your appointment.';
  end if;
  if a.status not in ('booked', 'accepted') then
    raise exception 'Only an upcoming appointment that has not been checked in can be moved.';
  end if;
  if p_date is null or p_slot_time is null then
    raise exception 'Pick a new date and time.';
  end if;
  if p_date = a.date and p_slot_time = a.slot_time then
    raise exception 'That is already your appointment time - pick a different one.';
  end if;

  select * into c from clinics where id = a.clinic_id;
  v_now_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_today := v_now_local::date;

  -- A patient can move a booking up to the clinic's window before it (shorter
  -- for a booking paid online - a convenience, never queue priority).
  if not v_by_clinic then
    v_window_hours := case
      when a.payment_status = 'paid_online' then coalesce(c.reschedule_window_hours_paid_online, 1)
      else coalesce(c.reschedule_window_hours, 2)
    end;
    if (a.date + a.slot_time) - make_interval(hours => v_window_hours) <= v_now_local then
      raise exception 'TOO_LATE_TO_RESCHEDULE: it is too close to your appointment to move it online (within % hour%). Please contact the clinic.',
        v_window_hours, case when v_window_hours = 1 then '' else 's' end;
    end if;
  end if;

  -- The new time: from today on, the clinic open, and a real slot of this doctor.
  if p_date < v_today then
    raise exception 'Pick a date from today onwards.';
  end if;
  if exists (select 1 from clinic_holidays h where h.clinic_id = a.clinic_id and h.date = p_date) then
    raise exception 'CLINIC_CLOSED: the clinic is closed on %. Pick another day.', to_char(p_date, 'DD Mon YYYY');
  end if;
  if not exists (select 1 from public.doctor_slot_times(a.doctor_id, p_date) s where s.slot_time = p_slot_time) then
    raise exception 'NOT_A_SLOT: the doctor has no % slot on %. Pick a time from the list.',
      to_char(p_slot_time, 'HH12:MI AM'), to_char(p_date, 'DD Mon YYYY');
  end if;

  -- The same booking rules as a new booking (enforce_booking_policy).
  if c.mode = 'appointment_only' then
    if p_date = v_today and not c.same_day_booking_enabled then
      raise exception 'This clinic takes advance bookings only - the earliest you can move to is %.',
        to_char(v_today + 1, 'DD Mon YYYY');
    end if;
    if p_date > v_today + c.booking_horizon_days then
      raise exception 'This clinic takes bookings up to % day(s) ahead - the latest you can move to is %.',
        c.booking_horizon_days, to_char(v_today + c.booking_horizon_days, 'DD Mon YYYY');
    end if;
  end if;
  if p_date = v_today then
    v_cutoff := case
      when c.mode = 'appointment_only' and c.same_day_booking_enabled then c.same_day_cutoff_minutes
      else c.past_slot_buffer_minutes
    end;
    if (p_date + p_slot_time) < v_now_local + make_interval(mins => coalesce(v_cutoff, 10)) then
      raise exception 'SAME_DAY_CUTOFF: the % slot has already passed or is too soon - pick a later time.',
        to_char(p_slot_time, 'HH12:MI AM');
    end if;
  end if;

  -- A seat in the new slot - lock first, then count (as enforce_slot_capacity).
  insert into doctor_slot_locks (doctor_id, date, slot_time)
  values (a.doctor_id, p_date, p_slot_time)
  on conflict (doctor_id, date, slot_time) do update set updated_at = now();
  v_capacity := public.slot_capacity_for(a.doctor_id, p_date, p_slot_time);
  select count(*) into v_booked
  from appointments
  where doctor_id = a.doctor_id and date = p_date and slot_time = p_slot_time
    and status not in ('cancelled', 'rejected') and id <> a.id;
  if v_booked >= v_capacity then
    raise exception 'SLOT_FULL: % on % is full - pick another time.',
      to_char(p_slot_time, 'HH12:MI AM'), to_char(p_date, 'DD Mon YYYY');
  end if;

  -- The clinic's daily cap, when moving to another day (appointment_only).
  if c.mode = 'appointment_only' and p_date <> a.date then
    insert into clinic_day_locks (clinic_id, date)
    values (a.clinic_id, p_date)
    on conflict (clinic_id, date) do update set updated_at = now();
    select count(*) into v_taken
    from appointments
    where clinic_id = a.clinic_id and date = p_date and status not in ('cancelled', 'rejected') and id <> a.id;
    if v_taken >= c.daily_cap then
      raise exception 'FULL_DAY: % is fully booked - pick another day.', to_char(p_date, 'DD Mon YYYY');
    end if;
  end if;

  -- Move it. The patient's own booking rules (one active booking per doctor,
  -- 4 hours apart from other doctors) are re-checked by their update trigger.
  -- The published running order and reminders belonged to the old slot.
  perform set_config('app.reschedule', 'on', true);
  update appointments
  set date = p_date,
      slot_time = p_slot_time,
      sequence_no = null,
      estimated_time = null,
      schedule_published_at = null,
      day_order_override = null,
      reminder_count = 0
  where id = a.id;
  perform set_config('app.reschedule', 'off', true);

  update encounters set visit_datetime = (p_date + p_slot_time)::timestamptz where id = a.encounter_id;

  perform public.record_audit(
    'appointment.rescheduled', a.clinic_id, 'appointment', a.id::text,
    jsonb_build_object(
      'from', to_char(a.date, 'YYYY-MM-DD') || ' ' || to_char(a.slot_time, 'HH24:MI'),
      'to', to_char(p_date, 'YYYY-MM-DD') || ' ' || to_char(p_slot_time, 'HH24:MI'),
      'by', case when v_by_clinic then 'clinic' else 'patient' end
    )
  );

  -- Moving off a full day frees a seat there: offer it to the waitlist, as a
  -- cancellation would (notify_waitlist_on_free_seat).
  if c.mode = 'appointment_only' and p_date <> a.date then
    select * into w
    from waitlist
    where clinic_id = a.clinic_id and date = a.date and status = 'waiting'
    order by created_at
    limit 1;
    if w.id is not null then
      update waitlist set status = 'offered', offered_at = now() where id = w.id;
      insert into notifications (user_id, type, message)
      select f.account_id, 'waitlist_seat',
             'A seat has opened up at ' || c.name || ' on ' || to_char(a.date, 'DD Mon YYYY')
               || '. Book now - it is first come, first served.'
      from family_members f
      where f.id = w.member_id;
    end if;
  end if;

  return query select a.id, p_date, p_slot_time;
end;
$$;

revoke all on function public.reschedule_appointment(uuid, date, time) from public, anon;
grant execute on function public.reschedule_appointment(uuid, date, time) to authenticated;

-- ----------------------------------------------------------------------------
-- 86.3 Patients move bookings only through reschedule_appointment()
-- ----------------------------------------------------------------------------
create or replace function public.guard_appointment_time_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.date, new.slot_time) is not distinct from (old.date, old.slot_time) then
    return new;
  end if;
  if coalesce(current_setting('app.reschedule', true), '') = 'on' then
    return new; -- inside reschedule_appointment()
  end if;
  if auth.uid() is null or public.is_admin() or public.is_own_clinic(old.clinic_id) then
    return new; -- server jobs, admins and clinic staff (e.g. full-day reschedule)
  end if;
  raise exception 'To move an appointment, use Reschedule.';
end;
$$;

drop trigger if exists on_appointment_guard_time_change on appointments;
create trigger on_appointment_guard_time_change
  before update of date, slot_time on appointments
  for each row execute function public.guard_appointment_time_change();
