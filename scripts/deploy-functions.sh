#!/usr/bin/env bash
# Deploy every edge function, then re-apply the three that must stay PUBLIC
# (no Supabase JWT check; each checks its callers itself instead):
#   razorpay-webhook   - Razorpay calls it (signed)
#   send-whatsapp-otp  - Supabase Auth's Send-SMS hook calls it (signed)
#   send-push          - the database calls it with alert ids only, and it
#                        sends only real, unsent patient alerts (migration 93)
#
#   ./scripts/deploy-functions.sh
#
# It asks for a Supabase access token (supabase.com/dashboard/account/tokens)
# and reads it hidden, so the token never shows on screen or lands in your
# Terminal history. (SUPABASE_ACCESS_TOKEN set beforehand is used as is.)
set -euo pipefail
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  read -r -s -p "Paste your Supabase access token (it won't show), then press Enter: " SUPABASE_ACCESS_TOKEN
  echo
fi
if [[ "${SUPABASE_ACCESS_TOKEN}" != sbp_* ]]; then
  echo "That doesn't look like an access token (they start with sbp_). Nothing was deployed." >&2
  exit 1
fi
export SUPABASE_ACCESS_TOKEN
REF="${PROJECT_REF:-maqnfncrqtdbjqrsibyq}"
npx supabase functions deploy --project-ref "$REF" --use-api
npx supabase functions deploy razorpay-webhook --no-verify-jwt --project-ref "$REF" --use-api
npx supabase functions deploy send-whatsapp-otp --no-verify-jwt --project-ref "$REF" --use-api
npx supabase functions deploy send-push --no-verify-jwt --project-ref "$REF" --use-api
echo "Done: every function is deployed."
