#!/bin/bash
# =============================================================================
# setup-pki.sh — create the key material for the three VPN methods (run BEFORE cdk deploy)
#
#   ./setup-pki.sh --project <project> --env <env> [--profile <profile>] [--region <region>]
#   ./setup-pki.sh --project <project> --env <env> --delete     # after cdk destroy
#
# Creates (all under /<project>/<env>/vpn/):
#   - a private CA, a server certificate and two client certificates (client2 is revoked in the CRL)
#   - ACM import of the server certificate             -> acm/server-cert-arn (SSM)
#   - OpenVPN server bundle {ca, cert, key, crl}        -> openvpn/server (Secrets Manager)
#   - WireGuard server key / public key / peer list    -> wireguard/server (SM), wireguard/* (SSM)
#   - per-client bundles {ca, cert, key, wgPrivateKey, wgAddress} -> clients/<name> (SM)
#
# Private keys never enter a CloudFormation template; the stacks reference these names only.
# Local files are kept in ./.pki (git-ignored). Re-running reuses them and updates AWS in place.
#
# Requirements: aws CLI v2, openssl 3, jq
# =============================================================================
set -euo pipefail

PROJECT=""
ENV_NAME=""
PROFILE=""
REGION="ap-northeast-1"
DELETE=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKI_DIR="$SCRIPT_DIR/.pki"
CLIENTS=(client1 client2)
REVOKED_CLIENT=client2
# Only client1 is registered as a WireGuard peer: an unregistered key is WireGuard's "revocation".
WG_PEERS=(client1)
# Must match wireGuard.tunnelCidr in parameters/*-params.ts (.1 is the server).
WG_TUNNEL_PREFIX="10.122.0"
CRL_DAYS=365

print_message() {
  local color=$1; shift
  case $color in
    green) printf '\033[32m%s\033[0m\n' "$*" ;;
    yellow) printf '\033[33m%s\033[0m\n' "$*" ;;
    red) printf '\033[31m%s\033[0m\n' "$*" >&2 ;;
    *) echo "$*" ;;
  esac
}

usage() {
  sed -n '3,6p' "$0"
  exit 1
}

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --project) PROJECT=$2; shift 2 ;;
      --env) ENV_NAME=$2; shift 2 ;;
      --profile) PROFILE=$2; shift 2 ;;
      --region) REGION=$2; shift 2 ;;
      --delete) DELETE=true; shift ;;
      -h|--help) usage ;;
      *) print_message red "Unknown option: $1"; usage ;;
    esac
  done
  [ -n "$PROJECT" ] && [ -n "$ENV_NAME" ] || usage
  PROFILE=${PROFILE:-$PROJECT-$ENV_NAME}
  PREFIX="/$PROJECT/$ENV_NAME/vpn"
}

check_requirements() {
  for cmd in aws openssl jq; do
    command -v "$cmd" >/dev/null || { print_message red "$cmd is required"; exit 1; }
  done
}

aws_cmd() { aws --profile "$PROFILE" --region "$REGION" "$@"; }

verify_credentials() {
  local account
  account=$(aws_cmd sts get-caller-identity --query Account --output text)
  print_message green "Account: $account  Region: $REGION  Prefix: $PREFIX"
}

# ---- local PKI -------------------------------------------------------------

write_ca_config() {
  cat > "$PKI_DIR/ca.cnf" <<EOF
[ ca ]
default_ca = vpn_ca
[ vpn_ca ]
dir = $PKI_DIR
database = \$dir/index.txt
new_certs_dir = \$dir/newcerts
serial = \$dir/serial
crlnumber = \$dir/crlnumber
certificate = \$dir/ca.crt
private_key = \$dir/ca.key
default_md = sha256
default_days = 825
default_crl_days = $CRL_DAYS
policy = policy_any
unique_subject = no
copy_extensions = copy
[ policy_any ]
commonName = supplied
[ ca_ext ]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[ server_ext ]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
[ client_ext ]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF
}

# Backdated by one hour so a skewed clock on the issuing machine or a server cannot make a fresh
# certificate "not yet valid".
start_date() { date -u -d '1 hour ago' +%Y%m%d%H%M%SZ; }

issue_cert() {
  local name=$1 cn=$2 ext=$3
  [ -f "$PKI_DIR/$name.crt" ] && return 0
  # Client VPN accepts only 1024/2048-bit RSA keys.
  openssl req -new -newkey rsa:2048 -nodes -keyout "$PKI_DIR/$name.key" -out "$PKI_DIR/$name.csr" \
    -subj "/CN=$cn" ${4:+-addext "subjectAltName=$4"} 2>/dev/null
  openssl ca -batch -config "$PKI_DIR/ca.cnf" -extensions "$ext" -startdate "$(start_date)" -in "$PKI_DIR/$name.csr" \
    -out "$PKI_DIR/$name.crt" -notext 2>/dev/null
  chmod 600 "$PKI_DIR/$name.key"
}

build_pki() {
  mkdir -p "$PKI_DIR/newcerts" && chmod 700 "$PKI_DIR"
  [ -f "$PKI_DIR/index.txt" ] || { touch "$PKI_DIR/index.txt"; echo 1000 > "$PKI_DIR/serial"; echo 1000 > "$PKI_DIR/crlnumber"; }
  write_ca_config
  if [ ! -f "$PKI_DIR/ca.crt" ]; then
    openssl req -new -newkey rsa:2048 -nodes -keyout "$PKI_DIR/ca.key" -out "$PKI_DIR/ca.csr" \
      -subj "/CN=$PROJECT-$ENV_NAME VPN CA" 2>/dev/null
    openssl ca -batch -selfsign -config "$PKI_DIR/ca.cnf" -keyfile "$PKI_DIR/ca.key" -extensions ca_ext \
      -startdate "$(start_date)" -days 3650 -in "$PKI_DIR/ca.csr" -out "$PKI_DIR/ca.crt" -notext 2>/dev/null
    chmod 600 "$PKI_DIR/ca.key"
  fi
  issue_cert server server.vpn.internal server_ext "DNS:server.vpn.internal"
  for c in "${CLIENTS[@]}"; do issue_cert "$c" "$c.vpn.internal" client_ext; done

  if ! grep -q "^R.*CN=$REVOKED_CLIENT.vpn.internal" "$PKI_DIR/index.txt"; then
    openssl ca -config "$PKI_DIR/ca.cnf" -revoke "$PKI_DIR/$REVOKED_CLIENT.crt" 2>/dev/null
  fi
  # Regenerated on every run: OpenVPN refuses all clients once nextUpdate has passed.
  openssl ca -config "$PKI_DIR/ca.cnf" -gencrl -out "$PKI_DIR/crl.pem" 2>/dev/null
  print_message green "PKI ready in $PKI_DIR (CRL valid $CRL_DAYS days, $REVOKED_CLIENT revoked)"
}

# WireGuard keys are raw X25519 keys in base64; openssl can produce them without wireguard-tools.
wg_keypair() {
  local name=$1
  [ -f "$PKI_DIR/$name.wg.key" ] && return 0
  openssl genpkey -algorithm X25519 -outform DER -out "$PKI_DIR/$name.wg.der"
  tail -c 32 "$PKI_DIR/$name.wg.der" | base64 > "$PKI_DIR/$name.wg.key"
  openssl pkey -inform DER -in "$PKI_DIR/$name.wg.der" -pubout -outform DER | tail -c 32 | base64 > "$PKI_DIR/$name.wg.pub"
  rm -f "$PKI_DIR/$name.wg.der"
  chmod 600 "$PKI_DIR/$name.wg.key"
}

# ---- AWS -------------------------------------------------------------------

put_secret() {
  local name=$1 value=$2
  if aws_cmd secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    aws_cmd secretsmanager put-secret-value --secret-id "$name" --secret-string "$value" >/dev/null
  else
    aws_cmd secretsmanager create-secret --name "$name" --description "VPN key material (setup-pki.sh)" \
      --secret-string "$value" >/dev/null
  fi
  print_message green "  secret  $name"
}

put_param() {
  aws_cmd ssm put-parameter --name "$1" --type String --value "$2" --overwrite >/dev/null
  print_message green "  param   $1"
}

import_server_cert() {
  local arn files=(--certificate "fileb://$PKI_DIR/server.crt" --private-key "fileb://$PKI_DIR/server.key"
    --certificate-chain "fileb://$PKI_DIR/ca.crt")
  arn=$(aws_cmd ssm get-parameter --name "$PREFIX/acm/server-cert-arn" --query Parameter.Value --output text 2>/dev/null || true)
  if [ -n "$arn" ]; then
    # Re-importing into the same ARN keeps the Client VPN endpoint pointing at it (tags not allowed here).
    aws_cmd acm import-certificate --certificate-arn "$arn" "${files[@]}" >/dev/null
  else
    arn=$(aws_cmd acm import-certificate "${files[@]}" \
      --tags Key=Project,Value="$PROJECT" Key=Environment,Value="$ENV_NAME" --query CertificateArn --output text)
  fi
  put_param "$PREFIX/acm/server-cert-arn" "$arn"
}

publish() {
  for c in "${CLIENTS[@]}" server; do wg_keypair "$c"; done

  import_server_cert

  put_secret "$PREFIX/openvpn/server" "$(jq -n \
    --rawfile ca "$PKI_DIR/ca.crt" --rawfile cert "$PKI_DIR/server.crt" \
    --rawfile key "$PKI_DIR/server.key" --rawfile crl "$PKI_DIR/crl.pem" \
    '{ca: $ca, cert: $cert, key: $key, crl: $crl}')"

  put_secret "$PREFIX/wireguard/server" "$(jq -n --arg k "$(cat "$PKI_DIR/server.wg.key")" '{privateKey: $k}')"
  put_param "$PREFIX/wireguard/server-public-key" "$(cat "$PKI_DIR/server.wg.pub")"

  local peers='[]' i=2
  for c in "${CLIENTS[@]}"; do
    local address="$WG_TUNNEL_PREFIX.$i/32"
    if [[ " ${WG_PEERS[*]} " == *" $c "* ]]; then
      peers=$(echo "$peers" | jq --arg n "$c" --arg k "$(cat "$PKI_DIR/$c.wg.pub")" --arg a "$address" \
        '. + [{name: $n, publicKey: $k, address: $a}]')
    fi
    put_secret "$PREFIX/clients/$c" "$(jq -n \
      --rawfile ca "$PKI_DIR/ca.crt" --rawfile cert "$PKI_DIR/$c.crt" --rawfile key "$PKI_DIR/$c.key" \
      --arg wk "$(cat "$PKI_DIR/$c.wg.key")" --arg wa "$address" \
      '{ca: $ca, cert: $cert, key: $key, wgPrivateKey: $wk, wgAddress: $wa}')"
    i=$((i + 1))
  done
  put_param "$PREFIX/wireguard/peers" "$peers"
}

delete_all() {
  local arn
  arn=$(aws_cmd ssm get-parameter --name "$PREFIX/acm/server-cert-arn" --query Parameter.Value --output text 2>/dev/null || true)
  if [ -n "$arn" ]; then
    aws_cmd acm delete-certificate --certificate-arn "$arn" && print_message green "  deleted $arn"
  fi
  for s in openvpn/server wireguard/server "${CLIENTS[@]/#/clients/}"; do
    aws_cmd secretsmanager delete-secret --secret-id "$PREFIX/$s" --force-delete-without-recovery >/dev/null 2>&1 \
      && print_message green "  deleted secret $PREFIX/$s"
  done
  for p in acm/server-cert-arn wireguard/server-public-key wireguard/peers; do
    aws_cmd ssm delete-parameter --name "$PREFIX/$p" >/dev/null 2>&1 && print_message green "  deleted param $PREFIX/$p"
  done
  print_message yellow "Local files in $PKI_DIR were kept; remove them manually if no longer needed."
}

main() {
  parse_args "$@"
  check_requirements
  verify_credentials
  if [ "$DELETE" = true ]; then
    delete_all
  else
    build_pki
    publish
    print_message green "Done. Deploy the stacks next."
  fi
}

main "$@"
