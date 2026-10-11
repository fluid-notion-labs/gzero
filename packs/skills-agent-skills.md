# skills/agent-skills

## api-and-interface-design

- Guides stable API and interface design. #api #design
- when-to-use: Designing new API endpoints - Defining module boundaries or contracts between teams - Creating component prop interfaces - Establishing dat… #api #design
- core-principles: ### Hyrum's Law #api #design
- rest-api-patterns: ### Resource Design #api #design
- typescript-interface-patterns: ### Use Discriminated Unions for Variants #api #design
- red-flags: Endpoints that return different shapes depending on conditions - Inconsistent error formats across endpoints - Validation scattered through… #api #design

## spec-driven-development

- Creates specs before coding. #planning #spec
- when-to-use: Starting a new project or feature - Requirements are ambiguous or incomplete - The change touches multiple files or modules - You're about… #planning #spec
- the-gated-workflow: Spec-driven development has four phases, preceded by a scope check (Phase 0) that activates only when one request bundles several independe… #planning #spec
- objective: ## Tech Stack [Framework, language, key dependencies with versions] #planning #spec
- tech-stack: ## Commands [Build, test, lint, dev — full commands] #planning #spec
- commands: ## Project Structure [Directory layout with descriptions] #planning #spec
- project-structure: ## Code Style [Example snippet + key conventions] #planning #spec

## test-driven-development

- Drives development with tests using the red-green-refactor loop. #testing
- when-to-use: Implementing any new logic or behavior - Fixing any bug (the Prove-It Pattern) - Modifying existing functionality - Adding edge case handli… #testing
- discover-the-stack-first: The TDD cycle is universal; the commands are not. #testing
- the-prove-it-pattern-(bug-fixes): When a bug is reported, do not start by trying to fix it. #testing
- the-test-pyramid: Invest testing effort according to the pyramid — most tests should be small and fast, with progressively fewer tests at higher levels: #testing
- writing-good-tests: ### Test State, Not Interactions #testing

## debugging-and-error-recovery

- Guides systematic root-cause debugging. #debugging
- when-to-use: Tests fail after a code change - The build breaks - Runtime behavior doesn't match expectations - A bug report arrives - An error appears i… #debugging
- the-stop-the-line-rule: When anything unexpected happens: #debugging
- the-triage-checklist: Work through these steps in order. #debugging
- error-specific-patterns: ### Test Failure Triage #debugging
- safe-fallback-patterns: When under time pressure, use safe fallbacks: #debugging
- instrumentation-guidelines: Add logging only when it helps. #debugging

## code-review-and-quality

- Conducts multi-axis code review. #code-review
- when-to-use: Before merging any PR or change - After completing a feature implementation - When another agent or model produced code you need to evaluat… #code-review
- the-five-axis-review: Every review evaluates code across these dimensions: #code-review
- structural-remedies: When you flag a structural problem, propose the move — not just the problem. #code-review
- change-sizing: Small, focused changes are easier to review, faster to merge, and safer to deploy. #code-review
- change-descriptions: Every change needs a description that stands alone in version control history. #code-review
- review-process: ### Step 1: Understand the Context #code-review

## performance-optimization

- Optimizes application performance across frontend, backend, queries, and databases. #performance
- when-to-use: Performance requirements exist in the spec (load time budgets, response time SLAs) - Users or monitoring report slow behavior - Core Web Vi… #performance
- see-also: For detailed performance checklists, optimization commands, and anti-pattern reference, see ../../references/performance-checklist.md. #performance
- red-flags: Optimization without profiling data to justify it - N+1 query patterns in data fetching - An index added without a query plan before and af… #performance

## security-and-hardening

- Hardens code against vulnerabilities. #security
- when-to-use: Building anything that accepts user input - Implementing authentication or authorization - Storing or transmitting sensitive data - Integra… #security
- process:-threat-model-first: Controls bolted on without a threat model are guesses. #security
- the-three-tier-boundary-system: ### Always Do (No Exceptions) #security
- hardening-controls: The rules below are the workflow; a concrete implementation of each lives in [references/hardening-patterns.md](references/hardening-patter… #security
- review-checklist: Before sign-off, walk ../../references/security-checklist.md: it covers authentication, authorization, input, data protection and privacy,… #security

## ci-cd-and-automation

- Automates CI/CD pipeline setup. #ci
- when-to-use: Setting up a new project's CI pipeline - Adding or modifying automated checks - Configuring deployment pipelines - When a change should tri… #ci
- the-quality-gate-pipeline: Every change goes through these gates before merge: #ci
- github-actions-configuration: ### Basic CI Pipeline #ci
- feeding-ci-failures-back-to-agents: The power of CI with AI agents is the feedback loop. #ci
- deployment-strategies: ### Preview Deployments #ci

## frontend-ui-engineering

- Builds production-quality, accessible, responsive user-facing UIs. #frontend
- when-to-use: Building new UI components or pages - Modifying existing user-facing interfaces - Implementing responsive layouts - Adding interactivity or… #frontend
- component-architecture: ### File Structure #frontend
- state-management: Choose the simplest approach that works: #frontend
- design-system-adherence: ### Reference-led UI quality #frontend
- accessibility-(wcag-2.1-aa): Every component must meet these standards: #frontend
- responsive-design: Design for mobile first, then expand: #frontend
