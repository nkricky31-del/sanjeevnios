-- ============================================================================
-- 72. FIELD-LEVEL ENCRYPTION, STEP 2 OF 2: TURN IT ON
--     Run ONLY after migration 71 is applied, the app version that reads
--     notes_plain / diagnosis_plain is deployed, and
--     select public.field_encryption_selftest();   returns true.
-- ============================================================================
-- From here on, every new or edited visit note / diagnosis / govt ID is
-- encrypted by a trigger before it is stored. Existing rows are NOT touched
-- here: run  select public.encrypt_existing_fields();  separately (below), after
-- you've saved one test note and read it back in the app.
--
-- govt_id used to be matched by equality to reuse a patient's MRN. Ciphertext
-- can't be compared, so a keyed blind index (govt_id_hash) takes over; legacy
-- plaintext rows still match until they are encrypted.
-- ============================================================================

alter table family_members add column if not exists govt_id_hash text;
create index if not exists family_members_govt_id_hash_idx on family_members (govt_id_hash) where govt_id_hash is not null;

-- Hash every existing govt ID (still plaintext) so MRN matching keeps working.
update family_members set govt_id_hash = public.blind_index(public.field_decrypt(govt_id))
where govt_id is not null and govt_id_hash is null;

create or replace function public.assign_family_member_mrn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_mrn text;
  v_hash text;
begin
  if new.mrn is not null then
    return new;
  end if;

  if new.phone is not null then
    select mrn into existing_mrn from family_members
    where phone = new.phone and mrn is not null
    order by created_at asc limit 1;
  end if;

  if existing_mrn is null and new.govt_id is not null then
    v_hash := public.blind_index(public.field_decrypt(new.govt_id));
    select mrn into existing_mrn from family_members
    where mrn is not null
      and (govt_id_hash = v_hash or govt_id = new.govt_id)
    order by created_at asc limit 1;
  end if;

  new.mrn := coalesce(existing_mrn, public.generate_mrn());
  return new;
end;
$$;

-- Encrypt on the way in. Names sort after on_family_member_assign_mrn, so MRN
-- matching still sees the plaintext first.
create or replace function public.encrypt_family_member_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.govt_id is not null and new.govt_id not like 'enc:v%' then
    new.govt_id_hash := public.blind_index(new.govt_id);
    new.govt_id := public.field_encrypt(new.govt_id);
  elsif new.govt_id is null then
    new.govt_id_hash := null;
  end if;
  return new;
end;
$$;

drop trigger if exists on_family_member_zz_encrypt on family_members;
create trigger on_family_member_zz_encrypt
  before insert or update of govt_id on family_members
  for each row execute function public.encrypt_family_member_fields();

create or replace function public.encrypt_visit_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.notes := public.field_encrypt(new.notes);
  new.diagnosis := public.field_encrypt(new.diagnosis);
  return new;
end;
$$;

drop trigger if exists on_visit_zz_encrypt on visits;
create trigger on_visit_zz_encrypt
  before insert or update of notes, diagnosis on visits
  for each row execute function public.encrypt_visit_fields();

-- One-off, run by you from the SQL editor when ready. Safe to repeat; returns
-- the number of rows it encrypted (0 = done). Take a backup first.
create or replace function public.encrypt_existing_fields(p_batch int default 500)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int := 0;
  v_c int;
begin
  update family_members set govt_id = govt_id
  where id in (select id from family_members where govt_id is not null and govt_id not like 'enc:v%' limit p_batch);
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  update visits set notes = notes
  where id in (select id from visits
               where (notes is not null and notes not like 'enc:v%')
                  or (diagnosis is not null and diagnosis not like 'enc:v%')
               limit p_batch);
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  return v_n;
end;
$$;

revoke all on function public.encrypt_existing_fields(int) from public, anon, authenticated;
