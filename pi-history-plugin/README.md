# pi-history-plugin

A pi extension: **ctrl+`** (or `/history`) opens a scrollable overlay of the
user's prompts from this project's pi sessions — newest first, with pure
filler ("yep", "ok, continue", "lets go", keyboard mash, ...) filtered out.
Enter inserts the selected prompt into the editor.

The filter regex was derived by mining 756 real prompts from
`~/.pi/agent/sessions` (30 unique fillers, zero false positives; the tests
pin real examples, including near-misses that must stay visible).

Scope: the session folder the current session lives in — one folder per
project directory, so the history is project-wide across sessions.

## Development

```
npm test                                  # node --test, no node_modules needed
sh ../tools/typecheck.sh pi-history-plugin
```
