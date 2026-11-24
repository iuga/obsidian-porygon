import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	addDays,
	buildDateTimeContext,
	endOfWeek,
	formatHumanDate,
	formatLocalDatetime,
	formatUtcDatetime,
	formatUtcOffset,
	startOfWeek,
} from "../src/agent/datetime-context";

void describe("formatHumanDate", () => {
	void test("uses the full weekday, month, day, and year", () => {
		assert.equal(formatHumanDate(new Date(2026, 10, 24, 10, 43)), "Tuesday, November 24, 2026");
	});
});

void describe("startOfWeek and endOfWeek", () => {
	void test("returns Sunday through Saturday for a mid-week date", () => {
		const date = new Date(2026, 10, 24, 10, 43);
		assert.equal(formatHumanDate(startOfWeek(date)), "Sunday, November 22, 2026");
		assert.equal(formatHumanDate(endOfWeek(date)), "Saturday, November 28, 2026");
	});

	void test("keeps a Sunday as the start of its own week", () => {
		const date = new Date(2026, 10, 22, 10, 43);
		assert.equal(formatHumanDate(startOfWeek(date)), "Sunday, November 22, 2026");
		assert.equal(formatHumanDate(endOfWeek(date)), "Saturday, November 28, 2026");
	});

	void test("keeps a Saturday in the week that started the previous Sunday", () => {
		const date = new Date(2026, 10, 28, 10, 43);
		assert.equal(formatHumanDate(startOfWeek(date)), "Sunday, November 22, 2026");
		assert.equal(formatHumanDate(endOfWeek(date)), "Saturday, November 28, 2026");
	});
});

void describe("addDays", () => {
	void test("moves backward and forward without mutating the input", () => {
		const date = new Date(2026, 10, 24, 10, 43);
		assert.equal(formatHumanDate(addDays(date, -1)), "Monday, November 23, 2026");
		assert.equal(formatHumanDate(addDays(date, 1)), "Wednesday, November 25, 2026");
		assert.equal(formatHumanDate(date), "Tuesday, November 24, 2026");
	});
});

void describe("timestamp formatting", () => {
	void test("drops seconds from the local timestamp", () => {
		const date = new Date(2026, 10, 24, 10, 43, 45);
		assert.equal(formatLocalDatetime(date), "2026-11-24T10:43+00:00");
		assert.match(formatLocalDatetime(date), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
	});

	void test("drops seconds from the UTC timestamp", () => {
		const date = new Date(Date.UTC(2026, 10, 24, 13, 43, 45));
		assert.equal(formatUtcDatetime(date), "2026-11-24T13:43Z");
	});

	void test("formats the UTC offset with a sign", () => {
		assert.equal(formatUtcOffset(new Date(2026, 10, 24, 10, 43)), "+00:00");
	});
});

void describe("buildDateTimeContext", () => {
	void test("renders the full context block", () => {
		const context = buildDateTimeContext({
			now: new Date(2026, 10, 24, 10, 43, 45),
			locale: "en-US",
			timezone: "UTC",
			timezoneAbbreviation: "UTC",
			platform: "Linux (desktop)",
			pluginVersion: "0.32.0",
			obsidianApiVersion: "1.11.4",
		});

		assert.equal(
			context,
			[
				"<context>",
				"- today: Tuesday, November 24, 2026",
				"- yesterday: Monday, November 23, 2026",
				"- tomorrow: Wednesday, November 25, 2026",
				"- week_start: Sunday, November 22, 2026",
				"- week_end: Saturday, November 28, 2026",
				"- now_local: 2026-11-24T10:43+00:00",
				"- now_utc: 2026-11-24T10:43Z",
				"- timezone: UTC (UTC+00:00, UTC)",
				"- locale: en-US",
				"- platform: Linux (desktop)",
				"- porygon_version: 0.32.0",
				"- obsidian_api_version: 1.11.4",
				"</context>",
			].join("\n"),
		);
	});

	void test("omits optional environment lines when values are missing", () => {
		const context = buildDateTimeContext({
			now: new Date(2026, 10, 24, 10, 43, 45),
			locale: "en-US",
			timezone: "UTC",
			timezoneAbbreviation: "UTC",
		});

		assert.doesNotMatch(context, /platform:/);
		assert.doesNotMatch(context, /porygon_version:/);
		assert.doesNotMatch(context, /obsidian_api_version:/);
	});
});
