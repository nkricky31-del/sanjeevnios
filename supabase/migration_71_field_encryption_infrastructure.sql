-- ============================================================================
-- 71. FIELD-LEVEL ENCRYPTION, STEP 1 OF 2: KEYS, FUNCTIONS, DECRYPT HELPERS
--     (changes no behaviour - encryption is switched on by migration 72)
-- ============================================================================
-- Goal: a stolen database dump or backup must not reveal govt IDs or clinical
-- notes. Scope: family_members.govt_id, visits.notes, visits.diagnosis.
-- NOT covered (stated plainly): phone numbers - they are the login identity and
-- are matched in SQL by staff, MRN and OTP logic, so encrypting them needs
-- blind indexes across much of the schema; and prescriptions.items (jsonb).
--
-- Envelope encryption:
--   * KEK (key-encryption key) - a random 32-byte secret in SUPABASE VAULT
--     (vault.secrets). Vault stores it encrypted with a root key that Supabase
--     keeps OUTSIDE the database, so it is not in any table dump or backup of
--     the data, and not in our code.
--   * DEK (data-encryption key) - random, versioned, stored in field_keys only
--     in WRAPPED form (encrypted by the KEK).
--   * Fields are encrypted with the active DEK; each value carries its DEK
--     version:  enc:v<version>:<base64 pgp_sym_encrypt>.
--   Rotating the KEK re-wraps the handful of DEK rows - no field is touched.
--   Rotating the DEK makes new writes use a new version; old values still
--   decrypt, and reencrypt_fields() migrates them in batches when wanted.
--
-- Honest limit: this is Vault, not an external cloud KMS. Anyone with
-- database-superuser (or service-role SQL) access can read vault.decrypted_
-- secrets. It defeats stolen disks, dumps, backups and leaked read-only
-- access; it does not defeat a fully compromised database admin.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- 71.1 Keys ------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'field_kek_v1') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'field_kek_v1',
      'KEK: wraps the data-encryption keys in field_keys');
  end if;
  if not exists (select 1 from vault.secrets where name = 'field_blind_index_key_v1') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'field_blind_index_key_v1',
      'HMAC key for searchable blind indexes of encrypted fields');
  end if;
exception when undefined_table or invalid_schema_name or undefined_function then
  raise exception 'Supabase Vault is not enabled. Enable it under Database > Extensions (supabase_vault), then re-run this migration.';
end;
$$;

create table if not exists field_keys (
  version int primary key,
  wrapped_dek bytea not null,
  kek_name text not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists field_keys_one_active on field_keys ((true)) where active;

alter table field_keys enable row level security;
revoke all on table field_keys from anon, authenticated;

-- 71.2 Internals (never callable from the API) ------------------------------------
create or replace function public._vault_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name;
$$;

create or replace function public._dek_hex(p_version int)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  k field_keys;
  v_kek text;
begin
  select * into k from field_keys where version = p_version;
  if k.version is null then
    raise exception 'Unknown field key version %.', p_version;
  end if;
  v_kek := public._vault_secret(k.kek_name);
  if v_kek is null then
    raise exception 'Key-encryption key % is missing from Vault.', k.kek_name;
  end if;
  return encode(pgp_sym_decrypt_bytea(k.wrapped_dek, v_kek), 'hex');
end;
$$;

-- First data key.
do $$
begin
  if not exists (select 1 from field_keys) then
    insert into field_keys (version, wrapped_dek, kek_name, active)
    values (1, extensions.pgp_sym_encrypt_bytea(extensions.gen_random_bytes(32), public._vault_secret('field_kek_v1')),
            'field_kek_v1', true);
  end if;
end;
$$;

-- 71.3 Encrypt / decrypt / blind index ----------------------------------------------
create or replace function public.field_encrypt(p_plain text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ver int;
begin
  if p_plain is null or p_plain like 'enc:v%' then
    return p_plain; -- nothing to do, or already encrypted (idempotent)
  end if;
  select version into v_ver from field_keys where active;
  return 'enc:v' || v_ver || ':' ||
    replace(encode(pgp_sym_encrypt(p_plain, public._dek_hex(v_ver)), 'base64'), E'\n', '');
end;
$$;

-- Plain (unencrypted legacy) values pass through unchanged, so this is safe to
-- use in the client BEFORE migration 72 turns encryption on.
create or replace function public.field_decrypt(p_cipher text)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_ver int;
begin
  if p_cipher is null or p_cipher not like 'enc:v%' then
    return p_cipher;
  end if;
  v_ver := split_part(substr(p_cipher, 6), ':', 1)::int; -- 'enc:v' is 5 chars
  return pgp_sym_decrypt(
    decode(substr(p_cipher, length('enc:v' || v_ver || ':') + 1), 'base64'),
    public._dek_hex(v_ver)
  );
end;
$$;

-- Deterministic, keyed hash of a normalised value: lets SQL answer "does this
-- govt ID already exist?" without storing it in the clear.
create or replace function public.blind_index(p_plain text)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case when p_plain is null or btrim(p_plain) = '' then null
    else encode(hmac(lower(regexp_replace(p_plain, '[\s-]', '', 'g')),
                     public._vault_secret('field_blind_index_key_v1'), 'sha256'), 'hex') end;
$$;

revoke all on function public._vault_secret(text) from public, anon, authenticated;
revoke all on function public._dek_hex(int) from public, anon, authenticated;
revoke all on function public.field_encrypt(text) from public, anon, authenticated;
revoke all on function public.blind_index(text) from public, anon, authenticated;
revoke all on function public.field_decrypt(text) from public, anon;
-- field_decrypt must be callable by signed-in users because the computed
-- columns below run as the CALLER (so RLS decides which rows they can see).
-- A caller can therefore decrypt a ciphertext they were already allowed to
-- read - never one they weren't - and nothing else.
grant execute on function public.field_decrypt(text) to authenticated;

-- 71.4 Computed columns (PostgREST: select=notes:notes_plain) ---------------------------
-- SECURITY INVOKER: the inner SELECT is subject to RLS, so a row the caller
-- can't read (migration 68's audited health-access rules) yields NULL.
create or replace function public.notes_plain(v visits)
returns text language sql stable security invoker set search_path = public
as $$ select public.field_decrypt(x.notes) from visits x where x.id = v.id $$;

create or replace function public.diagnosis_plain(v visits)
returns text language sql stable security invoker set search_path = public
as $$ select public.field_decrypt(x.diagnosis) from visits x where x.id = v.id $$;

create or replace function public.govt_id_plain(f family_members)
returns text language sql stable security invoker set search_path = public
as $$ select public.field_decrypt(x.govt_id) from family_members x where x.id = f.id $$;

-- 71.5 Rotation (run from the SQL editor; not callable from the API) ----------------------
-- Rotate the master key: new KEK secret, re-wrap every DEK. No field changes.
create or replace function public.rotate_field_kek()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_n int;
  v_new text;
  v_new_secret text := encode(gen_random_bytes(32), 'hex');
  r field_keys;
begin
  select coalesce(max(substring(name from 'field_kek_v(\d+)')::int), 0) + 1 into v_n
  from vault.secrets where name like 'field_kek_v%';
  v_new := 'field_kek_v' || v_n;
  perform vault.create_secret(v_new_secret, v_new, 'KEK rotated ' || now()::date);
  for r in select * from field_keys loop
    update field_keys
       set wrapped_dek = pgp_sym_encrypt_bytea(
             pgp_sym_decrypt_bytea(r.wrapped_dek, public._vault_secret(r.kek_name)), v_new_secret),
           kek_name = v_new
     where version = r.version;
  end loop;
  return v_new;
end;
$$;

-- Rotate the data key: new writes use it; old values keep decrypting.
create or replace function public.rotate_field_dek()
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ver int;
  v_kek text;
begin
  select coalesce(max(version), 0) + 1 into v_ver from field_keys;
  select kek_name into v_kek from field_keys where active;
  update field_keys set active = false where active;
  insert into field_keys (version, wrapped_dek, kek_name, active)
  values (v_ver, pgp_sym_encrypt_bytea(gen_random_bytes(32), public._vault_secret(v_kek)), v_kek, true);
  return v_ver;
end;
$$;

-- Re-encrypt old-version values under the active DEK, in batches. Returns rows
-- changed; call until it returns 0 (then old DEK versions may be retired).
create or replace function public.reencrypt_fields(p_batch int default 500)
returns int
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_active int;
  v_n int := 0;
  v_c int;
begin
  select version into v_active from field_keys where active;
  with t as (
    select id from visits
    where (notes like 'enc:v%' and notes not like 'enc:v' || v_active || ':%')
       or (diagnosis like 'enc:v%' and diagnosis not like 'enc:v' || v_active || ':%')
    limit p_batch)
  update visits v set
    notes = public.field_encrypt(public.field_decrypt(v.notes)),
    diagnosis = public.field_encrypt(public.field_decrypt(v.diagnosis))
  from t where v.id = t.id and (v.notes like 'enc:v%' or v.diagnosis like 'enc:v%');
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  with t as (
    select id from family_members
    where govt_id like 'enc:v%' and govt_id not like 'enc:v' || v_active || ':%' limit p_batch)
  update family_members f set govt_id = public.field_encrypt(public.field_decrypt(f.govt_id))
  from t where f.id = t.id;
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  return v_n;
end;
$$;

revoke all on function public.rotate_field_kek() from public, anon, authenticated;
revoke all on function public.rotate_field_dek() from public, anon, authenticated;
revoke all on function public.reencrypt_fields(int) from public, anon, authenticated;

-- Quick check you can run in the SQL editor:  select public.field_encryption_selftest();
create or replace function public.field_encryption_selftest()
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.field_decrypt(public.field_encrypt('selftest 123')) = 'selftest 123'
     and public.field_encrypt('selftest 123') like 'enc:v%';
$$;
revoke all on function public.field_encryption_selftest() from public, anon, authenticated;
