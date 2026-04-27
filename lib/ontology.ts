/**
 * Ontology loader. The ontology YAML is the single source of truth for
 * domains, entity types, sensitivity rules, synapse rules, and inference
 * rules. It is loaded once at process start by server.ts and by every
 * maintenance script that needs the same view of the world.
 *
 * The current canonical version is v1.1.0. As future versions are added,
 * this loader can grow to resolve "latest" or accept a version pin.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { SynapseRule } from "./policy.ts";

export type Ontology = {
  version: string;
  domains: Record<string, { schema: string; default_sensitivity: string }>;
  horizons?: Record<string, { description: string; window_days: number; entity_defaults: string[] }>;
  entity_types: Record<string, { domain_default: string; sensitivity: string; default_horizon?: string }>;
  inference_rules: Array<{
    name: string;
    condition: Record<string, unknown>;
    action: { domain: string; sensitivity: string; confidence_boost: number };
  }>;
  // synapse_rules keys hold two shapes:
  //   "<domain>_can_see": SynapseRule[]
  //   "never_cross":      string[]   (entity types quarantined to their home)
  synapse_rules: Record<string, SynapseRule[] | string[]>;
};

export const CURRENT_ONTOLOGY_VERSION = "1.1.0";

function defaultOntology(): Ontology {
  return {
    version: "0.0.0",
    domains: {
      work: { schema: "ob_work", default_sensitivity: "internal" },
      personal: { schema: "ob_personal", default_sensitivity: "confidential" },
      life: { schema: "ob_life", default_sensitivity: "confidential" },
      learning: { schema: "ob_learning", default_sensitivity: "public" },
    },
    entity_types: {},
    inference_rules: [],
    synapse_rules: {},
  };
}

/**
 * Resolve the bundled ontology YAML path for `version` (e.g. "1.1.0").
 * Path is computed relative to this module so callers don't have to.
 */
export function ontologyPathFor(version: string = CURRENT_ONTOLOGY_VERSION): string {
  return new URL(`../ontology/v${version}.yaml`, import.meta.url).pathname;
}

/**
 * Load the bundled ontology. On read or parse failure, returns a minimal
 * fallback ontology with empty rule sets so callers can still operate.
 * `onError` lets the caller log the failure (defaults to silent).
 */
export function loadOntology(
  version: string = CURRENT_ONTOLOGY_VERSION,
  onError: (err: unknown) => void = () => {}
): Ontology {
  try {
    const path = ontologyPathFor(version);
    return parseYaml(readFileSync(path, "utf-8")) as Ontology;
  } catch (err) {
    onError(err);
    return defaultOntology();
  }
}
