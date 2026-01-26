#!/bin/bash

#######################################
# Quick Test Script
#
# Sends 5 test messages to verify the setup
#######################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Running quick test (5 messages)..."
echo

"${SCRIPT_DIR}/send-messages.sh" --env dev --project drillexercises --count 5 "$@"
