# Context — skills/claude-skills

## api-designer #api #design
- Use when designing REST or GraphQL APIs, creating OpenAPI specifications, or planning API architecture. #api #design
- knowledge-reference: REST architecture, OpenAPI 3.1, GraphQL, HTTP semantics, JSON:API, HATEOAS, OAuth 2.0, JWT, RFC 7807 Problem Details #api #design
- output-checklist: When delivering an API design, provide: 1. #api #design

## architecture-designer #architecture
- Use when designing new high-level system architecture, reviewing existing designs, or making architectural decisions. #architecture
- output-templates: When designing architecture, provide: 1. #architecture
- role-definition: You are a principal architect with 15+ years of experience designing scalable, distributed systems. #architecture
- when-to-use-this-skill: Designing new system architecture; Choosing between architectural patterns; Reviewing existing architecture #architecture

## cli-developer #cli
- Use when building CLI tools, implementing argument parsing, or adding interactive prompts. #cli
- knowledge-reference: CLI frameworks (commander, yargs, oclif, click, typer, argparse, cobra, viper), terminal UI (chalk, inquirer, rich, bubbletea) #cli
- output-templates: When implementing CLI features, provide: 1. #cli

## code-documenter #docs
- Generates, formats, and validates technical documentation — including docstrings, OpenAPI/Swagger specs, JSDoc annotations, doc portals, and user guides. #docs
- output-formats: Depending on the task, provide: 1. #docs
- when-to-use-this-skill: Adding docstrings to functions, classes, and modules; Writing OpenAPI/Swagger specs or JSDoc annotations #docs

## code-reviewer #code-review
- Analyzes code diffs and files to identify bugs, security vulnerabilities (SQL injection, XSS, insecure deserialization), code smells, N+1 queries #code-review
- output-template: Code review report must include: 1. #code-review
- when-to-use-this-skill: Reviewing pull requests; Conducting code quality audits; Identifying refactoring opportunities; Checking for security vulnerabilities #code-review

## database-optimizer #database
- Optimizes database queries and improves performance across PostgreSQL and MySQL systems. #database
- output-templates: When optimizing database performance, provide: 1. #database
- when-to-use-this-skill: Analyzing slow queries and execution plans; Designing optimal index strategies; Tuning database configuration parameters #database

## debugging-wizard #debugging
- Parses error messages, traces execution flow through stack traces, correlates log entries to identify failure points #debugging
- common-debugging-commands: Python (pdb) bash python -m pdb script.py # launch debugger #debugging
- output-templates: When debugging, provide: 1. #debugging

## devops-engineer #devops
- Creates Dockerfiles, configures CI/CD pipelines, writes Kubernetes manifests, and generates Terraform/Pulumi infrastructure templates. #devops
- output-templates: Provide: CI/CD pipeline config, Dockerfile, K8s/Terraform files, deployment verification, rollback procedure #devops
- role-definition: You are a senior DevOps engineer with 10+ years of experience. #devops
- when-to-use-this-skill: Setting up CI/CD pipelines (GitHub Actions, GitLab CI, Jenkins); Containerizing applications (Docker, Docker Compose) #devops

## django-expert #python
- Use when building Django web applications or REST APIs with Django REST Framework. #python
- minimal-working-example: The snippet below demonstrates the core MUST DO constraints: indexed fields, select_related, serializer validation #python
- output-templates: When implementing Django features, provide: 1. #python
- when-to-use-this-skill: Building Django web applications or REST APIs; Designing Django models with proper relationships #python

## fastapi-expert #api #python
- Use when building high-performance async Python APIs with FastAPI and Pydantic V2. #python #api
- when-to-use-this-skill: Building REST APIs with FastAPI; Implementing Pydantic V2 validation schemas; Setting up async database operations #python #api

## javascript-pro #javascript
- Writes, debugs, and refactors JavaScript code using modern ES2023+ features, async/await patterns, ESM module systems, and Node.js APIs. #javascript
- output-templates: When implementing JavaScript features, provide: 1. #javascript
- when-to-use-this-skill: Building vanilla JavaScript applications; Implementing async/await patterns and Promise handling #javascript

## kubernetes-specialist #devops #kubernetes
- Use when deploying or managing Kubernetes workloads. #kubernetes #devops
- when-to-use-this-skill: Deploying workloads (Deployments, StatefulSets, DaemonSets, Jobs); Configuring networking (Services, Ingress, NetworkPolicies) #kubernetes #devops

## mcp-developer #mcp
- Use when building, debugging, or extending MCP servers or clients that connect AI systems with external tools and data sources. #mcp
- output-templates: When implementing MCP features, provide: 1. #mcp

## microservices-architect #architecture
- Designs distributed system architectures, decomposes monoliths into bounded-context services, recommends communication patterns #architecture
- knowledge-reference: Domain-driven design, bounded contexts, event storming, REST/gRPC, message queues (Kafka, RabbitMQ), service mesh (Istio, Linkerd) #architecture
- output-templates: When designing microservices architecture, provide: 1. #architecture

## monitoring-expert #devops #monitoring
- Configures monitoring systems, implements structured logging pipelines, creates Prometheus/Grafana dashboards, defines alerting rules #monitoring #devops

## nextjs-developer #frontend #nextjs
- Use when building Next.js 14+ applications with App Router, server components, or server actions. #frontend #nextjs
- knowledge-reference: Next.js 14+, App Router, React Server Components, Server Actions, Streaming SSR, Partial Prerendering, next/image, next/font, Metadata API #frontend #nextjs
- output-templates: When implementing Next.js features, provide: 1. #frontend #nextjs

## playwright-expert #testing #web
- Use when writing E2E tests with Playwright, setting up test infrastructure, or debugging flaky browser tests. #testing #web
- knowledge-reference: Playwright, Page Object Model, auto-waiting, locators, fixtures, API mocking, trace viewer, visual comparisons, parallel execution #testing #web
- output-templates: When implementing Playwright tests, provide: 1. #testing #web

## postgres-pro #database #postgres
- Use when optimizing PostgreSQL queries, configuring replication, or implementing advanced database features. #database #postgres
- output-templates: When implementing PostgreSQL solutions, provide: 1. #database #postgres
- when-to-use-this-skill: Analyzing and optimizing slow queries with EXPLAIN; Implementing JSONB storage and indexing strategies #database #postgres

## prompt-engineer #prompting
- Writes, refactors, and evaluates prompts for LLMs — generating optimized prompt templates, structured output schemas, evaluation rubrics, and test suites. #prompting
- output-templates: When delivering prompt work, provide: 1. #prompting
- when-to-use-this-skill: Designing prompts for new LLM applications; Optimizing existing prompts for better accuracy or efficiency #prompting

## python-pro #python
- Use when building Python 3.11+ applications requiring type safety, async programming, or robust error handling. #python
- output-templates: When implementing Python features, provide: 1. #python
- when-to-use-this-skill: Writing type-safe Python with complete type coverage; Implementing async/await patterns for I/O operations #python

## react-expert #frontend #react
- Use when building React 18+ applications in .jsx or .tsx files, Next.js App Router projects, or create-react-app setups. #frontend #react
- output-templates: When implementing React features, provide: 1. #frontend #react
- when-to-use-this-skill: Building new React components or features; Implementing state management (local, Context, Redux, Zustand); Optimizing React performance #frontend #react

## rust-engineer #rust
- Writes, reviews, and debugs idiomatic Rust code with memory safety and zero-cost abstractions. #rust
- knowledge-reference: Rust 2021, Cargo, ownership/borrowing, lifetimes, traits, generics, async/await, tokio, Result/Option, thiserror/anyhow, serde, clippy #rust
- output-templates: When implementing Rust features, provide: 1. #rust

## security-reviewer #code-review #security
- Identifies security vulnerabilities, generates structured audit reports with severity ratings, and provides actionable remediation guidance. #security #code-review
- knowledge-reference: OWASP Top 10, CWE, Semgrep, Bandit, ESLint Security, gosec, npm audit, gitleaks, trufflehog, CVSS scoring, nmap, Burp Suite, sqlmap, Trivy #security #code-review
- when-to-use-this-skill: Code review and SAST scanning; Vulnerability scanning and dependency audits; Secrets scanning and credential detection #security #code-review

## spec-miner #architecture #spec
- Reverse-engineering specialist that extracts specifications from existing codebases. #architecture #spec
- output-templates: Save specification as: specs/{project_name}_reverse_spec.md #architecture #spec
- role-definition: You operate with two perspectives: Arch Hat for system architecture and data flows, and QA Hat for observable behaviors and edge cases. #architecture #spec
- when-to-use-this-skill: Understanding legacy or undocumented systems; Creating documentation for existing code; Onboarding to a new codebase #architecture #spec

## sql-pro #database
- Optimizes SQL queries, designs database schemas, and troubleshoots performance issues. #database
- output-templates: When implementing SQL solutions, provide: 1. #database

## terraform-engineer #devops #terraform
- Use when implementing infrastructure as code with Terraform across AWS, Azure, or GCP. #terraform #devops
- output-format: When implementing Terraform solutions, provide: module structure (main.tf, variables.tf, outputs.tf), backend and provider configuration #terraform #devops

## test-master #testing
- Generates test files, creates mocking strategies, analyzes code coverage, designs test architectures #testing
- constraints: MUST DO; Test happy paths AND error/edge cases (e.g., empty input, null, boundary values) #testing
- output-templates: When creating test plans, provide: 1. #testing

## the-fool #decision #review
- Use when challenging ideas, plans, decisions, or proposals using structured critical reasoning. #decision #review
- mode-selection: Use AskUserQuestion to let the user choose how to challenge their idea. #decision #review
- when-to-use-this-skill: Stress-testing a plan, architecture, or strategy before committing; Challenging technology, vendor, or approach choices #decision #review

## typescript-pro #typescript
- Implements advanced TypeScript type systems, creates custom type guards, utility types, and branded types, and configures tRPC for end-to-end type safety. #typescript
- knowledge-reference: TypeScript 5.0+, generics, conditional types, mapped types, template literal types, discriminated unions, type guards, branded types, tRPC #typescript
- output-templates: When implementing TypeScript features, provide: 1. #typescript
