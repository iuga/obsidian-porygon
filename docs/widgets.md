# Widgets

Interactive components embedded inline in chat messages: file links, callouts, quotes, and similar.

## How they work

Agents have prompts that teach them to emit widget markup inside a message. The frontend parses the markup and renders the component in place. A widget is a `<x-porygon-widget>` tag; `type` selects which component renders, and the other attributes are specific to that type. Tags are either self-closing or wrap content between an opening and closing tag.

## Syntax

```html
<x-porygon-widget type="file" href="myFile.md" />
<x-porygon-widget type="callout" variant="idea">Something worth highlighting.</x-porygon-widget>
<x-porygon-widget type="callout" variant="quote" href="myFile.md">A passage from the file.</x-porygon-widget>
```

## File widget

A clickable link to a vault file. Use after an edit or as a search reference. Self-closing, takes only `href`; the widget resolves the file, shows its name, and previews the start of its content. A missing file renders a non-clickable "not found" card.

## Callout widget

Highlights a short passage with a predefined icon and accent color. Content-wrapping: the text to highlight goes between the tags. `variant` picks the icon and color; `href` is optional and, when present, makes the whole callout open that file.

Variants:

| variant | use for | icon | color |
|---|---|---|---|
| `idea` | suggestions, what-ifs | `lightbulb` | yellow |
| `insight` | the key takeaway | `sparkles` | purple |
| `note` | side note, context | `info` | blue |
| `success` | done, confirmed, good news | `circle-check` | green |
| `hot` | hot or trending topic | `flame` | pink |
| `warning` | caution, pay attention | `triangle-alert` | orange |
| `danger` | risk, severe, do-not-do | `octagon-alert` | red |
| `quote` | a quotation | `quote` | muted |

For quotations use the `quote` variant: pass the source note as `href` when the text comes from a file (so it stays clickable), or omit `href` for a quote with no source. An unknown or missing `variant` falls back to `note`.

## UX

- Full-width, rendered where the tag appears in the message.
- Multiple widgets render in message order.
- Vertical margin above and below to set them apart from text.
- Thin border, chat background color, hover effect on clickable widgets to signal interactivity.
