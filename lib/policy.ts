/**
 * Privacy policy enforcement for cross-domain queries.
 *
 * Pure, side-effect-free functions. server.ts binds them to its loaded
 * ontology; tests construct fixtures and call them directly.
 */

export type Domain = "work" | "personal" | "life" | "learning";
export const VALID_DOMAINS: readonly Domain[] = ["work", "personal", "life", "learning"] as const;

export function isValidDomain(d: string): d is Domain {
  return (VALID_DOMAINS as readonly string[]).includes(d);
}

export type SynapseRule = {
  domain: string;
  entity_types: string[];
  sensitivity_max: string;
};

// `synapse_rules` keys can hold either rule arrays (`<domain>_can_see`) or a
// flat string list (`never_cross`). Express that in the type.
export type SynapseRulesMap = Record<string, SynapseRule[] | string[]>;

export type PolicyOntology = {
  synapse_rules?: SynapseRulesMap;
};

// Sensitivity ordering. Anything not in this map is treated as "internal".
export const SENSITIVITY_RANK: Record<string, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
};

export function sensitivityRank(level: string | undefined | null): number {
  if (!level) return SENSITIVITY_RANK.internal;
  return SENSITIVITY_RANK[level] ?? SENSITIVITY_RANK.internal;
}

export function getSynapseRules(ontology: PolicyOntology, callerDomain: Domain): SynapseRule[] {
  const raw = ontology.synapse_rules?.[`${callerDomain}_can_see`];
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (r): r is SynapseRule =>
      typeof r === "object" && r !== null && "domain" in (r as object)
  );
}

export function getSynapseDomains(ontology: PolicyOntology, callerDomain: Domain): Domain[] {
  const domains: Domain[] = [callerDomain];
  for (const rule of getSynapseRules(ontology, callerDomain)) {
    const d = rule.domain;
    if (isValidDomain(d) && !domains.includes(d)) {
      domains.push(d);
    }
  }
  return domains;
}

export function getNeverCrossTypes(ontology: PolicyOntology): string[] {
  const raw = ontology.synapse_rules?.never_cross;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((x): x is string => typeof x === "string");
}

/**
 * Returns true if a thought living in `homeDomain` is visible to a query whose
 * caller is `callerDomain`.
 *
 * `callerDomain === null` represents an explicit cross-domain query
 * (cross_domain: true, or discover_connections) where there is no single
 * caller — only `never_cross` quarantines apply.
 *
 * Rules:
 *   - same domain                            -> visible
 *   - thought type in never_cross            -> hidden whenever home != caller
 *                                                (also hidden in null-caller mode)
 *   - callerDomain is null                   -> visible (after never_cross filter)
 *   - else: must satisfy a synapse rule for `<caller>_can_see` containing
 *     `home`. The thought's type must be in the rule's entity_types list
 *     (empty list = no types allowed). The thought's sensitivity rank must
 *     be <= rule.sensitivity_max rank.
 */
export function isVisibleAcross(
  ontology: PolicyOntology,
  thought: { metadata?: { type?: string; sensitivity?: string } | null },
  homeDomain: Domain,
  callerDomain: Domain | null
): boolean {
  if (callerDomain === homeDomain) return true;

  const type: string = thought?.metadata?.type ?? "";
  if (getNeverCrossTypes(ontology).includes(type)) return false;

  if (callerDomain === null) return true;

  const rule = getSynapseRules(ontology, callerDomain).find((r) => r.domain === homeDomain);
  if (!rule) return false;

  if (rule.entity_types.length > 0 && !rule.entity_types.includes(type)) return false;

  const sensitivity = thought?.metadata?.sensitivity ?? "internal";
  return sensitivityRank(sensitivity) <= sensitivityRank(rule.sensitivity_max);
}
