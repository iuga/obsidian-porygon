---
name: summarizer
description: Summarize a text note or markdown file into one of three formats (one-liner, one-paragraph, or extended). Use whenever the user asks to summarize, condense, recap, "give me the gist of", or "tl;dr" a note, even if they don't say the word "summary". Defaults to one-paragraph. Preserves every critical fact, never invents content, avoids buzzwords.
---

# Note Summarizer

Summarize plain text or markdown into one of three modes. 
You can use the `askUser` tool for the preferred mode, otherwise, the default is **one-paragraph**.

## Modes

**One-liner.** One sentence, 10 to 35 words. Answers: what is this about and what is its single most important point. If the source has more than one central point, pick the one the source itself emphasizes most. No semicolons or "and also" to smuggle in a second point.

**One-paragraph (default).** Continuous prose, no lists, no headings. Cover every critical point. Length roughly 5 to 15 percent of the source, capped near 200 words. Never pad to hit a length.

**Extended.** Several short sections. Each section: a plain noun-phrase title, then a 2 to 6 sentence paragraph. **No bullet lists, no numbered lists, no tables.** Section titles come from the source's structure or the topics it actually covers, in source order. The whole extended summary must be meaningfully shorter than the source; if it can't be, switch to one-paragraph and tell the user why.

## Rules (apply to every mode)

**Do not invent.** Every claim in the summary must be supported by the source. Do not infer motives, fill gaps, sharpen "considering" into "deciding", or add/remove hedges. Preserve attributions ("according to X", "we think").

**Preserve critical content.** Critical = decisions, numbers, dates, names, conditions, conclusions, action items, constraints, warnings. None may be dropped from one-paragraph or extended summaries. One-liner keeps only the most important one.

**Be concrete.** Use the source's own words for the things it discusses. "The database migration" stays "the database migration", not "the technical change". Cut filler: "It is important to note that", "Furthermore", "In addition", and adjectives that carry no fact ("significant", "key", "robust", "comprehensive").

**No buzzwords.** Do not introduce: leverage, synergy, streamline, robust, holistic, seamless, cutting-edge, innovative, paradigm, ecosystem, deep dive, unlock, empower, foster, journey, landscape, space (as in "the X space"), delve, tapestry, realm, testament, vibrant, navigate (as a vague verb), enable (as a vague verb). If the source itself uses one of these with a specific meaning, you may keep it. Never add one.

**Match the source.** Same language as the source. Same register: informal stays informal, technical stays technical. Do not upgrade casual notes into corporate prose.

## Output

Return only the summary text. No "Summary:" label, no preamble, no sign-off, no coverage notes.

## When to refuse

Refuse instead of summarizing when:

- The source contradicts itself on a critical point. Name the two conflicting statements and ask which is authoritative.
- The source is too vague to summarize faithfully (fragments, undefined references like "see above" with no above). Name what is missing.
- The source is empty or unreadable.

A refusal is a short message in the source's language. Do not pair it with a partial summary.

## Workflow

1. Read the entire source first.
2. Pick the mode. If the user did not say, use one-paragraph.
3. Identify the source's language and register.
4. List the critical points internally.
5. Check for contradiction or fatal vagueness; refuse if found.
6. Write the summary using the source's own terms.
7. Check: every claim traces to the source, no critical point is missing, no buzzword sneaked in, the summary is shorter than the source.
8. Output the summary text only.

## Example (one-paragraph, default)

Source:

> Quick note from the customer call. ACME is happy with the integration but flagged two issues. First, the webhook retry policy is too aggressive: they're seeing 5 retries within 30 seconds when their endpoint returns a 503, which is overwhelming their queue. They'd like exponential backoff. Second, they want per-event filtering on the webhook subscription, because right now they receive every event type and have to filter on their end. Either fix would unblock the rollout to their EU region in Q3. Renewal is in November.

Output:

> ACME is satisfied with the integration but raised two blockers for their Q3 EU rollout: the webhook retry policy fires 5 times in 30 seconds on 503 responses and overwhelms their queue, so they want exponential backoff; and they want per-event filtering on webhook subscriptions because they currently receive every event type and filter on their side. Either fix would unblock the EU rollout. Renewal is in November.
