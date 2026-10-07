import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { FAILURE_TITLES, type TelegramEvent } from "./telegram/notify.ts";
import {
	formatBinRange,
	nowStamp,
	rangeDirection,
	redactSecrets,
	shortAddr,
} from "./utils.ts";

export const ACTIVITY_KINDS = [
	"startup",
	"shutdown",
	"rebalanceNeeded",
	"rebalanced",
	"feesSwept",
	"feesCompounded",
	"failed",
	"paused",
	"resumed",
	"configChanged",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEntry {
	at: string;
	kind: ActivityKind;
	title: string;
	detail?: string;
	signature?: string;
	count?: number;
}

export const ACTIVITY_FILE = "activity.jsonl";
export const ACTIVITY_MAX = 50;
const DETAIL_MAX = 300;

type EntryBody = Omit<ActivityEntry, "at" | "count">;

const activityMappers: {
	[K in TelegramEvent["kind"]]: (
		event: Extract<TelegramEvent, { kind: K }>,
	) => EntryBody | null;
} = {
	startup: (event) => ({
		kind: "startup",
		title: "Bot started",
		detail: `${event.dryRun ? "dry run" : "LIVE"} · pool ${shortAddr(event.pool)}`,
	}),
	shutdown: () => ({ kind: "shutdown", title: "Bot stopped" }),
	// Range, not the active bin, so the every-poll notice while out of
	// range dedupes into one entry.
	rebalanceNeeded: (event) => ({
		kind: "rebalanceNeeded",
		title: "Rebalance needed",
		detail: `${event.pair} · ${rangeDirection(event.activeBinId, event.lowerBinId, event.upperBinId)} ${formatBinRange(event.lowerBinId, event.upperBinId)}`,
	}),
	rebalanced: (event) => ({
		kind: "rebalanced",
		title: "Rebalanced",
		detail: event.pair,
		signature: event.signature,
	}),
	feesClaimed: (event) => ({
		...(event.action === "sweep"
			? { kind: "feesSwept", title: "Fees swept to SOL" }
			: { kind: "feesCompounded", title: "Fees compounded" }),
		detail: `${event.pair} · ~${event.valueDisplay}`,
		signature: event.signature,
	}),
	failed: (event) => ({
		kind: "failed",
		title: FAILURE_TITLES[event.stage],
		detail: event.message,
	}),
};

export function activityFromEvent(
	event: TelegramEvent,
	now: Date = new Date(),
): ActivityEntry | null {
	const map = activityMappers[event.kind] as (
		event: TelegramEvent,
	) => EntryBody | null;
	const body = map(event);
	return body === null ? null : { at: now.toISOString(), ...body };
}

export function activityEntry(
	kind: ActivityKind,
	title: string,
	detail?: string,
	now: Date = new Date(),
): ActivityEntry {
	return { at: now.toISOString(), kind, title, detail };
}

// Oldest first, capped at max. A repeat of the newest entry bumps its time
// and count instead of appending.
export function appendActivity(
	entries: ReadonlyArray<ActivityEntry>,
	entry: ActivityEntry,
	max: number,
): ActivityEntry[] {
	const last = entries.at(-1);
	if (
		last &&
		last.kind === entry.kind &&
		last.detail === entry.detail &&
		last.signature === entry.signature
	) {
		return [
			...entries.slice(0, -1),
			{ ...last, at: entry.at, count: (last.count ?? 1) + 1 },
		];
	}
	return [...entries, entry].slice(-max);
}

function isActivityEntry(value: unknown): value is ActivityEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.at === "string" &&
		typeof record.title === "string" &&
		(ACTIVITY_KINDS as ReadonlyArray<unknown>).includes(record.kind)
	);
}

export function parseActivityLines(text: string): ActivityEntry[] {
	const entries: ActivityEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isActivityEntry(parsed)) {
				entries.push(parsed);
			}
		} catch {
			// A torn last line from a crash mid-write is skipped, not fatal.
		}
	}
	return entries;
}

// In-memory ring mirrored to a JSONL file. The file is rewritten from memory
// on every record, so a deduped entry never leaves a stale line behind. File
// errors only warn: logging must never fail an iteration.
export function makeActivityLog(path: string, max: number = ACTIVITY_MAX) {
	let entries: ActivityEntry[] = [];
	// Both loops record; chaining keeps writes ordered so the newest state lands last.
	let writes: Promise<void> = Promise.resolve();

	const persist = () => {
		writes = writes
			.then(() =>
				writeFile(
					path,
					entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
					"utf8",
				),
			)
			.catch((error: unknown) => {
				console.warn(
					`[${nowStamp()}] Activity log write failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		return writes;
	};

	return {
		load: () =>
			Effect.promise(async () => {
				try {
					entries = parseActivityLines(await readFile(path, "utf8")).slice(
						-max,
					);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						console.warn(
							`[${nowStamp()}] Activity log read failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}),
		record: (entry: ActivityEntry) =>
			Effect.promise(() => {
				const detail =
					entry.detail === undefined
						? undefined
						: redactSecrets(entry.detail).slice(0, DETAIL_MAX);
				entries = appendActivity(entries, { ...entry, detail }, max);
				return persist();
			}),
		// Newest first.
		recent: (limit: number): ActivityEntry[] => entries.slice(-limit).reverse(),
	};
}

export type ActivityLog = ReturnType<typeof makeActivityLog>;
