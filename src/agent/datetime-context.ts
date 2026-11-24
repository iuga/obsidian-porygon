export interface DateTimeContextInput {
	now?: Date;
	locale?: string;
	timezone?: string;
	timezoneAbbreviation?: string;
	platform?: string;
	pluginVersion?: string;
	obsidianApiVersion?: string;
}

/**
 * Builds the `<context>` block injected into the system prompt. Kept free of
 * Obsidian imports so the date arithmetic can be unit-tested.
 */
export function buildDateTimeContext(input: DateTimeContextInput = {}): string {
	const now = input.now ?? new Date();
	const timezone = input.timezone ?? resolveTimezone();
	const timezoneAbbreviation = input.timezoneAbbreviation ?? resolveTimezoneAbbreviation(now);
	const lines = [
		`- today: ${formatHumanDate(now)}`,
		`- yesterday: ${formatHumanDate(addDays(now, -1))}`,
		`- tomorrow: ${formatHumanDate(addDays(now, 1))}`,
		`- week_start: ${formatHumanDate(startOfWeek(now))}`,
		`- week_end: ${formatHumanDate(endOfWeek(now))}`,
		`- now_local: ${formatLocalDatetime(now)}`,
		`- now_utc: ${formatUtcDatetime(now)}`,
		`- timezone: ${formatTimezone(timezone, now, timezoneAbbreviation)}`,
		`- locale: ${input.locale ?? resolveLocale()}`,
	];

	if (input.platform) {
		lines.push(`- platform: ${input.platform}`);
	}
	if (input.pluginVersion) {
		lines.push(`- porygon_version: ${input.pluginVersion}`);
	}
	if (input.obsidianApiVersion) {
		lines.push(`- obsidian_api_version: ${input.obsidianApiVersion}`);
	}

	return `<context>\n${lines.join("\n")}\n</context>`;
}

export function formatHumanDate(date: Date): string {
	return new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
	}).format(date);
}

export function startOfWeek(date: Date): Date {
	const start = new Date(date);
	// Noon avoids the rare timezones that skip midnight on a DST transition.
	start.setHours(12, 0, 0, 0);
	start.setDate(start.getDate() - start.getDay());
	return start;
}

export function endOfWeek(date: Date): Date {
	const end = startOfWeek(date);
	end.setDate(end.getDate() + 6);
	return end;
}

export function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

export function formatLocalDatetime(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${formatUtcOffset(date)}`;
}

export function formatUtcDatetime(date: Date): string {
	return `${date.toISOString().slice(0, 16)}Z`;
}

export function formatUtcOffset(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetMinutes);
	return `${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
}

function formatTimezone(timezone: string, date: Date, abbreviation: string): string {
	return `${timezone} (UTC${formatUtcOffset(date)}, ${abbreviation})`;
}

function resolveLocale(): string {
	return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
}

function resolveTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
}

function resolveTimezoneAbbreviation(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(date);
	return parts.find((part) => part.type === "timeZoneName")?.value ?? "unknown";
}
