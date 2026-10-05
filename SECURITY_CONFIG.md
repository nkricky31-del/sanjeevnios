# Encryption and secrets - configuration and how to verify

## Status (as of 2026-10-05)

| Area | State |
|---|---|
| HTTP -> HTTPS redirect, HSTS, TLS >= 1.2 | Done and live (verified: 308 redirect, `strict-transport-security`, TLS 1.1 refused) |
| Security headers (`vercel.json`) | Done and live (HSTS + includeSubDomains, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy) |
| No hard-coded secrets in source or bundle | Done (`npm run scan:secrets` passes; planted-secret test fails as it should) |
| Card data | Never touches our servers (Razorpay Checkout only) |
| Field encryption, migrations 71 + 72 | Applied. New notes / diagnoses / govt IDs are encrypted on write |
| Existing data backfill | Done: counts of unencrypted visits and govt IDs are both 0 |
| Visit note encryption + app read-back | Verified by you (stored as `enc:v1:...`, reads fine in the app) |
| Govt ID encryption on a NEW row | Not yet verified (no test patient with an ID) |
| Old visits read in the app after backfill | To confirm |
| Supabase "Enforce SSL on incoming connections" | **Open - you must switch it on** |
| Backups present; manual dumps encrypted | **Open - confirm in the dashboard** |
| Rotate the live Razorpay key pasted into chat earlier | **Open - cannot be verified from code** |
| KEK rotation schedule (e.g. every 90 days) | **Open - not scheduled** |
| Phone numbers, `prescriptions.items`, patient_conditions | **Not encrypted** (see section 3) |
| External KMS | Not used - keys are in Supabase Vault (see section 3) |

What the code does, what you must switch on in dashboards, and how to test it.

## 1. In transit (HTTPS / TLS)
| Item | Where | Status |
|---|---|---|
| http -> https redirect | Vercel (automatic, 308) | Verified live |
| HSTS | `vercel.json` (`max-age=63072000; includeSubDomains`) | Header set by Vercel already; now pinned in code |
| TLS >= 1.2, auto-renewed certs | Vercel-managed | TLS 1.1 refused (verified) |
| Supabase API / Edge Functions / webhooks | Supabase serves HTTPS only | Platform |
| Database connections | Supabase dashboard > Settings > Database > **Enforce SSL on incoming connections = ON** | **You must switch this on** |

Test: `curl -sI http://www.sanjeevnios.in/` -> `308`, `Location: https://...`;
`curl -sI https://www.sanjeevnios.in/ | grep -i strict-transport` -> present.

## 2. At rest and backups
Supabase encrypts database volumes and backups (AES-256) at the platform
level; you can't disable it. **You must confirm** under Dashboard > Database >
Backups that daily backups (and PITR if you pay for it) exist, and keep any
manual `pg_dump` files encrypted (e.g. `age`/`gpg`) - a manual dump is NOT
covered by the platform. Receipts to keep: Supabase's SOC 2 / HIPAA
documentation if you need to show an auditor.

## 3. Field-level encryption (migrations 71 + 72)
Covered: `family_members.govt_id`, `visits.notes`, `visits.diagnosis`.
Not covered: phone numbers, `prescriptions.items`, patient_conditions.
Keys: KEK + blind-index key in Supabase Vault; DEKs wrapped in `field_keys`.

Order (important):
1. Run **migration 71** (changes no behaviour).
2. Deploy the app (it reads `notes_plain` / `diagnosis_plain`, which 71 creates).
3. `select public.field_encryption_selftest();` -> `true`.
4. Run **migration 72** (new writes are now encrypted).
5. Save one test note in the app and read it back in the app.
6. Take a backup, then `select public.encrypt_existing_fields();` repeatedly until it returns 0.

Test the raw row is unreadable:
```sql
select id, notes, diagnosis from visits order by created_at desc limit 3;
-- -> enc:v1:... (ciphertext)
select id, govt_id, govt_id_hash from family_members where govt_id is not null limit 3;
```
In the app the same note shows as readable text. Without Vault's secrets the
ciphertext can't be decrypted.

Rotation (SQL editor only, none callable from the API):
- Master key, scheduled (e.g. every 90 days) or after suspected exposure:
  `select public.rotate_field_kek();` - re-wraps the DEKs only; no field changes.
- Data key: `select public.rotate_field_dek();` then
  `select public.reencrypt_fields();` until 0.

## 4. Secrets
- Nothing secret is in the source or the browser bundle. The only keys in the
  bundle are the Supabase **anon** key (public by design, protected by RLS) and
  Razorpay key **IDs** (public).
- Server secrets live in Supabase Edge Function secrets
  (`supabase secrets set ...`), per environment: `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RESEND_API_KEY`,
  `RESEND_FROM_EMAIL`. Vercel holds only `VITE_SUPABASE_URL` / `..._ANON_KEY`.
- **Do now:** rotate the live Razorpay key that was pasted into a chat earlier
  (see RAZORPAY_SETUP_TODO.md), and rotate secrets on a schedule (90 days) and
  after any exposure.
- Test: `npm run scan:secrets` -> "OK: no hard-coded secrets found". It scans
  tracked files, JWTs that decode to `service_role`, tracked env/key files and
  the built bundle, and exits non-zero on a hit. Run it in CI before deploy.
- `.gitignore` now blocks `.env*` (except the example), key files and key CSVs.

## 5. Card data
No card field, PAN or CVV exists in the client or the edge functions
(grep for card number / cvv / cvc returns nothing). Payment collection is
Razorpay Checkout; we store only Razorpay order/payment ids and amounts.
