import { BodyComponent } from '.';

export function runSafely(context: string, callback: () => unknown) {
	try {
		const result = callback();

		if (
			result !== null &&
			result !== undefined &&
			typeof (result as PromiseLike<unknown>).then === 'function'
		) {
			void Promise.resolve(result).catch((error) => {
				console.error(`[${context}] Async failure`, error);
			});
		}
	} catch (error) {
		console.error(`[${context}] Failure`, error);
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

export function buildMessageBody(text: string, emotes: BodyComponent[]): BodyComponent[] {
	const sorted = [...emotes].sort((a, b) => a.start_inclusive - b.start_inclusive);

	const body: BodyComponent[] = [];
	let cursor = 0;

	for (const emote of sorted) {
		const start = emote.start_inclusive;
		const end = emote.end_exclusive;

		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < cursor ||
			end <= start ||
			end > text.length
		) {
			continue;
		}

		if (start > cursor) {
			body.push({
				type: 'text',
				text: text.slice(cursor, start),
				start_inclusive: cursor,
				end_exclusive: start,
			});
		}

		body.push(emote);
		cursor = end;
	}

	if (cursor < text.length || body.length === 0) {
		body.push({
			type: 'text',
			text: text.slice(cursor),
			start_inclusive: cursor,
			end_exclusive: text.length,
		});
	}

	return body;
}
