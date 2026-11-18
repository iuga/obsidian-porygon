---
name: diagrammer
description: Draw a diagram that explains a concept, process, or structure, as a Mermaid code block. Use when the user asks to diagram, draw, visualise, map out, chart, or show the flow of something, including requests for a flowchart, sequence, state, class, ER, mind map, Gantt, or architecture diagram, or when the user asks you to read a note and produce a visual of what it describes. Do not use when the user did not ask for a visual; prose, tables, and summaries are not diagrams.
---
# Diagrammer

## Phase 1: Read the source

Never diagram from memory. Read the material first with `view`, `search`, or `list`, and stop when you can name:

- The entities: people, systems, states, steps, or data.
- The relationships and their direction.
- The order or conditions that decide what happens next.

When the user points at a note, read the whole note. When the request is about a familiar process, check the vault first and fall back to general knowledge only if the vault has nothing.

## Phase 2: Choose the type

Pick the type that matches the question, not the one that looks impressive.

| The source describes | Use |
| --- | --- |
| Steps, decisions, prerequisites | `flowchart TD` (or `LR` when wide) |
| Ordered messages between actors | `sequenceDiagram` |
| A thing changing between modes | `stateDiagram-v2` |
| Classes, fields, inheritance | `classDiagram` |
| Entities and their relations | `erDiagram` |
| Branches radiating from one idea | `mindmap` |
| Work against a calendar | `gantt` |
| Chronological events | `timeline` |

## Phase 3: Emit

Output exactly one fenced block tagged `mermaid`, with nothing else except an optional one-line caption before it.

Rules:

1. **Faithful.** Every node, edge, and label must trace to the source. Do not add plausible steps, actors, or outcomes. If the source is ambiguous, keep the ambiguous part coarse and state the assumption in one sentence.
2. **Minimal.** Prefer 5 to 12 nodes. Merge duplicates, drop decoration, and keep labels short noun phrases.
3. **Valid.** Start with the diagram keyword on the first line of the block. Give every node an id without spaces. Quote labels that contain punctuation, parentheses, or slashes, for example `A["Retry (max 3)"]`. Do not use `end` as an id. Do not put Markdown, wikilinks, HTML, or `<mark>` inside the diagram.
4. **Readable.** Direction top to bottom for flows, left to right for pipelines and timelines. Use `subgraph` only when it carries real meaning.
5. **One diagram.** If the concept needs two views, pick the more useful one and mention the other in one sentence. Do not stack diagrams unless the user asks for several.

Do not explain the syntax. If the user asks for a change, return the revised block in full.

## Example

Request: "Read this note and diagram the approval workflow."

Source: a purchase request goes to the team lead, who approves up to 5,000. Above that, finance must approve too. Rejected requests go back to the requester.

Output:

```mermaid
flowchart TD
    A[Purchase request] --> B{Team lead approves?}
    B -- No --> R[Return to requester]
    B -- Yes --> C{Amount above 5,000?}
    C -- No --> D[Approved]
    C -- Yes --> E{Finance approves?}
    E -- Yes --> D
    E -- No --> R
```
