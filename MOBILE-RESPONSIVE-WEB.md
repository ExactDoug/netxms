# Mobile-responsive NetXMS web client (RWT) — working notes

Downstream (ExactDoug) working branch that builds on the responsive RWT shell work and adds:

1. A **lifecycle fix** so the responsive controller actually attaches, and
2. **Repeatable, fully-containerized local build + run tooling** to verify the web
   client on a dev machine with nothing installed on the host (Docker only).

This branch is based on `feature/rwt-responsive-shell` (draft PR #1). It is our own
line of work with its own PR, kept separate from PR #1.

## What the responsive feature does (inherited from the base branch)

Three RWT-only files under `src/client/nxmc/java/src/rwt/java/org/netxms/nxmc/`:

- `ResponsiveStartup.java` — RWT entry point; installs the controller per UI session.
- `base/windows/ResponsiveShellController.java` — the actual logic: at narrow/compact
  widths it collapses the perspective switcher to an icon rail, compacts the header,
  and adjusts the split-pane sashes. Width breakpoints:
  `NARROW_MAX_WIDTH = 699`, `COMPACT_MAX_WIDTH = 1199`.
- `WebApplicationConfiguration.java` — one-line wiring change.

## The lifecycle fix (this branch)

**Symptom:** on first testing, the layout never became responsive; the container log
showed `Responsive shell controller was not attached`.

**Root cause:** the original `ResponsiveStartup` retried `attach()` on a blind
wall-clock timer (240 × 250 ms = **60 s**) that started **at page load**, before login.
`attach()` only succeeds once the post-login main shell (with the `PerspectiveSwitcher`)
exists. Login + the initial release-notes dialog can easily consume the 60 s budget, so
the installer thread gave up before the main shell ever appeared.

**Fix:** attachment is now **event-driven**. `ResponsiveStartup` registers a display-wide
filter on `SWT.Show` / `SWT.Activate` and attaches when the main shell is actually shown,
regardless of how long login takes; the filter removes itself on success. The polling
loop is kept only as a backstop (now a 10-minute budget) and a
`Responsive shell controller attached` info line was added so success is observable.

## Known issues still open (not yet addressed)

- **Landscape scrollbar overlap:** the collapsed icon rail is a fixed ~48 px. In landscape
  (short height) the icon column overflows and a vertical scrollbar renders *on top of* the
  icons. Fix must **decouple rail width from icon size** (rail = icon + scrollbar + padding),
  or restyle/hide the scrollbar via RAP theme CSS. NOTE: this reproduces with the *native*
  collapsed switcher too — it is arguably an upstream rendering detail, not introduced here.
- **Breakpoints are width-only.** Landscape phones are wide-but-short, so a height-aware
  breakpoint (or orientation awareness) is likely needed. RAP exposes client/device info via
  `org.eclipse.rap.rwt.client.service.ClientInfo`.
- Content/layout of individual perspectives at narrow widths still needs per-view polish.

## Local build + run (Docker only — nothing installed on host)

Two scripts at the repo root (this branch):

```bash
./build-web-war.sh          # builds nxmc-*.war inside maven:3-eclipse-temurin-17
./run-web-local.sh up        # throwaway NetXMS server stack + serves the WAR in Tomcat
./run-web-local.sh down      # tears it all down (containers + volumes + network)
```

`build-web-war.sh` uses sibling dirs under `.worktrees/` (created on first run):
`zest-rwt/` (unreleased dependency, cloned from github.com/netxms/zest-rwt) and
`.m2-cache/` (persistent Maven repo). Build order: `netxms-base` → `netxms-client` →
`zest-rwt` → the WAR (`-Pweb -Dnetxms.build.disablePlatformProfile=true`). Output:
`src/client/nxmc/java/target/nxmc-<version>.war` (~50 MB).

`run-web-local.sh up` brings up the upstream `deployment-example` stack (db/agent/init/
server), serves our WAR in `tomcat:10.1-jdk17-temurin` on host network, and prints the
generated admin password. Browse `http://127.0.0.1:8080/`. Confirm the fix worked by
grepping the container log for `Responsive shell controller attached`. Backend is a
throwaway stack — production is never touched.

## Deploying this into our stack (when we decide to)

The web client is a single WAR baked into the upstream `web` image
(`FROM jetty… COPY nxmc-<ver>.war → ROOT.war`). The server address is injected via a JNDI
`nxmc/server` env-entry in `ROOT.xml`, not compiled in. So the **standard minimal change**
is a thin derived image:

```dockerfile
FROM ghcr.io/netxms/web:6.1.3
COPY nxmc-<ver>.war /var/lib/jetty/webapps/ROOT.war
```

Build → push to Harbor → deploy via the normal pipeline (`deploy.sh`). Versioned,
self-contained, survives restarts. A bind-mount of the WAR over `ROOT.war` works for quick
testing but is less clean for production. The long-term goal is to land the responsive work
upstream so the stock image carries it and we hold no fork.
