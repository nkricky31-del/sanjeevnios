-- Family member rules.
--
-- 1. Relations are now daughter / son / mother / father (plus 'self', which
--    onboarding and walk-ins create). The old spouse / child / parent values
--    stay legal for rows that already exist, but new rows can't use them.
-- 2. A family member added by a patient must have a date of birth, a
--    relation and a 12-digit Aadhaar number.
-- 3. One account can't hold two people with the same name (compared
--    case-insensitively, ignoring extra spaces). Clinic walk-ins are the
--    exception: they're all 'self' rows under the clinic's own account
--    (WalkInForm.tsx), and two different walk-in patients can share a name,
--    so a clash only counts when at least one of the two rows is not 'self'.
--
-- The trigger is named so it fires BEFORE on_family_member_zz_encrypt
-- (triggers fire in name order), which means it still sees the plain
-- Aadhaar number and can check its format.

alter table family_members drop constraint if exists family_relation_check;
alter table family_members
  add constraint family_relation_check
  check (relation in ('self', 'daughter', 'son', 'mother', 'father', 'spouse', 'child', 'parent'));

create or replace function public.validate_family_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := lower(regexp_replace(btrim(coalesce(new.name, '')), '\s+', ' ', 'g'));
begin
  if tg_op = 'INSERT' then
    if new.relation is null then
      raise exception 'Choose a relation.';
    end if;
    if new.relation in ('spouse', 'child', 'parent') then
      raise exception 'Relation must be daughter, son, mother or father.';
    end if;
    if new.relation <> 'self' then
      if new.dob is null then
        raise exception 'Date of birth is required.';
      end if;
      if new.govt_id is null or new.govt_id !~ '^[0-9]{12}$' then
        raise exception 'Enter a valid 12-digit Aadhaar number.';
      end if;
    end if;
  end if;

  if tg_op = 'INSERT' or new.name is distinct from old.name or new.relation is distinct from old.relation then
    if exists (
      select 1 from family_members f
      where f.account_id = new.account_id
        and f.id <> new.id
        and lower(regexp_replace(btrim(f.name), '\s+', ' ', 'g')) = v_name
        and not (f.relation = 'self' and new.relation = 'self')
    ) then
      raise exception 'Someone named "%" is already on this account.', btrim(new.name);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists on_family_member_validate on family_members;
create trigger on_family_member_validate
  before insert or update of name, relation on family_members
  for each row execute function public.validate_family_member();
