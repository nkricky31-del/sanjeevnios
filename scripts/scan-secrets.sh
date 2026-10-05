#!/usr/bin/env bash
# Fails (exit 1) if tracked source, docs or the built bundle contain something
# that looks like a real secret. Run before every commit / in CI:
#   npm run scan:secrets
# Public values are fine and are NOT flagged: the Supabase anon key
# (VITE_SUPABASE_ANON_KEY) and Razorpay key IDs (rzp_*_<id>, no secret half).
set -u
cd "$(dirname "$0")/.."

PATTERN='(rzp_(live|test)_[A-Za-z0-9]{10,}[\"'"'"' ]*[:=,][\"'"'"' ]*[A-Za-z0-9]{20,}'
PATTERN+='|sk_(live|test)_[A-Za-z0-9]{16,}'
PATTERN+='|whsec_[A-Za-z0-9]{16,}'
PATTERN+='|re_[A-Za-z0-9]{20,}'
PATTERN+='|AKIA[0-9A-Z]{16}'
PATTERN+='|-----BEGIN [A-Z ]*PRIVATE KEY-----'
PATTERN+='|(KEY_SECRET|WEBHOOK_SECRET|SERVICE_ROLE_KEY|API_KEY|PASSWORD|AUTH_TOKEN)[A-Z_]*[ ]*[:=][ ]*[\"'"'"'][A-Za-z0-9/+_.-]{16,}[\"'"'"'])'

fail=0

echo "Scanning tracked files..."
if git ls-files -z | xargs -0 grep -InE "$PATTERN" 2>/dev/null | grep -v "scripts/scan-secrets.sh"; then
  fail=1
fi

# A service-role JWT is a long eyJ... token whose payload says service_role.
echo "Scanning for JWTs that decode to the service role..."
for f in $(git ls-files); do
  [ -f "$f" ] || continue
  grep -oE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}' "$f" 2>/dev/null | while read -r t; do
    payload=$(printf '%s' "$t" | cut -d. -f2 | tr '_-' '/+')
    pad=$(( (4 - ${#payload} % 4) % 4 )); payload="$payload$(printf '=%.0s' $(seq 1 $pad))"
    if printf '%s' "$payload" | base64 -d 2>/dev/null | grep -q '"role" *: *"service_role"'; then
      echo "$f: service_role JWT"; exit 3
    fi
  done || fail=1
done

echo "Scanning for tracked env / key files..."
if git ls-files | grep -E '(^|/)\.env(\.|$)|\.(pem|p12|pfx|key)$|api_keys.*\.csv$' | grep -v '\.env\.local\.example$'; then
  fail=1
fi

if [ -d dist ]; then
  echo "Scanning the built bundle (dist/)..."
  if grep -rIlE 'service_role|KEY_SECRET|WEBHOOK_SECRET|RESEND_API_KEY' dist; then
    fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED: possible secret found above. Rotate it if it was ever real."
  exit 1
fi
echo "OK: no hard-coded secrets found."
