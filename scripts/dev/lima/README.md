# Lima OpenClaw VMs

These templates create two additive Lima guests on macOS without touching Podman's existing machine:

- `openclaw-gateway`: trusted VM for the OpenClaw gateway and trusted tools
- `openclaw-untrusted`: isolated VM for untrusted content and tool execution

Both instances use the Apple Virtualization.framework backend (`vmType: vz`) on
Apple Silicon, attach to Lima `vzNAT` networking so macOS can enforce egress by
guest IP, and disable Lima's catch-all localhost port forwarding. Only explicit
forwards are enabled.

## Host port mapping

- `openclaw-gateway`
  - host `127.0.0.1:29789` -> guest `127.0.0.1:18789`
  - host `127.0.0.1:29790` -> guest `127.0.0.1:18790`
  - host `0.0.0.0:8888` -> guest `0.0.0.0:8888` for Pipelock proxy traffic
- `openclaw-untrusted`
  - host `127.0.0.1:39789` -> guest `127.0.0.1:18789`
  - host `127.0.0.1:39790` -> guest `127.0.0.1:18790`

The OpenClaw Gateway forwards are for the Mac host only. Sibling Lima guests
should not use `host.lima.internal` to call the trusted gateway API.
The Pipelock forward is host-wide because Apple VZ NAT does not provide
guest-to-guest reachability. `configure-host-egress-pf.sh` installs a PF anchor
that allows only the untrusted VM's VZ NAT IP and host loopback to reach port
`8888`, then blocks other inbound sources for that port.

This is intentional: `vzNAT` gives each guest a PF-visible source IP, which is
what lets the Mac host enforce "untrusted must use the proxy." The tradeoff is
that the guests cannot directly route to each other on the VZ NAT segment. For
local dev, the controlled crossings are therefore:

- untrusted -> gateway Pipelock: host forward `0.0.0.0:8888`, restricted by PF
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
bash scripts/dev/lima/start-openclaw-vms.sh
limactl shell openclaw-gateway
limactl shell openclaw-untrusted
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

The helper installs the Linux Locksmith release binary for the guest
architecture, writes a user-level `locksmith.service`, enables the bundled
OpenClaw `locksmith` plugin, and restarts the gateway if one is already
running.

The default config:

- listens on `127.0.0.1:9200`
- sends cloud tool traffic through local gateway Pipelock at `127.0.0.1:8888`
- generates a local bearer token in `~/.config/locksmith/locksmith.env`
- makes Locksmith reject unauthenticated `/tools`
- sets `plugins.entries.locksmith.config.required: true`
- hides the generic `locksmith_call` tool
- keeps projected Locksmith tools out of the default trusted agent policy
- constrains file tools to the workspace
- configures a tight `main` agent policy with local workspace edits, memory,
  status, plan, outbound message/TTS, session send/spawn/yield, subagent
  control, and agent discovery
- denies direct shell/process, direct web, UI/browser, automation, node-control,
  media generation/understanding, session list/history, and generic
  `locksmith_call`/projected Locksmith tools on the trusted `main` agent
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

## Re-run Pipelock setup in the gateway guest

The Pipelock installer downloads the pinned Linux release, writes
`/etc/pipelock/pipelock.yaml`, enables `pipelock.service`, and configures the
gateway's common CLI/package-manager HTTP proxy settings for
`127.0.0.1:8888`. In this topology Pipelock also listens on the gateway's
non-loopback address and is forwarded to host port `8888`; the host PF anchor
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
  port `8888`. The PF anchor allows only host loopback and the untrusted VM's VZ
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
