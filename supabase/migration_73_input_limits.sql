-- ============================================================================
-- 73. SERVER-SIDE INPUT LIMITS (a backstop behind the app's own form checks)
-- ============================================================================
-- The app talks to the database through PostgREST, which already (a) binds
-- every value as a parameter - there is no string-built SQL anywhere - and (b)
-- rejects an unknown column in an insert/update with a 400, so "unexpected
-- fields" never reach a table. Column types and the existing check
-- constraints cover type and format. What nothing capped was LENGTH: a
-- direct API call could store a multi-megabyte string in any text column.
--
-- This trigger, on the tables patients, doctors and clinics write directly:
--   * rejects any text value over 5000 characters (name: 150, phone: 20),
--   * rejects control characters (everything below space except tab, LF, CR),
--   * on UPDATE only checks columns that actually changed, so a row that
--     already holds an older, longer value is never blocked from an
--     unrelated edit.
-- It does not touch jsonb / array columns, and not visits.notes/diagnosis
-- (stored as ciphertext, migration 72).
-- ============================================================================

create or replace function public.enforce_text_limits()
returns trigger
language plpgsql
as $$
declare
  r record;
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_text text;
  v_max int;
begin
  for r in select key, value from jsonb_each(v_new) loop
    if jsonb_typeof(r.value) <> 'string' then
      continue;
    end if;
    if tg_op = 'UPDATE' and v_old -> r.key is not distinct from r.value then
      continue; -- unchanged
    end if;
    v_text := r.value #>> '{}';
    v_max := case r.key when 'name' then 150 when 'phone' then 20 else 5000 end;
    if length(v_text) > v_max then
      raise exception 'INPUT_TOO_LONG: "%" is longer than % characters.', r.key, v_max
        using errcode = '22001';
    end if;
    if v_text ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
      raise exception 'INPUT_INVALID: "%" contains characters that are not allowed.', r.key
        using errcode = '22021';
    end if;
  end loop;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'family_members', 'appointments', 'clinics', 'doctors', 'documents', 'waitlist'] loop
    execute format('drop trigger if exists zz_text_limits on public.%I', t);
    execute format(
      'create trigger zz_text_limits before insert or update on public.%I
         for each row execute function public.enforce_text_limits()', t);
  end loop;
end;
$$;
