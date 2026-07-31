#!/usr/bin/env bash
# verify-war.sh — assert a built NetXMS web WAR actually contains what it must.
#
#   ./verify-war.sh [war]        # defaults to the build output
#
# WHY THIS IS SEPARATE FROM THE BUILD:
#   This build can report BUILD SUCCESS while silently dropping content — the gettext mojo
#   logs "Could not execute 'msgfmt'" and continues, which is how a WAR missing all seven UI
#   translations was built and very nearly deployed. So the artifact, not mvn's exit code, is
#   the thing that gets checked. Keeping it standalone also means an artifact can be re-checked
#   later without rebuilding it.
set -euo pipefail

WORKTREE="$(cd "$(dirname "$0")" && pwd)"
WAR="${1:-$(find "$WORKTREE/src/client/nxmc/java/target" -maxdepth 1 -name '*.war' -print -quit)}"
[[ -n "$WAR" && -f "$WAR" ]] || { echo "no WAR found (looked for: ${1:-build output})" >&2; exit 1; }

fails=0
check() { if [[ ${2:-0} -gt 0 ]]; then echo "ok:   $1 ($2)"; else echo "FAIL: $1 (0)"; fails=$((fails+1)); fi; }

echo "== Verifying $WAR =="
echo "   $(stat -c %s "$WAR") bytes   sha256=$(sha256sum "$WAR" | cut -d' ' -f1)"
echo

# The seven compiled translation bundles (cs de es fr iw pt_BR ru), each with a $1 inner class.
check "i18n message bundles compiled" \
  "$(unzip -l "$WAR" | grep -c 'WEB-INF/classes/i18n/Messages_.*\.class' || true)"

# The version resource lives INSIDE netxms-base-*.jar, not at the WAR top level. Without it,
# VersionInfo falls back to netxms-version.properties and the console reports 6.1-SNAPSHOT /
# untagged, indistinguishable from a dev build.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BASE_JAR="$(unzip -l "$WAR" | awk '/WEB-INF\/lib\/netxms-base-.*\.jar/{print $4}' | head -1)"
if [[ -n "$BASE_JAR" ]]; then
  unzip -p "$WAR" "$BASE_JAR" > "$TMP/base.jar"
  check "build tag resource in $(basename "$BASE_JAR")" \
    "$(unzip -l "$TMP/base.jar" | grep -c 'netxms-build-tag.properties' || true)"
  echo "--- version resource ---"
  unzip -p "$TMP/base.jar" netxms-build-tag.properties 2>/dev/null | sed 's/^/    /' || true
else
  check "netxms-base jar present" 0
fi

check "map input client script" "$(unzip -l "$WAR" | grep -c 'WEB-INF/classes/js/mapinput.js' || true)"
check "map input server class"  "$(unzip -l "$WAR" | grep -c 'MapInputWidget.class' || true)"

echo
if [[ $fails -ne 0 ]]; then
  echo "ARTIFACT REJECTED ($fails assertion(s) failed) — do not deploy." >&2
  exit 1
fi
echo "ARTIFACT OK"
