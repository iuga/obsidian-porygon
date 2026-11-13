/**
 * Tool timing formatting. Kept dependency-free so it can be unit tested.
 *
 * Live values tick as whole seconds (`0s`, `1s`, ...). Finished values keep
 * millisecond precision below one second and use `Xm Ys` from a minute up.
 */

const MS_PER_SECOND = 1000;

/** Live elapsed time, always whole seconds (e.g. "0s", "12s"). */
export function formatToolElapsed(startedAt: number, now = performance.now()): string {
	const elapsedMs = Math.max(0, now - startedAt);
	return `${Math.floor(elapsedMs / MS_PER_SECOND)}s`;
}

/**
 * Fixed duration after the tool finished:
 *   <1s       rounded milliseconds ("0ms", "200ms")
 *   1s–59s    rounded seconds ("1s", "2s")
 *   >=60s     "Xm Ys", seconds rounded and carried ("1m 0s", "1m 15s")
 */
export function formatToolDuration(durationMs: number): string {
	const safeMs = Math.max(0, durationMs);
	if (safeMs < MS_PER_SECOND) {
		return `${Math.round(safeMs)}ms`;
	}

	const totalSeconds = Math.round(safeMs / MS_PER_SECOND);
	if (totalSeconds < 60) {
		return `${Math.max(1, totalSeconds)}s`;
	}

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}
