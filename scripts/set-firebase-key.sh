#!/usr/bin/env bash
# Stores the Firebase service key as the FIREBASE_SERVICE_ACCOUNT secret of the
# Supabase functions. send-push signs in to Firebase with it to send patients'
# alerts to their phones.
#
#   ./scripts/set-firebase-key.sh [path/to/the-key.json]
#
# Get the key in the Firebase console: Project settings > Service accounts >
# Generate new private key (a .json file downloads). This asks for the file
# (drag it into the Terminal window) and for a Supabase access token
# (supabase.com/dashboard/account/tokens), read hidden. The key goes from the
# file straight to Supabase: it is never shown, nor kept anywhere else. You can
# delete the downloaded file afterwards; Firebase can always make a new one.
set -euo pipefail

KEY_FILE="${1:-}"
if [ -z "$KEY_FILE" ]; then
  read -r -p "Drag the Firebase key file (.json) here, or type its path, then press Enter: " KEY_FILE
fi
# A file dragged into Terminal comes with quotes, or backslashes before spaces.
KEY_FILE="$(printf '%s' "$KEY_FILE" | sed -e "s/^[\"']//" -e "s/[\"'][[:space:]]*$//" -e 's/\\ / /g' -e 's/[[:space:]]*$//')"
if [ ! -f "$KEY_FILE" ]; then
  echo "There's no file at: $KEY_FILE. Nothing was changed." >&2
  exit 1
fi

# Is it a Firebase service key? (Checked without showing any of it.)
if ! node -e '
  const k = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (k.type !== "service_account" || !k.project_id || !k.client_email || !String(k.private_key || "").includes("PRIVATE KEY")) process.exit(1);
  console.log("Firebase project: " + k.project_id);
' "$KEY_FILE" 2>/dev/null; then
  echo "That file isn't a Firebase service key (Project settings > Service accounts > Generate new private key). Nothing was changed." >&2
  exit 1
fi

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  read -r -s -p "Paste your Supabase access token (it won't show), then press Enter: " SUPABASE_ACCESS_TOKEN
  echo
fi
if [[ "${SUPABASE_ACCESS_TOKEN}" != sbp_* ]]; then
  echo "That doesn't look like an access token (they start with sbp_). Nothing was changed." >&2
  exit 1
fi
export SUPABASE_ACCESS_TOKEN
REF="${PROJECT_REF:-maqnfncrqtdbjqrsibyq}"

# Through a private temporary file rather than the command line, so the key
# never shows in the list of running programs. base64: one line, nothing to
# quote (send-push reads either form).
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
chmod 600 "$ENV_FILE"
node -e '
  const fs = require("fs");
  const key = JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1], "utf8")));
  fs.writeFileSync(process.argv[2], "FIREBASE_SERVICE_ACCOUNT=" + Buffer.from(key).toString("base64") + "\n", { mode: 0o600 });
' "$KEY_FILE" "$ENV_FILE"
npx supabase secrets set --env-file "$ENV_FILE" --project-ref "$REF"
echo "Done: send-push can now send alerts. (No need to redeploy: functions read secrets as they start.)"
