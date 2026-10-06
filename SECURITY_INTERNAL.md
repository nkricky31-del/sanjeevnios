# Insider protection: who inside SanjeevniOS can touch what

## The rules, and where each is enforced
| Rule | How | Where |
|---|---|---|
| Nobody on staff reads patient health data by default | `is_admin()` branches removed from visits, prescriptions, files, patient_conditions, family_members, encounters, storage | `migration_79` |
| Access only just-in-time: request -> **different** person approves -> 5-60 min -> auto-expires -> fully logged | `breakglass_*` tables + functions. Expiry is a timestamp checked on every read, so it cannot be "forgotten". The stored status is tidied by a 1-minute cron. | `migration_78`, `AdminBreakGlass.tsx` |
| Every read is logged: who, why, what, how many rows, until when | `breakglass_access_log` (append-only) + `audit_log` rows `breakglass.request/approve/deny/revoke/read/expire` | `migration_78` |
| Strong MFA (authenticator app, not SMS) for every internal account | Console gate enrols/verifies TOTP; the database requires `aal2` for every break-glass and role function, and for `is_admin()` once `mfa_required_admin = 'on'` | `AdminMfaGate.tsx`, `migration_78` |
| Separation of duties | One role per person (`staff_roles` primary key). **ops/support** do daily work and request access. **security_approver** approves access and manages roles but is *not* `is_admin()`, so cannot do daily operations. Nobody approves their own request (table constraint + function check) or changes their own role. **Key custodian** = the Supabase organization owner (a dashboard role, not in the database). | `migration_78` |
| Least-privilege credentials, no shared root | See "Credentials" below | dashboards + `analytics_ro` |
| Analytics on de-identified data | `analytics` schema: materialized aggregates, groups under 5 suppressed, no ids or free text; `analytics_ro` can see nothing else | `migration_78` |

## Rollout order (nothing locks anyone out until step 6)
1. **Supabase:** Authentication > Multi-Factor > confirm **TOTP is enabled** (it is by default).
2. SQL Editor: run `migration_78_internal_access_controls.sql` (additive).
3. **Bootstrap roles** (SQL Editor, once; find ids with `select id, name, phone from profiles where role = 'admin';`):
   ```sql
   -- your lead / second person: the approver (should NOT also be a daily operator)
   insert into staff_roles (user_id, role, granted_by) values ('<approver-uuid>', 'security_approver', '<approver-uuid>');
   -- everyone else on the team who has an admin login
   insert into staff_roles (user_id, role, granted_by) values ('<uuid>', 'ops', '<approver-uuid>');
   insert into staff_roles (user_id, role, granted_by) values ('<uuid>', 'support', '<approver-uuid>');
   ```
   You need **at least two people**: an approver and a requester. Afterwards the approver manages roles in-app (`set_staff_role`).
4. Deploy the frontend (commit + push). From now every admin login shows the authenticator-app screen.
5. Everyone signs in once and enrols their authenticator. **Then:** `update guard.settings set value = 'on' where key = 'mfa_required_admin';` (admins without MFA are locked out of admin functions - keep one SQL-editor path open).
6. Do break-glass test 2 below end to end, **then** run `migration_79_close_admin_health_access.sql`.
7. Give the analytics tool its own login: `alter role analytics_ro login password '<long random>';` (SQL Editor), connect it to the **pooler** URL with user `analytics_ro.<project-ref>`.

## Credentials (no shared root, rotate on a schedule)
| Credential | Held by | Rotate | How |
|---|---|---|---|
| Supabase **organization owner** | key custodian only (1-2 people) | n/a - MFA, no sharing | Supabase org settings > enforce MFA |
| Supabase project **service_role / JWT keys** | edge functions only (never a person) | every 90 days or on departure | Dashboard > Settings > API; then redeploy functions |
| **Database password** (`postgres`) | nobody day to day (break-glass vault) | every 90 days | Settings > Database > Reset password |
| `analytics_ro` | analytics tool only; read-only, aggregates only | every 90 days | `alter role analytics_ro password '...'` |
| Field-encryption **KEK/DEK** | custodian | per `SECURITY_CONFIG.md` | `select rotate_field_kek();` / `rotate_field_dek();` |
| Razorpay keys, MSG91 key, Turnstile secret | function secrets only | every 90 days | `npx supabase secrets set ...` + provider dashboard |
| Personal access tokens (`sbp_...`, GitHub, Vercel, Cloudflare) | each person, own token, short expiry | revoke after use | never paste in chat/tickets |
Each person has their **own** login everywhere. No shared "admin@" accounts. When someone leaves: remove their `staff_roles` row, delete their provider accounts, rotate the credentials above they could have seen.

## MFA on the consoles (dashboards - only you can switch these on)
- **Supabase:** account > Security: enable MFA for every member; organization > Security: **enforce MFA** if offered on your plan.
- **GitHub:** organization > Settings > Authentication security > **Require two-factor authentication** (prefer security keys/passkeys).
- **Vercel:** Team > Settings > Security: require MFA / enforce SAML if available; otherwise each member enables it.
- **Cloudflare:** each account > My Profile > Authentication > two-factor; for Access (`/admin*`) the email PIN is the first factor, TOTP in-app the second.
- **Razorpay, MSG91, registrar:** enable TOTP on every login.
Test: ask each person to sign in from a private window; no console should reach the dashboard without a code.

## How to test
**1. A normal employee cannot read patient health data** (after migration 79)
- Sign in as an `ops` or `support` admin, complete the authenticator step, open Admin > **Patients**. You see only "Request access".
- As that user's JWT, the API must return nothing:
  ```
  curl -s "$SUPABASE_URL/rest/v1/visits?select=id&limit=5" -H "apikey: $ANON" -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN"   # -> []
  curl -s "$SUPABASE_URL/rest/v1/family_members?select=id,govt_id&limit=5" ...                                                 # -> []
  curl -s "$SUPABASE_URL/rest/v1/prescriptions?select=id&limit=5" ...                                                          # -> []
  ```
  (Get the token from the browser: DevTools > Application > local storage > the `sb-...-auth-token` entry.)
- Also try as the engineer's own database login: `select count(*) from analytics.daily_bookings;` works as `analytics_ro`; `select * from public.visits;` fails with "permission denied".

**2. Break-glass: needs approval, expires, fully logged**
1. As `support`: Patients > fill MRN, ticket, reason (>= 20 chars), 5 minutes > **Request access**. The status is `pending`; try the section buttons - there are none; calling the function directly fails with `BREAKGLASS_EXPIRED`.
2. As the same user, try to approve: refused (not an approver). Sign in as the `security_approver`: **Approve**. As the approver, try to approve your *own* request: refused ("cannot decide your own request").
3. As `support`: the card shows `active - 5 min left`; open `profile`, `visits`. Each shows data.
4. Wait for expiry (or click **End access now**): the same buttons now fail with `BREAKGLASS_EXPIRED`; state shows `expired`.
5. Log, in the SQL Editor:
   ```sql
   select at, action, actor_role, reason, details from audit_log where action like 'breakglass.%' order by at desc limit 20;
   select * from breakglass_access_log order by at desc;     -- section + row count per read
   ```
   Try `update breakglass_access_log set row_count = 0;` -> "The audit trail is append-only."

**3. Every admin/cloud account needs MFA**
- App: sign in at `/admin/login` with a fresh admin: you cannot reach any admin screen without enrolling/entering the authenticator code. With `mfa_required_admin = 'on'`, calling an admin API using a token from *before* the code step (aal1) returns empty/denied.
- DB: `select public.request_breakglass('MRN-1','x','y',5);` with an aal1 token -> `MFA_REQUIRED`.
- Consoles: the dashboard checklist above; for GitHub `Settings > People` shows "2FA: enabled" for every member, Supabase org members likewise.

## Known limits (be honest with yourself)
- The Supabase **project owner / database superuser** can still read everything and edit triggers. This is why the custodian list must stay tiny and MFA-protected; the audit trail resists every app role, not the owner.
- `appointments.reason`, payments and booking data stay visible to admins (needed for fraud/settlements). Keep admins few.
- `get_patient_contacts()` still lets admins see name/phone/age/MRN (identity, not clinical data).
- Break-glass shows records on screen; it cannot stop a person photographing it. File contents are not served through break-glass at all.
- A service-role key in an edge function bypasses RLS by design; protect it by limiting who can deploy functions (GitHub/Vercel/Supabase MFA + reviews).
