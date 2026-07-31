#!/usr/bin/env bash
# Fully containerized build of the NetXMS RWT web client WAR.
# Nothing is installed on the host: all Java/Maven work happens inside a
# digest-pinned Maven image. Produces src/client/nxmc/java/target/*.war.
#
# Layout (all under .worktrees/):
#   <this worktree>/        <- mounted at /work
#   zest-rwt/               <- unreleased dependency source (mounted at /zest)
#   .m2-build/<stamp>/      <- per-build Maven repo (mounted at /root/.m2)
#
# WHY A PER-BUILD .m2 (do not "optimize" this back to a shared cache):
#   nxmc/pom.xml runs org.netxms:unsigner-maven-plugin with processDependencies=true,
#   which REWRITES the cached org.eclipse.rap:* jars IN PLACE. A shared cache therefore
#   ends up holding artifacts whose bytes no longer match the .sha1 recorded from Maven
#   Central, so nothing in it can be re-verified against upstream afterwards. A fresh
#   repo per build keeps "what did we actually consume" answerable.
#   Pass --reuse-m2 to trade that away for speed during iteration; never for a build
#   whose artifact is going to be deployed.
#
# WHY msgfmt IS INSTALLED AND ASSERTED:
#   nxmc/pom.xml binds org.netxms:gettext-maven-plugin goal `dist`, which shells out to
#   `msgfmt --java2` to compile src/main/resources/po/*.po into i18n/Messages_<locale>.
#   The stock maven image has no gettext. The mojo then logs "Could not execute 'msgfmt'"
#   and the build STILL reports BUILD SUCCESS - silently shipping an English-only console.
#   That is exactly how a WAR 742 KB smaller than upstream's got built and nearly deployed.
#   So: install gettext, and hard-fail if msgfmt is missing or if the compiled bundles are
#   absent from the finished WAR.
set -euo pipefail

REUSE_M2="no"
for arg in "$@"; do
  case "$arg" in
    --reuse-m2) REUSE_M2="yes" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

WORKTREE="$(cd "$(dirname "$0")" && pwd)"
PARENT="$(dirname "$WORKTREE")"
ZEST="$PARENT/zest-rwt"

# Builder pinned by DIGEST, not by the floating `maven:3-eclipse-temurin-17` tag, so the
# toolchain is a recorded input rather than whatever Docker Hub served that day.
# Resolve a replacement with:  docker buildx imagetools inspect maven:3-eclipse-temurin-17
IMAGE="maven:3-eclipse-temurin-17@sha256:1ed5d1f54416b706707b4f3238f63a20bb06aab27c6d240090a2bb9ad895ed45"
IMAGE_FALLBACK_TAG="maven:3-eclipse-temurin-17"

# zest-rwt is built from source. Pin the commit so the dependency is a recorded input too;
# it is otherwise whatever origin/master happened to be at build time.
ZEST_EXPECTED_SHA="${ZEST_EXPECTED_SHA:-98589cc}"

[[ -f "$ZEST/pom.xml" ]] || { echo "ERROR: zest-rwt not found at $ZEST" >&2; exit 1; }

ZEST_SHA="$(git -C "$ZEST" rev-parse --short HEAD)"
if [[ "$ZEST_SHA" != "$ZEST_EXPECTED_SHA"* && "$ZEST_EXPECTED_SHA" != "$ZEST_SHA"* ]]; then
  echo "ERROR: zest-rwt is at $ZEST_SHA but this build pins $ZEST_EXPECTED_SHA." >&2
  echo "       Check it out, or set ZEST_EXPECTED_SHA= to adopt the new commit deliberately." >&2
  exit 1
fi

if [[ "$REUSE_M2" == "yes" ]]; then
  M2="$PARENT/.m2-cache"
  echo "!! --reuse-m2: using the SHARED cache. Its RAP jars may already be unsigner-rewritten."
  echo "!! Do not ship an artifact built this way."
else
  M2="$PARENT/.m2-build/$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$M2"

GIT_SHA="$(git -C "$WORKTREE" rev-parse HEAD)"
GIT_DESC="$(git -C "$WORKTREE" describe --tags --always --long 2>/dev/null || echo unknown)"

# Version resource, generated HERE rather than in the container. This is a git WORKTREE, so
# .git is a gitfile pointing at the main repo's .git/worktrees/<name>, which is outside the
# bind mount - git inside the container cannot resolve it. Generating on the host also keeps
# git and perl out of the builder image.
# Without netxms-build-tag.properties, VersionInfo falls back to netxms-version.properties
# and the console reports itself as 6.1-SNAPSHOT / untagged, indistinguishable from a dev
# build. Both generated paths are gitignored, so this leaves no dirty tree.
echo "== Stamping version resource =="
( cd "$WORKTREE/build" && ./updatetag.pl )
cp "$WORKTREE/build/netxms-build-tag.properties" \
   "$WORKTREE/src/java-common/netxms-base/src/main/resources/"
cat "$WORKTREE/build/netxms-build-tag.properties"

echo "== Building web WAR =="
echo "   worktree : $WORKTREE"
echo "   commit   : $GIT_SHA  ($GIT_DESC)"
echo "   zest-rwt : $ZEST @ $ZEST_SHA"
echo "   builder  : $IMAGE"
echo "   .m2 repo : $M2  (reuse=$REUSE_M2)"

# Pinned digest first; fall back to the tag only if the digest is not resolvable, and say so
# loudly, because that fallback un-pins the toolchain.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1 && ! docker pull -q "$IMAGE" >/dev/null 2>&1; then
  echo "!! WARNING: pinned builder digest not resolvable; falling back to $IMAGE_FALLBACK_TAG."
  echo "!! The toolchain is NOT pinned for this build. Record that, or update the digest."
  IMAGE="$IMAGE_FALLBACK_TAG"
fi

docker run --rm \
  -v "$WORKTREE":/work \
  -v "$ZEST":/zest \
  -v "$M2":/root/.m2 \
  -w /work \
  "$IMAGE" \
  bash -euxo pipefail -c '
    # 0. gettext supplies msgfmt (see header). Assert it, because the gettext mojo failing
    #    is a WARNING, not an error, and would silently drop every translation.
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends gettext >/dev/null
    command -v msgfmt >/dev/null || { echo "FATAL: msgfmt still absent after install"; exit 1; }
    msgfmt --version | head -1
    mvn -v

    # 2. NetXMS base + client libs into the local repo
    mvn -B -f /work/src/java-common/netxms-base/pom.xml   -DskipTests install
    mvn -B -f /work/src/client/java/netxms-client/pom.xml -DskipTests install
    # 3. unreleased zest-rwt dependency
    mvn -B -f /zest/pom.xml -DskipTests install
    # 4. the RWT web client WAR
    mvn -B -f /work/src/client/nxmc/java/pom.xml -Pweb \
        -Dnetxms.build.disablePlatformProfile=true -DskipTests package
  '

WAR="$(find "$WORKTREE/src/client/nxmc/java/target" -maxdepth 1 -name '*.war' -print -quit)"
[[ -n "$WAR" ]] || { echo "ERROR: no WAR produced" >&2; exit 1; }

# POST-BUILD ASSERTIONS. The build is capable of "succeeding" while silently dropping
# content, so success is asserted against the artifact, not against mvn's exit code.
echo
"$WORKTREE/verify-war.sh" "$WAR" || {
  echo "BUILD REJECTED — do not deploy this artifact." >&2
  exit 1
}

echo
echo "== Build complete =="
printf '%s  %s bytes\n' "$WAR" "$(stat -c %s "$WAR")"
echo "sha256: $(sha256sum "$WAR" | cut -d' ' -f1)"
echo "commit: $GIT_SHA  ($GIT_DESC)"
echo "zest:   $ZEST_SHA"
echo "builder:$IMAGE"
