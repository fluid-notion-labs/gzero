// filler.ts — classify pure-filler user prompts so the history view can
// hide them: "yep", "ok, continue", "lets go", keyboard mash, ...
//
// Patterns derived by mining 756 real user prompts across all pi sessions
// on this machine (2026-10-15): 30 unique fillers, zero false positives in
// the corpus. The tests pin the real examples, including near-misses that
// must stay visible ('ok, 9463', 'ls', 'push', 'salad').

/** Whole-prompt filler phrases (single token or fixed idiom). */
const FILLER_PHRASES = new RegExp(
  `^(?:\\s*)` +
    `(?:` +
    `yep+|yeah+|yah|yes|yus|nope|nop|ok(?:ay)?|dokie|kk+|k|alright|roger|` +
    `go|goahead|go ahead|let'?s go|continue|cont|carry on|proceed|onward|` +
    `next|next one|try|try again|try now|again|will do|` +
    `thanks|thank you|thankyou|tyvm|ty|thx|` +
    `nice|nice one|ooh|ohh|ooo|cool|perfect|purr?fect|great|awesome|wow|sweet|` +
    `lol|lmao|haha+|hehe+|` +
    `hello+|hi|hey+|yo|` +
    `sounds good|sounds great|sounds fine|` +
    `:d|:\\)|:\\(|:p|;p|;\\)` +
    `)` +
    `[\\s!.,?~:)*('"]*$`,
  "i",
);

/** Words that only ever appear in filler prompts when the prompt is entirely filler. */
const FILLER_WORDS = new Set(
  ("ok okay yep yeah yes yup yus nope nop well and so then that this these those it its it's " +
    "looks look good great fine nice perfect purrfect cool awesome sweet thanks thank you thankyou thx " +
    "we i am are is was were be been the a an to now done plz please all everything go continue " +
    "parked in there here v btw ooh ohh ooo haha hehe lol lmao wow love glad mate dude thats dokie " +
    "alright sure will do did sounds onward carry k kk next try again hello hi hey lets let us with one").split(
    " ",
  ),
);

/** Keyboard-mash runs ('asdf', 'asdlfkjasdf', ...). */
const MASH = /asdf|jkl|qwer|zxcv/i;

/**
 * True when a prompt carries no recallable content: pure acknowledgment,
 * go-ahead, praise, greeting, or keyboard mash. Prompts containing any
 * digit are never filler (numbers carry content: 'ok, 9463').
 */
export function isFiller(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length === 0) return true;
  if (FILLER_PHRASES.test(p)) return true;
  if (/\d/.test(p)) return false;
  const tokens = p.toLowerCase().match(/[a-z']+/g) ?? [];
  if (tokens.length === 0) return false;
  if (tokens.every((t) => FILLER_WORDS.has(t))) return true;
  return MASH.test(p);
}
