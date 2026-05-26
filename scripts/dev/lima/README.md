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
- hides the generic `locksmith_call` tool
- enables the direct `kamiwaza_call` fallback bridge for trusted local use with
  required signed delegation
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
