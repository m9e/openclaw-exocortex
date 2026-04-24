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

## Isolation model

- `openclaw-gateway` inherits Lima's default read-only home mount so it can inspect the host repo without mutating it.
- `openclaw-untrusted` mounts no host directories.
- Neither VM auto-forwards random guest localhost ports back onto the host.
