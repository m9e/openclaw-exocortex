# Lima OpenClaw VMs

These templates create two additive Lima guests on macOS without touching Podman's existing machine.
The default runtime lives under the workspace-local `claw-runtime/openclaw/`
folder, including its Lima home, metadata, logs, and symlinks to the companion
dependency repos:

- `deps/exocortex-agent-locksmith`
- `deps/exocortex-openclaw-hardened`
- `deps/exocortex-untrusted-content`

Default guests:

- `openclaw-gateway`: trusted VM for the OpenClaw gateway and trusted tools
- `openclaw-untrusted`: isolated VM for untrusted content and tool execution

Both instances use the Apple Virtualization.framework backend (`vmType: vz`) on
Apple Silicon, attach to Lima `vzNAT` networking so macOS can enforce egress by
guest IP, and disable Lima's catch-all localhost port forwarding. Only explicit
forwards are enabled. The Lima templates intentionally avoid package-manager
work during first boot; `bootstrap-claw-runtime.sh` and the install helpers own
package setup so VM creation is not coupled to guest internet availability.

## Host port mapping

- `openclaw-gateway`
  - host `127.0.0.1:29789` -> guest `127.0.0.1:18789`
  - host `127.0.0.1:29790` -> guest `127.0.0.1:18790`
  - host `0.0.0.0:29888` -> guest `0.0.0.0:8888` for Pipelock proxy traffic
- `openclaw-untrusted`
  - host `127.0.0.1:39789` -> guest `127.0.0.1:18789`
  - host `127.0.0.1:39790` -> guest `127.0.0.1:18790`

The OpenClaw Gateway forwards are for the Mac host only. Sibling Lima guests
should not use `host.lima.internal` to call the trusted gateway API.
The Pipelock forward is host-wide because Apple VZ NAT does not provide
guest-to-guest reachability. `configure-host-egress-pf.sh` installs a PF anchor
that allows only the untrusted VM's VZ NAT IP and host loopback to reach port
`29888`, then blocks other inbound sources for that port.

This is intentional: `vzNAT` gives each guest a PF-visible source IP, which is
what lets the Mac host enforce "untrusted must use the proxy." The tradeoff is
that the guests cannot directly route to each other on the VZ NAT segment. For
local dev, the controlled crossings are therefore:

- untrusted -> gateway Pipelock: host forward `0.0.0.0:29888`, restricted by PF
  to the untrusted VM source IP and host loopback;
- gateway -> untrusted SSH sandbox: Lima's host-forwarded SSH port with a
  gateway-only key and strict `known_hosts`;
- host -> gateway OpenClaw UI/API: loopback-only forwards `29789` / `29790`.

Do not replace these with broad `host.lima.internal` access to the OpenClaw
Gateway API. The gateway API should stay host-loopback only.

Existing instances created before the strict `vzNAT` topology need a one-time
stop and edit before strict host egress can be installed:

```bash
limactl stop openclaw-gateway
limactl stop openclaw-untrusted
limactl edit --tty=false --set '.networks = [{"vzNAT": true}]' openclaw-gateway
limactl edit --tty=false --set '.networks = [{"vzNAT": true}]' openclaw-untrusted
limactl start openclaw-gateway
limactl start openclaw-untrusted
```

## Turnkey install

`turnkey-kamiwaza-openclaw.sh` is the one-command path for a fully
Kamiwaza-integrated VM pair. It validates host prerequisites and Kamiwaza API
access, prompts for a Kamiwaza API key or username/password (a password login
mints a scoped PAT through `POST /api/auth/pats`), checks that a Kamiwaza
model is `DEPLOYED` (advising the Kamiwaza UI with an explicit bypass when
none is), derives the model endpoint from the deployment's `access_path`,
live-verifies it with the resolved credential, writes the PAT store consumed
by the guest credential sync, then runs `bootstrap-kamiwaza-mode.sh`:

```bash
bash scripts/dev/lima/turnkey-kamiwaza-openclaw.sh
```

The installer prompts for (or takes `--workspace`) a host directory that is
mounted writable into the gateway VM as the agent workspace, defaulting to
`~/claws/<runtime-name>`. The gateway VM gets no host home mount: only the
repo, the workspace `deps/`, the runtime `metadata/` (all read-only), the
agent workspace (writable), and any `OPENCLAW_GATEWAY_EXTRA_MOUNTS` entries
are visible inside the VM. Host ports default to one free five-port block
scanned from `31300-31400` (gateway, gateway alt, Pipelock, untrusted,
untrusted alt); existing runtimes keep their recorded ports on re-runs.

For a parallel runtime pair:

```bash
bash scripts/dev/lima/turnkey-kamiwaza-openclaw.sh --runtime-name kz2 --workspace ~/claws/kz2
```

Useful knobs: `--model NAME` picks a specific deployed model,
`--yes`/`OPENCLAW_TURNKEY_ASSUME_YES=1` accepts confirmation prompts,
`OPENCLAW_KAMIWAZA_ALLOW_NO_MODEL=1` proceeds without a deployed model,
`--port-offset N` keeps the legacy offset port scheme, and
`KAMIWAZA_API_URL` overrides the default `https://localhost/api`. Arguments
after `--` pass through to `bootstrap-kamiwaza-mode.sh` unchanged.

## clawctl

`scripts/dev/lima/clawctl` is the one CLI over all of this. It sweeps every
runtime under `claw-runtime/` (each pair has its own `LIMA_HOME`, so plain
`limactl list` does not show them):

```bash
clawctl deploy --name agentzero --workspace ~/claws/agentzero --yes
clawctl list                          # all runtimes + VM states
clawctl status --name agentzero      # health, ports, workspace
clawctl agent --name agentzero -m "hello"
clawctl dashboard --name agentzero   # URL + token, copies to clipboard
clawctl mount add ~/code/some-repo --dest projects/some-repo --name agentzero
clawctl creds set SERPER_API_KEY=... --name agentzero   # VALUE=- reads stdin
clawctl tool add weather --upstream https://api.example.com \
  --auth-header X-API-Key --secret-env WEATHER_API_KEY --name agentzero
clawctl egress allow "*.example.com" --name agentzero   # Pipelock outbound
```

`mount add` restarts the gateway VM (Lima mounts apply at boot), defaults to
read-only, refuses to mount `$HOME` or `/` wholesale, and resolves relative
`--dest` under the agent workspace. `tool add` appends a Locksmith upstream
tool, verifies it in the catalog, projects it as a first-class
`locksmith_<name>` agent tool, and restarts the gateway.

## Usage

```bash
bash scripts/dev/lima/bootstrap-claw-runtime.sh
limactl shell openclaw-gateway
limactl shell openclaw-untrusted
```

`bootstrap-claw-runtime.sh` creates/starts both VMs, installs the gateway
checkout, installs Pipelock and Locksmith, configures the SSH-backed untrusted
sandbox, syncs Kamiwaza PAT credentials when the workspace helper and PAT export
exist, refreshes first-class Locksmith projections for any active `kamiwaza_*`
tools discovered after that PAT sync, configures the local `kamiwaza-local` provider for
`kamiwaza/relic/MiniMax-M2.7-AWQ-4bit`, and starts the gateway user service.

To create a second co-existing pair, use a distinct runtime name and port
offset:

```bash
OPENCLAW_RUNTIME_NAME=claw2 OPENCLAW_RUNTIME_PORT_OFFSET=1000 \
  bash scripts/dev/lima/bootstrap-claw-runtime.sh
```

The second pair lands under `claw-runtime/claw2/`, uses Lima instances
`claw2-gateway` and `claw2-untrusted`, and offsets the host ports by `1000`.
Use the same environment when running helper commands for that pair.

For VM creation only:

```bash
bash scripts/dev/lima/bootstrap-claw-runtime.sh --no-install
```

## Kamiwaza-mode bootstrap

Use `bootstrap-kamiwaza-mode.sh` when the VM pair should come up with the
local Kamiwaza tool surface ready for agent use:

```bash
bash scripts/dev/lima/bootstrap-kamiwaza-mode.sh
```

The wrapper first deploys a configurable set of local Kamiwaza extension repos
through `~/code/kz/amatt-push-local-extensions.sh`, applies matching active
`KamiwazaExtension` CRs, then runs `bootstrap-claw-runtime.sh` so OpenClaw,
Pipelock, Locksmith, the untrusted SSH sandbox, PAT sync, model config, and
gateway service are all configured in one documented path. It loads
`~/.api_keys` by default, exports syntactically valid environment assignments
for helper tools, and logs only key names such as `SERPER_API_KEY`, never secret
values. Secret env vars required by active tools are written to Kubernetes
Secrets and referenced from the CR; they are not embedded as literal CR values.

The default extension target set is:

- `~/code/kz/kamiwaza-extensions-serperdev:tool:tool-serperdev`
- `~/code/kz/kamiwaza-extensions-tool-untrusted:tool:tool-untrusted-content`

Override that set with comma-separated target specs:

```bash
OPENCLAW_KAMIWAZA_EXTENSION_TARGETS="$HOME/code/kz/kamiwaza-extensions-serperdev:tool:tool-serperdev,$HOME/code/kz/kamiwaza-extensions-tool-untrusted:tool:tool-untrusted-content" \
  bash scripts/dev/lima/bootstrap-kamiwaza-mode.sh
```

Target specs are `/repo/path[:tool|app|service[:target-name]]`. When a kind and
target name are provided, the wrapper validates that
`<repo>/<kind>s/<target-name>/kamiwaza.json` exists before invoking the deploy
helper. The helper receives a temporary workspace containing symlinks only to
the selected repos, so unrelated local extension repos stay outside the deploy
blast radius.

To include the Telegram tool during local UAT:

```bash
OPENCLAW_KAMIWAZA_EXTENSION_TARGETS="$HOME/code/kz/kamiwaza-extensions-serperdev:tool:tool-serperdev,$HOME/code/kz/kamiwaza-extensions-tool-untrusted:tool:tool-untrusted-content,$HOME/code/kz/kamiwaza-extensions-telegram:tool:tool-telegram" \
  bash scripts/dev/lima/bootstrap-kamiwaza-mode.sh
```

Active CR application is intentionally idempotent and server-side applied. The
wrapper waits for `kamiwazaextensions.extensions.kamiwaza.io` to be established,
creates the target namespace if needed, pre-pulls local-registry images into the
`kamiwaza-k0s` VM with `k0s ctr --plain-http`, then waits for each active
extension to become `Ready`.

Useful activation knobs:

- `--no-push-extensions` skips the helper/template push but still applies the
  active CRs. This is useful after a successful image/template push when only CR
  shape, proxy, or secret wiring changed.
- `--no-activate-extensions` pushes extension templates but skips active CRs.
- `--no-wait-extensions` skips the final `Ready` wait.
- `OPENCLAW_KAMIWAZA_EXTENSION_NAMESPACE` defaults to `kamiwaza-extensions`.
- `OPENCLAW_KAMIWAZA_DEPLOYMENT_SUFFIX` defaults to `openclaw`, producing ids
  such as `tool-serperdev-openclaw`.
- `OPENCLAW_KAMIWAZA_LOCAL_REGISTRY` defaults to
  `registry.infra.kamiwaza.test:5001`.
- `OPENCLAW_KAMIWAZA_PREPULL_IMAGES=0` disables the k0s image pre-pull.
- `OPENCLAW_KAMIWAZA_LIMA_HOME` overrides the Lima home used to find the
  Kamiwaza k0s VM. By default the pre-pull unsets the OpenClaw runtime
  `LIMA_HOME`, because the Kamiwaza cluster VM usually lives in the user's
  normal Lima home rather than the per-runtime OpenClaw Lima directory.
- `OPENCLAW_KAMIWAZA_TOOL_EGRESS_PROXY` defaults to
  `http://<kamiwaza-k0s-default-gateway>:$OPENCLAW_PIPELOCK_PORT`, falling back
  to `host.lima.internal` if the gateway cannot be discovered. Kubernetes pods
  do not reliably resolve Lima guest helper hostnames, so the discovered gateway
  IP is the preferred path for tool egress through Pipelock.

For a clean co-existing UAT pair, use a runtime name and port offset:

```bash
OPENCLAW_RUNTIME_NAME=oc1 OPENCLAW_RUNTIME_PORT_OFFSET=3000 \
  bash scripts/dev/lima/bootstrap-kamiwaza-mode.sh
```

If multiple OpenClaw VM pairs should keep independent active Kamiwaza tool CRs,
also set a unique deployment suffix:

```bash
OPENCLAW_RUNTIME_NAME=oc2 OPENCLAW_RUNTIME_PORT_OFFSET=6000 \
  bash scripts/dev/lima/bootstrap-kamiwaza-mode.sh --extension-deployment-suffix oc2
```

To persist the trusted agent's workspace/memory in a Git-manageable host folder,
set `OPENCLAW_AGENT_STATE_HOST_DIR`:

```bash
OPENCLAW_AGENT_STATE_HOST_DIR="$HOME/code/agent-states/oc1" \
  bash scripts/dev/lima/bootstrap-kamiwaza-mode.sh
```

That path is mounted writable into the gateway VM only and is written into
`agents.defaults.workspace` and the `main` agent's `workspace`. The untrusted VM
still receives no host workspace mount. Lima mounts are fixed at instance
creation, so set this before first start of a given runtime pair. Keep runtime
names short or set a short `OPENCLAW_RUNTIME_DIR`; Lima's generated SSH socket
paths must fit macOS `UNIX_PATH_MAX`.

The model endpoint defaults remain the same as `bootstrap-claw-runtime.sh`:
`OPENCLAW_KAMIWAZA_BASE_URL=http://host.lima.internal:4000/v1` and
`OPENCLAW_KAMIWAZA_MODEL_ID=kamiwaza/relic/MiniMax-M2.7-AWQ-4bit`. To test the
external Tokenator Kimi endpoint that was used for local validation, set:

```bash
OPENCLAW_KAMIWAZA_BASE_URL="https://tokenator.kamiwaza.ai/runtime/models/5913f08b-05bc-4ff3-8746-8e24760b220e/v1"
OPENCLAW_KAMIWAZA_MODEL_ID="Kimi-K2.6"
OPENCLAW_KAMIWAZA_MODEL_API_KEY="$(jq -r '.active_tokens[] | select(.host_name == "tokenator") | .token' ~/code/kzproxy/incoming/pdash-pat-store.json | head -n 1)"
```

Do not print that token. The bootstrap writes it into a `0600` guest env file
and configures OpenClaw to read it through an env SecretRef.

## Install OpenClaw in the gateway guest

The gateway VM sees the host checkout read-only at the same `/Users/...` path.
Install a writable Linux checkout in the guest user's home directory:

```bash
limactl shell openclaw-gateway -- \
  bash /Users/yod/code/exocortex/openclaw-exocortex/scripts/dev/lima/install-in-guest.sh
```

The installer clones the mounted checkout into `~/code/openclaw-exocortex`,
installs Node 24 + pnpm, runs `pnpm install`, creates
`~/.openclaw/gateway.token`, installs the required local Locksmith sidecar,
installs the required Pipelock egress proxy on the gateway,
and writes two guest helpers:

- `~/bin/openclaw`: runs the dev CLI from the guest checkout without typing `pnpm`
- `~/bin/openclaw-gateway-dev`: starts the gateway with local VM defaults

Set `OPENCLAW_GUEST_INSTALL_PIPELOCK=0` or `OPENCLAW_GUEST_INSTALL_LOCKSMITH=0`
only when you intentionally need a non-hardened guest for debugging. The
gateway helper also defaults `OPENCLAW_REQUIRE_LOCKSMITH=1`; override that only
for the same kind of debugging session.

The helper starts with `--allow-unconfigured` by default for first-boot VM
bring-up; set `OPENCLAW_GATEWAY_REQUIRE_CONFIG=1` once you want config to be
mandatory.

Open a new guest shell after install, then run CLI commands directly:

```bash
openclaw pairing list --channel telegram
openclaw channels status --probe
```

## Re-run Locksmith setup in the gateway guest

`install-in-guest.sh` installs and enables the `agent-locksmith` sidecar by
default. Re-run the Locksmith installer directly after changing sidecar config,
rotating its local bearer token, or repairing an older gateway checkout:

```bash
limactl shell openclaw-gateway -- \
  bash /Users/yod/code/exocortex/openclaw-exocortex/scripts/dev/lima/install-locksmith-in-guest.sh
```

The helper installs the Linux Locksmith CLI release for the guest architecture,
builds the `locksmithd` daemon from the workspace dep at
`deps/exocortex-agent-locksmith`, writes a user-level `locksmith.service`,
enables the bundled OpenClaw `locksmith` plugin, and restarts the gateway if
one is already running.

The default config:

- listens on `127.0.0.1:9200`
- sends cloud tool traffic through local gateway Pipelock at `127.0.0.1:8888`
- generates a local bearer token in `~/.config/locksmith/locksmith.env`
- generates a local Kamiwaza delegation signing secret in the same env file
- configures Locksmith's `kamiwaza:` provider block for
  `https://host.lima.internal/api` with TLS verification disabled for the local
  self-signed gateway certificate
- selects the Kamiwaza PAT for `OPENCLAW_KAMIWAZA_CREDENTIAL_HOST` when set, or
  the host's local name (`scutil --get LocalHostName` / `hostname -s`) otherwise
- projects active `kamiwaza_*` tools as first-class OpenClaw Locksmith tools
  during bootstrap when the local catalog is reachable, while leaving new tools
  added later to the dynamic warning/restart path
- makes Locksmith reject unauthenticated `/tools`
- sets `plugins.entries.locksmith.config.required: true`
- sets `plugins.entries.locksmith.config.startupTimeoutMs: 120000`, because
  authenticated Locksmith `/tools` performs live Kamiwaza MCP discovery across
  every active extension and can take tens of seconds when the catalog is large
  or cold
- hides the generic `locksmith_call` tool
- enables the direct `kamiwaza_call` fallback bridge for trusted local use with
  required signed delegation
- enables the `untrusted-content` guard plugin against the active
  `tool-untrusted-content-<suffix>` route, using the Kamiwaza PAT as an env
  SecretRef and `tlsRejectUnauthorized: false` for the local self-signed route
- constrains file tools to the workspace
- configures a tight `main` agent policy with local workspace edits, memory,
  status, plan, outbound message/TTS, session send/spawn/yield, subagent
  control, agent discovery, the projected `locksmith_github` tool, and
  `kamiwaza_call`
- denies direct shell/process, direct web, UI/browser, automation, node-control,
  media generation/understanding, session list/history, and generic
  `locksmith_call` on the trusted `main` agent
- requires `sessions_spawn` to name an `agentId`, so the trusted agent has to
  pick the local brain, read-only untrusted, or write-only untrusted profile

That policy keeps trusted orchestration and communication available while
removing the easy direct-egress bypasses from the gateway agent.

Check it from inside the guest:

```bash
systemctl status pipelock.service
systemctl --user status locksmith.service
openclaw locksmith status
openclaw locksmith tools
openclaw locksmith call github zen
```

When a local Kamiwaza platform is running and PAT credentials have been synced,
run the tool-plumbing smoke from inside the gateway guest:

```bash
bash /Users/yod/code/exocortex/openclaw-exocortex/scripts/dev/lima/smoke-kamiwaza-tools.sh
```

That checks the direct `openclaw kamiwaza` catalog, verifies the PAT is available
without printing it, and verifies Locksmith can see active Kamiwaza upstream
tools. To also execute a known-safe tool through both direct OpenClaw and
Locksmith paths, provide the tool slug and JSON arguments:

```bash
OPENCLAW_KAMIWAZA_SMOKE_TOOL=kamiwaza_tool_z_19607be6_search \
OPENCLAW_KAMIWAZA_SMOKE_ARGS='{"query":"openclaw"}' \
  bash /Users/yod/code/exocortex/openclaw-exocortex/scripts/dev/lima/smoke-kamiwaza-tools.sh --call
```

The direct call uses `OPENCLAW_KAMIWAZA_SMOKE_AGENT_ID` as the delegated
identity subject, defaulting to `openclaw-smoke`, so the local required
delegation policy still fails closed for calls without an explicit identity.

## Re-run Pipelock setup in the gateway guest

The Pipelock installer downloads the pinned Linux release, writes
`/etc/pipelock/pipelock.yaml`, enables `pipelock.service`, and configures the
gateway's common CLI/package-manager HTTP proxy settings for
`127.0.0.1:8888`. In this topology Pipelock also listens on the gateway's
non-loopback address and is forwarded to host port `29888`; the host PF anchor
restricts who can reach that forwarded proxy:

```bash
limactl shell openclaw-gateway -- \
  sudo env PIPELOCK_LISTEN=0.0.0.0:8888 \
  bash /Users/yod/code/exocortex/openclaw-exocortex/scripts/dev/lima/install-pipelock-in-guest.sh
```

Do not run Pipelock as the untrusted guest's local security boundary. The
untrusted guest is a proxy client; the Mac host PF anchor is what prevents raw
direct egress from bypassing gateway Pipelock.

## Configure the untrusted sandbox target

Use the host-side helper after both Lima instances are running:

```bash
bash scripts/dev/lima/configure-untrusted-sandbox.sh
```

The helper enables SSH in `openclaw-untrusted`, creates a gateway-only SSH key,
authorizes it in the untrusted guest, records the untrusted host-forwarded SSH
target and host key in the gateway config, installs gateway Pipelock, configures
the untrusted guest as a proxy client of gateway Pipelock, installs a Mac host
PF anchor that default-drops untrusted egress except to gateway Pipelock, and
re-runs the
Locksmith policy installer.

After that, the trusted `main` agent can choose:

- local constrained work: `sessions_spawn` with `agentId: "main"`
- untrusted read-only work: `sessions_spawn` with `agentId: "untrusted"` or
  `agentId: "untrusted-read"` and `sandbox: "require"`
- untrusted write-only work: `sessions_spawn` with
  `agentId: "untrusted-write"` and `sandbox: "require"`

The `untrusted` and `untrusted-read` agents can read but cannot write, execute
commands, call web/search/fetch, talk to users, spawn more agents, or call
Locksmith. The `untrusted-write` agent can write/edit/apply patches but cannot
read, execute commands, call web/search/fetch, talk to users, spawn more
agents, or call Locksmith. The trusted `main` agent is the membrane between
those profiles.

Start the gateway from inside the guest with:

```bash
openclaw-gateway-dev
```

From the Mac host, the gateway is reachable on `http://127.0.0.1:29789/`
because Lima forwards host port `29789` to guest port `18789`.

To open the dashboard from the host and copy the token:

```bash
bash scripts/dev/lima/dashboard-open.sh
```

Paste these values into the login gate if prompted:

- Gateway URL: `ws://127.0.0.1:29789`
- Token: the value printed by `dashboard-open.sh`

## Isolation model

- `openclaw-gateway` inherits Lima's default read-only home mount so it can inspect the host repo without mutating it.
- When `OPENCLAW_AGENT_STATE_HOST_DIR` is set before first start, the gateway
  also receives that one host directory as a writable mount for the trusted
  `main` agent workspace.
- `openclaw-untrusted` mounts no host directories.
- Neither VM auto-forwards random guest localhost ports back onto the host.
- Both VMs attach to Lima `vzNAT` so macOS PF can distinguish their traffic.
- The gateway runs Pipelock on `0.0.0.0:8888` inside the VM, forwarded to host
  port `29888`. The PF anchor allows only host loopback and the untrusted VM's VZ
  NAT IP to that forward.
- The untrusted guest does not run local Pipelock as its security boundary; its
  apt/git/pip/npm/shell proxy environment points at gateway Pipelock.
- The gateway's Locksmith sidecar sends cloud tool traffic through Pipelock.
- The Mac host PF anchor installed by `configure-host-egress-pf.sh` permits
  untrusted egress only to the gateway Pipelock port and default-drops
  everything else from the untrusted VM's VZ NAT IP.
- The trusted `main` agent has no direct shell/process, direct web, or
  Locksmith tools by default. It can talk to the user, read/write only its
  workspace, and delegate to explicitly selected subagent profiles.
