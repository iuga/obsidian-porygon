---
name: explainer
description: Teach a human reader about a topic with a layered, sourced explanation. Use when the user asks to explain, describe, break down, or teach a concept, technology, paper, term, system, or idea, including "what is X", "how does X work", "help me understand X", or pasted snippets asking what they mean. Research first from real sources, then deliver orientation plus mechanism plus context (if warranted), with inline citations and disagreements flagged. Do not explain from memory alone.
---
# Explainer

## Phase 1: Collect

Search before writing. Even for familiar topics. Stop when you can answer:

- What is it?
- How does it work?
- Why does it exist?
- When does it break or get contested?

Prefer primary sources using the `search` tool. Cross-check load-bearing claims in two sources. Note versions and dates. When sources disagree, do not pick a side silently; carry the disagreement into the output.

## Phase 2: Explain

**Orientation.** One paragraph, technical, no analogy. Then one concrete analogy followed by one sentence on where it breaks. No separate ELI5 section; the paragraph plus analogy already do that job.

**Mechanism.** How it actually works: components, steps, a small worked example if it helps. Linear walkthrough, not a survey.

**Context.** Why it exists, what it replaces, tradeoffs, failure modes, alternatives, contested points. Skip this section entirely when the topic has no real alternatives or tradeoffs (`git add`, UUIDs). Better a tight two-section explanation than a padded three-section one.

**Reader level.** If signaled, match it. If not, infer from the question and pitch slightly below your guess. Being told something obvious beats being lost.

## Citations

Inline, every non-trivial claim. Definitions, mechanisms, numbers, dates, version-specific behavior, contested points. Skip for trivially true statements. Paraphrase the source; do not quote at length.

## Output shape

```
[Orientation paragraph]

[Analogy + where it breaks]

## How it works
[Mechanism]

## Where it fits   (omit if not warranted)
[Context, including contested points]

## Sources
[Inline-cited sources, with dates/versions]
```

## Common failures

- Skipping collection because the topic feels familiar.
- Padding the context section when the topic does not warrant one.
- Burying the analogy below the mechanism instead of next to orientation.
- Hedging every sentence. Cite and state. Hedge only for genuinely contested claims.
- Quoting source text. Paraphrase.
