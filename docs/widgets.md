# Widgets

Interactive components embedded inline in chat messages: buttons, forms, sliders, links, and similar.

## How they work

Agents have prompts that teach them to emit widget markup inside a message. The frontend parses the markup and renders the component in place.

## Syntax

```html
<x-porygon-widget type="file" label="My File" href="myFile.md" />
```

## File widget

A clickable link to a vault file. Use after an edit or as a search reference.

The example above renders a link labeled "My File" pointing to `myFile.md`.

`file` is the only type at launch; more types follow.

## UX

- Full-width, rendered where the tag appears in the message.
- Multiple widgets render in message order.
- Vertical margin above and below to set them apart from text.
- Thin border, chat background color, hover effect to signal interactivity.
