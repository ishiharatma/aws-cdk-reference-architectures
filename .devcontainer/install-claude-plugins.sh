#!/usr/bin/env bash
# Register marketplaces and install plugins declared in .claude/settings.json.
# Never fails the container build: SSH access to the private marketplace is optional.
SETTINGS=".claude/settings.json"

if ! command -v claude >/dev/null 2>&1; then
    echo "⚠️ claude CLI not found. Skipping plugin installation."
    exit 0
fi
if [ ! -f "$SETTINGS" ]; then
    echo "⚠️ $SETTINGS not found. Skipping plugin installation."
    exit 0
fi

# Trust GitHub host key so git over SSH does not prompt
mkdir -p ~/.ssh
ssh-keygen -F github.com >/dev/null 2>&1 || ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null

node -e '
const s = require("./'"$SETTINGS"'");
for (const [name, m] of Object.entries(s.extraKnownMarketplaces || {})) {
  const src = m.source || {};
  console.log(`M\t${name}\t${src.source === "github" ? src.repo : src.url}`);
}
for (const p of s.enabledPlugins || []) console.log(`P\t${p.plugin}\t${p.marketplace}`);
' | while IFS=$'\t' read -r kind a b; do
    if [ "$kind" = "M" ]; then
        echo "Adding marketplace: $a ($b)"
        claude plugin marketplace add "$b" || echo "⚠️ Failed to add marketplace $a (check SSH agent / ssh -T git@github.com)"
    else
        echo "Installing plugin: $a@$b"
        claude plugin install "$a@$b" || echo "⚠️ Failed to install $a@$b"
    fi
done
exit 0
