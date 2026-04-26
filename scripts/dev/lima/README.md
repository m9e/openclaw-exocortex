# Lima OpenClaw VMs

These templates create two additive Lima guests on macOS without touching Podman's existing machine:

- `openclaw-gateway`: trusted VM for the OpenClaw gateway and trusted tools
- `openclaw-untrusted`: isolated VM for untrusted content and tool execution

Both instances use the Apple Virtualization.framework backend (`vmType: vz`) on Apple Silicon and disable Lima's catch-all localhost port forwarding. Only explicit localhost forwards are enabled.

## Host port mapping

- `openclaw-gateway`
  - host `*:29789` -> guest `127.0.0.1:18789`
  - host `*:29790` -> guest `127.0.0.1:18790`
- `openclaw-untrusted`
  - host `*:39789` -> guest `127.0.0.1:18789`
  - host `*:39790` -> guest `127.0.0.1:18790`

From another Lima guest, reach those services via `host.lima.internal`.
Because the forwards bind on all host interfaces, they are also reachable from the host LAN unless a local firewall blocks them.

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
`~/.openclaw/gateway.token`, and writes two guest helpers:

- `~/bin/openclaw`: runs the dev CLI from the guest checkout without typing `pnpm`
- `~/bin/openclaw-gateway-dev`: starts the gateway with local VM defaults

The helper starts with `--allow-unconfigured` by default for first-boot VM
bring-up; set `OPENCLAW_GATEWAY_REQUIRE_CONFIG=1` once you want config to be
mandatory.

Open a new guest shell after install, then run CLI commands directly:

```bash
openclaw pairing list --channel telegram
openclaw channels status --probe
```

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
