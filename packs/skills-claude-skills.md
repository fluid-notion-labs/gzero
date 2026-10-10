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
