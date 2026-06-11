// Normalizes plugin tool contracts from manifest metadata.
import type { PluginManifestContracts } from "./manifest.js";

export function normalizePluginToolContractNames(
  contracts: Pick<PluginManifestContracts, "tools"> | undefined,
): string[] {
  return normalizePluginToolNames(contracts?.tools);
}

export function normalizePluginToolNames(names: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized];
}

export function findUndeclaredPluginToolNames(params: {
  declaredNames: readonly string[];
  toolNames: readonly string[];
}): string[] {
  const declared = new Set<string>();
  const declaredPrefixes: string[] = [];
  for (const name of normalizePluginToolNames(params.declaredNames)) {
    // A contract entry like "locksmith_*" declares ownership of every tool
    // sharing that prefix, so plugins that project operator-configured tool
    // names (unknowable at manifest time) still pass the contract gate.
    if (name.endsWith("*") && name.length > 1) {
      declaredPrefixes.push(name.slice(0, -1));
    } else {
      declared.add(name);
    }
  }
  return normalizePluginToolNames(params.toolNames).filter(
    (name) => !declared.has(name) && !declaredPrefixes.some((prefix) => name.startsWith(prefix)),
  );
}
