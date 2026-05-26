export type MemoryImportance = "high" | "medium" | "low";

export interface Memory {
	id: string;
	timestamp: string;
	importance: MemoryImportance;
	content: string;
}

export interface MemoriesStore {
	get(): string;
	set(raw: string): Promise<void>;
}

export interface SaveMemoryInput {
	content: string;
	importance: MemoryImportance;
	id?: string;
}

export const DEFAULT_MEMORIES = "<memories>\n</memories>";

const MAX_MEMORIES_IN_PROMPT = 50;
const MEMORY_LINE = /^\[([0-9a-f]+)\]\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+\[(high|medium|low)\]\s+(.+)$/;
const IMPORTANCE_RANK: Record<MemoryImportance, number> = { high: 3, medium: 2, low: 1 };

export function parseMemories(raw: string): Memory[] {
	const memories: Memory[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = MEMORY_LINE.exec(line.trim());
		if (!match) {
			continue;
		}
		const [, id, timestamp, importance, content] = match;
		memories.push({ id: id!, timestamp: timestamp!, importance: importance as MemoryImportance, content: content! });
	}
	return memories;
}

export function serializeMemories(memories: Memory[]): string {
	const body = sortMemories(memories).map(formatMemoryLine).join("\n");
	return body ? `<memories>\n${body}\n</memories>` : DEFAULT_MEMORIES;
}

export function buildMemoryPromptBlock(raw: string): string {
	const memories = sortMemories(parseMemories(raw)).slice(0, MAX_MEMORIES_IN_PROMPT);
	return serializeMemories(memories);
}

export function applyMemoryChange(raw: string, input: SaveMemoryInput): { raw: string; message: string } {
	const memories = parseMemories(raw);
	const trimmedContent = input.content.trim();

	if (input.id) {
		const index = memories.findIndex((memory) => memory.id === input.id);
		if (index === -1) {
			throw new Error(`Memory not found: ${input.id}`);
		}
		if (trimmedContent === "") {
			memories.splice(index, 1);
			return { raw: serializeMemories(memories), message: `Deleted memory ${input.id}` };
		}
		memories[index] = { id: input.id, timestamp: nowTimestamp(), importance: input.importance, content: trimmedContent };
		return { raw: serializeMemories(memories), message: `Updated memory ${input.id}` };
	}

	if (trimmedContent === "") {
		throw new Error("Cannot create a memory with empty content.");
	}
	const id = generateMemoryId();
	memories.push({ id, timestamp: nowTimestamp(), importance: input.importance, content: trimmedContent });
	return { raw: serializeMemories(memories), message: `Saved memory ${id}` };
}

function sortMemories(memories: Memory[]): Memory[] {
	return [...memories].sort((a, b) => {
		const rank = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
		if (rank !== 0) {
			return rank;
		}
		return b.timestamp.localeCompare(a.timestamp);
	});
}

function formatMemoryLine(memory: Memory): string {
	return `[${memory.id}] ${memory.timestamp} [${memory.importance}] ${memory.content}`;
}

function nowTimestamp(): string {
	const now = new Date();
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function generateMemoryId(): string {
	return crypto.randomUUID().split("-")[0]!;
}
