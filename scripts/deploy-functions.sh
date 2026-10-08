#!/usr/bin/env bash
# Deploy every edge function, then re-apply the two that must stay PUBLIC
# (no Supabase JWT check; they verify their own signatures instead):
#   razorpay-webhook   - Razorpay calls it
#   send-whatsapp-otp  - Supabase Auth's Send-SMS hook calls it
#   SUPABASE_ACCESS_TOKEN=sbp_... ./scripts/deploy-functions.sh
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?}"
REF="${PROJECT_REF:-maqnfncrqtdbjqrsibyq}"
npx supabase functions deploy --project-ref "$REF" --use-api
npx supabase functions deploy razorpay-webhook --no-verify-jwt --project-ref "$REF" --use-api
npx supabase functions deploy send-whatsapp-otp --no-verify-jwt --project-ref "$REF" --use-api
