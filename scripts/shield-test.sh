#!/usr/bin/env bash
# Verifies the edge shield. Usage:
#   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon> ./scripts/shield-test.sh
# Optional: SITE=https://www.sanjeevnios.in
set -u
: "${SUPABASE_URL:?set SUPABASE_URL}"; : "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"
SITE="${SITE:-https://www.sanjeevnios.in}"
HOST="$(echo "$SUPABASE_URL" | sed -E 's#https?://##; s#/.*##')"
DB_HOST="db.${HOST}"
pass=0; fail=0
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
bad(){ echo "  FAIL  $1"; fail=$((fail+1)); }

echo "1) API rate limit - 'search' class allows 240/min per IP; sending 300 reads"
codes=$(for i in $(seq 1 300); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
    "$SUPABASE_URL/rest/v1/clinics?select=id&limit=1"
done)
n429=$(echo "$codes" | grep -c '^429$'); n200=$(echo "$codes" | grep -c '^200$')
echo "     200 x $n200, 429 x $n429"
[ "$n429" -gt 0 ] && ok "throttled with HTTP 429 after the limit" || bad "never throttled (is migration 74 applied and guard.settings rate_limit = enforce?)"
echo "     Retry-After header:"
curl -s -D - -o /dev/null -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  "$SUPABASE_URL/rest/v1/clinics?select=id&limit=1" | grep -iE '^(HTTP|retry-after)'

echo "2) Website edge - scripted client + scanner probe"
c=$(curl -s -o /dev/null -w "%{http_code}" -A "python-requests/2.0" "$SITE/")
case "$c" in 403|429) ok "scripted user-agent challenged/blocked ($c)";; *) bad "scripted user-agent got $c (expected 403/429 from Cloudflare)";; esac
c=$(curl -s -o /dev/null -w "%{http_code}" "$SITE/.env")
[ "$c" = "403" ] && ok "/.env probe blocked (403)" || bad "/.env probe got $c"
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST -A "Mozilla/5.0" "$SITE/")
[ "$c" = "403" ] && ok "POST to static site blocked (403)" || bad "POST got $c"
server=$(curl -sI -A "Mozilla/5.0" "$SITE/" | tr -d '\r' | grep -i '^server:')
echo "     $server"
echo "$server" | grep -qi cloudflare && ok "site is served through Cloudflare" || bad "site is NOT behind Cloudflare"

echo "3) Database port must NOT be reachable from the public internet"
for port in 5432 6543; do
  if nc -z -w 5 "$DB_HOST" "$port" 2>/dev/null; then bad "$DB_HOST:$port is OPEN to the internet"
  else ok "$DB_HOST:$port is closed/unreachable"; fi
done

echo; echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
