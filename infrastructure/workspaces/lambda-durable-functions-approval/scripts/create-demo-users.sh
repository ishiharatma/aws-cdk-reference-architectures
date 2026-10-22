#!/usr/bin/env bash
# Create (or reset) the two demo users of the demo web UI: one requester and one approver.
#
#   ./scripts/create-demo-users.sh <user-pool-id> <requester-email> <approver-email> [aws cli args...]
#
# The e-mail addresses are only sign-in names: invitations are suppressed and no mail is sent.
# A random permanent password is generated per user and printed once.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: $0 <user-pool-id> <requester-email> <approver-email> [aws cli args...]" >&2
  exit 1
fi
POOL_ID=$1; REQUESTER=$2; APPROVER=$3; shift 3

# 20 characters that satisfy the pool policy (upper, lower, digit, symbol).
gen_password() {
  local base
  base=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
  echo "${base}Aa1!"
}

create_user() { # email group
  local email=$1 group=$2 password
  password=$(gen_password)
  aws cognito-idp admin-create-user "${AWS_ARGS[@]}" --user-pool-id "$POOL_ID" --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --message-action SUPPRESS >/dev/null 2>&1 || true   # already exists: reset below
  aws cognito-idp admin-set-user-password "${AWS_ARGS[@]}" --user-pool-id "$POOL_ID" \
    --username "$email" --password "$password" --permanent
  aws cognito-idp admin-add-user-to-group "${AWS_ARGS[@]}" --user-pool-id "$POOL_ID" \
    --username "$email" --group-name "$group"
  printf '%-10s %-40s %s\n' "$group" "$email" "$password"
}

AWS_ARGS=("$@")
printf '%-10s %-40s %s\n' GROUP USER PASSWORD
create_user "$REQUESTER" requesters
create_user "$APPROVER" approvers
