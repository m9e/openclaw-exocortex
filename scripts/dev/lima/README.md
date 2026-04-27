# Lima OpenClaw VMs

These templates create two additive Lima guests on macOS without touching Podman's existing machine:

- `openclaw-gateway`: trusted VM for the OpenClaw gateway and trusted tools
- `openclaw-untrusted`: isolated VM for untrusted content and tool execution

Both instances use the Apple Virtualization.framework backend (`vmType: vz`) on Apple Silicon and disable Lima's catch-all localhost port forwarding. Only explicit host-loopback forwards are enabled.

## Host port mapping

- `openclaw-gateway`
  - host `127.0.0.1:29789` -> guest `127.0.0.1:18789`
  - host `127.0.0.1:29790` -> guest `127.0.0.1:18790`
- `openclaw-untrusted`
  - host `127.0.0.1:39789` -> guest `127.0.0.1:18789`
  - host `127.0.0.1:39790` -> guest `127.0.0.1:18790`

The OpenClaw Gateway forwards are for the Mac host only. Sibling Lima guests
should not use `host.lima.internal` to call the trusted gateway API.

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
and writes two guest helpers:

- `~/bin/openclaw`: runs the dev CLI from the guest checkout without typing `pnpm`
- `~/bin/openclaw-gateway-dev`: starts the gateway with local VM defaults

Set `OPENCLAW_GUEST_INSTALL_LOCKSMITH=0` only when you intentionally need a
non-hardened guest for debugging. The gateway helper also defaults
`OPENCLAW_REQUIRE_LOCKSMITH=1`; override that only for the same kind of
debugging session.

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
- generates a local bearer token in `~/.config/locksmith/locksmith.env`
- makes Locksmith reject unauthenticated `/tools`
- sets `plugins.entries.locksmith.config.required: true`
- hides the generic `locksmith_call` tool
- projects only `locksmith_github`
- constrains file tools to the workspace
- configures a tight `main` agent policy with local workspace edits, memory,
  status, plan, outbound message/TTS, session send/spawn/yield, subagent
  control, agent discovery, and `locksmith_github`
- denies direct shell/process, direct web, UI/browser, automation, node-control,
  media generation/understanding, session list/history, and generic
  `locksmith_call` on the trusted `main` agent

That policy keeps trusted orchestration and communication available while
removing the easy direct-egress bypasses from the gateway agent.

Check it from inside the guest:

```bash
systemctl --user status locksmith.service
openclaw locksmith status
openclaw locksmith tools
openclaw locksmith call github zen
```

## Configure the untrusted sandbox target

Use the host-side helper after both Lima instances are running:

```bash
bash scripts/dev/lima/configure-untrusted-sandbox.sh
```

The helper enables SSH in `openclaw-untrusted`, creates a gateway-only SSH key,
authorizes it in the untrusted guest, records the current untrusted Lima SSH
port and host key in the gateway config, installs an egress guard that blocks
the untrusted guest from calling the trusted gateway's host-forwarded OpenClaw
ports, blocks new outbound internet connections from the untrusted guest by
default, and re-runs the Locksmith policy installer.

After that, the trusted `main` agent can choose:

- local constrained work: `sessions_spawn` without `agentId`, or with
  `agentId: "main"`
- broader isolated work: `sessions_spawn` with `agentId: "untrusted"` and
  `sandbox: "require"`

The `untrusted` agent runs file tools and `exec`/`process` through the SSH
sandbox backend in `openclaw-untrusted`. It intentionally does not get direct
web/search/fetch, message/TTS, gateway, node, browser/UI, session-list/history,
projected Locksmith tools, or generic `locksmith_call` tools.

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
- The untrusted guest is blocked from reaching the trusted gateway's
  host-forwarded OpenClaw ports (`29789` and `29790` by default). Override the
  blocked list for experiments with `OPENCLAW_UNTRUSTED_BLOCK_HOST_PORTS`.
- The untrusted guest blocks new outbound TCP/UDP/ICMP internet connections by
  default after the helper runs. Set `OPENCLAW_UNTRUSTED_ALLOW_INTERNET=1` only
  for a deliberate experiment that needs direct network egress.
