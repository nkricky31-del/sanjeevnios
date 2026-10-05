#!/usr/bin/env bash
# Locks the Postgres port to an allowlist. REQUIRES the Supabase PRO plan
# (Network Restrictions is not available on Free).
#   SUPABASE_ACCESS_TOKEN=sbp_... PROJECT_REF=maqnfncrqtdbjqrsibyq \
#   ALLOW_CIDRS="203.0.113.7/32" ./scripts/lock-db-network.sh
# The API (PostgREST/Auth/Storage/Edge Functions) keeps working: network
# restrictions only gate DIRECT Postgres/pooler connections (5432 / 6543).
set -euo pipefail
: "${SUPABASE_ACCESS_TOKEN:?}"; : "${PROJECT_REF:?}"; : "${ALLOW_CIDRS:?comma-separated IPv4 CIDRs, e.g. your office/VPN egress}"
args=(); IFS=',' read -ra cidrs <<<"$ALLOW_CIDRS"
for c in "${cidrs[@]}"; do args+=(--db-allow-cidr "$c"); done
npx supabase network-restrictions update --project-ref "$PROJECT_REF" "${args[@]}" --experimental
npx supabase network-restrictions get --project-ref "$PROJECT_REF" --experimental
