import { describe, expect, test } from "bun:test";
import {
  type Domain,
  type PolicyOntology,
  getSynapseDomains,
  isVisibleAcross,
  sensitivityRank,
} from "../lib/policy.ts";

// Mirror of the relevant slice of ontology/v1.1.0.yaml. Hand-coded so that
// changes to the live ontology don't quietly weaken what these tests check.
const ontology: PolicyOntology = {
  synapse_rules: {
    work_can_see: [
      {
        domain: "learning",
        entity_types: ["learning", "reference", "research", "idea"],
        sensitivity_max: "internal",
      },
    ],
    personal_can_see: [
      {
        domain: "life",
        entity_types: ["health", "goal"],
        sensitivity_max: "confidential",
      },
    ],
    life_can_see: [
      {
        domain: "learning",
        entity_types: ["learning", "reference"],
        sensitivity_max: "public",
      },
    ],
    learning_can_see: [],
    never_cross: ["financial", "custody", "psychological", "person_note"],
  },
};

const thought = (type: string, sensitivity = "internal") => ({
  metadata: { type, sensitivity },
});

describe("sensitivityRank", () => {
  test("orders public < internal < confidential < secret", () => {
    expect(sensitivityRank("public")).toBeLessThan(sensitivityRank("internal"));
    expect(sensitivityRank("internal")).toBeLessThan(sensitivityRank("confidential"));
    expect(sensitivityRank("confidential")).toBeLessThan(sensitivityRank("secret"));
  });

  test("treats unknown / missing as internal", () => {
    expect(sensitivityRank(undefined)).toBe(sensitivityRank("internal"));
    expect(sensitivityRank("unknown-level")).toBe(sensitivityRank("internal"));
  });
});

describe("getSynapseDomains", () => {
  test("work expands to itself + learning", () => {
    expect(getSynapseDomains(ontology, "work" as Domain).sort()).toEqual(["learning", "work"]);
  });

  test("learning expands to only itself", () => {
    expect(getSynapseDomains(ontology, "learning" as Domain)).toEqual(["learning"]);
  });
});

describe("isVisibleAcross", () => {
  test("same domain: always visible", () => {
    expect(isVisibleAcross(ontology, thought("financial", "secret"), "personal", "personal")).toBe(
      true
    );
    expect(isVisibleAcross(ontology, thought("psychological", "secret"), "personal", "personal")).toBe(
      true
    );
  });

  test("never_cross types: hidden when caller != home, even with synapse rule", () => {
    // financial is in never_cross. work_can_see learning, but financial in
    // learning would be hidden (and learning isn't its home anyway). Test
    // financial in personal, which is its home — visible from personal,
    // hidden from any other caller and from null caller.
    expect(isVisibleAcross(ontology, thought("financial", "secret"), "personal", "work")).toBe(
      false
    );
    expect(isVisibleAcross(ontology, thought("financial", "secret"), "personal", "life")).toBe(
      false
    );
    expect(isVisibleAcross(ontology, thought("financial", "secret"), "personal", null)).toBe(false);
  });

  test("never_cross applies to null caller (cross_domain mode)", () => {
    expect(isVisibleAcross(ontology, thought("custody", "secret"), "personal", null)).toBe(false);
    expect(
      isVisibleAcross(ontology, thought("psychological", "secret"), "personal", null)
    ).toBe(false);
    expect(isVisibleAcross(ontology, thought("person_note"), "personal", null)).toBe(false);
  });

  test("null caller: non-never_cross types pass", () => {
    expect(isVisibleAcross(ontology, thought("learning", "public"), "learning", null)).toBe(true);
    expect(isVisibleAcross(ontology, thought("meeting", "internal"), "work", null)).toBe(true);
  });

  test("synapse rule must exist for the home domain", () => {
    // learning_can_see = [], so learning caller cannot see work
    expect(isVisibleAcross(ontology, thought("meeting", "internal"), "work", "learning")).toBe(
      false
    );
    // No work_can_see life rule
    expect(isVisibleAcross(ontology, thought("goal", "confidential"), "life", "work")).toBe(false);
  });

  test("synapse rule entity_types whitelist is honored", () => {
    // work_can_see learning entity_types = [learning, reference, research, idea]
    expect(isVisibleAcross(ontology, thought("learning", "public"), "learning", "work")).toBe(true);
    // observation is NOT in the whitelist
    expect(isVisibleAcross(ontology, thought("observation", "public"), "learning", "work")).toBe(
      false
    );
  });

  test("sensitivity_max is enforced", () => {
    // work_can_see learning sensitivity_max = internal
    expect(isVisibleAcross(ontology, thought("learning", "public"), "learning", "work")).toBe(true);
    expect(isVisibleAcross(ontology, thought("learning", "internal"), "learning", "work")).toBe(
      true
    );
    // confidential exceeds the ceiling
    expect(
      isVisibleAcross(ontology, thought("learning", "confidential"), "learning", "work")
    ).toBe(false);
  });

  test("personal->life synapse: health/goal pass at confidential, others blocked", () => {
    expect(isVisibleAcross(ontology, thought("health", "confidential"), "life", "personal")).toBe(
      true
    );
    expect(isVisibleAcross(ontology, thought("goal", "confidential"), "life", "personal")).toBe(
      true
    );
    // belief is not in entity_types
    expect(
      isVisibleAcross(ontology, thought("belief", "confidential"), "life", "personal")
    ).toBe(false);
  });

  test("life->learning synapse caps at public", () => {
    expect(isVisibleAcross(ontology, thought("learning", "public"), "learning", "life")).toBe(true);
    // internal exceeds the ceiling
    expect(
      isVisibleAcross(ontology, thought("learning", "internal"), "learning", "life")
    ).toBe(false);
  });

  test("missing sensitivity defaults to internal (passes when ceiling is internal)", () => {
    const t = { metadata: { type: "learning" } };
    expect(isVisibleAcross(ontology, t, "learning", "work")).toBe(true);
  });

  test("missing type does not match any never_cross or whitelist", () => {
    // No type -> not in never_cross (good), but also not in any synapse
    // entity_types whitelist with non-empty entries -> hidden across.
    const t = { metadata: { sensitivity: "internal" } };
    expect(isVisibleAcross(ontology, t, "learning", "work")).toBe(false);
    expect(isVisibleAcross(ontology, t, "learning", "learning")).toBe(true);
    // null caller, non-never_cross type -> visible
    expect(isVisibleAcross(ontology, t, "learning", null)).toBe(true);
  });
});
