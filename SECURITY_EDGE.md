# Edge shield: WAF/CDN, rate limits, bot checks, private DB

## What sits where (read this first)
This app is a static site on Vercel; the **browser talks to Supabase directly**. So there are two traffic paths and
each needs its own guard:

| Path | Guard | File |
|---|---|---|
| browser -> www.sanjeevnios.in (HTML/JS/CSS) | Cloudflare proxy: DDoS, managed WAF, custom rules, edge rate limit, Bot Fight, Access on `/admin*` | `infra/cloudflare/*.tf` |
| browser -> Supabase REST/RPC (search, booking, every table) | Per-IP / per-account / per-endpoint limits inside PostgREST (HTTP 429) | `supabase/migration_74_edge_rate_limiting.sql` |
| browser -> Supabase Auth (signup/login/OTP) | Turnstile verified by Supabase Auth + Auth rate limits (dashboard) | `src/pages/*Login.tsx`, `src/components/TurnstileWidget.tsx` |
| booking | Turnstile verified by edge function, enforced by a DB trigger | `functions/verify-captcha`, `migration_75_booking_captcha.sql` |
| browser -> Edge Functions | 60 req/min per user across all functions | `functions/_shared/authorize.ts` |

A CDN cannot rate-limit Supabase API calls (they never pass through it), and on the Free plan Supabase cannot be put
behind your own proxy, so the database layer is where API limits live. Direct calls to `*.supabase.co` are covered too.

## Rollout order (nothing is enforced until you do each step)
1. **Cloudflare account + site.** Add `sanjeevnios.in`, switch nameservers at your registrar, wait until Active.
   In Vercel > Domains keep the domain. Then:
   ```
   cd infra/cloudflare && cp terraform.tfvars.example terraform.tfvars   # fill account_id, zone_id
   export CLOUDFLARE_API_TOKEN=...      # permissions listed in versions.tf
   terraform init && terraform plan && terraform apply
   terraform output turnstile_site_key
   terraform output -raw turnstile_secret_key
   ```
   Also import the existing DNS records if `apply` reports they exist (`allow_overwrite` is on for the two it manages).
   Vercel's `*.vercel.app` URL still bypasses Cloudflare - turn on Vercel > Settings > Deployment Protection for
   non-production, and never publish the vercel.app URL.
2. **Turnstile keys.**
   - Vercel env var `VITE_TURNSTILE_SITE_KEY=<site key>` (Production), then redeploy.
   - Supabase Dashboard > Authentication > Attack Protection > **Enable CAPTCHA** > Cloudflare Turnstile > paste the secret.
   - `npx supabase secrets set TURNSTILE_SECRET_KEY=<secret> --project-ref maqnfncrqtdbjqrsibyq`
   - `npx supabase functions deploy verify-captcha` (and redeploy the others: `authorize.ts` changed).
   IMPORTANT: enable CAPTCHA in Supabase **only after** the new frontend with the site key is live, or logins fail
   with "captcha verification process failed".
3. **SQL Editor:** run `migration_74_edge_rate_limiting.sql` (enforces immediately; generous limits, fails open),
   then `migration_75_booking_captcha.sql` (ships OFF).
4. After the frontend + `verify-captcha` are live and you have booked once successfully:
   `update guard.settings set value='on' where key='captcha_booking';`
5. **Supabase Auth rate limits** (Dashboard > Authentication > Rate Limits): lower "SMS sent" to e.g. 30/hour per
   project-wide cap you can afford, "Token verifications" to 30/5min per IP. SMS pumping is the expensive attack.
6. **Scraping cap:** Dashboard > Settings > API > **Max rows** = 200 (default 1000), so one request can't dump a table.
7. **Database network:** see below.

## Tuning / kill switches
```sql
select klass, count(*), max(at) from guard.rate_events group by 1;           -- who is hitting limits
update guard.rate_rules set per_ip = 600 where klass = 'search';              -- loosen (CGNAT-heavy IPs)
update guard.settings set value = 'log' where key = 'rate_limit';             -- observe only
update guard.settings set value = 'off' where key = 'rate_limit';             -- off
alter role authenticator reset pgrst.db_pre_request; notify pgrst, 'reload config';   -- remove hook entirely
update guard.settings set value = 'off' where key = 'captcha_booking';        -- booking CAPTCHA off
```
Limits (per 60 s, defaults): booking 40/IP 15/account - search 240/120 - sensitive 120/90 - rpc 300/240 - write 200/120
- other 600/400. A caller over the limit is blocked for the rule's penalty (60-300 s). Mobile carriers share IPs, so
the IP numbers are loose on purpose; the account numbers are the real brake.

## Private database - what Free can and cannot do
Your app tier is Supabase's API; the browser never needs port 5432. But **on the Free plan Supabase offers no network
allowlist**, so `db.<ref>.supabase.co:5432` (and the 6543 pooler) stay reachable from the internet, protected only by the
database password + SSL. I cannot make that port private on Free. Do these now:
- Dashboard > Settings > Database: **Enforce SSL = ON**, and **reset the database password** to a long random one.
- Never put the DB URL in the frontend or in Vercel env vars (it isn't today).
- Upgrade to **Pro** and run `scripts/lock-db-network.sh` (allow only your own egress IP / VPN) - port 5432 then
  refuses everyone else, while the app keeps working because it uses HTTPS APIs. Re-run `scripts/shield-test.sh` after.

Admin tools: the only admin surface we host is `/admin*` in the SPA, now behind Cloudflare Access (email PIN for
`admin_emails`). The Supabase dashboard is Supabase-hosted: turn on MFA on your Supabase and GitHub/Vercel accounts.
There is no self-hosted database admin UI (pgAdmin etc.) exposed.

## How to test
Automated: `SUPABASE_URL=... SUPABASE_ANON_KEY=... ./scripts/shield-test.sh`

Manual:
1. **429.** Run 300 reads against the API; after ~240 you must see `HTTP 429` with `Retry-After`:
   ```
   for i in $(seq 1 300); do curl -s -o /dev/null -w "%{http_code}\n" \
     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
     "$SUPABASE_URL/rest/v1/clinics?select=id&limit=1"; done | sort | uniq -c
   ```
   Then confirm the app works again after the penalty (60 s). To see it faster:
   `update guard.rate_rules set per_ip = 10 where klass='search';` (restore to 240 after).
2. **Bot check on signup/OTP.** Open https://www.sanjeevnios.in/login (and /clinic/login, /admin/login): a Turnstile box
   appears and "Continue" stays disabled until it is solved. Proof the server enforces it (not just the UI):
   ```
   curl -s -X POST "$SUPABASE_URL/auth/v1/otp" -H "apikey: $ANON" -H "Content-Type: application/json" \
     -d '{"phone":"+919999999999"}'          # -> error: captcha verification process failed
   ```
   Booking: with `captcha_booking='on'`, insert into `appointments` without a pass -> `CAPTCHA_REQUIRED`.
3. **Database port.** From a machine that is NOT allowlisted:
   `nc -vz db.maqnfncrqtdbjqrsibyq.supabase.co 5432` -> must time out/refuse. (On Free this will still connect - that is
   the open gap above, closed by Pro + `lock-db-network.sh`.)
4. **Edge:** `curl -I -A "python-requests/2" https://www.sanjeevnios.in/` -> 403 challenge; `curl -I https://www.sanjeevnios.in/.env` -> 403.
