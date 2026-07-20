# Chorus Roadmap

Chorus is a stateless AI Review Engine. Current product work centers on role-based workflows, source-backed findings, challenged conclusions, measurable review quality, and integration with engineering review surfaces.

## Current

- Code, architecture, and design review workflows
- Architecture, security, performance, maintainability, devil, and integrator roles
- Code, document, and log evidence contracts with workspace validation
- Markdown, JSON, GitHub review, and SARIF renderers
- Quick/deep profiles, git diff scope, CI policy, jobs, artifacts, cancellation, and resume
- Constrained JSON/YAML definitions and namespaced extension registries
- Single-reviewer comparison and seeded evaluation fixtures

## Next

- Validate workflow defaults with opt-in live-model evaluation and real developer acceptance data
- Improve PR comment update/deduplication after observing GitHub integration usage
- Add incident-response workflows only when event-history and case-management requirements are concrete
- Add renderer adapters for issue trackers and team collaboration tools based on demand

## Deferred

Long-term belief graphs, AGM belief revision, confidence propagation, lineage graphs, incremental reasoning, and cross-session belief state are deliberately deferred. They should enter implementation only after repeated user demand for historical reasoning, not merely because the architecture can accommodate them.
