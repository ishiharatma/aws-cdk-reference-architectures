#!/usr/bin/env bash
# Register marketplaces and install plugins declared in .claude/settings.json.
# Never fails the container build: SSH access to the private marketplace is optional.
SETTINGS=".claude/settings.json"

# The named volume mounted at ~/.claude is created root-owned by Docker.
# Without this, the node user cannot write credentials (login fails) or plugins.
if [ -d "$HOME/.claude" ] && [ "$(stat -c %U "$HOME/.claude")" != "$(id -un)" ]; then
    sudo chown -R "$(id -un):$(id -gn)" "$HOME/.claude" || echo "⚠️ Failed to chown ~/.claude"
fi

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

# enabledPlugins accepts both the Claude Code format ({"plugin@marketplace": true})
# and the legacy list format ([{plugin, marketplace}]) this repository used before.
node -e '
const s = require("./'"$SETTINGS"'");
const known = s.extraKnownMarketplaces || {};
for (const [name, m] of Object.entries(known)) {
  const src = m.source || {};
  console.log(`M\t${name}\t${src.source === "github" ? src.repo : src.url}`);
}
const ep = s.enabledPlugins || {};
const plugins = Array.isArray(ep)
  ? ep.map((p) => [p.plugin, p.marketplace])
  : Object.entries(ep).filter(([, on]) => on === true).map(([id]) => id.split("@"));
// The official marketplace is not declared in extraKnownMarketplaces; register it if referenced.
if (!known["claude-plugins-official"] && plugins.some(([, m]) => m === "claude-plugins-official")) {
  console.log("M\tclaude-plugins-official\tanthropics/claude-plugins-official");
}
for (const [plugin, marketplace] of plugins) console.log(`P\t${plugin}\t${marketplace}`);
' | while IFS=$'\t' read -r kind a b; do
    if [ "$kind" = "M" ]; then
        echo "Adding marketplace: $a ($b)"
        claude plugin marketplace add "$b" </dev/null || echo "⚠️ Failed to add marketplace $a (check SSH agent / ssh -T git@github.com)"
    else
        echo "Installing plugin: $a@$b"
        claude plugin install "$a@$b" </dev/null || echo "⚠️ Failed to install $a@$b"
    fi
done
exit 0
