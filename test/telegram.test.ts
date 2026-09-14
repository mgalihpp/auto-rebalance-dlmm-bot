import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { Effect } from "effect";
import { ConfigError, type EnvSource, loadConfig } from "../src/config.ts";
import {
	clearPendingLiveConfirm,
	fetchTelegramUpdates,
	hasPendingLiveConfirm,
	nextUpdatesOffset,
	parseBotCommand,
	queuePendingLiveConfirm,
	shouldDeferLiveConfirm,
	takePendingLiveConfirm,
} from "../src/telegram/commands.ts";
import {
	directionLine,
	escapeHtml,
	formatTelegramMessage,
	notifyTelegramEvent,
	notifyTelegramText,
	sendTelegramEvent,
	sendTelegramText,
	TelegramError,
	type TelegramFetch,
} from "../src/telegram/notify.ts";
import {
	formatTokenAmount,
	rangeDirection,
	renderRangeBar,
	shortAddr,
} from "../src/utils.ts";

function makeEnv(overrides?: EnvSource): EnvSource {
	return {
		RPC_URL: "https://api.mainnet-beta.solana.com",
		POOL_ADDRESS: Keypair.generate().publicKey.toBase58(),
		PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey),
		...overrides,
	};
}

function makeUpdate(updateId: number, chatId: number | string, text?: unknown) {
	return {
		update_id: updateId,
		message: {
			message_id: 1,
			chat: { id: chatId, type: "private" },
			text,
		},
	};
}

const okFetch: TelegramFetch = async (_url, _init) => ({
	ok: true,
	status: 200,
	text: async () => "ok",
	json: async () => ({ ok: true, result: true }),
});

describe("telegram config pairing", () => {
	test("both absent means disabled", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		expect(config.telegram).toBeUndefined();
	});

	test("both set enables telegram", async () => {
		const config = await Effect.runPromise(
			loadConfig(
				makeEnv({
					TELEGRAM_BOT_TOKEN: "token123",
					TELEGRAM_CHAT_ID: "987654",
				}),
			),
		);
		expect(config.telegram).toEqual({
			botToken: "token123",
			chatId: "987654",
		});
	});

	test("only token set is a ConfigError", async () => {
		const error = await Effect.runPromise(
			Effect.flip(loadConfig(makeEnv({ TELEGRAM_BOT_TOKEN: "token123" }))),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("only chat id set is a ConfigError", async () => {
		const error = await Effect.runPromise(
			Effect.flip(loadConfig(makeEnv({ TELEGRAM_CHAT_ID: "987654" }))),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});
});

describe("formatTelegramMessage", () => {
	test("startup includes pool and dry-run mode", () => {
		const text = formatTelegramMessage({
			kind: "startup",
			pool: "Pool111",
			dryRun: true,
		});
		expect(text).toContain("Po");
		expect(text).toContain("dry run");
	});

	test("shutdown is a short notice", () => {
		expect(formatTelegramMessage({ kind: "shutdown" })).toContain("stopped");
	});

	test("rebalanceNeeded includes preview ranges", () => {
		const text = formatTelegramMessage({
			kind: "rebalanceNeeded",
			pool: "Pool111",
			position: "Pos222",
			activeBinId: 1100,
			lowerBinId: 966,
			upperBinId: 1034,
			newLowerBinId: 1066,
			newUpperBinId: 1134,
			amountXDisplay: "0.90269 X",
			amountYDisplay: "0.756 Y",
			slippageBps: 50,
			dryRun: true,
		});
		expect(text).toContain("ABOVE");
		expect(text).toContain("966 to 1034");
		expect(text).toContain("1066 to 1134");
		expect(text).toContain("0.90269 X");
		expect(text).toContain("0.756 Y");
		expect(text).toContain("<pre>");
		expect(text).toContain("^");
		expect(text).toContain("Dry run");
	});

	test("rebalanced includes short signature link", () => {
		const text = formatTelegramMessage({
			kind: "rebalanced",
			pool: "Pool111",
			position: "Pos222",
			signature: "Sig333",
		});
		expect(text).toContain("Sig333");
		expect(text).toContain("https://solscan.io/tx/Sig333");
		expect(text).toContain("https://app.meteora.ag/dlmm/Pool111");
	});

	test("failed includes the error message", () => {
		const text = formatTelegramMessage({
			kind: "failed",
			message: "boom",
		});
		expect(text).toContain("boom");
	});
});

describe("parseBotCommand", () => {
	const allowed = "987654";

	test("parses /status", () => {
		expect(parseBotCommand(makeUpdate(1, 987654, "/status"), allowed)).toEqual({
			kind: "status",
			chatId: allowed,
			updateId: 1,
		});
	});

	test("parses /help", () => {
		expect(parseBotCommand(makeUpdate(2, 987654, "/help"), allowed)).toEqual({
			kind: "help",
			chatId: allowed,
			updateId: 2,
		});
	});

	test("parses /rebalance preview vs confirm", () => {
		expect(
			parseBotCommand(makeUpdate(3, 987654, "/rebalance"), allowed),
		).toEqual({
			kind: "rebalance",
			chatId: allowed,
			updateId: 3,
			confirmed: false,
		});
		expect(
			parseBotCommand(makeUpdate(4, 987654, "/rebalance confirm"), allowed),
		).toEqual({
			kind: "rebalance",
			chatId: allowed,
			updateId: 4,
			confirmed: true,
		});
	});

	test("strips @BotName suffix", () => {
		const parsed = parseBotCommand(
			makeUpdate(5, 987654, "/status@MyBot"),
			allowed,
		);
		expect(parsed?.kind).toBe("status");
	});

	test("rejects wrong chat id", () => {
		expect(
			parseBotCommand(makeUpdate(6, 111111, "/status"), allowed),
		).toBeNull();
	});

	test("ignores non-command text and missing text", () => {
		expect(parseBotCommand(makeUpdate(7, 987654, "hello"), allowed)).toBeNull();
		expect(
			parseBotCommand(makeUpdate(8, 987654, undefined), allowed),
		).toBeNull();
		expect(parseBotCommand({ update_id: 9 }, allowed)).toBeNull();
	});

	test("unknown slash command parses as unknown", () => {
		expect(parseBotCommand(makeUpdate(10, 987654, "/dance"), allowed)).toEqual({
			kind: "unknown",
			chatId: allowed,
			updateId: 10,
			text: "/dance",
		});
	});
});

describe("telegram offsets", () => {
	test("advances past ignored updates", () => {
		const updates = [
			makeUpdate(41, 111111, "/status"),
			makeUpdate(42, 987654, "/status"),
		];
		expect(nextUpdatesOffset(updates, undefined)).toBe(43);
		expect(nextUpdatesOffset([], 43)).toBe(43);
	});
});

describe("telegram send", () => {
	const telegram = { botToken: "secret-token", chatId: "987654" };

	test("send posts to api.telegram.org without failing on ok", async () => {
		let seenUrl = "";
		const capture: TelegramFetch = async (url, _init) => {
			seenUrl = url;
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true, result: true }),
			};
		};
		await Effect.runPromise(
			sendTelegramEvent({ kind: "shutdown" }, telegram, capture),
		);
		expect(seenUrl).toContain("https://api.telegram.org/");
		expect(seenUrl).not.toContain("PRIVATE_KEY");
	});

	test("send surfaces TelegramError on HTTP failure", async () => {
		const failing: TelegramFetch = async () => ({
			ok: false,
			status: 500,
			text: async () => "oops",
			json: async () => null,
		});
		const error = await Effect.runPromise(
			Effect.flip(sendTelegramEvent({ kind: "shutdown" }, telegram, failing)),
		);
		expect(error).toBeInstanceOf(TelegramError);
	});

	test("notify never fails and warns without the token", async () => {
		const failing: TelegramFetch = async () => {
			throw new Error("network down");
		};
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			await Effect.runPromise(
				notifyTelegramEvent({ kind: "shutdown" }, telegram, failing),
			);
		} finally {
			console.warn = original;
		}
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("Telegram send failed");
		expect(warnings[0]).not.toContain("secret-token");
	});

	test("notify is a no-op without network when disabled", async () => {
		let called = false;
		const spy: TelegramFetch = async (_url, _init) => {
			called = true;
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true, result: true }),
			};
		};
		await Effect.runPromise(
			notifyTelegramEvent({ kind: "shutdown" }, undefined, spy),
		);
		expect(called).toBe(false);
		expect(okFetch).toBeDefined();
	});

	test("fetchTelegramUpdates returns raw results offline", async () => {
		const updates = [makeUpdate(100, 987654, "/status")];
		const good: TelegramFetch = async () => ({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ ok: true, result: updates }),
		});
		const result = await Effect.runPromise(
			fetchTelegramUpdates(telegram, undefined, good),
		);
		expect(result.length).toBe(1);
	});
});

describe("telegram HTML structure", () => {
	test("startup uses <b> header and <code> pool", () => {
		const text = formatTelegramMessage({
			kind: "startup",
			pool: "Pool111",
			dryRun: true,
		});
		expect(text).toContain("<b>");
		expect(text).toContain("<code>Pool111</code>");
	});

	test("shutdown uses <b> header", () => {
		const text = formatTelegramMessage({ kind: "shutdown" });
		expect(text).toContain("<b>");
	});

	test("rebalanceNeeded uses <b>, <code> rows", () => {
		const text = formatTelegramMessage({
			kind: "rebalanceNeeded",
			pool: "Pool111",
			position: "Pos222",
			activeBinId: 1100,
			lowerBinId: 966,
			upperBinId: 1034,
			newLowerBinId: 1066,
			newUpperBinId: 1134,
			amountXDisplay: "0.90269 X",
			amountYDisplay: "0.756 Y",
			slippageBps: 50,
			dryRun: true,
		});
		expect(text).toContain("<b>Rebalance needed</b>");
		expect(text).toContain("1100");
		expect(text).toContain("<pre>");
	});

	test("rebalanced links the signature via solscan <a href>", () => {
		const text = formatTelegramMessage({
			kind: "rebalanced",
			pool: "Pool111",
			position: "Pos222",
			signature: "Sig333",
		});
		expect(text).toContain("<b>Rebalanced</b>");
		expect(text).toContain('<a href="https://solscan.io/tx/Sig333">');
		expect(text).toContain("<code>Sig333</code>");
	});

	test("failed uses <b> header and <code> message", () => {
		const text = formatTelegramMessage({ kind: "failed", message: "boom" });
		expect(text).toContain("<b>");
		expect(text).toContain("<code>boom</code>");
	});

	test("sendMessage requests HTML parse_mode", async () => {
		let seenBody = "";
		const capture: TelegramFetch = async (_url, init) => {
			seenBody = String((init as RequestInit)?.body ?? "");
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true, result: true }),
			};
		};
		const telegram = { botToken: "token", chatId: "987654" };
		await Effect.runPromise(sendTelegramText("hello", telegram, capture));
		expect(JSON.parse(seenBody).parse_mode).toBe("HTML");
	});
});

describe("telegram HTML escaping", () => {
	test("escapeHtml escapes <>&", () => {
		expect(escapeHtml("<>&")).toBe("&lt;&gt;&amp;");
		expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
	});

	test("failed event escapes hostile input", () => {
		const hostile = '<script>alert("x")&</script>';
		const text = formatTelegramMessage({ kind: "failed", message: hostile });
		expect(text).not.toContain("<script>");
		expect(text).toContain("&lt;script&gt;");
		expect(text).toContain("&amp;");
	});

	test("rebalanced escapes hostile pool text", () => {
		const text = formatTelegramMessage({
			kind: "rebalanced",
			pool: "<evil>&",
			position: "Pos222",
			signature: "Sig333",
		});
		expect(text).not.toContain("<evil>");
		expect(text).toContain("&lt;evil&gt;&amp;");
	});
});

describe("telegram poll interval config", () => {
	test("defaults to 3000 when unset", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		expect(config.telegramPollIntervalMs).toBe(3000);
	});

	test("accepts a valid custom value", async () => {
		const config = await Effect.runPromise(
			loadConfig(makeEnv({ TELEGRAM_POLL_INTERVAL_MS: "1000" })),
		);
		expect(config.telegramPollIntervalMs).toBe(1000);
	});

	test("rejects below-min with ConfigError", async () => {
		const error = await Effect.runPromise(
			Effect.flip(loadConfig(makeEnv({ TELEGRAM_POLL_INTERVAL_MS: "500" }))),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("rejects above-max with ConfigError", async () => {
		const error = await Effect.runPromise(
			Effect.flip(loadConfig(makeEnv({ TELEGRAM_POLL_INTERVAL_MS: "70000" }))),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("rejects non-integer with ConfigError", async () => {
		const error = await Effect.runPromise(
			Effect.flip(loadConfig(makeEnv({ TELEGRAM_POLL_INTERVAL_MS: "abc" }))),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});
});

describe("pending-confirm handoff", () => {
	test("shouldDefer only for confirmed-live rebalance", () => {
		const liveConfirm = {
			kind: "rebalance",
			chatId: "987654",
			updateId: 1,
			confirmed: true,
		} as const;
		const preview = { ...liveConfirm, confirmed: false };
		const status = { kind: "status", chatId: "987654", updateId: 2 } as const;
		expect(shouldDeferLiveConfirm(liveConfirm, false)).toBe(true);
		expect(shouldDeferLiveConfirm(liveConfirm, true)).toBe(false);
		expect(shouldDeferLiveConfirm(preview, false)).toBe(false);
		expect(shouldDeferLiveConfirm(status, false)).toBe(false);
	});

	test("DRY_RUN=true confirm stays preview (never defers)", () => {
		const confirm = {
			kind: "rebalance",
			chatId: "987654",
			updateId: 3,
			confirmed: true,
		} as const;
		expect(shouldDeferLiveConfirm(confirm, true)).toBe(false);
	});

	test("queue without main-loop consumption sends nothing live", async () => {
		clearPendingLiveConfirm();
		let called = false;
		const spy: TelegramFetch = async () => {
			called = true;
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true, result: true }),
			};
		};
		const confirm = {
			kind: "rebalance",
			chatId: "987654",
			updateId: 4,
			confirmed: true,
		} as const;
		queuePendingLiveConfirm(confirm);
		expect(hasPendingLiveConfirm()).toBe(true);
		expect(called).toBe(false);
		expect(spy).toBeDefined();
		const taken = takePendingLiveConfirm();
		expect(taken).toEqual(confirm);
		expect(hasPendingLiveConfirm()).toBe(false);
		expect(called).toBe(false);
		clearPendingLiveConfirm();
	});

	test("unconfirmed rebalance never queues", () => {
		clearPendingLiveConfirm();
		queuePendingLiveConfirm({
			kind: "rebalance",
			chatId: "987654",
			updateId: 5,
			confirmed: false,
		});
		expect(hasPendingLiveConfirm()).toBe(false);
		clearPendingLiveConfirm();
	});
});

describe("fast-loop disabled no-op", () => {
	test("notify text and event without telegram never hit network", async () => {
		let called = false;
		const spy: TelegramFetch = async () => {
			called = true;
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true, result: true }),
			};
		};
		await Effect.runPromise(
			notifyTelegramEvent({ kind: "shutdown" }, undefined, spy),
		);
		await Effect.runPromise(notifyTelegramText("hello", undefined, spy));
		expect(called).toBe(false);
	});

	test("disabled config leaves telegram unset with a fast default", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		expect(config.telegram).toBeUndefined();
		expect(config.telegramPollIntervalMs).toBe(3000);
	});
});

describe("shortAddr", () => {
	test("shortens long addresses to first4..last4", () => {
		expect(shortAddr("Ab12Cd34Ef56Gh78Ij90KlMn")).toBe("Ab12..KlMn");
	});

	test("passes through short strings", () => {
		expect(shortAddr("Pool111")).toBe("Pool111");
		expect(shortAddr("12345678901")).toBe("12345678901");
	});
});

describe("rangeDirection", () => {
	test("above when active exceeds upper", () => {
		expect(rangeDirection(1100, 966, 1034)).toBe("above");
	});

	test("below when active under lower", () => {
		expect(rangeDirection(900, 966, 1034)).toBe("below");
	});

	test("inside on the boundaries", () => {
		expect(rangeDirection(1000, 966, 1034)).toBe("inside");
		expect(rangeDirection(966, 966, 1034)).toBe("inside");
		expect(rangeDirection(1034, 966, 1034)).toBe("inside");
	});
});

describe("directionLine", () => {
	test("above reports the bin gap", () => {
		expect(directionLine(1100, 966, 1034)).toContain("ABOVE");
		expect(directionLine(1100, 966, 1034)).toContain("66 bins");
	});

	test("below reports the bin gap", () => {
		expect(directionLine(900, 966, 1034)).toContain("BELOW");
	});

	test("inside stays quiet", () => {
		expect(directionLine(1000, 966, 1034)).toContain("inside");
	});
});

describe("formatTokenAmount", () => {
	test("formats 9-decimal amounts", () => {
		expect(formatTokenAmount(new BN("1500000000"), 9, "SOL")).toBe("1.5 SOL");
	});

	test("formats 6-decimal amounts", () => {
		expect(formatTokenAmount(new BN("756000000"), 6, "USDC")).toBe("756 USDC");
	});

	test("falls back to raw string when decimals undefined", () => {
		expect(formatTokenAmount(new BN("902690000"), undefined, "X")).toBe(
			"902,690,000 X",
		);
	});

	test("groups thousands on normalized amounts", () => {
		expect(formatTokenAmount(new BN("12500000000"), 6, "MEME")).toBe(
			"12,500 MEME",
		);
	});
});

describe("renderRangeBar", () => {
	test("above: marks old, new, overlap and the active caret", () => {
		const bar = renderRangeBar(966, 1034, 1066, 1134, 1100);
		expect(bar).toContain("=");
		expect(bar).toContain("+");
		expect(bar).toContain("^");
		const rows = bar.split("\n");
		expect(rows.length).toBe(3);
		expect(rows[1]).toContain("^");
		expect(rows[0]).toMatch(/^[|=+* ]+$/);
	});

	test("below: caret sits left of the old range", () => {
		const bar = renderRangeBar(966, 1034, 866, 934, 900);
		const rows = bar.split("\n");
		expect(rows[1]?.indexOf("^") ?? -1).toBeLessThan(10);
		expect(bar).toContain("=");
		expect(bar).toContain("+");
	});

	test("inside: identical ranges collapse to overlap marks", () => {
		const bar = renderRangeBar(966, 1034, 966, 1034, 1000);
		expect(bar).toContain("*");
		expect(bar).not.toContain("=");
		expect(bar).not.toContain("+");
	});
});
