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
