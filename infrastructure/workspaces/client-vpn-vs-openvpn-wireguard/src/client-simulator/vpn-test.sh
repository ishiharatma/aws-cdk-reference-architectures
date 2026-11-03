#!/bin/bash
# Runs on the client simulator (as root, through SSM Run Command).
#
#   vpn-test <client-vpn|openvpn|wireguard> <client1|client2> [blob_mb] [runs] [wg_mtu|auto]
#
# Brings up one tunnel, waits until the private target answers, measures ping RTT and HTTP
# throughput through the tunnel, then tears the tunnel down. Prints one "RESULT ..." line.
set -uo pipefail
source /etc/vpn-test.env   # REGION, PREFIX

METHOD=${1:?method}
CLIENT=${2:?client}
BLOB_MB=${3:-100}
RUNS=${4:-3}
# WireGuard only. "auto" lets wg-quick derive it from the route MTU (9001 on EC2 -> 8921).
WG_MTU=${5:-1420}
[ "$WG_MTU" = auto ] && WG_MTU=""
CONNECT_TIMEOUT=60
WORK=/run/vpn-test
mkdir -p "$WORK" && chmod 700 "$WORK"
AWS=/snap/bin/aws

param() { $AWS ssm get-parameter --region "$REGION" --name "$PREFIX/$1" --query Parameter.Value --output text; }
TARGET=$(param target/private-ip)
BUNDLE=$($AWS secretsmanager get-secret-value --region "$REGION" --secret-id "$PREFIX/clients/$CLIENT" --query SecretString --output text)
field() { echo "$BUNDLE" | jq -r ".$1"; }

inline_credentials() {
  echo "<ca>"; field ca; echo "</ca>"
  echo "<cert>"; field cert; echo "</cert>"
  echo "<key>"; field key; echo "</key>"
}

start_tunnel() {
  case "$METHOD" in
    client-vpn)
      local endpoint
      endpoint=$(param client-vpn/endpoint-id)
      # The exported profile already carries the CA; only the client certificate and key are added.
      # Piped through cat on purpose: the snap build of AWS CLI v2 writes nothing when its stdout is
      # redirected straight to a file under SSM Run Command (observed on Ubuntu 24.04, CLI 2.35).
      $AWS ec2 export-client-vpn-client-configuration --region "$REGION" \
        --client-vpn-endpoint-id "$endpoint" --output text 2> "$WORK/export.err" | cat > "$WORK/vpn.ovpn"
      if ! grep -q '^remote ' "$WORK/vpn.ovpn"; then
        echo "export-client-vpn-client-configuration failed: $(cat "$WORK/export.err")" > "$WORK/openvpn.log"
        return 1
      fi
      { echo "<cert>"; field cert; echo "</cert>"; echo "<key>"; field key; echo "</key>"; } >> "$WORK/vpn.ovpn"
      openvpn --config "$WORK/vpn.ovpn" --daemon --writepid "$WORK/openvpn.pid" --log "$WORK/openvpn.log"
      ;;
    openvpn)
      {
        echo "client"
        echo "dev tun"
        echo "proto udp"
        echo "remote $(param openvpn/public-ip) 1194"
        echo "nobind"
        echo "remote-cert-tls server"
        echo "data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305"
        echo "verb 3"
        inline_credentials
      } > "$WORK/vpn.ovpn"
      openvpn --config "$WORK/vpn.ovpn" --daemon --writepid "$WORK/openvpn.pid" --log "$WORK/openvpn.log"
      ;;
    wireguard)
      umask 077
      cat > /etc/wireguard/wgtest.conf <<EOF
[Interface]
PrivateKey = $(field wgPrivateKey)
Address = $(field wgAddress)
${WG_MTU:+MTU = $WG_MTU}

[Peer]
PublicKey = $(param wireguard/server-public-key)
Endpoint = $(param wireguard/public-ip):51820
AllowedIPs = $(param target/vpc-cidr)
PersistentKeepalive = 25
EOF
      wg-quick up wgtest > "$WORK/wg.log" 2>&1
      ;;
    *) echo "unknown method $METHOD" >&2; exit 2 ;;
  esac
}

stop_tunnel() {
  if [ -f "$WORK/openvpn.pid" ]; then kill "$(cat "$WORK/openvpn.pid")" 2>/dev/null; sleep 2; rm -f "$WORK/openvpn.pid"; fi
  if ip link show wgtest >/dev/null 2>&1; then wg-quick down wgtest >/dev/null 2>&1; fi
  rm -f /etc/wireguard/wgtest.conf "$WORK/vpn.ovpn"
}
trap stop_tunnel EXIT
stop_tunnel

START=$(date +%s.%N)
start_tunnel || true
CONNECTED=false
for i in $(seq 1 $((CONNECT_TIMEOUT * 2))); do
  if WHOAMI=$(curl -s --max-time 1 "http://$TARGET/whoami"); then CONNECTED=true; break; fi
  # Client VPN rejections (connect handler / auth) make openvpn exit: stop waiting early.
  # (The daemon writes its pid file shortly after start, so a missing file counts only after ~5 s.)
  if [ "$METHOD" != wireguard ] && [ "$i" -gt 10 ] && \
     { [ ! -f "$WORK/openvpn.pid" ] || ! kill -0 "$(cat "$WORK/openvpn.pid")" 2>/dev/null; }; then break; fi
  sleep 0.5
done
END=$(date +%s.%N)
CONNECT_S=$(echo "$END - $START" | bc)

if [ "$CONNECTED" != true ]; then
  echo "RESULT method=$METHOD client=$CLIENT status=failed waited_s=$CONNECT_S"
  echo "--- client log (tail) ---"
  if [ -f "$WORK/openvpn.log" ]; then tail -n 15 "$WORK/openvpn.log"; fi
  if ip link show wgtest >/dev/null 2>&1; then wg show wgtest; fi
  exit 0
fi

RTT=$(ping -c 20 -i 0.2 -q "$TARGET" | awk -F'/' '/^rtt/ {print $5}')
SPEEDS=()
for _ in $(seq 1 "$RUNS"); do
  BPS=$(curl -s -o /dev/null --max-time 120 -w '%{speed_download}' "http://$TARGET/blob?mb=$BLOB_MB")
  SPEEDS+=("$(echo "scale=1; $BPS * 8 / 1000000" | bc)")
done
REMOTE=$(echo "$WHOAMI" | jq -r .remote_addr)
TUN_IF=$(ip route get "$TARGET" | awk '{for (i=1;i<=NF;i++) if ($i=="dev") print $(i+1)}')
MTU=$(cat "/sys/class/net/$TUN_IF/mtu")
echo "RESULT method=$METHOD client=$CLIENT status=connected connect_s=$CONNECT_S rtt_avg_ms=$RTT" \
  "throughput_mbps=$(IFS=,; echo "${SPEEDS[*]}") target_saw=$REMOTE tun_if=$TUN_IF mtu=$MTU"
