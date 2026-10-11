# skills/claude-skills

## api-designer

- Use when designing REST or GraphQL APIs, creating OpenAPI specifications, or planning API architecture. #api #design
- core-workflow: 1. #api #design
- reference-guide: Load detailed guidance based on context: #api #design
- constraints: ### MUST DO - Follow REST principles (resource-oriented, proper HTTP methods) - Use consistent naming conventions (snake_case or camelCase… #api #design
- templates: ### OpenAPI 3.1 Resource Endpoint (copy-paste starter) #api #design
- output-checklist: When delivering an API design, provide: 1. #api #design
- knowledge-reference: REST architecture, OpenAPI 3.1, GraphQL, HTTP semantics, JSON:API, HATEOAS, OAuth 2.0, JWT, RFC 7807 Problem Details, API versioning patter… #api #design

## architecture-designer

- Use when designing new high-level system architecture, reviewing existing designs, or making architectural decisions. #architecture
- role-definition: You are a principal architect with 15+ years of experience designing scalable, distributed systems. #architecture
- when-to-use-this-skill: Designing new system architecture - Choosing between architectural patterns - Reviewing existing architecture - Creating Architecture Decis… #architecture
- core-workflow: 1. #architecture
- reference-guide: Load detailed guidance based on context: #architecture
- constraints: ### MUST DO - Document all significant decisions with ADRs - Consider non-functional requirements explicitly - Evaluate trade-offs, not jus… #architecture
- output-templates: When designing architecture, provide: 1. #architecture

## code-reviewer

- Analyzes code diffs and files to identify bugs, security vulnerabilities (SQL injection, XSS, insecure deserialization), code smells, N+1 queries, naming issue… #code-review
- when-to-use-this-skill: Reviewing pull requests - Conducting code quality audits - Identifying refactoring opportunities - Checking for security vulnerabilities -… #code-review
- core-workflow: 1. #code-review
- reference-guide: Load detailed guidance based on context: #code-review
- review-patterns-(quick-reference): ### N+1 Query — Bad vs Good python #code-review
- constraints: ### MUST DO - Summarize PR intent before reviewing (see Workflow step 1) - Provide specific, actionable feedback - Include code examples in… #code-review
- output-template: Code review report must include: 1. #code-review

## database-optimizer

- Optimizes database queries and improves performance across PostgreSQL and MySQL systems. #database
- when-to-use-this-skill: Analyzing slow queries and execution plans - Designing optimal index strategies - Tuning database configuration parameters - Optimizing sch… #database
- core-workflow: 1. #database
- reference-guide: Load detailed guidance based on context: #database
- common-operations-&-examples: ### Identify Top Slow Queries (PostgreSQL) sql -- Requires pg_stat_statements extension SELECT query, calls, round(total_exec_time::numeric… #database
- constraints: ### MUST DO - Capture EXPLAIN (ANALYZE, BUFFERS) output before optimizing — this is the baseline - Measure performance before and after eve… #database
- output-templates: When optimizing database performance, provide: 1. #database

## debugging-wizard

- Parses error messages, traces execution flow through stack traces, correlates log entries to identify failure points, and applies systematic hypothesis-driven… #debugging
- core-workflow: 1. #debugging
- reference-guide: Load detailed guidance based on context: #debugging
- constraints: ### MUST DO - Reproduce the issue first - Gather complete error messages and stack traces - Test one hypothesis at a time - Document findin… #debugging
- common-debugging-commands: Python (pdb) bash python -m pdb script.py # launch debugger #debugging
- output-templates: When debugging, provide: 1. #debugging

## cli-developer

- Use when building CLI tools, implementing argument parsing, or adding interactive prompts. #cli
- core-workflow: 1. #cli
- reference-guide: Load detailed guidance based on context: #cli
- quick-start-example: ### Node.js (commander) #cli
- constraints: ### MUST DO - Keep startup time under 50ms - Provide clear, actionable error messages - Support --help and --version flags - Use consistent… #cli
- output-templates: When implementing CLI features, provide: 1. #cli
- knowledge-reference: CLI frameworks (commander, yargs, oclif, click, typer, argparse, cobra, viper), terminal UI (chalk, inquirer, rich, bubbletea), testing (sn… #cli

## devops-engineer

- Creates Dockerfiles, configures CI/CD pipelines, writes Kubernetes manifests, and generates Terraform/Pulumi infrastructure templates. #devops
- role-definition: You are a senior DevOps engineer with 10+ years of experience. #devops
- when-to-use-this-skill: Setting up CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins) - Containerizing applications (Docker, Docker Compose) - Kubernetes deploym… #devops
- core-workflow: 1. #devops
- reference-guide: Load detailed guidance based on context: #devops
- constraints: ### MUST DO - Use infrastructure as code (never manual changes) - Implement health checks and readiness probes - Store secrets in secret ma… #devops
- output-templates: Provide: CI/CD pipeline config, Dockerfile, K8s/Terraform files, deployment verification, rollback procedure #devops

## fastapi-expert

- Use when building high-performance async Python APIs with FastAPI and Pydantic V2. #python #api
- when-to-use-this-skill: Building REST APIs with FastAPI - Implementing Pydantic V2 validation schemas - Setting up async database operations - Implementing JWT aut… #python #api
- core-workflow: 1. #python #api
- minimal-complete-example: Schema + endpoint + dependency injection in one cohesive unit: #python #api
- reference-guide: Load detailed guidance based on context: #python #api
- constraints: ### MUST DO - Use type hints everywhere (FastAPI requires them) - Use Pydantic V2 syntax (field_validator, model_validator, model_config) -… #python #api

## django-expert

- Use when building Django web applications or REST APIs with Django REST Framework. #python
- when-to-use-this-skill: Building Django web applications or REST APIs - Designing Django models with proper relationships - Implementing DRF serializers and viewse… #python
- core-workflow: 1. #python
- reference-guide: Load detailed guidance based on context: #python
- minimal-working-example: The snippet below demonstrates the core MUST DO constraints: indexed fields, select_related, serializer validation, and endpoint permission… #python
- constraints: ### MUST DO - Use select_related/prefetch_related for related objects - Add database indexes for frequently queried fields - Use environmen… #python
- output-templates: When implementing Django features, provide: 1. #python

## python-pro

- Use when building Python 3.11+ applications requiring type safety, async programming, or robust error handling. #python
- when-to-use-this-skill: Writing type-safe Python with complete type coverage - Implementing async/await patterns for I/O operations - Setting up pytest test suites… #python
- core-workflow: 1. #python
- reference-guide: Load detailed guidance based on context: #python
- constraints: ### MUST DO - Type hints for all function signatures and class attributes - PEP 8 compliance with black formatting - Comprehensive docstrin… #python
- code-examples: ### Type-annotated function with error handling python from pathlib import Path #python
- output-templates: When implementing Python features, provide: 1. #python

## rust-engineer

- Writes, reviews, and debugs idiomatic Rust code with memory safety and zero-cost abstractions. #rust
- core-workflow: 1. #rust
- reference-guide: Load detailed guidance based on context: #rust
- key-patterns-with-examples: ### Ownership & Lifetimes #rust
- constraints: ### MUST DO - Use ownership and borrowing for memory safety - Minimize unsafe code (document all unsafe blocks with safety invariants) - Us… #rust
- output-templates: When implementing Rust features, provide: 1. #rust
- knowledge-reference: Rust 2021, Cargo, ownership/borrowing, lifetimes, traits, generics, async/await, tokio, Result/Option, thiserror/anyhow, serde, clippy, rus… #rust

## typescript-pro

- Implements advanced TypeScript type systems, creates custom type guards, utility types, and branded types, and configures tRPC for end-to-end type safety. #typescript
- core-workflow: 1. #typescript
- reference-guide: Load detailed guidance based on context: #typescript
- code-examples: ### Branded Types typescript // Branded type for domain modeling type Brand<T, B extends string> = T & { readonly __brand: B }; type UserId… #typescript
- constraints: ### MUST DO - Enable strict mode with all compiler flags - Use type-first API design - Implement branded types for domain modeling - Use sa… #typescript
- output-templates: When implementing TypeScript features, provide: 1. #typescript
- knowledge-reference: TypeScript 5.0+, generics, conditional types, mapped types, template literal types, discriminated unions, type guards, branded types, tRPC,… #typescript

## javascript-pro

- Writes, debugs, and refactors JavaScript code using modern ES2023+ features, async/await patterns, ESM module systems, and Node.js APIs. #javascript
- when-to-use-this-skill: Building vanilla JavaScript applications - Implementing async/await patterns and Promise handling - Working with modern module systems (ESM… #javascript
- core-workflow: 1. #javascript
- reference-guide: Load detailed guidance based on context: #javascript
- constraints: ### MUST DO - Use ES2023+ features exclusively - Use X | null or X | undefined patterns - Use optional chaining (?.) and nullish coalescing… #javascript
- key-patterns-with-examples: ### Async/Await Error Handling js // ✅ Correct — always handle async errors explicitly async function fetchUser(id) { try { const response… #javascript
- output-templates: When implementing JavaScript features, provide: 1. #javascript

## react-expert

- Use when building React 18+ applications in .jsx or .tsx files, Next.js App Router projects, or create-react-app setups. #frontend #react
- when-to-use-this-skill: Building new React components or features - Implementing state management (local, Context, Redux, Zustand) - Optimizing React performance -… #frontend #react
- core-workflow: 1. #frontend #react
- reference-guide: Load detailed guidance based on context: #frontend #react
- key-patterns: ### Server Component (Next.js App Router) tsx // app/users/page.tsx — Server Component, no "use client" import { db } from '@/lib/db'; #frontend #react
- constraints: ### MUST DO - Use TypeScript with strict mode - Implement error boundaries for graceful failures - Use key props correctly (stable, unique… #frontend #react
- output-templates: When implementing React features, provide: 1. #frontend #react

## nextjs-developer

- Use when building Next.js 14+ applications with App Router, server components, or server actions. #frontend #nextjs
- core-workflow: 1. #frontend #nextjs
- reference-guide: Load detailed guidance based on context: #frontend #nextjs
- constraints: ### MUST DO (Next.js-specific) - Use App Router (app/ directory), never Pages Router (pages/) - Keep components as Server Components by def… #frontend #nextjs
- code-examples: ### Server Component with data fetching and caching tsx // app/products/page.tsx import { Suspense } from 'react' #frontend #nextjs
- output-templates: When implementing Next.js features, provide: 1. #frontend #nextjs
- knowledge-reference: Next.js 14+, App Router, React Server Components, Server Actions, Streaming SSR, Partial Prerendering, next/image, next/font, Metadata API,… #frontend #nextjs

## playwright-expert

- Use when writing E2E tests with Playwright, setting up test infrastructure, or debugging flaky browser tests. #testing #web
- core-workflow: 1. #testing #web
- reference-guide: Load detailed guidance based on context: #testing #web
- constraints: ### MUST DO - Use role-based selectors when possible - Leverage auto-waiting (don't add arbitrary timeouts) - Keep tests independent (no sh… #testing #web
- code-examples: ### Selector: Role-based (correct) vs CSS class (brittle) #testing #web
- output-templates: When implementing Playwright tests, provide: 1. #testing #web
- knowledge-reference: Playwright, Page Object Model, auto-waiting, locators, fixtures, API mocking, trace viewer, visual comparisons, parallel execution, CI/CD i… #testing #web

## test-master

- Generates test files, creates mocking strategies, analyzes code coverage, designs test architectures, and produces test plans and defect reports across functio… #testing
- core-workflow: 1. #testing
- quick-start-example: A minimal Jest unit test illustrating the key patterns this skill enforces: #testing
- reference-guide: Load detailed guidance based on context: #testing
- constraints: MUST DO - Test happy paths AND error/edge cases (e.g., empty input, null, boundary values) - Mock external dependencies — never call real A… #testing
- output-templates: When creating test plans, provide: 1. #testing

## postgres-pro

- Use when optimizing PostgreSQL queries, configuring replication, or implementing advanced database features. #database #postgres
- when-to-use-this-skill: Analyzing and optimizing slow queries with EXPLAIN - Implementing JSONB storage and indexing strategies - Setting up streaming or logical r… #database #postgres
- core-workflow: 1. #database #postgres
- reference-guide: Load detailed guidance based on context: #database #postgres
- common-patterns: ### JSONB — GIN Index and Query #database #postgres
- constraints: ### MUST DO - Use EXPLAIN (ANALYZE, BUFFERS) for query optimization - Verify indexes are actually used with EXPLAIN before and after creati… #database #postgres
- output-templates: When implementing PostgreSQL solutions, provide: 1. #database #postgres

## sql-pro

- Optimizes SQL queries, designs database schemas, and troubleshoots performance issues. #database
- core-workflow: 1. #database
- reference-guide: Load detailed guidance based on context: #database
- quick-reference-examples: ### CTE Pattern sql -- Isolate expensive subquery logic for reuse and readability WITH ranked_orders AS ( SELECT customer_id, order_id, tot… #database
- constraints: ### MUST DO - Analyze execution plans before recommending optimizations - Use set-based operations over row-by-row processing - Apply filte… #database
- output-templates: When implementing SQL solutions, provide: 1. #database

## kubernetes-specialist

- Use when deploying or managing Kubernetes workloads. #kubernetes #devops
- when-to-use-this-skill: Deploying workloads (Deployments, StatefulSets, DaemonSets, Jobs) - Configuring networking (Services, Ingress, NetworkPolicies) - Managing… #kubernetes #devops
- core-workflow: 1. #kubernetes #devops
- reference-guide: Load detailed guidance based on context: #kubernetes #devops
- constraints: ### MUST DO - Use declarative YAML manifests (avoid imperative kubectl commands) - Set resource requests and limits on all containers - Inc… #kubernetes #devops
- common-yaml-patterns: ### Deployment with resource limits, probes, and security context #kubernetes #devops
- validation-commands: After deploying, verify health and security posture: #kubernetes #devops

## terraform-engineer

- Use when implementing infrastructure as code with Terraform across AWS, Azure, or GCP. #terraform #devops
- core-workflow: 1. #terraform #devops
- reference-guide: Load detailed guidance based on context: #terraform #devops
- constraints: ### MUST DO - Use semantic versioning and pin provider versions - Enable remote state with locking and encryption - Validate inputs with va… #terraform #devops
- code-examples: ### Minimal Module Structure #terraform #devops
- output-format: When implementing Terraform solutions, provide: module structure (main.tf, variables.tf, outputs.tf), backend and provider configuration, e… #terraform #devops

## monitoring-expert

- Configures monitoring systems, implements structured logging pipelines, creates Prometheus/Grafana dashboards, defines alerting rules, and instruments distribu… #monitoring #devops
- core-workflow: 1. #monitoring #devops
- quick-start-examples: ### Structured Logging (Node.js / Pino) js import pino from 'pino'; #monitoring #devops
- reference-guide: Load detailed guidance based on context: #monitoring #devops
- constraints: ### MUST DO - Use structured logging (JSON) - Include request IDs for correlation - Set up alerts for critical paths - Monitor business met… #monitoring #devops

## microservices-architect

- Designs distributed system architectures, decomposes monoliths into bounded-context services, recommends communication patterns, and produces service boundary… #architecture
- core-workflow: 1. #architecture
- reference-guide: Load detailed guidance based on context: #architecture
- implementation-examples: ### Correlation ID Middleware (Node.js / Express) js const { v4: uuidv4 } = require('uuid'); #architecture
- constraints: ### MUST DO - Apply domain-driven design for service boundaries - Use database per service pattern - Implement circuit breakers for externa… #architecture
- output-templates: When designing microservices architecture, provide: 1. #architecture
- knowledge-reference: Domain-driven design, bounded contexts, event storming, REST/gRPC, message queues (Kafka, RabbitMQ), service mesh (Istio, Linkerd), Kuberne… #architecture

## spec-miner

- Reverse-engineering specialist that extracts specifications from existing codebases. #architecture #spec
- role-definition: You operate with two perspectives: Arch Hat for system architecture and data flows, and QA Hat for observable behaviors and edge cases. #architecture #spec
- when-to-use-this-skill: Understanding legacy or undocumented systems - Creating documentation for existing code - Onboarding to a new codebase - Planning enhanceme… #architecture #spec
- core-workflow: 1. #architecture #spec
- reference-guide: Load detailed guidance based on context: #architecture #spec
- constraints: ### MUST DO - Ground all observations in actual code evidence - Use Read, Grep, Glob extensively to explore - Distinguish between observed… #architecture #spec
- output-templates: Save specification as: specs/{project_name}_reverse_spec.md #architecture #spec

## code-documenter

- Generates, formats, and validates technical documentation — including docstrings, OpenAPI/Swagger specs, JSDoc annotations, doc portals, and user guides. #docs
- when-to-use-this-skill: Adding docstrings to functions, classes, and modules - Writing OpenAPI/Swagger specs or JSDoc annotations - Creating API documentation for… #docs
- core-workflow: 1. #docs
- quick-reference-examples: ### Google-style Docstring (Python) python def fetch_user(user_id: int, active_only: bool = True) -> dict: """Fetch a single user record by… #docs
- reference-guide: Load detailed guidance based on context: #docs
- constraints: ### MUST DO - Ask for format preference before starting - Detect framework for correct API doc strategy - Document all public functions/cla… #docs
- output-formats: Depending on the task, provide: 1. #docs

## security-reviewer

- Identifies security vulnerabilities, generates structured audit reports with severity ratings, and provides actionable remediation guidance. #security #code-review
- when-to-use-this-skill: Code review and SAST scanning - Vulnerability scanning and dependency audits - Secrets scanning and credential detection - Penetration test… #security #code-review
- core-workflow: 1. #security #code-review
- reference-guide: Load detailed guidance based on context: #security #code-review
- constraints: ### MUST DO - Check authentication/authorization first - Run automated tools before manual review - Provide specific file/line locations -… #security #code-review
- output-templates: 1. #security #code-review
- knowledge-reference: OWASP Top 10, CWE, Semgrep, Bandit, ESLint Security, gosec, npm audit, gitleaks, trufflehog, CVSS scoring, nmap, Burp Suite, sqlmap, Trivy,… #security #code-review

## mcp-developer

- Use when building, debugging, or extending MCP servers or clients that connect AI systems with external tools and data sources. #mcp
- core-workflow: 1. #mcp
- reference-guide: Load detailed guidance based on context: #mcp
- minimal-working-example: ### TypeScript — Tool with Zod Validation #mcp
- constraints: ### MUST DO - Implement JSON-RPC 2.0 protocol correctly - Validate all inputs with schemas (Zod/Pydantic) - Use proper transport mechanisms… #mcp
- output-templates: When implementing MCP features, provide: 1. #mcp

## prompt-engineer

- Writes, refactors, and evaluates prompts for LLMs — generating optimized prompt templates, structured output schemas, evaluation rubrics, and test suites. #prompting
- when-to-use-this-skill: Designing prompts for new LLM applications - Optimizing existing prompts for better accuracy or efficiency - Implementing chain-of-thought… #prompting
- core-workflow: 1. #prompting
- reference-guide: Load detailed guidance based on context: #prompting
- prompt-examples: ### Zero-shot vs. #prompting
- constraints: ### MUST DO - Test prompts with diverse, realistic inputs including edge cases - Measure performance with quantitative metrics (accuracy, c… #prompting
- output-templates: When delivering prompt work, provide: 1. #prompting

## the-fool

- Use when challenging ideas, plans, decisions, or proposals using structured critical reasoning. #decision #review
- when-to-use-this-skill: Stress-testing a plan, architecture, or strategy before committing - Challenging technology, vendor, or approach choices - Evaluating busin… #decision #review
- core-workflow: 1. #decision #review
- mode-selection: Use AskUserQuestion to let the user choose how to challenge their idea. #decision #review
- constraints: ### MUST DO - Steelman the thesis before challenging it (restate in strongest form) - Use AskUserQuestion for mode selection — never assume… #decision #review
