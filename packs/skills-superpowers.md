# skills/superpowers

## test-driven-development

- Use when implementing any feature or bugfix, before writing implementation code #testing
- when-to-use: Always: - New features - Bug fixes - Refactoring - Behavior changes #testing
- red-flags---stop-and-start-over: Code before test - Test after implementation - Test passes immediately - Can't explain why test failed - Tests added "later" - Rationalizin… #testing

## systematic-debugging

- Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes #debugging
- when-to-use: Use for ANY technical issue: - Test failures - Bugs in production - Unexpected behavior - Performance problems - Build failures - Integrati… #debugging
- the-four-phases: You MUST complete each phase before proceeding to the next. #debugging
- red-flags---stop-and-follow-process: If you catch yourself thinking: - "Quick fix for now, investigate later" - "Just try changing X and see if it works" - "Add multiple change… #debugging
- your-human-partner's-signals-you're-doing-it-wrong: Watch for these redirections: - "Is that not happening?" - You assumed without verifying - "Will it show us...?" - You should have added ev… #debugging

## requesting-code-review

- Use when completing tasks, implementing major features, or before merging to verify work meets requirements #code-review
- when-to-request-review: Mandatory: - After each task in subagent-driven development - After completing major feature - Before merge to main #code-review
- how-to-request: 1. #code-review
- red-flags: Never: - Skip review because "it's simple" - Ignore Critical issues - Proceed with unfixed Important issues - Argue with valid technical fe… #code-review

## receiving-code-review

- Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical… #code-review
- forbidden-responses: NEVER: - "You're absolutely right!" (explicit instruction-file violation) - "Great point!" / "Excellent feedback!" (performative) - "Let me… #code-review
- source-specific-handling: ### From your human partner - Trusted - implement after understanding - Still ask if scope unclear - No performative agreement - Skip to ac… #code-review

## writing-plans

- Use when you have a spec or requirements for a multi-step task, before touching code #planning
- scope-check: If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. #planning
- file-structure: Before defining tasks, map out which files will be created or modified and what each one is responsible for. #planning
- task-right-sizing: A task is the smallest unit that carries its own test cycle and is worth a fresh reviewer's gate. #planning
- step-granularity: Each step is one action with a checkable result: - "Write the failing test" - step - "Run it to make sure it fails" - step - "Implement the… #planning
- plan-document-header: Every plan MUST start with this header: #planning
- global-constraints: [The spec's project-wide requirements — version floors, dependency limits, naming and copy rules, platform requirements — one line each, wi… #planning

## executing-plans

- Use when executing an implementation plan in the current session as the implementer yourself — your human partner chose inline execution, or no subagent tool i… #planning
- when-to-use: You have a plan from superpowers:writing-plans and your human partner chose inline execution at the handoff. #planning
- setup: Ensure the work happens in an isolated workspace: use superpowers:using-git-worktrees to create one or verify the existing one. #planning
- the-task-loop: Everything you print, and every tool result, stays resident in your context for the rest of the session. #planning
- final-review: Run ../subagent-driven-development/scripts/review-package PLAN_FILE MERGE_BASE HEAD (MERGE_BASE = the commit the branch started from, e.g. #planning
- finish: Before you delete anything, collect every ledger line containing Ruling: into your final message under "Rulings I made", in the order you m… #planning

## verification-before-completion

- Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output b… #verification
- red-flags---stop: Using "should", "probably", "seems to" - Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.) - About to commi… #verification
- key-patterns: Tests: ✅ [Run test command] [See: 34/34 pass] "All tests pass" ❌ "Should pass now" / "Looks correct" #verification

## using-git-worktrees

- Use when starting feature work that needs isolation from current workspace or before executing implementation plans - ensures an isolated workspace exists via… #git
- step-0:-detect-existing-isolation: Before creating anything, check if you are already in an isolated workspace. #git
- step-1:-create-isolated-workspace: You have two mechanisms. #git
- step-2:-project-setup: Auto-detect and run appropriate setup: #git
- step-3:-verify-clean-baseline: Run tests to ensure workspace starts clean: #git

## brainstorming

- You MUST use this before any creative work - creating features, building components, adding functionality, modifying behavior, or planning anything new, in sof… #planning
- first:-what-do-you-actually-know?: Before you reply, ask yourself: what do I know about what they want, and why? #planning
- your-first-message: Your first message is two things, in this order: #planning
- the-conversation: Each message ends with one question: a single sentence with no list of example answers hanging off it. #planning
- play-it-back: Play back as you go. #planning
- size-the-work: Once you understand what they want, pick a size and say it in plain words. #planning
- the-written-design: For a project, write a plain document a talented builder in the domain could plan from without going back to your human partner. #planning

## dispatching-parallel-agents

- Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies #agents #planning
- the-pattern: ### 1. #agents #planning
- agent-prompt-structure: Good agent prompts are: 1. #agents #planning
- common-mistakes: ❌ Too broad: "Fix all the tests" - agent gets lost ✅ Specific: "Fix agent-tool-abort.test.ts" - focused scope #agents #planning
- when-not-to-use: Related failures: Fixing one might fix others - investigate together first Need full context: Understanding requires seeing entire system E… #agents #planning
- real-example-from-session: Scenario: 6 test failures across 3 files after major refactoring #agents #planning

## subagent-driven-development

- Use when executing implementation plans with independent tasks in the current session #agents #planning
- setup: Ensure the work happens in an isolated workspace: use superpowers:using-git-worktrees to create one or verify the existing one. #agents #planning
- model-selection: Use the least powerful model that can handle each role to conserve cost and increase speed. #agents #planning
- the-task-loop: Batch small same-shape work. #agents #planning
- final-review: The final whole-branch review gets a package too: run bash scripts/review-package PLAN_FILE MERGE_BASE HEAD (MERGE_BASE = the commit the br… #agents #planning

## finishing-a-development-branch

- Use when implementation is complete, all tests pass, and you need to decide how to integrate the work #git
- step-1:-verify-tests: Run the project's full test suite (npm test / cargo test / pytest / go test ./...). #git
- step-3:-determine-base-branch: The base branch is whatever this work forked from — usually named in the plan, the conversation, or the branch's upstream. #git
- step-4:-present-options: Normal repo and named-branch worktree — present exactly these 3 options: #git
- step-5:-execute-choice: ### Option 1: Merge Locally #git
- step-6:-cleanup-workspace: Runs for Option 1 and confirmed discards. #git

## using-superpowers

- Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions #skills #meta
- the-rule: Invoke relevant or requested skills BEFORE any response or action — including clarifying questions, exploring the codebase, or checking fil… #skills #meta
- skill-priority: When multiple skills apply, process skills come first — they set the approach, then implementation skills (frontend-design, etc.) carry it… #skills #meta
- red-flags: These thoughts mean STOP—you're rationalizing: #skills #meta
- platform-adaptation: If your harness appears here, read its reference file for special instructions: #skills #meta

## writing-skills

- Use when creating new skills, editing existing skills, or verifying skills work before deployment #skills #meta
- what-is-a-skill?: A skill is a reference guide for proven techniques, patterns, or tools. #skills #meta
- when-to-create-a-skill: Create when: - Technique wasn't intuitively obvious to you - You'd reference this again across projects - Pattern applies broadly (not proj… #skills #meta
- skill-types: ### Technique Concrete method with steps to follow (condition-based-waiting, root-cause-tracing) #skills #meta
- skill.md-structure: Frontmatter (YAML): - Two required fields: name and description (see [agentskills.io/specification](https://agentskills.io/specification) f… #skills #meta
