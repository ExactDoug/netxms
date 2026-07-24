#!/usr/bin/env bash
# Run the locally-built RWT web client WAR against a THROWAWAY NetXMS server
# stack (does not touch production DH01). Mirrors the proven CI recipe.
#
#   ./run-web-local.sh up     # bring up throwaway server + serve the WAR
#   ./run-web-local.sh down   # tear everything down
#
# After 'up': browse http://127.0.0.1:8080/  (accept the admin password it prints).
# Use Chrome device toolbar to test the responsive breakpoints (<=699 narrow,
# <=1199 compact, wide).
set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$WORKTREE")"
DOCKER_SRC="$PARENT/netxms-docker-src"
WEB_CTR="nxmc-web-local"
TARGET="$WORKTREE/src/client/nxmc/java/target"

up() {
  WAR="$(find "$TARGET" -maxdepth 1 -name '*.war' -print -quit || true)"
  [[ -n "$WAR" ]] || { echo "ERROR: no WAR in $TARGET — run ./build-web-war.sh first"; exit 1; }
  echo "Using WAR: $WAR"

  # 1. Throwaway NetXMS backend (db + agent + init + server) via upstream compose.
  if [[ ! -d "$DOCKER_SRC" ]]; then
    git clone --depth 1 https://github.com/netxms/docker.git "$DOCKER_SRC"
  fi
  cd "$DOCKER_SRC/deployment-example"
  [[ -f .env ]] || cp .env.example .env
  sed -i 's/^NETXMS_VERSION=.*/NETXMS_VERSION=latest/' .env
  # publish 4701 (client API) on the host so the web container can reach it
  sed -i 's/48920:4701/4701:4701/' compose.yaml || true
  docker compose up -d db agent init server

  echo "Waiting for server API on 127.0.0.1:4701..."
  for i in $(seq 1 120); do
    (echo > /dev/tcp/127.0.0.1/4701) >/dev/null 2>&1 && break
    sleep 2
  done

  docker compose logs --no-color init | tee /tmp/nxmc-init.log >/dev/null || true
  ADMIN_PASSWORD="$(sed -n 's/.*Password:[[:space:]]*//p' /tmp/nxmc-init.log | tail -1 | tr -d '\r' || true)"
  # clear "must change password" + grace logins so auto-login works
  docker compose exec -T db psql -U netxms -d netxms \
    -c 'UPDATE users SET flags = flags & ~8, grace_logins = 5 WHERE id = 1;' || true

  # 2. Serve OUR war in Tomcat, host network so it reaches 127.0.0.1:4701.
  docker rm -f "$WEB_CTR" >/dev/null 2>&1 || true
  docker run -d --name "$WEB_CTR" --network host \
    -v "$WAR:/usr/local/tomcat/webapps/ROOT.war:ro" \
    tomcat:10.1-jdk17-temurin

  echo
  echo "=================================================================="
  echo " Web client:  http://127.0.0.1:8080/"
  echo " Login:       admin / ${ADMIN_PASSWORD:-<see: docker compose logs init>}"
  echo " Server addr: 127.0.0.1 (throwaway stack)"
  echo " Tear down:   ./run-web-local.sh down"
  echo "=================================================================="
}

down() {
  docker rm -f "$WEB_CTR" >/dev/null 2>&1 || true
  if [[ -d "$DOCKER_SRC/deployment-example" ]]; then
    cd "$DOCKER_SRC/deployment-example"
    docker compose down -v || true
  fi
  echo "Torn down."
}

case "${1:-up}" in
  up)   up ;;
  down) down ;;
  *)    echo "usage: $0 {up|down}"; exit 1 ;;
esac
