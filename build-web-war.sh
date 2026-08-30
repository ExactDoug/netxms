#!/usr/bin/env bash
# Fully containerized build of the NetXMS RWT web client WAR.
# Nothing is installed on the host: all Java/Maven work happens inside
# maven:3-eclipse-temurin-17. Produces src/client/nxmc/java/target/*.war.
#
# Layout (all under .worktrees/):
#   rwt-responsive-shell/   <- this worktree (mounted at /work)
#   zest-rwt/               <- unreleased dependency source (mounted at /zest)
#   .m2-cache/              <- persistent Maven repo (mounted at /root/.m2)
set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$WORKTREE")"
ZEST="$PARENT/zest-rwt"
M2="$PARENT/.m2-cache"
IMAGE="maven:3-eclipse-temurin-17"

[[ -f "$ZEST/pom.xml" ]] || { echo "ERROR: zest-rwt not found at $ZEST"; exit 1; }
mkdir -p "$M2"

echo "== Building web WAR inside $IMAGE =="
echo "   worktree: $WORKTREE"
echo "   zest-rwt: $ZEST"
echo "   .m2 cache: $M2"

docker run --rm \
  -v "$WORKTREE":/work \
  -v "$ZEST":/zest \
  -v "$M2":/root/.m2 \
  -w /work \
  "$IMAGE" \
  bash -euxo pipefail -c '
    # 1. NetXMS base + client libs into local .m2
    mvn -B -f /work/src/java-common/netxms-base/pom.xml   -DskipTests install
    mvn -B -f /work/src/client/java/netxms-client/pom.xml -DskipTests install
    # 2. unreleased zest-rwt dependency
    mvn -B -f /zest/pom.xml -DskipTests install
    # 3. the RWT web client WAR
    mvn -B -f /work/src/client/nxmc/java/pom.xml -Pweb \
        -Dnetxms.build.disablePlatformProfile=true -DskipTests package
  '

echo
echo "== Build complete. WAR(s): =="
find "$WORKTREE/src/client/nxmc/java/target" -maxdepth 1 -name '*.war' -printf '%p  %s bytes\n'
