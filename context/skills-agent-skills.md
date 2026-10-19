# Context — skills/agent-skills

## api-and-interface-design #api #design
- Guides stable API and interface design. #api #design
- red-flags: Endpoints that return different shapes depending on conditions; Inconsistent error formats across endpoints #api #design
- when-to-use: Designing new API endpoints; Defining module boundaries or contracts between teams; Creating component prop interfaces #api #design

## ci-cd-and-automation #ci
- Automates CI/CD pipeline setup. #ci
- feeding-ci-failures-back-to-agents: The power of CI with AI agents is the feedback loop. #ci
- when-to-use: Setting up a new project's CI pipeline; Adding or modifying automated checks; Configuring deployment pipelines #ci

## code-review-and-quality #code-review
- Conducts multi-axis code review. #code-review
- change-descriptions: Every change needs a description that stands alone in version control history. #code-review
- change-sizing: Small, focused changes are easier to review, faster to merge, and safer to deploy. #code-review
- structural-remedies: When you flag a structural problem, propose the move — not just the problem. #code-review
- when-to-use: Before merging any PR or change; After completing a feature implementation; When another agent or model produced code you need to evaluate #code-review

## debugging-and-error-recovery #debugging
- Guides systematic root-cause debugging. #debugging
- instrumentation-guidelines: Add logging only when it helps. #debugging
- the-triage-checklist: Work through these steps in order. #debugging
- when-to-use: Tests fail after a code change; The build breaks; Runtime behavior doesn't match expectations; A bug report arrives #debugging

## frontend-ui-engineering #frontend
- Builds production-quality, accessible, responsive user-facing UIs. #frontend
- when-to-use: Building new UI components or pages; Modifying existing user-facing interfaces; Implementing responsive layouts #frontend

## performance-optimization #performance
- Optimizes application performance across frontend, backend, queries, and databases. #performance
- red-flags: Optimization without profiling data to justify it; N+1 query patterns in data fetching #performance
- see-also: For detailed performance checklists, optimization commands, and anti-pattern reference, see ../../references/performance-checklist.md. #performance
- when-to-use: Performance requirements exist in the spec (load time budgets, response time SLAs); Users or monitoring report slow behavior #performance

## security-and-hardening #security
- Hardens code against vulnerabilities. #security
- hardening-controls: The rules below are the workflow; a concrete implementation of each lives in #security
- process-threat-model-first: Controls bolted on without a threat model are guesses. #security
- review-checklist: Before sign-off, walk ../../references/security-checklist.md: it covers authentication, authorization, input, data protection and privacy #security
- when-to-use: Building anything that accepts user input; Implementing authentication or authorization; Storing or transmitting sensitive data #security

## spec-driven-development #planning #spec
- Creates specs before coding. #planning #spec
- the-gated-workflow: Spec-driven development has four phases, preceded by a scope check (Phase 0) that activates only when one request bundles several #planning #spec
- when-to-use: Starting a new project or feature; Requirements are ambiguous or incomplete; The change touches multiple files or modules #planning #spec

## test-driven-development #testing
- Drives development with tests using the red-green-refactor loop. #testing
- discover-the-stack-first: The TDD cycle is universal; the commands are not. #testing
- the-prove-it-pattern-(bug-fixes): When a bug is reported, do not start by trying to fix it. #testing
- when-to-use: Implementing any new logic or behavior; Fixing any bug (the Prove-It Pattern); Modifying existing functionality; Adding edge case handling #testing
