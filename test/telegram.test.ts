import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { Effect, Ref } from "effect";
import {
	ConfigError,
	type EnvSource,
	loadConfig,
	tunablesFromConfig,
} from "../src/config.ts";
import { persistEnvKey, RuntimeTunables } from "../src/services.ts";
import {
	type BotCommand,
	clearPendingLiveConfirm,
	EDITABLE_KEYS,
	EDITABLE_REGISTRY,
	type EditableKey,
	fetchTelegramUpdates,
	hasPendingLiveConfirm,
	isBotPaused,
	isEditableKey,
	nextUpdatesOffset,
	normalizeEditableKey,
	parseBotCommand,
	parseConfigMenuAction,
	queuePendingLiveConfirm,
	setBotPaused,
	shouldDeferLiveConfirm,
	takePendingLiveConfirm,
} from "../src/telegram/commands.ts";
import {
	activeSummary,
	configMenuKeyboard,
	configValueKeyboard,
	escapeHtml,
	formatConfigBadValue,
	formatConfigPick,
	formatConfigPreview,
	formatConfigShow,
	formatConfigUnknownKey,
	formatConfigUpdated,
	formatPausedReply,
	formatPausedSkip,
	formatPreviewReply,
	formatResumedReply,
	formatStatusReply,
	formatTelegramMessage,
	mainMenuKeyboard,
	notifyTelegramText,
	previewKeyboard,
	REMOVE_REPLY_KEYBOARD,
	sendTelegramText,
	TELEGRAM_BOT_COMMANDS,
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

const POOL = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6Z";
const POSITION = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SIG =
	"8uirQ6d2vyYH2JXqpMvB4Lm4hS5c9bNw3e7kTq1zR8fG2pXyW5nV6tA3sD9jK4mL7oP1qR2sT3uV4wX5yZ6aS7Ba";

const visibleText = (html: string) => html.replace(/<[^>]+>/g, "");
const hrefsOf = (html: string) =>
	[...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

// Shared phone-layout contract: emoji + bold title, blank line, every link
// once and only on the final line, and no full address in visible text.
function expectPhoneLayout(text: string) {
	const lines = text.split("\n");
	expect(lines[0]).toMatch(/^\S+ <b>[^<]+<\/b>/);
	if (lines.length > 1) {
		expect(lines[1]).toBe("");
	}
	const hrefs = hrefsOf(text);
	expect(new Set(hrefs).size).toBe(hrefs.length);
	if (hrefs.length > 0) {
		const last = lines.at(-1) ?? "";
		expect(last.startsWith("🔗 ")).toBe(true);
		expect(hrefsOf(last).length).toBe(hrefs.length);
	}
	const visible = visibleText(text);
	for (const full of [POOL, POSITION, SIG]) {
		expect(visible).not.toContain(full);
	}
}

const neededEvent = {
	kind: "rebalanceNeeded",
	pool: POOL,
	position: POSITION,
	pair: "PEPE/SOL",
	activeBinId: 1100,
	lowerBinId: 966,
	upperBinId: 1034,
	newLowerBinId: 1066,
	newUpperBinId: 1134,
	amountXDisplay: "0.90269 X",
	amountYDisplay: "0.756 Y",
	slippageBps: 50,
	dryRun: true,
} as const;

describe("formatTelegramMessage", () => {
	test("startup shows mode and a short pool with one Pool link", () => {
		const text = formatTelegramMessage({
			kind: "startup",
			pool: POOL,
			dryRun: true,
		});
		expectPhoneLayout(text);
		expect(text).toContain("<b>Bot started</b>");
		expect(text).toContain("Mode: dry run");
		expect(text).toContain(`<code>${shortAddr(POOL)}</code>`);
		expect(hrefsOf(text)).toEqual([`https://app.meteora.ag/dlmm/${POOL}`]);
	});

	test("shutdown is a title-only notice", () => {
		const text = formatTelegramMessage({ kind: "shutdown" });
		expectPhoneLayout(text);
		expect(text).toBe("🛑 <b>Bot stopped</b>");
	});

	test("rebalanceNeeded keeps the range bar and uses the shared labels", () => {
		const text = formatTelegramMessage(neededEvent);
		expectPhoneLayout(text);
		expect(text.split("\n")[0]).toBe(
			"⚠️ <b>Rebalance needed</b> <code>PEPE/SOL</code>",
		);
		expect(text).toContain("Active: 1100 · 66 bins ABOVE range");
		expect(text).toContain(
			"Range: <code>966 to 1034</code> → <code>1066 to 1134</code>",
		);
		expect(text).toContain("<pre>");
		expect(text).toContain("<i>= old range · + new range · ^ active</i>");
		expect(text).toContain(
			"Balances: <code>0.90269 X</code> · <code>0.756 Y</code>",
		);
		expect(text).toContain("Slippage: 50 bps");
		expect(text).toContain("Mode: dry run");
		expect(text).toContain("No transactions sent.");
		expect(hrefsOf(text)).toEqual([
			`https://app.meteora.ag/dlmm/${POOL}`,
			`https://solscan.io/account/${POSITION}`,
		]);
	});

	test("rebalanceNeeded live says it is executing", () => {
		const text = formatTelegramMessage({ ...neededEvent, dryRun: false });
		expectPhoneLayout(text);
		expect(text).toContain("Mode: <b>LIVE</b>");
		expect(text).toContain("Executing now.");
	});

	test("rebalanced links tx, pool and position once each", () => {
		const text = formatTelegramMessage({
			kind: "rebalanced",
			pool: POOL,
			position: POSITION,
			pair: "PEPE/SOL",
			signature: SIG,
		});
		expectPhoneLayout(text);
		expect(text).toContain("<b>Rebalanced</b> <code>PEPE/SOL</code>");
		expect(text).toContain(`Tx: <code>${shortAddr(SIG)}</code>`);
		expect(hrefsOf(text)).toEqual([
			`https://solscan.io/tx/${SIG}`,
			`https://app.meteora.ag/dlmm/${POOL}`,
			`https://solscan.io/account/${POSITION}`,
		]);
	});

	test("feesClaimed names the action and shows the value", () => {
		const base = {
			kind: "feesClaimed",
			pool: POOL,
			position: POSITION,
			pair: "PEPE/SOL",
			valueDisplay: "0.012 SOL",
			signature: SIG,
		} as const;
		const sweep = formatTelegramMessage({ ...base, action: "sweep" });
		expectPhoneLayout(sweep);
		expect(sweep).toContain("<b>Fees swept to SOL</b>");
		expect(sweep).not.toContain("Fees compounded");
		expect(sweep).toContain("Value: ~0.012 SOL");
		expect(hrefsOf(sweep).length).toBe(3);
		const compound = formatTelegramMessage({ ...base, action: "compound" });
		expectPhoneLayout(compound);
		expect(compound).toContain("<b>Fees compounded</b>");
		expect(compound).not.toContain("Fees swept to SOL");
	});

	test("failed names the stage that failed", () => {
		const titles = {
			rebalance: "Rebalance failed",
			"fee claim": "Fee claim failed",
			command: "Command failed",
		} as const;
		for (const [stage, title] of Object.entries(titles)) {
			const text = formatTelegramMessage({
				kind: "failed",
				stage: stage as keyof typeof titles,
				message: "boom",
			});
			expectPhoneLayout(text);
			expect(text).toBe(`❌ <b>${title}</b>\n\nError: <code>boom</code>`);
		}
	});

	test("failed adds a hint when no position is funded", () => {
		const text = formatTelegramMessage({
			kind: "failed",
			stage: "command",
			message: "no DLMM position found for owner",
		});
		expect(text).toContain("POOL_ADDRESS");
	});

	test("failed never shows an RPC api key in chat", () => {
		const text = formatTelegramMessage({
			kind: "failed",
			stage: "rebalance",
			message:
				"fetch https://mainnet.helius-rpc.com/?api-key=secret-123 failed",
		});
		expect(text).not.toContain("secret-123");
		expect(text).toContain("api-key=***");
	});
});

describe("status and preview replies", () => {
	const snapshot = {
		pool: POOL,
		position: POSITION,
		owner: POSITION,
		activeBinId: 1000,
		activeBinPrice: "1",
		lowerBinId: 966,
		upperBinId: 1034,
		amountX: new BN("1500000000"),
		amountY: new BN("756000000"),
		feeX: new BN(0),
		feeY: new BN(0),
		claimedFeeX: new BN(0),
		claimedFeeY: new BN(0),
		tokenXMint: POOL,
		tokenYMint: POSITION,
		tokenXDecimals: 9,
		tokenYDecimals: 6,
		tokenXSymbol: "PEPE",
		tokenYSymbol: "SOL",
	};

	test("status keeps the range bar and shows mode and pause state", () => {
		const text = formatStatusReply(snapshot, { dryRun: true, paused: true });
		expectPhoneLayout(text);
		expect(text.split("\n")[0]).toBe(
			"📊 <b>Position</b> <code>PEPE/SOL</code>",
		);
		expect(text).toContain("Active: 1000 · inside range");
		expect(text).toContain("<pre>");
		expect(text).toContain("<i>* range · ^ active</i>");
		expect(text).toContain(
			"Balances: <code>1.5 PEPE</code> · <code>756 SOL</code>",
		);
		expect(text).toContain("Mode: dry run · ⏸ paused");
		expect(
			formatStatusReply(snapshot, { dryRun: false, paused: false }),
		).not.toContain("paused");
	});

	test("chat preview uses the preview title and the caller note", () => {
		const text = formatPreviewReply({
			...neededEvent,
			preview: true,
			note: "Tap ✅ Confirm live",
		});
		expectPhoneLayout(text);
		expect(text).toContain("🔍 <b>Rebalance preview</b>");
		expect(text).toContain("Tap ✅ Confirm live");
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
		await Effect.runPromise(sendTelegramText("bye", telegram, capture));
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
			Effect.flip(sendTelegramText("bye", telegram, failing)),
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
			await Effect.runPromise(notifyTelegramText("bye", telegram, failing));
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
		await Effect.runPromise(notifyTelegramText("bye", undefined, spy));
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
			pair: "PEPE/SOL",
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
			pair: "PEPE/SOL",
			signature: "Sig333",
		});
		expect(text).toContain("<b>Rebalanced</b>");
		expect(text).toContain('<a href="https://solscan.io/tx/Sig333">');
		expect(text).toContain("<code>Sig333</code>");
	});

	test("failed uses <b> header and <code> message", () => {
		const text = formatTelegramMessage({
			kind: "failed",
			stage: "rebalance",
			message: "boom",
		});
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

	test("sendMessage disables link previews", async () => {
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
		const body = JSON.parse(seenBody);
		expect(body.link_preview_options).toEqual({ is_disabled: true });
		expect(body.disable_web_page_preview).toBeUndefined();
	});
});

describe("telegram HTML escaping", () => {
	test("escapeHtml escapes <>&", () => {
		expect(escapeHtml("<>&")).toBe("&lt;&gt;&amp;");
		expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
	});

	test("failed event escapes hostile input", () => {
		const hostile = '<script>alert("x")&</script>';
		const text = formatTelegramMessage({
			kind: "failed",
			stage: "rebalance",
			message: hostile,
		});
		expect(text).not.toContain("<script>");
		expect(text).toContain("&lt;script&gt;");
		expect(text).toContain("&amp;");
	});

	test("rebalanced escapes hostile pool text", () => {
		const text = formatTelegramMessage({
			kind: "rebalanced",
			pool: "<evil>&",
			position: "Pos222",
			pair: "PEPE/SOL",
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
		await Effect.runPromise(notifyTelegramText("bye", undefined, spy));
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

describe("activeSummary", () => {
	test("above reports the bin gap", () => {
		expect(activeSummary(1100, 966, 1034)).toContain("ABOVE");
		expect(activeSummary(1100, 966, 1034)).toContain("66 bins");
	});

	test("below reports the bin gap", () => {
		expect(activeSummary(900, 966, 1034)).toContain("BELOW");
	});

	test("inside stays quiet", () => {
		expect(activeSummary(1000, 966, 1034)).toContain("inside");
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

describe("parseBotCommand /config", () => {
	const allowed = "987654";

	test("parses /config as show", () => {
		expect(
			parseBotCommand(makeUpdate(201, 987654, "/config"), allowed),
		).toEqual({
			kind: "config_show",
			chatId: allowed,
			updateId: 201,
		});
	});

	test("parses /config set KEY VALUE", () => {
		expect(
			parseBotCommand(
				makeUpdate(202, 987654, "/config set SLIPPAGE_BPS 50"),
				allowed,
			),
		).toEqual({
			kind: "config_set",
			chatId: allowed,
			updateId: 202,
			key: "SLIPPAGE_BPS",
			value: "50",
			confirmed: false,
		});
	});

	test("parses pool switch with confirm suffix", () => {
		const pool = Keypair.generate().publicKey.toBase58();
		expect(
			parseBotCommand(
				makeUpdate(203, 987654, `/config set POOL_ADDRESS ${pool} confirm`),
				allowed,
			),
		).toEqual({
			kind: "config_set",
			chatId: allowed,
			updateId: 203,
			key: "POOL_ADDRESS",
			value: pool,
			confirmed: true,
		});
		expect(
			parseBotCommand(
				makeUpdate(204, 987654, `/config set POOL_ADDRESS ${pool}`),
				allowed,
			),
		).toMatchObject({ kind: "config_set", confirmed: false });
	});

	test("strips @BotName suffix on /config", () => {
		const parsed = parseBotCommand(
			makeUpdate(205, 987654, "/config@MyBot"),
			allowed,
		);
		expect(parsed?.kind).toBe("config_show");
	});

	test("rejects wrong chat id for /config", () => {
		expect(
			parseBotCommand(makeUpdate(206, 111111, "/config"), allowed),
		).toBeNull();
		expect(
			parseBotCommand(
				makeUpdate(207, 111111, "/config set SLIPPAGE_BPS 50"),
				allowed,
			),
		).toBeNull();
	});

	test("menu Config label parses back to show", () => {
		expect(
			parseBotCommand(makeUpdate(208, 987654, "⚙️ Config"), allowed)?.kind,
		).toBe("config_show");
		expect(
			parseBotCommand(makeUpdate(209, 987654, "config"), allowed)?.kind,
		).toBe("config_show");
	});

	test("malformed /config surfaces as unknown (help path)", () => {
		expect(
			parseBotCommand(makeUpdate(210, 987654, "/config frobnicate"), allowed)
				?.kind,
		).toBe("unknown");
	});
});

describe("editable registry", () => {
	test("covers exactly the nine editable keys", () => {
		const expected: EditableKey[] = [
			"COMPOUND_FEES",
			"FEE_CLAIM_THRESHOLD_SOL",
			"REACCUMULATE_FEES_TO_SOL",
			"POLL_INTERVAL_MS",
			"POOL_ADDRESS",
			"PRIORITY_LEVEL",
			"SLIPPAGE_BPS",
			"STRATEGY",
			"TELEGRAM_POLL_INTERVAL_MS",
		];
		expect([...EDITABLE_KEYS].sort()).toEqual([...expected].sort());
	});

	test("startup-only keys are never editable", () => {
		for (const key of [
			"DRY_RUN",
			"RPC_URL",
			"PRIVATE_KEY",
			"TELEGRAM_BOT_TOKEN",
			"TELEGRAM_CHAT_ID",
			"JUPITER_API_KEY",
		]) {
			expect(isEditableKey(key)).toBe(false);
			expect(normalizeEditableKey(key)).toBeNull();
		}
	});

	test("key lookup is case-insensitive", () => {
		expect(isEditableKey("slippage_bps")).toBe(true);
		expect(normalizeEditableKey("pool_address")).toBe("POOL_ADDRESS");
		expect(isEditableKey("FROBNICATE")).toBe(false);
	});

	test("needsConfirm is true only for POOL_ADDRESS", () => {
		for (const key of EDITABLE_KEYS) {
			expect(EDITABLE_REGISTRY[key].needsConfirm).toBe(key === "POOL_ADDRESS");
		}
	});

	test("rejects out-of-range ints with ConfigError", async () => {
		for (const [key, bad] of [
			["SLIPPAGE_BPS", "10001"] as const,
			["SLIPPAGE_BPS", "-1"] as const,
			["POLL_INTERVAL_MS", "4999"] as const,
			["POLL_INTERVAL_MS", "3600001"] as const,
			["TELEGRAM_POLL_INTERVAL_MS", "999"] as const,
			["TELEGRAM_POLL_INTERVAL_MS", "60001"] as const,
		]) {
			const error = await Effect.runPromise(
				Effect.flip(EDITABLE_REGISTRY[key].parse(bad)),
			);
			expect(error).toBeInstanceOf(ConfigError);
		}
	});

	test("accepts int boundaries", async () => {
		expect(
			await Effect.runPromise(EDITABLE_REGISTRY.SLIPPAGE_BPS.parse("0")),
		).toBe(0);
		expect(
			await Effect.runPromise(EDITABLE_REGISTRY.SLIPPAGE_BPS.parse("10000")),
		).toBe(10000);
		expect(
			await Effect.runPromise(EDITABLE_REGISTRY.POLL_INTERVAL_MS.parse("5000")),
		).toBe(5000);
		expect(
			await Effect.runPromise(
				EDITABLE_REGISTRY.TELEGRAM_POLL_INTERVAL_MS.parse("60000"),
			),
		).toBe(60000);
	});

	test("rejects bad pubkey, accepts valid base58", async () => {
		const error = await Effect.runPromise(
			Effect.flip(EDITABLE_REGISTRY.POOL_ADDRESS.parse("not-an-address")),
		);
		expect(error).toBeInstanceOf(ConfigError);
		const pool = Keypair.generate().publicKey.toBase58();
		expect(
			await Effect.runPromise(EDITABLE_REGISTRY.POOL_ADDRESS.parse(pool)),
		).toBe(pool);
	});

	test("accepts strategy aliases", async () => {
		for (const [raw, expected] of [
			["Spot", "Spot"],
			["spot", "Spot"],
			["CURVE", "Curve"],
			["BidAsk", "BidAsk"],
			["bidask", "BidAsk"],
			["bid-ask", "BidAsk"],
			["bid_ask", "BidAsk"],
		] as const) {
			expect(
				await Effect.runPromise(EDITABLE_REGISTRY.STRATEGY.parse(raw)),
			).toBe(expected);
		}
		const error = await Effect.runPromise(
			Effect.flip(EDITABLE_REGISTRY.STRATEGY.parse("sideways")),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("accepts priority levels case-insensitively", async () => {
		expect(
			await Effect.runPromise(EDITABLE_REGISTRY.PRIORITY_LEVEL.parse("auto")),
		).toBe("Auto");
		expect(
			await Effect.runPromise(
				EDITABLE_REGISTRY.PRIORITY_LEVEL.parse("veryhigh"),
			),
		).toBe("VeryHigh");
		const error = await Effect.runPromise(
			Effect.flip(EDITABLE_REGISTRY.PRIORITY_LEVEL.parse("Ultra")),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("fee claim threshold parses to a persistable SOL string and applies lamports", async () => {
		const entry = EDITABLE_REGISTRY.FEE_CLAIM_THRESHOLD_SOL;
		expect(entry.needsConfirm).toBe(false);
		expect(entry.presets).toEqual(["0.01", "0.05", "off"]);
		expect(await Effect.runPromise(entry.parse("0.01"))).toBe("0.01");
		expect(await Effect.runPromise(entry.parse("OFF"))).toBe("off");
		expect(await Effect.runPromise(entry.parse("0"))).toBe("off");
		const error = await Effect.runPromise(Effect.flip(entry.parse("-1")));
		expect(error).toBeInstanceOf(ConfigError);

		const config = await Effect.runPromise(loadConfig(makeEnv()));
		const before = tunablesFromConfig(config);
		expect(entry.getDisplay(before)).toBe("off");
		const on = await Effect.runPromise(entry.apply(before, "0.05"));
		expect(on.feeClaimThresholdLamports?.toString()).toBe("50000000");
		expect(entry.getDisplay(on)).toBe("0.05 SOL");
		const off = await Effect.runPromise(entry.apply(on, "off"));
		expect(off.feeClaimThresholdLamports).toBeNull();
	});

	test("apply returns new tunables without mutating the original", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		const before = tunablesFromConfig(config);
		const after = await Effect.runPromise(
			EDITABLE_REGISTRY.SLIPPAGE_BPS.apply(before, "200"),
		);
		expect(after.slippageBps).toBe(200);
		expect(before.slippageBps).toBe(config.slippageBps);
		const pool = Keypair.generate().publicKey.toBase58();
		const switched = await Effect.runPromise(
			EDITABLE_REGISTRY.POOL_ADDRESS.apply(before, pool),
		);
		expect(switched.poolAddress).toBe(pool);
		expect(before.poolAddress).toBe(config.poolAddress);
	});

	test("pool apply clears a queued live confirm", async () => {
		clearPendingLiveConfirm();
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		const before = tunablesFromConfig(config);
		queuePendingLiveConfirm({
			kind: "rebalance",
			chatId: "987654",
			updateId: 999,
			confirmed: true,
		});
		expect(hasPendingLiveConfirm()).toBe(true);
		const pool = Keypair.generate().publicKey.toBase58();
		const ref = await Effect.runPromise(Ref.make(before));
		const updated = await Effect.runPromise(
			EDITABLE_REGISTRY.POOL_ADDRESS.apply(
				await Effect.runPromise(Ref.get(ref)),
				pool,
			),
		);
		await Effect.runPromise(Ref.set(ref, updated));
		clearPendingLiveConfirm();
		expect(hasPendingLiveConfirm()).toBe(false);
		expect((await Effect.runPromise(Ref.get(ref))).poolAddress).toBe(pool);
		clearPendingLiveConfirm();
	});
});

describe("config formatters", () => {
	test("show lists keys with bounds, escaped", () => {
		const text = formatConfigShow([
			{
				key: "SLIPPAGE_BPS",
				display: "50 bps",
				describe: "integer in [0, 10000] bps",
				sideEffect: "applies to the next zap estimate",
			},
		]);
		expect(text).toContain("SLIPPAGE_BPS");
		expect(text).toContain("50 bps");
		expect(text).toContain("DRY_RUN");
		const hostile = formatConfigShow([
			{
				key: "<evil>",
				display: "<b>&",
				describe: "<script>",
				sideEffect: "&>",
			},
		]);
		expect(hostile).not.toContain("<evil>");
		expect(hostile).toContain("&lt;evil&gt;");
	});

	test("preview shows old->new with confirm hint", () => {
		const text = formatConfigPreview(
			"POOL_ADDRESS",
			"Ab12..KlMn",
			"Cd34..OpQr",
			"Cd34Ef56Gh78Ij90KlMnOpQrStUvWxYz123456789012",
		);
		expect(text).toContain("Ab12..KlMn");
		expect(text).toContain("Cd34..OpQr");
		expect(text).toContain("Cd34Ef56Gh78Ij90KlMnOpQrStUvWxYz123456789012");
		expect(text).toContain("confirm");
	});

	test("updated includes side effect and optional hint", () => {
		const text = formatConfigUpdated(
			"POOL_ADDRESS",
			"Ab12..KlMn",
			"Cd34..OpQr",
			"switches pool",
			"Send /status to verify",
		);
		expect(text).toContain("Config updated");
		expect(text).toContain("/status");
	});

	test("unknown key lists valid keys, bad value shows bounds", () => {
		const unknown = formatConfigUnknownKey("DRY_RUN", [
			{ key: "SLIPPAGE_BPS", describe: "integer in [0, 10000] bps" },
		]);
		expect(unknown).toContain("DRY_RUN");
		expect(unknown).toContain("SLIPPAGE_BPS");
		const bad = formatConfigBadValue(
			"SLIPPAGE_BPS",
			"99999",
			"integer in [0, 10000] bps",
		);
		expect(bad).toContain("99999");
		expect(bad).toContain("No state changed");
	});
});

describe("config UX wiring", () => {
	test("help, menu and slash commands stay in sync", async () => {
		const { TELEGRAM_HELP_TEXT } = await import("../src/telegram/commands.ts");
		expect(TELEGRAM_HELP_TEXT).toContain("/config");
		expect(TELEGRAM_HELP_TEXT).toContain("POOL_ADDRESS");
		expect(TELEGRAM_HELP_TEXT).toContain("/pause");
		expect(TELEGRAM_HELP_TEXT).toContain("/resume");
		expect(TELEGRAM_BOT_COMMANDS.map((c) => c.command)).toContain("config");
		expect(TELEGRAM_BOT_COMMANDS.map((c) => c.command)).toContain("pause");
		expect(TELEGRAM_BOT_COMMANDS.map((c) => c.command)).toContain("resume");
		expect(TELEGRAM_HELP_TEXT).toContain("/logs");
		expect(TELEGRAM_HELP_TEXT).toContain("/menu");
		expect(TELEGRAM_BOT_COMMANDS.map((c) => c.command)).toContain("menu");
	});
});

describe("inline main menu", () => {
	const allowed = "987654";
	const buttons = (keyboard: {
		inline_keyboard: ReadonlyArray<
			ReadonlyArray<{ text: string; callback_data: string }>
		>;
	}) => keyboard.inline_keyboard.map((row) => row.map((b) => b.text));

	test("compact 2x3 layout with one pause/resume toggle", () => {
		expect(buttons(mainMenuKeyboard(false))).toEqual([
			["📊 Status", "👁 Preview"],
			["📜 Logs", "⚙️ Config"],
			["⏸ Pause", "❓ Help"],
		]);
		expect(buttons(mainMenuKeyboard(true))[2]).toEqual(["▶️ Resume", "❓ Help"]);
	});

	test("every button parses back to its command", () => {
		const expected: Record<string, string> = {
			"📊 Status": "status",
			"👁 Preview": "rebalance",
			"📜 Logs": "logs",
			"⚙️ Config": "config_show",
			"⏸ Pause": "pause",
			"▶️ Resume": "resume",
			"❓ Help": "help",
		};
		for (const paused of [false, true]) {
			for (const button of mainMenuKeyboard(paused).inline_keyboard.flat()) {
				const parsed = parseBotCommand(
					makeCallback(601, 987654, button.callback_data),
					allowed,
				);
				expect(parsed?.kind).toBe(expected[button.text] as BotCommand["kind"]);
				if (parsed?.kind === "rebalance") {
					expect(parsed.confirmed).toBe(false);
				}
			}
		}
	});

	test("live preview stacks confirm above the menu, dry run is just the menu", () => {
		expect(previewKeyboard(true, false)).toEqual(mainMenuKeyboard(false));
		const live = previewKeyboard(false, false);
		expect(live.inline_keyboard[0]).toEqual([
			{ text: "✅ Confirm live", callback_data: "rebalance_confirm" },
		]);
		expect(live.inline_keyboard.slice(1)).toEqual(
			mainMenuKeyboard(false).inline_keyboard,
		);
		expect(
			parseBotCommand(makeCallback(602, 987654, "rebalance_confirm"), allowed),
		).toMatchObject({ kind: "rebalance", confirmed: true });
	});

	test("/menu, typed menu and callback parse to menu", () => {
		expect(parseBotCommand(makeUpdate(603, 987654, "/menu"), allowed)).toEqual({
			kind: "menu",
			chatId: allowed,
			updateId: 603,
		});
		expect(
			parseBotCommand(makeUpdate(604, 987654, "menu"), allowed)?.kind,
		).toBe("menu");
		expect(
			parseBotCommand(makeCallback(605, 987654, "menu"), allowed)?.kind,
		).toBe("menu");
	});

	test("stale reply-keyboard labels still parse", () => {
		for (const [label, kind] of [
			["📊 Status", "status"],
			["👁 Preview", "rebalance"],
			["✅ Confirm", "rebalance"],
			["❓ Help", "help"],
			["⏸ Pause", "pause"],
			["▶️ Resume", "resume"],
			["⚙️ Config", "config_show"],
		] as const) {
			expect(
				parseBotCommand(makeUpdate(606, 987654, label), allowed)?.kind,
			).toBe(kind);
		}
	});

	test("sendMessage carries the given markup and omits it when absent", async () => {
		const bodies: Record<string, unknown>[] = [];
		const capture: TelegramFetch = async (_url, init) => {
			bodies.push(JSON.parse(String((init as RequestInit)?.body ?? "")));
			return {
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ ok: true, result: true }),
			};
		};
		const telegram = { botToken: "token", chatId: "987654" };
		await Effect.runPromise(sendTelegramText("plain", telegram, capture));
		await Effect.runPromise(
			sendTelegramText("start", telegram, capture, {
				replyMarkup: REMOVE_REPLY_KEYBOARD,
			}),
		);
		expect("reply_markup" in (bodies[0] ?? {})).toBe(false);
		expect(bodies[1]?.reply_markup).toEqual({ remove_keyboard: true });
	});
});

describe("persistEnvKey atomic write (offline, temp files)", () => {
	test("replaces POOL_ADDRESS, preserves other lines incl. secrets", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dlmm-env-"));
		try {
			const envPath = join(dir, ".env");
			const poolA = Keypair.generate().publicKey.toBase58();
			const poolB = Keypair.generate().publicKey.toBase58();
			const secret = bs58.encode(Keypair.generate().secretKey);
			const original = `# comment\nRPC_URL=https://example.com\nPOOL_ADDRESS=${poolA}\nPRIVATE_KEY=${secret}\n`;
			await writeFile(envPath, original, "utf8");
			await Effect.runPromise(persistEnvKey("POOL_ADDRESS", poolB, envPath));
			const next = await readFile(envPath, "utf8");
			expect(next).toContain(`POOL_ADDRESS=${poolB}`);
			expect(next).not.toContain(poolA);
			expect(next).toContain(`PRIVATE_KEY=${secret}`);
			expect(next).toContain("# comment");
			expect(next).toContain("RPC_URL=https://example.com");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("appends when missing and creates when absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dlmm-env-"));
		try {
			const pool = Keypair.generate().publicKey.toBase58();
			const missing = join(dir, "sub", ".env");
			await Effect.runPromise(
				persistEnvKey("POOL_ADDRESS", pool, missing),
			).then(
				() => expect.unreachable(),
				(error) => expect(error).toBeInstanceOf(ConfigError),
			);
			const fresh = join(dir, ".env");
			await Effect.runPromise(persistEnvKey("POOL_ADDRESS", pool, fresh));
			expect(await readFile(fresh, "utf8")).toBe(`POOL_ADDRESS=${pool}\n`);
			await Effect.runPromise(persistEnvKey("POOL_ADDRESS", pool, fresh));
			expect(await readFile(fresh, "utf8")).toBe(`POOL_ADDRESS=${pool}\n`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("persists non-pool key (STRATEGY) via registry apply", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dlmm-env-"));
		try {
			const envPath = join(dir, ".env");
			await writeFile(envPath, "STRATEGY=Spot\n", "utf8");
			const config = await Effect.runPromise(
				loadConfig(makeEnv({ STRATEGY: "Spot" })),
			);
			const before = tunablesFromConfig(config);
			const after = await Effect.runPromise(
				EDITABLE_REGISTRY.STRATEGY.apply(before, "Curve"),
			);
			expect(after.strategy).toBe("Curve");
			const parsed = await Effect.runPromise(
				EDITABLE_REGISTRY.STRATEGY.parse("Curve"),
			);
			await Effect.runPromise(
				persistEnvKey("STRATEGY", String(parsed), envPath),
			);
			const next = await readFile(envPath, "utf8");
			expect(next).toContain("STRATEGY=Curve");
			expect(next).not.toContain("STRATEGY=Spot");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("RuntimeTunables layer initializes from loadConfig", async () => {
		const { makeAppLive } = await import("../src/services.ts");
		const pool = Keypair.generate().publicKey.toBase58();
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const ref = yield* RuntimeTunables;
					return yield* Ref.get(ref);
				}),
				makeAppLive(makeEnv({ POOL_ADDRESS: pool, SLIPPAGE_BPS: "200" })),
			),
		);
		expect(result.poolAddress).toBe(pool);
		expect(result.slippageBps).toBe(200);
	});
});

function makeCallback(
	updateId: number,
	chatId: number | string,
	data: unknown,
	callbackId = "cb1",
) {
	return {
		update_id: updateId,
		callback_query: {
			id: callbackId,
			data,
			message: {
				message_id: 1,
				chat: { id: chatId, type: "private" },
			},
		},
	};
}

describe("config menu callbacks", () => {
	const allowed = "987654";

	test("parses config/config_show to show", () => {
		for (const data of ["config", "config_show"]) {
			expect(parseBotCommand(makeCallback(301, 987654, data), allowed)).toEqual(
				{
					kind: "config_show",
					chatId: allowed,
					updateId: 301,
					callbackId: "cb1",
				},
			);
		}
		expect(parseConfigMenuAction("config")).toEqual({ kind: "config_show" });
		expect(parseConfigMenuAction("config_show")).toEqual({
			kind: "config_show",
		});
	});

	test("parses pick callbacks", () => {
		expect(
			parseBotCommand(
				makeCallback(302, 987654, "config_pick:STRATEGY"),
				allowed,
			),
		).toEqual({
			kind: "config_pick",
			chatId: allowed,
			updateId: 302,
			key: "STRATEGY",
			callbackId: "cb1",
		});
		expect(parseConfigMenuAction("config_pick:POOL_ADDRESS")).toEqual({
			kind: "config_pick",
			key: "POOL_ADDRESS",
		});
	});

	test("parses set callbacks", () => {
		expect(
			parseBotCommand(
				makeCallback(303, 987654, "config_set:SLIPPAGE_BPS:50"),
				allowed,
			),
		).toEqual({
			kind: "config_set",
			chatId: allowed,
			updateId: 303,
			key: "SLIPPAGE_BPS",
			value: "50",
			confirmed: false,
			callbackId: "cb1",
		});
		expect(parseConfigMenuAction("config_set:STRATEGY:Spot")).toEqual({
			kind: "config_set",
			key: "STRATEGY",
			value: "Spot",
			confirmed: false,
		});
	});

	test("parses set callbacks with confirm suffix", () => {
		const pool = Keypair.generate().publicKey.toBase58();
		expect(
			parseBotCommand(
				makeCallback(304, 987654, `config_set:POOL_ADDRESS:${pool}:confirm`),
				allowed,
			),
		).toEqual({
			kind: "config_set",
			chatId: allowed,
			updateId: 304,
			key: "POOL_ADDRESS",
			value: pool,
			confirmed: true,
			callbackId: "cb1",
		});
		expect(
			parseConfigMenuAction(`config_set:POOL_ADDRESS:${pool}:confirm`),
		).toEqual({
			kind: "config_set",
			key: "POOL_ADDRESS",
			value: pool,
			confirmed: true,
		});
		expect(parseConfigMenuAction("config_set:STRATEGY:Spot:confirm")).toEqual({
			kind: "config_set",
			key: "STRATEGY",
			value: "Spot",
			confirmed: true,
		});
	});

	test("rejects wrong chatId for menu callbacks", () => {
		expect(
			parseBotCommand(makeCallback(305, 111111, "config_show"), allowed),
		).toBeNull();
		expect(
			parseBotCommand(
				makeCallback(306, 111111, "config_pick:STRATEGY"),
				allowed,
			),
		).toBeNull();
		expect(
			parseBotCommand(
				makeCallback(307, 111111, "config_set:SLIPPAGE_BPS:50"),
				allowed,
			),
		).toBeNull();
	});

	test("unknown key maps to unknown without state change", () => {
		for (const data of [
			"config_pick:FROBNICATE",
			"config_set:FROBNICATE:50",
			"config_pick:DRY_RUN",
			"config_set:RPC_URL:https://example.com",
		]) {
			const parsed = parseBotCommand(makeCallback(308, 987654, data), allowed);
			expect(parsed?.kind).toBe("unknown");
			expect(parseConfigMenuAction(data)).toBeNull();
		}
	});

	test("malformed shapes map to unknown", () => {
		for (const data of [
			"config_pick:",
			"config_pick:STRATEGY:extra",
			"config_set:SLIPPAGE_BPS:",
			"config_set:SLIPPAGE_BPS:50:maybe",
			"config_set:SLIPPAGE_BPS:50:confirm:extra",
			"config_set:SLIPPAGE_BPS:with space",
			"config_frobnicate",
		]) {
			const parsed = parseBotCommand(makeCallback(309, 987654, data), allowed);
			expect(parsed?.kind).toBe("unknown");
			expect(parseConfigMenuAction(data)).toBeNull();
		}
	});
});

describe("config menu keyboards", () => {
	test("menu keyboard covers every editable key with pick callbacks", () => {
		const keyboard = configMenuKeyboard(EDITABLE_KEYS);
		expect(keyboard.inline_keyboard.length).toBe(EDITABLE_KEYS.length);
		const seen = new Set<string>();
		for (const row of keyboard.inline_keyboard) {
			expect(row.length).toBe(1);
			const button = row[0];
			expect(button).toBeDefined();
			if (!button) {
				continue;
			}
			seen.add(button.text);
			const action = parseConfigMenuAction(button.callback_data);
			expect(action?.kind).toBe("config_pick");
			if (action?.kind === "config_pick") {
				expect(button.callback_data).toBe(`config_pick:${action.key}`);
				expect(EDITABLE_KEYS).toContain(action.key);
			}
		}
		expect([...seen].sort()).toEqual([...EDITABLE_KEYS].sort());
	});

	test("value keyboards match registry presets plus back, round-trip to set", () => {
		for (const key of EDITABLE_KEYS) {
			const presets = EDITABLE_REGISTRY[key].presets;
			const keyboard = configValueKeyboard(key, presets);
			expect(keyboard.inline_keyboard.length).toBe(presets.length + 1);
			const presetRows = keyboard.inline_keyboard.slice(0, presets.length);
			presetRows.forEach((row, index) => {
				const button = row[0];
				expect(button).toBeDefined();
				if (!button) {
					return;
				}
				const expected = presets[index] ?? "";
				expect(button.text).toBe(expected);
				expect(button.callback_data).toBe(`config_set:${key}:${expected}`);
				expect(parseConfigMenuAction(button.callback_data)).toEqual({
					kind: "config_set",
					key,
					value: expected,
					confirmed: false,
				});
			});
			const back = keyboard.inline_keyboard[presets.length]?.[0];
			expect(back?.callback_data).toBe("config_show");
			expect(parseConfigMenuAction(back?.callback_data ?? "")).toEqual({
				kind: "config_show",
			});
		}
	});

	test("registry holds the exact preset lists, POOL_ADDRESS back-only", () => {
		expect([...EDITABLE_REGISTRY.STRATEGY.presets]).toEqual([
			"Spot",
			"Curve",
			"BidAsk",
		]);
		expect([...EDITABLE_REGISTRY.COMPOUND_FEES.presets]).toEqual([
			"true",
			"false",
		]);
		expect([...EDITABLE_REGISTRY.PRIORITY_LEVEL.presets]).toEqual([
			"Auto",
			"Min",
			"Low",
			"Medium",
			"High",
			"VeryHigh",
			"UnsafeMax",
		]);
		expect([...EDITABLE_REGISTRY.SLIPPAGE_BPS.presets]).toEqual([
			"10",
			"25",
			"50",
			"100",
		]);
		expect([...EDITABLE_REGISTRY.POLL_INTERVAL_MS.presets]).toEqual([
			"15000",
			"30000",
			"60000",
			"300000",
		]);
		expect([...EDITABLE_REGISTRY.TELEGRAM_POLL_INTERVAL_MS.presets]).toEqual([
			"2000",
			"3000",
			"5000",
		]);
		expect([...EDITABLE_REGISTRY.POOL_ADDRESS.presets]).toEqual([]);
		const poolKeyboard = configValueKeyboard(
			"POOL_ADDRESS",
			EDITABLE_REGISTRY.POOL_ADDRESS.presets,
		);
		expect(poolKeyboard.inline_keyboard.length).toBe(1);
		expect(poolKeyboard.inline_keyboard[0]?.[0]?.callback_data).toBe(
			"config_show",
		);
		for (const row of poolKeyboard.inline_keyboard) {
			for (const button of row) {
				expect(button.callback_data).not.toContain("config_set");
			}
		}
	});

	test("every preset is URL-safe and passes its registry validator", async () => {
		for (const key of EDITABLE_KEYS) {
			for (const preset of EDITABLE_REGISTRY[key].presets) {
				expect(preset).not.toContain(" ");
				expect(preset).not.toContain(":");
				await Effect.runPromise(EDITABLE_REGISTRY[key].parse(preset));
			}
		}
	});
});

describe("config menu safety", () => {
	test("bad callback value parses but fails validation without state change", async () => {
		const parsed = parseBotCommand(
			makeCallback(310, 987654, "config_set:SLIPPAGE_BPS:99999"),
			"987654",
		);
		expect(parsed).toMatchObject({
			kind: "config_set",
			key: "SLIPPAGE_BPS",
			value: "99999",
		});
		const error = await Effect.runPromise(
			Effect.flip(EDITABLE_REGISTRY.SLIPPAGE_BPS.parse("99999")),
		);
		expect(error).toBeInstanceOf(ConfigError);
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		const before = tunablesFromConfig(config);
		const ref = await Effect.runPromise(Ref.make(before));
		await Effect.runPromise(
			EDITABLE_REGISTRY.SLIPPAGE_BPS.apply(
				await Effect.runPromise(Ref.get(ref)),
				"99999",
			),
		).then(
			() => expect.unreachable(),
			(applyError) => expect(applyError).toBeInstanceOf(ConfigError),
		);
		expect((await Effect.runPromise(Ref.get(ref))).slippageBps).toBe(
			before.slippageBps,
		);
	});

	test("POOL_ADDRESS pick never applies, replies with type-in instructions", () => {
		const picked = parseBotCommand(
			makeCallback(311, 987654, "config_pick:POOL_ADDRESS"),
			"987654",
		);
		expect(picked?.kind).toBe("config_pick");
		expect(picked).not.toMatchObject({ kind: "config_set" });
		const entry = EDITABLE_REGISTRY.POOL_ADDRESS;
		expect(entry.presets.length).toBe(0);
		expect(entry.customHint).toContain("/config set POOL_ADDRESS");
		const text = formatConfigPick({
			key: "POOL_ADDRESS",
			display: "Ab12..KlMn",
			describe: entry.describe(),
			sideEffect: entry.sideEffect,
			customHint: entry.customHint,
		});
		expect(text).toContain("/config set POOL_ADDRESS");
		expect(text).toContain("confirm");
		expect(text).not.toContain("PRIVATE_KEY");
	});

	test("startup-only keys stay absent from registry and menus", () => {
		const keyboard = configMenuKeyboard(EDITABLE_KEYS);
		const callbacks = keyboard.inline_keyboard
			.flat()
			.map((button) => button.callback_data);
		for (const key of [
			"DRY_RUN",
			"RPC_URL",
			"PRIVATE_KEY",
			"TELEGRAM_BOT_TOKEN",
			"TELEGRAM_CHAT_ID",
			"JUPITER_API_KEY",
		]) {
			expect(isEditableKey(key)).toBe(false);
			for (const callback of callbacks) {
				expect(callback).not.toContain(key);
			}
		}
	});
});

describe("config menu help sync", () => {
	test("show mentions tap plus free-type fallback, pick keeps the hint", async () => {
		const { TELEGRAM_HELP_TEXT } = await import("../src/telegram/commands.ts");
		expect(TELEGRAM_HELP_TEXT).toContain("/config");
		expect(TELEGRAM_HELP_TEXT).toContain("POOL_ADDRESS");
		expect(TELEGRAM_BOT_COMMANDS.map((c) => c.command)).toContain("config");
		const labels = mainMenuKeyboard(false)
			.inline_keyboard.flat()
			.map((b) => b.text);
		expect(labels).toContain("⚙️ Config");
		const text = formatConfigShow([
			{
				key: "SLIPPAGE_BPS",
				display: "50 bps",
				describe: "integer in [0, 10000] bps",
				sideEffect: "applies to the next zap estimate",
			},
		]);
		expect(text).toContain("Tap a key below");
		expect(text).toContain("/config set KEY VALUE");
		const pick = formatConfigPick({
			key: "SLIPPAGE_BPS",
			display: "50 bps",
			describe: "integer in [0, 10000] bps",
			sideEffect: "applies to the next zap estimate",
			customHint: EDITABLE_REGISTRY.SLIPPAGE_BPS.customHint,
		});
		expect(pick).toContain("/config set SLIPPAGE_BPS VALUE");
		expect(pick).toContain("Custom:");
		const hostile = formatConfigPick({
			key: "SLIPPAGE_BPS",
			display: "<b>&",
			describe: "<script>",
			sideEffect: "&>",
			customHint: "<evil>",
		});
		expect(hostile).not.toContain("<evil>");
		expect(hostile).toContain("&lt;evil&gt;");
	});
});

describe("pause and resume commands", () => {
	const allowed = "987654";

	test("parses /pause and /stop as pause", () => {
		expect(parseBotCommand(makeUpdate(401, 987654, "/pause"), allowed)).toEqual(
			{
				kind: "pause",
				chatId: allowed,
				updateId: 401,
			},
		);
		expect(parseBotCommand(makeUpdate(402, 987654, "/stop"), allowed)).toEqual({
			kind: "pause",
			chatId: allowed,
			updateId: 402,
		});
		expect(
			parseBotCommand(makeUpdate(403, 987654, "/pause@MyBot"), allowed)?.kind,
		).toBe("pause");
	});

	test("parses /resume and /start as resume", () => {
		expect(
			parseBotCommand(makeUpdate(404, 987654, "/resume"), allowed),
		).toEqual({
			kind: "resume",
			chatId: allowed,
			updateId: 404,
		});
		expect(parseBotCommand(makeUpdate(405, 987654, "/start"), allowed)).toEqual(
			{
				kind: "resume",
				chatId: allowed,
				updateId: 405,
			},
		);
		expect(
			parseBotCommand(makeUpdate(406, 987654, "/start@MyBot"), allowed)?.kind,
		).toBe("resume");
	});

	test("menu labels and callbacks round-trip to pause and resume", () => {
		expect(
			parseBotCommand(makeUpdate(407, 987654, "⏸ Pause"), allowed)?.kind,
		).toBe("pause");
		expect(
			parseBotCommand(makeUpdate(408, 987654, "▶️ Resume"), allowed)?.kind,
		).toBe("resume");
		expect(
			parseBotCommand(makeUpdate(409, 987654, "stop"), allowed)?.kind,
		).toBe("pause");
		expect(
			parseBotCommand(makeUpdate(410, 987654, "start"), allowed)?.kind,
		).toBe("resume");
		expect(
			parseBotCommand(makeCallback(411, 987654, "pause"), allowed),
		).toMatchObject({ kind: "pause" });
		expect(
			parseBotCommand(makeCallback(412, 987654, "resume"), allowed),
		).toMatchObject({ kind: "resume" });
		expect(
			parseBotCommand(makeCallback(413, 987654, "stop"), allowed),
		).toMatchObject({ kind: "pause" });
		expect(
			parseBotCommand(makeCallback(414, 987654, "start"), allowed),
		).toMatchObject({ kind: "resume" });
	});

	test("pause state toggles in memory only", () => {
		setBotPaused(false);
		expect(isBotPaused()).toBe(false);
		setBotPaused(true);
		expect(isBotPaused()).toBe(true);
		setBotPaused(false);
		expect(isBotPaused()).toBe(false);
	});

	test("pause and resume replies mention the opposite command", () => {
		expect(formatPausedReply(false)).toContain("/resume");
		expect(formatPausedReply(true)).toContain("Already paused");
		expect(formatResumedReply(false)).toContain("/pause");
		expect(formatResumedReply(true)).toContain("Already running");
		expect(formatPausedSkip()).toContain("/resume");
	});
});

describe("logs command", () => {
	const allowed = "987654";

	test("slash, label and callback all parse to logs", () => {
		expect(parseBotCommand(makeUpdate(501, 987654, "/logs"), allowed)).toEqual({
			kind: "logs",
			chatId: allowed,
			updateId: 501,
		});
		expect(
			parseBotCommand(makeUpdate(502, 987654, "📜 Logs"), allowed)?.kind,
		).toBe("logs");
		expect(
			parseBotCommand(makeCallback(503, 987654, "logs"), allowed),
		).toMatchObject({ kind: "logs", callbackId: "cb1" });
		expect(TELEGRAM_BOT_COMMANDS).toContainEqual({
			command: "logs",
			description: "show recent bot activity",
		});
	});

	test("prototype keys in chat text are not commands", () => {
		expect(
			parseBotCommand(makeUpdate(504, 987654, "constructor"), allowed),
		).toBeNull();
		expect(
			parseBotCommand(makeCallback(505, 987654, "constructor"), allowed)?.kind,
		).toBe("unknown");
	});
});
