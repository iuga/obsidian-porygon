## 0.1.1: Local Porygon chat with note-aware context

Build an Obsidian plugin that provides a polished local chat experience backed by Ollama, including onboarding and settings for Ollama host, models, thinking mode, and a configurable prompt. Porygon should support Markdown-rendered, selectable responses; optional streamed reasoning shown separately and collapsible; explicit note mentions via a searchable keyboard-accessible popup; live note-content injection into chat context; composer controls for new conversation, note mentions, send/unreachable state; and a privacy-first local workflow where only the user’s message, conversation history, and explicitly mentioned notes are sent to the configured Ollama host.

## 0.1.2: Local LangGraph/Ollama chat agent with streaming tool support

Implement a local chat agent for Porygon using LangGraph, LangChain, and `@langchain/ollama`, routing all chat responses through `src/agent.ts` instead of calling Ollama directly. The agent must use the existing system prompt, support Ollama thinking mode, stream both reasoning and final answers separately, expose a `current_timestamp` tool returning the current ISO timestamp, avoid showing tool outputs as user-visible responses, prevent repeated tool-call loops, keep health status based on Ollama reachability, and make all chat content selectable for copy/paste, including user messages, Porygon responses, thinking blocks, and errors.

## 0.1.3: Replace Direct Ollama Chat Integration with a LangGraph Agent

Migrate the Porygon chat flow from direct Ollama SDK access to a LangGraph/LangChain agent backed by `ChatOllama`, using the documented `agent.stream({ streamMode: "messages" })` API for streamed responses. Preserve existing chat behavior including message history, note mention context, streaming Porygon content, Ollama thinking/reasoning display, and accurate thinking duration. Remove the old direct `ollama` dependency, replace health/model-list checks with a small Obsidian `requestUrl`-based Ollama HTTP client, add a simple timestamp tool to the agent, avoid LangChain internal/private APIs, pin LangChain dependency versions to reduce upgrade risk, and keep the implementation type-safe, lint-clean, buildable, and suitable for an Obsidian community plugin.

## 0.2.2: Porygon vault-aware agent tools and chat transparency

Add vault-aware agent capabilities to Porygon, including tools to list notes by regex, search note contents with line matches, view notes with line-numbered excerpts, and create/edit/delete note content through exact-match replacements. Each tool must include an `intent` parameter for debugging, support robust logging/error reporting, and enforce safe editing behavior such as reading before editing, exact whitespace matching, and no filename guessing. The chat UI should optionally show tool usage in a collapsible wrench section, support selectable user/Porygon text, render thinking in a capped auto-scrolling panel, and provide settings toggles for model thinking and tool usage reporting.

## 0.2.3: Split prompts and polish Porygon settings

Split prompts into an internal bundled system prompt and a user-configurable personal prompt. Keep both defaults in root-level Markdown files under `prompts/`, send the internal prompt as the agent system prompt, send the personal prompt as a second system message, and expose only the personal prompt in settings. Improve the personal prompt editor with a stacked full-width layout so it is easier to read and edit.

## 0.2.4: Porygon product polish and stability

Polish and stabilize the Obsidian plugin by renaming the product from “The Obsidian Assistant” to **Porygon** across metadata, UI strings, prompts, docs, package names, code identifiers, and CSS namespaces. Split prompts into two human-readable Markdown files: a bundled, non-configurable internal system prompt and a user-configurable personal prompt exposed in settings as a full-width, readable editor. Ensure Porygon sends both prompt layers as system messages, preserves compatibility with old settings, updates documentation/specs, and passes build and lint checks.

## 0.2.5: Richer mention and command workflow
The mention popup now opens from `@`, focuses a filter, uses left-aligned rows with icons for notes, folders, and the active note, supports active-note mentions, lists folders, inserts Obsidian links, keeps mention chips synced with composer text, and expands folder mentions into direct child Markdown files as hidden file-context messages; the mention UI and chat chips were polished with horizontal wrapping, smaller chip text, and an attached top popup style. Slash commands were introduced with a new bottom-left `circle-slash` button, searchable keyboard-navigable popup, command descriptions, click-outside/Escape dismissal, and commands that execute without inserting text; `/new` replaces the old new-chat button and prompts to save when the current chat has content, while `/save` writes the visible conversation to `porygon/conversation_{first-message-timestamp}.md`, overwriting the existing file on subsequent saves so it always matches the current UI conversation.

## 0.2.6: Porygon chat responsiveness, vault rename, and publishing readiness
Porygon improved responsiveness by immediately showing a `Thinking...` Porygon answer bubble until the first streamed token, reasoning delta, or tool intent arrives; added a centered deterministic daily empty-chat quote and a clearer composer placeholder for `/` commands and `@` mentions; introduced a safe `rename(intent, source_path, destination_path)` agent tool that uses Obsidian `FileManager.renameFile` and documents its privacy impact; and addressed Obsidian community plugin publishing feedback by removing interval-based Ollama polling, using event-based health checks, replacing newer APIs that exceeded `minAppVersion`, fixing UI construction warnings, and adding an attested GitHub Actions release workflow for `main.js`, `manifest.json`, and `styles.css`.

## 0.2.7: Obsidian plugin publishing and polish

## 0.2.8: Obsidian plugin publishing and polish

## 0.2.9: Saved sessions and mention-aware reloads
Porygon added a `/sessions` command for loading saved chats from `porygon/sessions/`, renamed saved conversations to sessions, and changed `/save` to write `{session-id}.md` files with top-level metadata containing the session id and title. Session files now preserve per-message mention metadata in compact `kind`/`path`/`files` blocks so note and folder mentions can be rehydrated in order when a session is loaded; loading a session prompts to save the active chat first, restores visible messages and hidden file context, and logs malformed or missing mention data without blocking the load. Untitled sessions now generate a concise human-readable title from user messages through a lightweight LangChain/Ollama title generator, with a local fallback if generation fails.

## 0.3.0: Local semantic search over the vault
Porygon adds a local RAG foundation for semantic vault search using the same Ollama provider as chat: Markdown notes are chunked with LangChain text splitters, embedded with the configured Ollama embeddings model, and persisted in an IndexedDB-backed index under `src/rag/*`. The index is maintained in the background through startup reconciliation and Obsidian vault create/modify/delete/rename events, supports ignored-path settings and model/host freshness checks, exposes index status in settings, and adds a `semantic_search` agent tool that returns matching note paths, wikilinks, scores, and snippets for contextual note discovery while keeping existing exact `list`, `search`, and `view` tools as fallbacks.
