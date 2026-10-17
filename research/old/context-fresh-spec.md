OK. we need to see what is stale in the rest of this directory. Here is the architecture/product vision as I see it today:

contextual is an mcp server.

keywords:
  - WS: workflow system
  - context: the injected context, prefix g,l,s for that specific part of the context (global, local, skillset), also known as prompt
  - 
  
it stores global, local, and skillsets, and injects them into the agent context. lcoal, and skillsets persist across sessions. global, is global.
There should be a workflow in the global context, where the agent is instructed, that if the user wants to do something 'new', (i.e. create a rust document), that the agent should assess whether to activate a skill, from the skillsets, semi automatically (ask user)

we also have the workflow-system (called WF). This is for storing:
  - repository/ project:
    - vision &/or
    - synopsis, short, and more thorough
    - architecture (evolves over time)
    - plan, which are todo checklists
    - arbitrary checklists
    - user stories
    - any others that we can think of (please do this)


WS is the next step from storing the global, local, and skillsets and injecting. it eventually will inject tasks from the plan prompted by the user, into the context

WS features:
  - arbitrary number of 'sections'. we start with vision/synopsis etc. later we might use for novel workflows
  - we can link (via content addressable links) across the different workflows, this is advanced and later
  - stores arbitrary text. markdown.
  - type field (md, checkbox, etc)

This is initially intended for use as a memory/workflow system for pi

We may go to cloudflare in the future.


Architecture.
  Currently skills/bag is home brew (I think), bagflow (deprecated).
  we will try automerge for the things it is good at (ordering, storage, distribution... ?)
