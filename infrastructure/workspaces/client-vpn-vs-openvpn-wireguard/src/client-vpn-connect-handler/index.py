"""AWS Client VPN client connect handler.

Runs after certificate authentication and before the authorization rules. Rejects certificate
common names listed in DENIED_COMMON_NAMES, which removes a user without touching the CRL or
re-issuing certificates. Every decision is logged as one JSON line for auditing.
"""

import json
import os

DENIED_COMMON_NAMES = set(json.loads(os.environ.get("DENIED_COMMON_NAMES", "[]")))


def handler(event, _context):
    common_name = event.get("common-name", "")
    allowed = common_name not in DENIED_COMMON_NAMES
    print(
        json.dumps(
            {
                "decision": "allow" if allowed else "deny",
                "common-name": common_name,
                "connection-id": event.get("connection-id"),
                "public-ip": event.get("public-ip"),
                "platform": event.get("platform"),
                "client-openvpn-version": event.get("client-openvpn-version"),
            }
        )
    )
    return {
        "allow": allowed,
        "error-msg-on-denied-connection": "" if allowed else "This device is no longer authorized.",
        "posture-compliance-statuses": [],
        "schema-version": "v3",
    }
