-- ============================================================================
-- Fix for: "new row violates row-level security policy" when uploading a
-- doctor's verification document.
-- Paste this whole file into Supabase Dashboard -> SQL Editor -> Run.
-- Safe to re-run.
-- ============================================================================

create or replace function public.owns_doctor(target_doctor_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from doctors d
    join clinics c on c.id = d.clinic_id
    where d.id = target_doctor_id and c.owner_id = auth.uid()
  );
$$;

drop policy if exists "verification_docs_select" on storage.objects;
create policy "verification_docs_select" on storage.objects for select
  to authenticated
  using (
    bucket_id = 'verification-docs'
    and (
      public.is_admin()
      or (
        (storage.foldername(name))[1] = 'clinics'
        and public.is_own_clinic(((storage.foldername(name))[2])::uuid)
      )
      or (
        (storage.foldername(name))[1] = 'doctors'
        and public.owns_doctor(((storage.foldername(name))[2])::uuid)
      )
    )
  );

drop policy if exists "verification_docs_insert" on storage.objects;
create policy "verification_docs_insert" on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'verification-docs'
    and (
      (
        (storage.foldername(name))[1] = 'clinics'
        and public.is_own_clinic(((storage.foldername(name))[2])::uuid)
      )
      or (
        (storage.foldername(name))[1] = 'doctors'
        and public.owns_doctor(((storage.foldername(name))[2])::uuid)
      )
    )
  );
