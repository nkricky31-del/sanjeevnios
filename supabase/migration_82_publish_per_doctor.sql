-- Publish the day's schedule per doctor.
--
-- Until now compute/preview/publish_day_schedule ran over the whole clinic, so
-- every doctor's patients shared ONE running order (#1, #2, #3 ... across all
-- doctors). Each doctor has their own queue, so each doctor now gets their own
-- order, starting at the clinic's start time. An optional p_doctor_id scopes all
-- three functions to one doctor; NULL keeps the old whole-clinic behaviour.
-- Breaks may also be tied to one doctor (doctor_id null = applies to everyone).

alter table clinic_schedule_breaks add column if not exists doctor_id uuid references doctors (id) on delete cascade;

-- The old two-argument versions must go, otherwise the new optional argument
-- creates an overload and PostgREST can't tell which one a call means.
drop function if exists public.preview_day_schedule(uuid, date);
drop function if exists public.publish_day_schedule(uuid, date);
drop function if exists public.compute_day_schedule(uuid, date);

create or replace function public.compute_day_schedule(p_clinic_id uuid, p_date date, p_doctor_id uuid default null)
returns table (appointment_id uuid, seq int, estimated_time time)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c clinics;
  v_clock time;
  v_minutes int;
  v_seq int := 0;
  v_break_minutes int;
  r record;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  v_clock := c.publish_start_time;
  v_minutes := greatest(c.avg_minutes_per_patient, 1);

  for r in (
    with base as (
      select a.id,
             row_number() over (order by a.slot_time, a.created_at) as base_rank,
             a.day_order_override
      from appointments a
      where a.clinic_id = p_clinic_id
        and a.date = p_date
        and (p_doctor_id is null or a.doctor_id = p_doctor_id)
        and a.status in ('booked', 'accepted', 'checked_in', 'called', 'in_consultation')
    )
    select id
    from base
    order by coalesce(day_order_override, base_rank), base_rank
  ) loop
    v_seq := v_seq + 1;

    select coalesce(sum(b.minutes), 0) into v_break_minutes
    from clinic_schedule_breaks b
    where b.clinic_id = p_clinic_id and b.date = p_date and b.before_seq = v_seq
      and (b.doctor_id is null or p_doctor_id is null or b.doctor_id = p_doctor_id);
    v_clock := v_clock + make_interval(mins => v_break_minutes);

    appointment_id := r.id;
    seq := v_seq;
    estimated_time := v_clock;
    return next;

    v_clock := v_clock + make_interval(mins => v_minutes);
  end loop;
end;
$$;

create or replace function public.preview_day_schedule(p_clinic_id uuid, p_date date, p_doctor_id uuid default null)
returns table (
  appointment_id uuid,
  seq int,
  estimated_time time,
  member_name text,
  doctor_name text,
  slot_time time,
  status text,
  patient_type text,
  day_order_override double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select c.appointment_id, c.seq, c.estimated_time, fm.name, d.name, a.slot_time, a.status, a.patient_type,
         a.day_order_override
  from public.compute_day_schedule(p_clinic_id, p_date, p_doctor_id) c
  join appointments a on a.id = c.appointment_id
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  order by c.seq;
$$;

create or replace function public.publish_day_schedule(p_clinic_id uuid, p_date date, p_doctor_id uuid default null)
returns table (
  appointment_id uuid,
  seq int,
  estimated_time time,
  member_name text,
  encounter_no text,
  doctor_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  c clinics;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select * into c from clinics where id = p_clinic_id;
  if c.id is null then
    raise exception 'Clinic not found.';
  end if;

  if p_doctor_id is not null and not exists (select 1 from doctors where id = p_doctor_id and clinic_id = p_clinic_id) then
    raise exception 'That doctor does not belong to this clinic.';
  end if;

  update appointments a
  set sequence_no = null, estimated_time = null
  where a.clinic_id = p_clinic_id and a.date = p_date
    and (p_doctor_id is null or a.doctor_id = p_doctor_id)
    and a.sequence_no is not null
    and not exists (
      select 1 from public.compute_day_schedule(p_clinic_id, p_date, p_doctor_id) comp where comp.appointment_id = a.id
    );

  update appointments a
  set sequence_no = comp.seq,
      estimated_time = comp.estimated_time,
      schedule_published_at = v_now
  from public.compute_day_schedule(p_clinic_id, p_date, p_doctor_id) comp
  where a.id = comp.appointment_id;

  insert into notifications (user_id, appointment_id, type, message)
  select fm.account_id, a.id, 'schedule_published',
    'Your number for ' || to_char(p_date, 'DD Mon YYYY') || ' with ' || d.name || ' at ' || c.name || ' is #' || a.sequence_no
      || ', expected around ' || to_char(a.estimated_time, 'HH12:MI AM')
      || '. This is your place in the day''s order, not a check-in - you will still need to check in when you arrive.'
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  where a.clinic_id = p_clinic_id and a.date = p_date and a.schedule_published_at = v_now;

  return query
  select a.id, a.sequence_no, a.estimated_time, fm.name, e.encounter_no, d.name
  from appointments a
  join family_members fm on fm.id = a.member_id
  join doctors d on d.id = a.doctor_id
  left join encounters e on e.id = a.encounter_id
  where a.clinic_id = p_clinic_id and a.date = p_date and a.schedule_published_at = v_now
  order by a.sequence_no;
end;
$$;

grant execute on function public.compute_day_schedule(uuid, date, uuid) to authenticated;
grant execute on function public.preview_day_schedule(uuid, date, uuid) to authenticated;
grant execute on function public.publish_day_schedule(uuid, date, uuid) to authenticated;
