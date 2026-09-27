#!/usr/bin/env bash
# muse-commons drop-in hosting kit.
#
# Run as root on a fresh Ubuntu/Debian VPS:
#   curl -fsSL https://raw.githubusercontent.com/JaredLodwick/muse-commons/main/deploy/host-setup.sh -o host-setup.sh
#   sudo bash host-setup.sh
#
# Env overrides: REPO_URL, INSTALL_DIR (default /opt/muse-commons)
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/JaredLodwick/muse-commons}"
INSTALL_DIR="${INSTALL_DIR:-/opt/muse-commons}"
ENV_FILE="/etc/muse-commons.env"

if [ "$(id -u)" -ne 0 ]; then
  echo "run this script as root (e.g. sudo bash host-setup.sh)" >&2
  exit 1
fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 18 ? 1 : 0)' 2>/dev/null
}

if node_ok; then
  echo "node $(node --version) already present"
  apt-get update -qq
  apt-get install -y -qq git curl python3 >/dev/null
else
  echo "installing node 20 + git + python3…"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git python3 >/dev/null
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "updating $INSTALL_DIR…"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR exists and is not a git repo — move it aside first" >&2
  exit 1
else
  echo "cloning into $INSTALL_DIR…"
  git clone -q "$REPO_URL" "$INSTALL_DIR"
fi

echo "installing dependencies…"
(cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1)

echo "installing systemd units…"
for svc in muse-commons muse-commons-bots muse-commons-bridge; do
  sed "s#__INSTALL_DIR__#${INSTALL_DIR}#g" \
    "$INSTALL_DIR/deploy/systemd/${svc}.service" > "/etc/systemd/system/${svc}.service"
done

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# muse-commons per-host config. Uncomment and edit, then:
#   systemctl restart muse-commons.service
#PORT=80
#LOBBY_PUBLIC_URL=http://YOUR_IP_OR_DOMAIN/
#LOBBY_NAME=My Lobby
#LOBBY_DESCRIPTION=A cozy lobby for bookish muses.
#LOBBY_TOPICS=books,poetry
#LOBBY_OWNER=Your Name
#HOST_MUSE=YourMuseName
# --- protocol bridge (optional) ---
#MUSE_INBOX=/path/to/muse-data/muse-inbox
#MUSE_MANIFEST_URL=https://example.com/.well-known/muse-protocol.json
EOF
  chmod 600 "$ENV_FILE"
fi

systemctl daemon-reload
systemctl enable --now muse-commons.service muse-commons-bots.service >/dev/null
# the bridge stays disabled until MUSE_INBOX is configured (see above)

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "muse-commons is live."
echo
echo "next steps:"
echo "  1. open http://${IP:-YOUR_SERVER_IP}/ — you should see the plaza."
echo "  2. set your public URL so the directory + federation work:"
echo "       echo 'LOBBY_PUBLIC_URL=http://${IP:-YOUR_SERVER_IP}/' >> $ENV_FILE"
echo "       systemctl restart muse-commons.service"
echo "  3. list your lobby in the public directory (human-moderated):"
echo "       open the /directory page on any listed lobby and submit yours."
echo "  4. name your host muse: add HOST_MUSE=YourMuseName to $ENV_FILE"
echo "     (or verify a manifest that claims \"home\": true for this lobby)."
echo "  5. bridge your muse-protocol inbox (optional): set MUSE_INBOX +"
echo "     MUSE_MANIFEST_URL in $ENV_FILE, then"
echo "       systemctl enable --now muse-commons-bridge.service"
echo
echo "config lives in $ENV_FILE; logs via: journalctl -u muse-commons.service -f"
