-- ============================================================================
-- 89. PATIENT BILLS - issued by the clinic when a visit is completed
-- ============================================================================
-- Every completed visit gets a bill from the CLINIC (not from SanjeevniOS):
-- the clinic's name, address and GSTIN, a running bill number per clinic and
-- financial year, the patient and the visit, the consultation charge, any
-- coupon, GST if the clinic charges it, and how it was paid. The patient
-- downloads it in the app and gets it by WhatsApp/email (the send-patient-bill
-- edge function); the clinic keeps every bill and can download them per
-- patient or per date range.
--
-- GST: health care services by a clinic or doctor are exempt, so by default no
-- GST is added. A GST-registered clinic's bill is then a "Bill of Supply"; a
-- clinic without a GSTIN issues a plain "Invoice". A clinic whose consultations
-- are taxable can set a rate (5% or 18%): the price stays what the patient was
-- shown, and the GST inside it is shown as CGST + SGST (the visit is at the
-- clinic, so it is always within the state) on a "Tax Invoice".
--
-- A bill is a snapshot - later edits to the clinic, doctor or patient don't
-- change bills already issued. Only its payment line follows the booking (paid
-- at the desk later, refunded).
--
-- The Rs.10 online convenience fee is SanjeevniOS's, not the clinic's (the
-- booking screen calls it the platform convenience fee), so it appears in the
-- payment line, not as a clinic charge.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 89.1 The clinic's billing details (Booking mode -> Bills & GST)
-- ----------------------------------------------------------------------------
alter table clinics add column if not exists bill_legal_name text;
alter table clinics add column if not exists bill_address text;
alter table clinics add column if not exists gstin text;
alter table clinics add column if not exists consultation_gst_rate numeric not null default 0;

alter table clinics drop constraint if exists clinics_gstin_format;
alter table clinics add constraint clinics_gstin_format
  check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
alter table clinics drop constraint if exists clinics_consultation_gst_rate_check;
alter table clinics add constraint clinics_consultation_gst_rate_check
  check (consultation_gst_rate in (0, 5, 18));
alter table clinics drop constraint if exists clinics_bill_text_length;
alter table clinics add constraint clinics_bill_text_length
  check (char_length(coalesce(bill_legal_name, '')) <= 200 and char_length(coalesce(bill_address, '')) <= 500);

-- ----------------------------------------------------------------------------
-- 89.2 Bills
-- ----------------------------------------------------------------------------
create table if not exists patient_bills (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics (id) on delete cascade,
  appointment_id uuid not null unique references appointments (id) on delete cascade,
  member_id uuid not null references family_members (id) on delete cascade,
  doctor_id uuid references doctors (id) on delete set null,
  bill_no text not null,
  financial_year text not null,
  doc_type text not null check (doc_type in ('tax_invoice', 'bill_of_supply', 'invoice')),
  issued_at timestamptz not null default now(),
  -- the clinic, as it was when the bill was issued
  clinic_name text not null,
  clinic_legal_name text,
  clinic_address text,
  clinic_phone text,
  clinic_email text,
  clinic_reg_no text,
  clinic_gstin text,
  -- the patient
  patient_name text not null,
  patient_mrn text,
  patient_phone text,
  -- the visit
  doctor_name text,
  doctor_specialty text,
  doctor_reg_no text,
  visit_date date not null,
  visit_time time,
  -- the charge (what the clinic bills; GST, if any, is inside total_amount)
  sac_code text not null default '999312',
  description text not null,
  fee_amount numeric(12, 2) not null,
  discount_amount numeric(12, 2) not null default 0,
  discount_label text,
  total_amount numeric(12, 2) not null,
  gst_rate numeric(5, 2) not null default 0,
  taxable_value numeric(12, 2) not null,
  cgst_amount numeric(12, 2) not null default 0,
  sgst_amount numeric(12, 2) not null default 0,
  -- how it was paid (kept up to date with the booking)
  payment_status text not null,
  payment_method text,
  paid_amount numeric(12, 2),
  convenience_fee numeric(12, 2) not null default 0,
  paid_at timestamptz,
  payment_reference text,
  -- sending (send-patient-bill)
  whatsapp_sent_at timestamptz,
  email_sent_at timestamptz,
  email_sent_to text,
  last_send_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, bill_no)
);

create index if not exists patient_bills_clinic_issued_idx on patient_bills (clinic_id, issued_at desc);
create index if not exists patient_bills_member_idx on patient_bills (member_id, issued_at desc);
create index if not exists patient_bills_clinic_mrn_idx on patient_bills (clinic_id, patient_mrn);

alter table patient_bills enable row level security;
-- The patient (their own family's bills), the clinic that issued it, admins.
-- No write policies: bills are written only by the functions below and the
-- send-patient-bill edge function (service role).
drop policy if exists "patient_bills_select" on patient_bills;
create policy "patient_bills_select" on patient_bills for select
  using (public.is_admin() or public.is_own_clinic(clinic_id) or public.is_own_member(member_id));

-- Running numbers per clinic and financial year (April-March): 2026-27/000001.
create table if not exists patient_bill_counters (
  clinic_id uuid not null references clinics (id) on delete cascade,
  financial_year text not null,
  last_no int not null default 0,
  primary key (clinic_id, financial_year)
);
alter table patient_bill_counters enable row level security;

-- ----------------------------------------------------------------------------
-- 89.3 The payment line - filled in at issue and again whenever the booking's
--      payment changes
-- ----------------------------------------------------------------------------
create or replace function public.refresh_patient_bill_payment(p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  p payments;
  v_convenience numeric;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    return;
  end if;
  select * into p from payments where appointment_id = a.id order by created_at desc limit 1;
  -- The same rule as create_payment_with_coupon(): online payments carry a
  -- Rs.10 convenience fee, free follow-ups don't.
  v_convenience := case
    when p.method = 'online' and coalesce(p.status, '') <> 'waived' and coalesce(p.gross_amount, 0) >= 10 then 10
    else 0
  end;
  update patient_bills
  set payment_status = a.payment_status,
      payment_method = p.method,
      convenience_fee = v_convenience,
      paid_amount = case a.payment_status
        when 'paid_at_clinic' then coalesce(a.paid_amount, p.net_amount, p.amount)
        when 'paid_online' then coalesce(p.net_amount, p.amount)
        when 'free_followup' then 0
        when 'refunded' then coalesce(p.net_amount, p.amount)
        else null
      end,
      paid_at = case a.payment_status
        when 'paid_at_clinic' then a.paid_at
        when 'paid_online' then coalesce(a.paid_at, p.created_at)
        when 'refunded' then coalesce(a.paid_at, p.created_at)
        else null
      end,
      payment_reference = p.razorpay_payment_id,
      updated_at = now()
  where appointment_id = a.id;
end;
$$;

revoke all on function public.refresh_patient_bill_payment(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 89.4 Issue a visit's bill (once - a second call returns the same bill)
-- ----------------------------------------------------------------------------
create or replace function public.issue_patient_bill(p_appointment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a appointments;
  c clinics;
  m family_members;
  d doctors;
  p payments;
  v_id uuid;
  v_local timestamp;
  v_fy text;
  v_no int;
  v_fee numeric;
  v_discount numeric;
  v_total numeric;
  v_rate numeric;
  v_taxable numeric;
  v_tax numeric;
  v_cgst numeric;
  v_phone text;
  v_member_phone text;
  v_account_phone text;
begin
  select * into a from appointments where id = p_appointment_id;
  if a.id is null then
    raise exception 'Appointment not found.';
  end if;
  -- From the completion trigger this runs as whoever completed the visit (the
  -- clinic); called directly, only the clinic or an admin may issue.
  if auth.uid() is not null and not (public.is_admin() or public.is_own_clinic(a.clinic_id)) then
    raise exception 'This is not your clinic.';
  end if;

  select id into v_id from patient_bills where appointment_id = a.id;
  if v_id is not null then
    return v_id;
  end if;
  if a.status <> 'completed' then
    raise exception 'A bill is issued once the visit is completed.';
  end if;

  select * into c from clinics where id = a.clinic_id;
  select * into m from family_members where id = a.member_id;
  select * into d from doctors where id = a.doctor_id;
  select * into p from payments where appointment_id = a.id order by created_at desc limit 1;

  -- Financial year in the clinic's own time zone (April to March).
  v_local := now() at time zone coalesce(c.timezone, 'Asia/Kolkata');
  v_fy := case
    when extract(month from v_local) >= 4 then to_char(v_local, 'YYYY') || '-' || to_char(v_local + interval '1 year', 'YY')
    else to_char(v_local - interval '1 year', 'YYYY') || '-' || to_char(v_local, 'YY')
  end;
  insert into patient_bill_counters (clinic_id, financial_year, last_no)
  values (c.id, v_fy, 1)
  on conflict (clinic_id, financial_year) do update set last_no = patient_bill_counters.last_no + 1
  returning last_no into v_no;

  -- The clinic's charge: the consultation fee (the payment's gross less the
  -- platform's online convenience fee; walk-ins record just the amount), less
  -- any coupon - which can't take it below zero.
  v_fee := coalesce(
    p.gross_amount - case when p.method = 'online' and coalesce(p.status, '') <> 'waived' and coalesce(p.gross_amount, 0) >= 10 then 10 else 0 end,
    p.amount,
    d.consultation_fee,
    0
  );
  v_fee := greatest(round(v_fee, 2), 0);
  v_discount := least(round(coalesce(p.discount_amount, 0), 2), v_fee);
  if a.payment_status = 'free_followup' then
    v_discount := v_fee;
  end if;
  v_total := v_fee - v_discount;

  -- GST only with a GSTIN; the price includes it.
  v_rate := case when c.gstin is null then 0 else coalesce(c.consultation_gst_rate, 0) end;
  v_taxable := round(v_total * 100 / (100 + v_rate), 2);
  v_tax := v_total - v_taxable;
  v_cgst := round(v_tax / 2, 2);

  -- Where the patient can be reached: their own phone, else the account
  -- holder's - unless that account is the clinic's own (a walk-in not yet
  -- claimed by the patient).
  v_member_phone := nullif(m.phone, '');
  select pr.phone into v_account_phone from profiles pr where pr.id = m.account_id and pr.role = 'patient';
  v_phone := coalesce(v_member_phone, v_account_phone);

  insert into patient_bills (
    clinic_id, appointment_id, member_id, doctor_id, bill_no, financial_year, doc_type,
    clinic_name, clinic_legal_name, clinic_address, clinic_phone, clinic_email, clinic_reg_no, clinic_gstin,
    patient_name, patient_mrn, patient_phone,
    doctor_name, doctor_specialty, doctor_reg_no, visit_date, visit_time,
    description, fee_amount, discount_amount, discount_label, total_amount,
    gst_rate, taxable_value, cgst_amount, sgst_amount, payment_status
  ) values (
    c.id, a.id, a.member_id, a.doctor_id, v_fy || '/' || lpad(v_no::text, 6, '0'), v_fy,
    case when c.gstin is null then 'invoice' when v_rate > 0 then 'tax_invoice' else 'bill_of_supply' end,
    c.name, nullif(trim(c.bill_legal_name), ''),
    coalesce(nullif(trim(c.bill_address), ''), nullif(c.formatted_address, ''), c.address),
    c.contact_phone, c.contact_email, c.reg_no, c.gstin,
    coalesce(nullif(trim(m.name), ''), 'Patient'), m.mrn, v_phone,
    d.name, d.specialty, d.reg_no, a.date, a.slot_time,
    'Consultation' || coalesce(' - ' || d.name, '') || coalesce(' (' || d.specialty || ')', ''),
    v_fee, v_discount,
    case
      when a.payment_status = 'free_followup' then 'Free follow-up'
      when v_discount > 0 and p.coupon_code is not null then 'Coupon ' || p.coupon_code
      when v_discount > 0 then 'Discount'
    end,
    v_total, v_rate, v_taxable, v_cgst, v_tax - v_cgst, a.payment_status
  )
  returning id into v_id;

  perform public.refresh_patient_bill_payment(a.id);
  perform public.record_audit(
    'patient_bill.issued', a.clinic_id, 'appointment', a.id::text,
    jsonb_build_object('bill_no', v_fy || '/' || lpad(v_no::text, 6, '0'), 'total', v_total)
  );
  return v_id;
end;
$$;

revoke all on function public.issue_patient_bill(uuid) from public, anon;
grant execute on function public.issue_patient_bill(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 89.5 Issue on completion; keep the payment line current
-- ----------------------------------------------------------------------------
create or replace function public.issue_patient_bill_on_complete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Never let a billing problem stop a visit from being completed: the
  -- clinic's Patient bills screen offers to create any that are missing.
  begin
    perform public.issue_patient_bill(new.id);
  exception when others then
    raise warning 'Bill not issued for appointment %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_appointment_completed_issue_bill on appointments;
create trigger on_appointment_completed_issue_bill
  after update of status on appointments
  for each row
  when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function public.issue_patient_bill_on_complete();

create or replace function public.sync_patient_bill_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.refresh_patient_bill_payment(new.id);
  return new;
end;
$$;

drop trigger if exists on_appointment_payment_sync_bill on appointments;
create trigger on_appointment_payment_sync_bill
  after update of payment_status, paid_amount, paid_at on appointments
  for each row
  when (
    old.payment_status is distinct from new.payment_status
    or old.paid_amount is distinct from new.paid_amount
    or old.paid_at is distinct from new.paid_at
  )
  execute function public.sync_patient_bill_payment();

-- ----------------------------------------------------------------------------
-- 89.6 For the clinic's Patient bills screen
-- ----------------------------------------------------------------------------
-- Totals for a range of bill dates (the clinic's own calendar days), added up
-- in the database so they stay right however many bills there are.
create or replace function public.clinic_bill_totals(p_clinic_id uuid, p_from date, p_to date)
returns table (bills int, billed numeric, paid numeric, due numeric, refunded numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'Not your clinic.';
  end if;
  select coalesce(timezone, 'Asia/Kolkata') into v_tz from clinics where id = p_clinic_id;
  return query
    select count(*)::int,
           coalesce(sum(b.total_amount), 0),
           coalesce(sum(b.total_amount) filter (where b.payment_status in ('paid_online', 'paid_at_clinic', 'free_followup')), 0),
           coalesce(sum(b.total_amount) filter (where b.payment_status = 'pay_at_clinic'), 0),
           coalesce(sum(b.total_amount) filter (where b.payment_status = 'refunded'), 0)
    from patient_bills b
    where b.clinic_id = p_clinic_id
      and b.issued_at >= (p_from::timestamp at time zone v_tz)
      and b.issued_at < ((p_to + 1)::timestamp at time zone v_tz);
end;
$$;

revoke all on function public.clinic_bill_totals(uuid, date, date) from public, anon;
grant execute on function public.clinic_bill_totals(uuid, date, date) to authenticated;

-- Completed visits in a range of visit dates that have no bill yet (visits
-- from before bills existed, or a rare failure at completion).
create or replace function public.count_unbilled_visits(p_clinic_id uuid, p_from date, p_to date)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'Not your clinic.';
  end if;
  return (
    select count(*)::int
    from appointments a
    where a.clinic_id = p_clinic_id
      and a.status = 'completed'
      and a.date between p_from and p_to
      and not exists (select 1 from patient_bills b where b.appointment_id = a.id)
  );
end;
$$;

revoke all on function public.count_unbilled_visits(uuid, date, date) from public, anon;
grant execute on function public.count_unbilled_visits(uuid, date, date) to authenticated;

-- ...and issue them, oldest visit first, up to 500 per call.
create or replace function public.issue_missing_patient_bills(p_clinic_id uuid, p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  if not (public.is_admin() or public.is_own_clinic(p_clinic_id)) then
    raise exception 'Not your clinic.';
  end if;
  for r in
    select a.id
    from appointments a
    where a.clinic_id = p_clinic_id
      and a.status = 'completed'
      and a.date between p_from and p_to
      and not exists (select 1 from patient_bills b where b.appointment_id = a.id)
    order by a.date, a.slot_time
    limit 500
  loop
    perform public.issue_patient_bill(r.id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.issue_missing_patient_bills(uuid, date, date) from public, anon;
grant execute on function public.issue_missing_patient_bills(uuid, date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- 89.7 Where send-patient-bill keeps the PDF it shares on WhatsApp (private;
--      only the service role reads or writes it, through short-lived links)
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('patient-bills', 'patient-bills', false)
on conflict (id) do nothing;
