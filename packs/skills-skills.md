# skills/skills

## mcp-builder

- Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. #mcp

## webapp-testing

- Toolkit for interacting with and testing local web applications using Playwright. #testing #web
- common-pitfall: ❌ Don't inspect the DOM before waiting for networkidle on dynamic apps ✅ Do wait for page.wait_for_load_state('networkidle') before #testing #web
- best-practices: Use bundled scripts as black boxes; To accomplish a task, consider whether one of the scripts available in scripts/ can help. #testing #web

## frontend-design

- Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. #frontend #design
- ground-your-designs-in-the-subject-matter: If the brief does not identify what the product or subject matter is, identify it yourself before designing, and confirm with the client. #frontend #design
- design-principles: For web designs, the hero is the first thing viewers will see. #frontend #design
- process-plan,-review-against-the-brief,-build,-critique: For calibration, AI-generated design right now clusters around some traits: 1. #frontend #design
- restraint-and-self-critique: Spend your boldness in one place. #frontend #design
- more-on-writing-in-design: Words appear in a design for one reason: to make it easier to understand and use. #frontend #design

## skill-creator

- Create new skills, modify and improve existing skills, and measure skill performance. #skills #meta
- communicating-with-the-user: The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. #skills #meta
- report-structure: Examples pattern; It's useful to include examples. #skills #meta
- executive-summary: Examples pattern; It's useful to include examples. #skills #meta
- key-findings: Examples pattern; It's useful to include examples. #skills #meta
- recommendations: Examples pattern; It's useful to include examples. #skills #meta

## claude-api

- before-you-start: Scan the target file (or, if no target file, the prompt and project) for non-Anthropic provider markers #claude #api
- warning-api-drift---your-training-prior-may-be-stale: Several common Claude API shapes changed in 2025-2026. #claude #api
- subcommands: If the User Request at the bottom of this prompt is a bare subcommand string (no prose), search every Subcommands table in this document #claude #api
- language-detection: Before reading code examples, determine which language the user is working in (exception: for the prompt-audit subcommand #claude #api

## web-artifacts-builder

- Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). #frontend #web
- design-&-style-guidelines: VERY IMPORTANT: To avoid what is often referred to as "AI slop", avoid using excessive centered layouts, purple gradients #frontend #web

## doc-coauthoring

- Guide users through a structured workflow for co-authoring documentation. #docs #writing
- when-to-offer-this-workflow: Trigger conditions:; User mentions writing documentation: "write a doc", "draft a proposal", "create a spec", "write up" #docs #writing
- stage-1-context-gathering: Goal: Close the gap between what the user knows and what Claude knows, enabling smart guidance later. #docs #writing
- stage-2-refinement-&-structure: Goal: Build the document section by section through brainstorming, curation, and iterative refinement. #docs #writing
- stage-3-reader-testing: Goal: Test the document with a fresh Claude (no context bleed) to verify it works for readers. #docs #writing
- final-review: When Reader Testing passes: Announce the doc has passed Reader Claude testing. #docs #writing
- tips-for-effective-guidance: Tone:; Be direct and procedural; Explain rationale briefly when it affects user behavior; Don't try to "sell" the approach; just execute it #docs #writing

## docx

- Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files) or Word templates (.dotx files). #documents
- creating-with-docx-js-—-gotchas: docx is preinstalled — do not run npm install first; write the script and require('docx') directly. #documents
- editing-existing-documents: Legacy .doc files must be converted first: python scripts/office/soffice.py --headless --convert-to docx file.doc. #documents
- comments: Comments require six cross-linked files. #documents

## pdf

- Use this skill whenever the user wants to do anything with PDF files. #documents

## pptx

- Use this skill any time a .pptx or .potx file is involved in any way — as input, output, or both. #documents
- scripts: Paths are relative to this skill's directory. #documents
- creating-with-pptxgenjs-—-gotchas: pptxgenjs is preinstalled — do not run npm install first; write the script and require('pptxgenjs') directly. #documents
- editing-existing-decks-and-templates: Pick layouts first: python scripts/thumbnail.py template.pptx template-thumbs writes a labeled grid of every slide and prints the file(s) #documents
- design-ideas: Don't create boring slides. #documents
- qa-(required): Your first render usually has a few real issues — overlaps, overflow, misalignment. #documents

## xlsx

- Use this skill any time a spreadsheet file is the primary input or output. #documents
- requirements-for-every-output: Professional font (Arial, Times New Roman) throughout, unless the user says otherwise.; Zero formula errors. #documents
- recalculate-(mandatory-whenever-the-file-contains-formulas): openpyxl writes formulas as strings with no cached values. #documents
- choosing-formulas-that-survive-verification: LibreOffice implements fewer functions than Excel, and one it cannot evaluate becomes a literal #NAME? baked into the file you deliver. #documents
- openpyxl-gotchas: Reading a model takes two loads. #documents
- financial-models: Unless the user says otherwise, or the existing file already does something else. #documents
