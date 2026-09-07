-- ============================================================================
-- 61. DOCTOR AND CLINIC RATINGS - a trust signal for patients
-- ============================================================================
-- One row per COMPLETED appointment a patient chooses to rate - 1 to 5
-- stars, optional comment, identity hidden unless the patient opts in.
-- Eligibility ("only a patient who actually had a completed encounter with
-- that doctor, only once per visit") is enforced in TWO places that have to
-- agree, same defense-in-depth shape register_clinic() already uses:
--   1. reviews_insert's own WITH CHECK (the real, unbypassable gate - a
--      direct REST/RPC call from outside this app hits this exactly the
--      same way the UI does).
--   2. submit_review() - runs as the CALLER (not security definer), so it's
--      just a friendlier front door: same checks, but with an actual
--      exception message ("You can only rate a visit after it's completed")
--      instead of a bare RLS-violation error.
--
-- "Encounter" (schema.sql section 18) turned out NOT to be the right key to
-- review against: encounters.status is never updated anywhere in this
-- schema (it's a static snapshot written at BOOKING time, before the visit
-- happens - see create_encounter_for_appointment()). appointments.status is
-- what actually tracks the visit through to 'completed', so reviews key off
-- appointment_id directly (unique per row - "only once per visit").
--
-- Aggregates (avg rating, count, percent positive) only ever count
-- status = 'visible' rows - the moment an admin hides one, it stops
-- affecting the public score immediately, not just the review list.
-- percent_positive is computed here regardless of count; "hide it under 5
-- ratings" is a DISPLAY rule, left to the client (RatingBadge.tsx) so the
-- threshold can change without a migration.
-- ============================================================================

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id) on delete cascade,
  clinic_id uuid not null references clinics (id) on delete cascade,
  doctor_id uuid not null references doctors (id) on delete cascade,
  account_id uuid not null references profiles (id) on delete cascade,
  -- Denormalized from profiles.name AT SUBMISSION TIME, shown only when
  -- anonymous = false. This is deliberate, not a shortcut: profiles_select
  -- (schema.sql section 4) already restricts a profiles row to its own
  -- owner or an admin, so a plain `profiles(name)` join from another
  -- patient's session would return null regardless of this review's own
  -- anonymous flag - that's the right behavior for "hidden by default", but
  -- it would also make "opt in to show identity" impossible to honor for
  -- anyone OTHER than the reviewer themselves. Copying the name onto the
  -- review row (readable by anyone once status = 'visible', same as the
  -- rating itself) is what actually lets an opt-in choice reach other
  -- patients reading this review.
  reviewer_name text,
  rating int not null check (rating between 1 and 5),
  comment text,
  anonymous boolean not null default true,
  status text not null default 'visible' check (status in ('visible', 'hidden')),
  hidden_reason text,
  hidden_by uuid references profiles (id),
  hidden_at timestamptz,
  created_at timestamptz not null default now()
);

-- "Only once per visit" - the hard version, not just a UI disabled state.
alter table reviews add constraint reviews_appointment_id_unique unique (appointment_id);

create index if not exists reviews_doctor_id_idx on reviews (doctor_id) where status = 'visible';
create index if not exists reviews_clinic_id_idx on reviews (clinic_id) where status = 'visible';

alter table reviews enable row level security;

-- A visible review is a public trust signal (same reasoning as
-- clinics_select's "approved & active clinics" branch) - readable by any
-- signed-in user, not just admins/the clinic itself. A HIDDEN one is only
-- visible to the reviewer (so they still see their own review, and why it
-- was hidden), the clinic it's about (transparency into what's been
-- moderated off their own profile), and admins.
drop policy if exists "reviews_select" on reviews;
create policy "reviews_select" on reviews for select
  using (
    status = 'visible'
    or account_id = auth.uid()
    or public.is_admin()
    or public.is_own_clinic(clinic_id)
  );

drop policy if exists "reviews_insert" on reviews;
create policy "reviews_insert" on reviews for insert
  with check (
    account_id = auth.uid()
    and exists (
      select 1 from appointments a
      join family_members fm on fm.id = a.member_id
      where a.id = reviews.appointment_id
        and fm.account_id = auth.uid()
        and a.status = 'completed'
        and a.doctor_id = reviews.doctor_id
        and a.clinic_id = reviews.clinic_id
    )
  );
-- No update/delete policy for anyone - moderation only ever happens through
-- moderate_review()/delete_review() below (admin-only, SECURITY DEFINER). A
-- patient can't edit or delete their own review once posted (keeps the
-- "genuine, one per visit" guarantee from quietly eroding into "whichever
-- version they left it at last").

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
    (select name from profiles where id = auth.uid()),
    p_rating,
    nullif(trim(coalesce(p_comment, '')), ''),
    p_anonymous
  )
  returning * into result;

  return result;
end;
$$;

-- ----------------------------------------------------------------------------
-- Admin moderation - hide (reversible, keeps the row for audit) or delete
-- (permanent). Both admin-only, both SECURITY DEFINER since there's no
-- update/delete RLS policy for these to run under otherwise.
-- ----------------------------------------------------------------------------

create or replace function public.moderate_review(p_review_id uuid, p_action text, p_reason text default null)
returns reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  result reviews;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can moderate a review.';
  end if;
  if p_action not in ('hide', 'unhide') then
    raise exception 'Action must be either hide or unhide.';
  end if;
  if p_action = 'hide' and trim(coalesce(p_reason, '')) = '' then
    raise exception 'A reason is required to hide a review.';
  end if;

  update reviews
  set status = case when p_action = 'hide' then 'hidden' else 'visible' end,
      hidden_reason = case when p_action = 'hide' then trim(p_reason) else null end,
      hidden_by = case when p_action = 'hide' then auth.uid() else null end,
      hidden_at = case when p_action = 'hide' then now() else null end
  where id = p_review_id
  returning * into result;

  if result.id is null then
    raise exception 'Review not found.';
  end if;

  return result;
end;
$$;

create or replace function public.delete_review(p_review_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete a review.';
  end if;
  delete from reviews where id = p_review_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- Single-profile lookups (DoctorPage.tsx - one doctor at a time, so an RPC
-- per page view is fine, unlike the list below).
-- ----------------------------------------------------------------------------

create or replace function public.get_doctor_rating(p_doctor_id uuid)
returns table (avg_rating numeric, review_count int, percent_positive int)
language sql
stable
as $$
  select
    round(avg(rating)::numeric, 1),
    count(*)::int,
    round(100.0 * count(*) filter (where rating >= 4) / nullif(count(*), 0))::int
  from reviews
  where doctor_id = p_doctor_id and status = 'visible';
$$;

create or replace function public.get_clinic_rating(p_clinic_id uuid)
returns table (avg_rating numeric, review_count int, percent_positive int)
language sql
stable
as $$
  select
    round(avg(rating)::numeric, 1),
    count(*)::int,
    round(100.0 * count(*) filter (where rating >= 4) / nullif(count(*), 0))::int
  from reviews
  where clinic_id = p_clinic_id and status = 'visible';
$$;

-- ----------------------------------------------------------------------------
-- search_doctors() (schema.sql section 16) - re-declared again, same "drop
-- first, CREATE OR REPLACE can't change a return row shape" reasoning its
-- own previous re-declaration used, now also returning the doctor's rating
-- so a LIST of results doesn't need one RPC call per row.
-- ----------------------------------------------------------------------------

drop function if exists public.search_doctors(text);
create function public.search_doctors(search_term text default '')
returns table (
  doctor_id uuid,
  doctor_name text,
  specialty text,
  clinic_id uuid,
  clinic_name text,
  clinic_address text,
  clinic_lat double precision,
  clinic_lng double precision,
  doctor_verified boolean,
  clinic_verified boolean,
  doctor_avg_rating numeric,
  doctor_review_count int,
  doctor_percent_positive int
)
language sql
stable
as $$
  select
    d.id, d.name, d.specialty, c.id, c.name, c.address, c.lat, c.lng,
    public.is_currently_verified('doctor', d.id),
    public.is_currently_verified('clinic', c.id),
    dr.avg_rating, coalesce(dr.review_count, 0), dr.percent_positive
  from doctors d
  join clinics c on c.id = d.clinic_id
  left join lateral (
    select
      round(avg(r.rating)::numeric, 1) as avg_rating,
      count(*)::int as review_count,
      round(100.0 * count(*) filter (where r.rating >= 4) / nullif(count(*), 0))::int as percent_positive
    from reviews r
    where r.doctor_id = d.id and r.status = 'visible'
  ) dr on true
  where d.status = 'approved'
    and c.status = 'approved'
    and c.is_active
    and (
      search_term = ''
      or d.name ilike '%' || search_term || '%'
      or d.specialty ilike '%' || search_term || '%'
      or c.name ilike '%' || search_term || '%'
      or c.address ilike '%' || search_term || '%'
    )
  order by c.name, d.name;
$$;
