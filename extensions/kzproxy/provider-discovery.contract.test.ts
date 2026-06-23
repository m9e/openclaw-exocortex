// Kzproxy tests cover provider discovery.contract plugin behavior.
import { fileURLToPath } from "node:url";
import { describeKzproxyProviderDiscoveryContract } from "openclaw/plugin-sdk/provider-test-contracts";

describeKzproxyProviderDiscoveryContract({
  load: () => import("./index.js"),
  apiModuleId: fileURLToPath(new URL("./api.js", import.meta.url)),
});
