import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	type ActivityEntry,
	activityEntry,
	activityFromEvent,
	appendActivity,
	makeActivityLog,
	parseActivityLines,
	redactSecrets,
} from "../src/activity.ts";
import {
	activityStamp,
	formatActivityReply,
	type TelegramEvent,
} from "../src/telegram/notify.ts";

const SIG =
	"8uirQ6d2vyYH2JXqpMvB4Lm4hS5c9bNw3e7kTq1zR8fG2pXyW5nV6tA3sD9jK4mL7oP1qR2sT3uV4wX5yZ6aS7Ba";
const NOW = new Date("2026-10-07T09:02:00.000Z");

const outOfRange = (activeBinId: number): TelegramEvent => ({
	kind: "rebalanceNeeded",
	pool: "Pool111",
	position: "Pos222",
	pair: "PEPE/SOL",
	activeBinId,
	lowerBinId: 966,
	upperBinId: 1034,
	newLowerBinId: activeBinId - 34,
	newUpperBinId: activeBinId + 34,
	amountXDisplay: "1 PEPE",
	amountYDisplay: "1 SOL",
	slippageBps: 50,
	dryRun: true,
});

describe("activityFromEvent", () => {
	test("maps every event kind to a titled entry", () => {
		const events: TelegramEvent[] = [
			{ kind: "startup", pool: "Pool111", dryRun: true },
			{ kind: "shutdown" },
			outOfRange(1100),
			{
				kind: "rebalanced",
				pool: "Pool111",
				position: "Pos222",
				pair: "PEPE/SOL",
				signature: SIG,
			},
			{
				kind: "feesClaimed",
				action: "sweep",
				pool: "Pool111",
				position: "Pos222",
				pair: "PEPE/SOL",
				valueDisplay: "0.012 SOL",
				signature: SIG,
			},
			{ kind: "failed", stage: "fee claim", message: "boom" },
		];
		const titles = events.map((event) => activityFromEvent(event, NOW)?.title);
		expect(titles).toEqual([
			"Bot started",
			"Bot stopped",
			"Rebalance needed",
			"Rebalanced",
			"Fees swept to SOL",
			"Fee claim failed",
		]);
		const rebalanced = activityFromEvent(events[3] as TelegramEvent, NOW);
		expect(rebalanced).toEqual({
			at: NOW.toISOString(),
			kind: "rebalanced",
			title: "Rebalanced",
			detail: "PEPE/SOL",
			signature: SIG,
		});
	});

	test("rebalanceNeeded detail ignores the active bin so polls dedupe", () => {
		expect(activityFromEvent(outOfRange(1100))?.detail).toBe(
			activityFromEvent(outOfRange(1105))?.detail,
		);
	});
});

describe("appendActivity", () => {
	const needed = activityEntry("rebalanceNeeded", "Rebalance needed", "a", NOW);

	test("repeat of the newest entry bumps at and count", () => {
		const later = { ...needed, at: "2026-10-07T09:03:00.000Z" };
		const once = appendActivity([], needed, 50);
		const twice = appendActivity(once, later, 50);
		const thrice = appendActivity(twice, later, 50);
		expect(twice).toEqual([{ ...needed, at: later.at, count: 2 }]);
		expect(thrice[0]?.count).toBe(3);
	});

	test("different detail, kind or signature appends", () => {
		const base = appendActivity([], needed, 50);
		expect(appendActivity(base, { ...needed, detail: "b" }, 50).length).toBe(2);
		expect(appendActivity(base, { ...needed, kind: "failed" }, 50).length).toBe(
			2,
		);
		const tx = { ...needed, kind: "rebalanced" as const, signature: "s1" };
		const withTx = appendActivity(base, tx, 50);
		expect(appendActivity(withTx, { ...tx, signature: "s2" }, 50).length).toBe(
			3,
		);
	});

	test("only dedupes against the newest entry", () => {
		const other = activityEntry("paused", "Paused", undefined, NOW);
		const entries = [needed, other].reduce<ActivityEntry[]>(
			(acc, entry) => appendActivity(acc, entry, 50),
			[],
		);
		expect(appendActivity(entries, needed, 50).length).toBe(3);
	});

	test("caps at max, dropping the oldest", () => {
		let entries: ActivityEntry[] = [];
		for (let i = 0; i < 5; i++) {
			entries = appendActivity(
				entries,
				activityEntry("failed", "Failed", String(i), NOW),
				3,
			);
		}
		expect(entries.map((entry) => entry.detail)).toEqual(["2", "3", "4"]);
	});
});

describe("redactSecrets", () => {
	test("masks Helius api keys and Telegram bot tokens", () => {
		const raw =
			'fetch https://mainnet.helius-rpc.com/?api-key=abc-123_DEF&x=1 failed; "https://api.telegram.org/bot123456:AAH-x_9zQ/sendMessage" api-key=zzz';
		const redacted = redactSecrets(raw);
		expect(redacted).toBe(
			'fetch https://mainnet.helius-rpc.com/?api-key=***&x=1 failed; "https://api.telegram.org/bot***/sendMessage" api-key=***',
		);
		expect(redacted).not.toContain("abc-123_DEF");
		expect(redacted).not.toContain("AAH-x_9zQ");
	});

	test("leaves ordinary text alone", () => {
		expect(redactSecrets("robot 12 says hi")).toBe("robot 12 says hi");
	});
});

describe("activity log file", () => {
	test("records redacted lines, dedupes in place, reloads the tail", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dlmm-activity-"));
		try {
			const path = join(dir, "activity.jsonl");
			const log = makeActivityLog(path, 3);
			await Effect.runPromise(log.load());
			expect(log.recent(15)).toEqual([]);
			await Effect.runPromise(
				log.record(
					activityEntry(
						"failed",
						"Rebalance failed",
						"rpc https://x/?api-key=SECRET down",
						NOW,
					),
				),
			);
			await Effect.runPromise(
				log.record(
					activityEntry(
						"failed",
						"Rebalance failed",
						"rpc https://x/?api-key=SECRET down",
						NOW,
					),
				),
			);
			const text = await readFile(path, "utf8");
			expect(text).not.toContain("SECRET");
			const lines = parseActivityLines(text);
			expect(lines.length).toBe(1);
			expect(lines[0]?.count).toBe(2);

			for (const title of ["Paused", "Resumed", "Paused again"]) {
				await Effect.runPromise(
					log.record(activityEntry("paused", title, title, NOW)),
				);
			}
			const reloaded = makeActivityLog(path, 3);
			await Effect.runPromise(reloaded.load());
			expect(reloaded.recent(15).map((entry) => entry.title)).toEqual([
				"Paused again",
				"Resumed",
				"Paused",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("skips torn or foreign lines on load", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dlmm-activity-"));
		try {
			const path = join(dir, "activity.jsonl");
			const good = activityEntry("startup", "Bot started", undefined, NOW);
			await writeFile(
				path,
				`${JSON.stringify(good)}\n{"kind":"bogus","at":"x","title":"y"}\n{"at":`,
				"utf8",
			);
			const log = makeActivityLog(path);
			await Effect.runPromise(log.load());
			expect(log.recent(15)).toEqual([good]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("write failure only warns", async () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			const log = makeActivityLog(join(tmpdir(), "missing-dir-xyz", "a.jsonl"));
			await Effect.runPromise(
				log.record(activityEntry("paused", "Paused", undefined, NOW)),
			);
			expect(log.recent(1).length).toBe(1);
		} finally {
			console.warn = original;
		}
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("Activity log write failed");
	});
});

describe("formatActivityReply", () => {
	test("empty state", () => {
		expect(formatActivityReply([])).toBe(
			"📜 <b>Recent activity</b>\n\nNo activity yet.",
		);
	});

	test("one line per entry with short tx link and repeat count", () => {
		const text = formatActivityReply([
			{
				at: NOW.toISOString(),
				kind: "rebalanced",
				title: "Rebalanced",
				signature: SIG,
			},
			{
				at: NOW.toISOString(),
				kind: "rebalanceNeeded",
				title: "Rebalance needed",
				detail: "PEPE/SOL · above 966 to 1034 <x>",
				count: 4,
			},
		]);
		const lines = text.split("\n");
		const stamp = activityStamp(NOW.toISOString());
		expect(stamp).toMatch(/^\d\d [A-Z][a-z]{2} \d\d:\d\d$/);
		expect(lines[2]).toBe(
			`${stamp} ✅ Rebalanced · tx <a href="https://solscan.io/tx/${SIG}">8uir..S7Ba</a>`,
		);
		expect(lines[3]).toBe(
			`${stamp} ⚠️ Rebalance needed · PEPE/SOL · above 966 to 1034 &lt;x&gt; ×4`,
		);
	});
});
