-- ============================================================================
-- 66. ANONYMOUS REVIEWS STAY ANONYMOUS + ADMIN PLAN EDITOR
-- ============================================================================
-- Two independent fixes, one migration:
--
-- 66.1 Review identity leak (migration 61). submit_review() copied the
--      reviewer's name onto EVERY review, and reviews_select lets any
--      signed-in user read a visible review row - RLS is row-level, it can't
--      hide one column. So an anonymous reviewer's real name was one direct
--      API call away (`select reviewer_name from reviews`), even though
--      ReviewsList.tsx never rendered it. Now the name is only stored when the
--      patient opts in; for an anonymous review it is null on the row itself.
--      Admins still see who wrote it - AdminReviews.tsx reads the name from
--      profiles via account_id instead (profiles_select already lets an admin
--      read any profile, and nobody else can).
--
-- 66.2 Admin plan editor (migration 62). plans_write already lets an admin
--      write plans, but the doctor-count bands only work as a set: they must
--      start at 1 doctor, follow on with no gaps or overlaps, and end in one
--      unlimited tier - otherwise plan_for_doctor_count() returns nothing (a
--      gap) or an arbitrary tier (an overlap) for some clinics. Moving one
--      band edge always means changing two rows (Small's max and Group's
--      min), so admin_save_plans() takes every active plan at once, validates
--      the whole set, and writes it in one transaction.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 66.1 Only store a reviewer's name when they chose to show it
-- ----------------------------------------------------------------------------

create or replace function public.submit_review(
  p_appointment_id uuid,
  p_rating int,
  p_comment text default null,
  p_anonymous boolean default true
)
returns reviews
language plpgsql
as $$
declare
  appt appointments;
  result reviews;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to leave a review.';
  end if;
  if p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5 stars.';
  end if;

  select a.* into appt
  from appointments a
  join family_members fm on fm.id = a.member_id
  where a.id = p_appointment_id and fm.account_id = auth.uid();

  if appt.id is null then
    raise exception 'That booking was not found on your account.';
  end if;
  if appt.status <> 'completed' then
    raise exception 'You can only rate a visit after it''s completed.';
  end if;
  if exists (select 1 from reviews where appointment_id = p_appointment_id) then
    raise exception 'You''ve already reviewed this visit.';
  end if;

  insert into reviews (appointment_id, clinic_id, doctor_id, account_id, reviewer_name, rating, comment, anonymous)
  values (
    p_appointment_id,
    appt.clinic_id,
    appt.doctor_id,
    auth.uid(),
    -- Anonymous (the default): no name on the row at all, so there is
    -- nothing for another patient's query to read.
    case when coalesce(p_anonymous, true) then null else (select name from profiles where id = auth.uid()) end,
    p_rating,
    nullif(trim(coalesce(p_comment, '')), ''),
    coalesce(p_anonymous, true)
  )
  returning * into result;

  return result;
end;
$$;

-- The same rule as a hard backstop, for a row written any other way
-- (reviews_insert allows a direct insert by the reviewer themselves).
create or replace function public.strip_anonymous_reviewer_name()
returns trigger
language plpgsql
as $$
begin
  if new.anonymous then
    new.reviewer_name := null;
  end if;
  return new;
end;
$$;

drop trigger if exists on_review_strip_anonymous_name on reviews;
create trigger on_review_strip_anonymous_name
  before insert or update of anonymous, reviewer_name on reviews
  for each row
  execute function public.strip_anonymous_reviewer_name();

-- Clean up any anonymous review already posted under the old behavior.
update reviews set reviewer_name = null where anonymous and reviewer_name is not null;

-- ----------------------------------------------------------------------------
-- 66.2 admin_save_plans() - edit every active plan's price and doctor band
--      together, validated as a set
-- ----------------------------------------------------------------------------
-- p_plans: [{ "id": uuid, "monthly_price": number, "min_doctors": int,
--             "max_doctors": int | null }, ...] - one entry per ACTIVE plan.

create or replace function public.admin_save_plans(p_plans jsonb)
returns setof plans
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  prev_max int;
  seen int := 0;
  active_count int;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can edit plans.';
  end if;
  if p_plans is null or jsonb_typeof(p_plans) <> 'array' then
    raise exception 'Send the plans as a list.';
  end if;

  select count(*) into active_count from plans where active;

  for rec in
    select
      (e ->> 'id')::uuid as id,
      (e ->> 'monthly_price')::numeric as monthly_price,
      (e ->> 'min_doctors')::int as min_doctors,
      nullif(e ->> 'max_doctors', '')::int as max_doctors,
      p.name,
      p.active
    from jsonb_array_elements(p_plans) e
    left join plans p on p.id = (e ->> 'id')::uuid
    order by (e ->> 'min_doctors')::int
  loop
    seen := seen + 1;
    if rec.name is null or not rec.active then
      raise exception 'One of these plans no longer exists or has been retired - refresh and try again.';
    end if;
    if rec.monthly_price is null or rec.monthly_price < 0 then
      raise exception '%: the monthly price must be 0 or more.', rec.name;
    end if;
    if rec.min_doctors is null or rec.min_doctors < 1 then
      raise exception '%: the minimum must be at least 1 doctor.', rec.name;
    end if;
    if rec.max_doctors is not null and rec.max_doctors < rec.min_doctors then
      raise exception '%: the maximum (%) can''t be below the minimum (%).', rec.name, rec.max_doctors, rec.min_doctors;
    end if;

    if seen = 1 then
      if rec.min_doctors <> 1 then
        raise exception 'The smallest plan (%) must start at 1 doctor, otherwise a 1-doctor clinic has no plan.', rec.name;
      end if;
    elsif prev_max is null then
      raise exception 'Only the largest plan can have no maximum - % starts after an unlimited plan.', rec.name;
    elsif rec.min_doctors <> prev_max + 1 then
      raise exception '% must start at % doctors, right after the previous plan ends at % (no gaps or overlaps).',
        rec.name, prev_max + 1, prev_max;
    end if;

    prev_max := rec.max_doctors;
  end loop;

  if seen <> active_count then
    raise exception 'Send every active plan together (expected %, got %).', active_count, seen;
  end if;
  if prev_max is not null then
    raise exception 'The largest plan must have no maximum, otherwise clinics above % doctors have no plan.', prev_max;
  end if;

  update plans p
  set monthly_price = (e ->> 'monthly_price')::numeric,
      min_doctors = (e ->> 'min_doctors')::int,
      max_doctors = nullif(e ->> 'max_doctors', '')::int
  from jsonb_array_elements(p_plans) e
  where p.id = (e ->> 'id')::uuid;

  insert into audit_log (actor, action, target)
  values (auth.uid(), 'plans_updated', p_plans::text);

  return query select * from plans where active order by min_doctors;
end;
$$;

grant execute on function public.admin_save_plans(jsonb) to authenticated;
