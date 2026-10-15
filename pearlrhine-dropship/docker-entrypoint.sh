#!/bin/sh
# Datenverzeichnis anlegen und den Prozess als User node starten (PID 1 = node, damit SIGTERM SQLite schließt).
set -eu
dir="${DATA_DIR:-/data}"
mkdir -p "$dir"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$dir"
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all node dist/server.js
  fi
  exec su -s /bin/sh node -c 'exec node dist/server.js'
fi
exec node dist/server.js
