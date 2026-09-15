/** Web-free research result for coordinator/UI tests; never starts a real provider. */
export const fakeBriefContent = {
  headline: "A practical agent workflow update",
  summary: "A small change to test in your development workflow.",
  items: [
    {
      title: "Evaluate parallel tasks including review time",
      category: "workflow" as const,
      publishedOn: "2026-09-15",
      whatChanged: "A practitioner published a controlled workflow experiment.",
      implication: "Independent tasks can be evaluated for parallel execution.",
      evidence: "practitioner_experience" as const,
      caveat: "This is a fixture, not a claim about current research.",
      nextStep: "Compare two independent tasks with your normal process.",
      sources: [
        { title: "Fixture source", url: "https://example.invalid/research" },
      ],
    },
  ],
  workflowExperiment:
    "Measure total development and review time for two independent tasks.",
  opportunity: null,
  coverage: "Fake research; no live sources were consulted.",
};
