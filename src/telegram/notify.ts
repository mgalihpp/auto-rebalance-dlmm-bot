import { Data, Effect } from "effect";
import type { TelegramConfig } from "../config.ts";
import type { PositionSnapshot } from "../rebalance/types.ts";
import {
	formatBinRange,
	formatTokenAmount,
	meteoraPoolUrl,
	nowStamp,
	rangeDirection,
	renderRangeBar,
	shortAddr,
	solscanAccountUrl,
	solscanTxUrl,
} from "../utils.ts";

export class TelegramError extends Data.TaggedError("TelegramError")<{
	message: string;
}> {}

// Outgoing bot events. inRange is intentionally absent: the poll loop stays
// quiet when the position is healthy to avoid spamming the owner.
export type TelegramEvent =
	| {
			kind: "startup";
			pool: string;
			dryRun: boolean;
	  }
	| { kind: "shutdown" }
	| {
			kind: "rebalanceNeeded";
			pool: string;
			position: string;
			activeBinId: number;
			lowerBinId: number;
			upperBinId: number;
			newLowerBinId: number;
			newUpperBinId: number;
			amountXDisplay: string;
			amountYDisplay: string;
			slippageBps: number;
			dryRun: boolean;
			swapsDisplay?: string;
	  }
	| { kind: "rebalanced"; pool: string; position: string; signature: string }
	| { kind: "failed"; message: string };

// Persistent reply keyboard so the owner taps buttons instead of typing slash
// commands. Labels are parsed back in commands.ts, so keep both in sync.
export const TELEGRAM_MAIN_MENU = {
	keyboard: [
		[{ text: "📊 Status" }, { text: "👁 Preview" }],
		[{ text: "✅ Confirm" }, { text: "❓ Help" }],
	],
	resize_keyboard: true,
	is_persistent: true,
} as const;

export const TELEGRAM_BOT_COMMANDS = [
	{ command: "status", description: "show position snapshot (read-only)" },
	{ command: "help", description: "show help" },
	{ command: "rebalance", description: "preview rebalance (no transactions)" },
] as const;

// Inline confirm button attached to live-mode previews. Tapping it emits a
// callback_query with data "rebalance_confirm", parsed as a confirmed rebalance.
export function confirmInlineKeyboard(dryRun: boolean) {
	if (dryRun) {
		return undefined;
	}
	return {
		inline_keyboard: [
			[{ text: "✅ Confirm live", callback_data: "rebalance_confirm" }],
		],
	} as const;
}
// Escape dynamic text for Telegram HTML parse_mode.
// ">" is escaped too so arrows like "->" never read as markup.
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Single formatter table over the union. Add new event kinds here, not with
// scattered conditionals at the call sites.
export function directionLine(
	active: number,
	lower: number,
	upper: number,
): string {
	const direction = rangeDirection(active, lower, upper);
	if (direction === "above") {
		return `Active ${active} is ABOVE range by ${active - upper} bins`;
	}
	if (direction === "below") {
		return `Active ${active} is BELOW range by ${lower - active} bins`;
	}
	return `Active ${active} is inside range`;
}

export interface PreviewReplyInput {
	pool: string;
	position: string;
	activeBinId: number;
	lowerBinId: number;
	upperBinId: number;
	newLowerBinId: number;
	newUpperBinId: number;
	amountXDisplay: string;
	amountYDisplay: string;
	slippageBps: number;
	dryRun: boolean;
	swapsDisplay?: string;
	header?: string;
}

export function formatPreviewReply(input: PreviewReplyInput): string {
	const header = input.header ?? "⚠️ <b>Rebalance needed</b>";
	const bar = renderRangeBar(
		input.lowerBinId,
		input.upperBinId,
		input.newLowerBinId,
		input.newUpperBinId,
		input.activeBinId,
	);
	const swaps = input.swapsDisplay
		? `\nSwaps: <code>${escapeHtml(input.swapsDisplay)}</code>`
		: "";
	const mode = input.dryRun
		? "Dry run — no transactions sent."
		: "<b>LIVE</b> — executing.";
	return (
		`${header}\n${escapeHtml(directionLine(input.activeBinId, input.lowerBinId, input.upperBinId))}\n` +
		`<pre>${escapeHtml(bar)}</pre>\n` +
		`<i>= old range · + new range · ^ active</i>\n` +
		`Range: <code>${escapeHtml(formatBinRange(input.lowerBinId, input.upperBinId))}</code> → <code>${escapeHtml(formatBinRange(input.newLowerBinId, input.newUpperBinId))}</code>\n` +
		`Balances: <code>${escapeHtml(input.amountXDisplay)}</code> | <code>${escapeHtml(input.amountYDisplay)}</code>\n` +
		`Slippage: <code>${input.slippageBps} bps</code>${swaps}\n` +
		`Pool: <a href="${escapeHtml(meteoraPoolUrl(input.pool))}"><code>${escapeHtml(shortAddr(input.pool))}</code></a> ` +
		`Position: <a href="${escapeHtml(solscanAccountUrl(input.position))}"><code>${escapeHtml(shortAddr(input.position))}</code></a>\n` +
		mode
	);
}

export function formatStatusReply(snapshot: PositionSnapshot): string {
	const bar = renderRangeBar(
		snapshot.lowerBinId,
		snapshot.upperBinId,
		snapshot.lowerBinId,
		snapshot.upperBinId,
		snapshot.activeBinId,
	);
	const pair = `${snapshot.tokenXSymbol}/${snapshot.tokenYSymbol}`;
	return (
		`📊 <b>Position snapshot</b> <code>${escapeHtml(pair)}</code>\n` +
		`${escapeHtml(directionLine(snapshot.activeBinId, snapshot.lowerBinId, snapshot.upperBinId))}\n` +
		`<pre>${escapeHtml(bar)}</pre>\n` +
		`<i>* range · ^ active</i>\n` +
		`Range: <code>${escapeHtml(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}</code>\n` +
		`Balances: <code>${escapeHtml(formatTokenAmount(snapshot.amountX, snapshot.tokenXDecimals, snapshot.tokenXSymbol))}</code> | ` +
		`<code>${escapeHtml(formatTokenAmount(snapshot.amountY, snapshot.tokenYDecimals, snapshot.tokenYSymbol))}</code>\n` +
		`Pool: <a href="${escapeHtml(meteoraPoolUrl(snapshot.pool))}"><code>${escapeHtml(shortAddr(snapshot.pool))}</code></a> ` +
		`Position: <a href="${escapeHtml(solscanAccountUrl(snapshot.position))}"><code>${escapeHtml(shortAddr(snapshot.position))}</code></a>`
	);
}

export function formatInRangeReply(snapshot: PositionSnapshot): string {
	return `✅ <b>In range</b> — no rebalance needed.\n${escapeHtml(directionLine(snapshot.activeBinId, snapshot.lowerBinId, snapshot.upperBinId))} within <code>${escapeHtml(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}</code>`;
}

const telegramFormatters: {
	[K in TelegramEvent["kind"]]: (
		event: Extract<TelegramEvent, { kind: K }>,
	) => string;
} = {
	startup: (event) => {
		return `<b>🤖 DLMM bot started</b>\nPool: <a href="${escapeHtml(meteoraPoolUrl(event.pool))}"><code>${escapeHtml(shortAddr(event.pool))}</code></a>\nMode: ${event.dryRun ? "dry run (preview only)" : "<b>LIVE</b> (will send transactions)"}`;
	},
	shutdown: () => "🛑 <b>DLMM bot stopped.</b>",
	rebalanceNeeded: (event) =>
		formatPreviewReply({
			pool: event.pool,
			position: event.position,
			activeBinId: event.activeBinId,
			lowerBinId: event.lowerBinId,
			upperBinId: event.upperBinId,
			newLowerBinId: event.newLowerBinId,
			newUpperBinId: event.newUpperBinId,
			amountXDisplay: event.amountXDisplay,
			amountYDisplay: event.amountYDisplay,
			slippageBps: event.slippageBps,
			dryRun: event.dryRun,
			swapsDisplay: event.swapsDisplay,
		}),
	rebalanced: (event) =>
		`✅ <b>Rebalanced</b>\nTx: <a href="${escapeHtml(solscanTxUrl(event.signature))}"><code>${escapeHtml(shortAddr(event.signature))}</code></a>\nPool: <a href="${escapeHtml(meteoraPoolUrl(event.pool))}"><code>${escapeHtml(shortAddr(event.pool))}</code></a> <a href="${escapeHtml(meteoraPoolUrl(event.pool))}">Meteora</a> | <a href="${escapeHtml(solscanTxUrl(event.signature))}">Solscan</a>\nPosition: <a href="${escapeHtml(solscanAccountUrl(event.position))}"><code>${escapeHtml(shortAddr(event.position))}</code></a>`,
	failed: (event) =>
		`❌ <b>Rebalance failed</b>\n<code>${escapeHtml(event.message.slice(0, 1000))}</code>`,
};

export function formatTelegramMessage(event: TelegramEvent): string {
	const format = telegramFormatters[event.kind] as (
		event: TelegramEvent,
	) => string;
	return format(event);
}

// Minimal structural subset of fetch Response so tests can inject a fake
// without touching the network. Compatible with globalThis.fetch.
export interface TelegramHttpResponse {
	readonly ok: boolean;
	readonly status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

export type TelegramFetch = (
	url: string,
	init?: RequestInit,
) => Promise<TelegramHttpResponse>;

function toTelegramError(error: unknown): TelegramError {
	if (error instanceof TelegramError) {
		return error;
	}
	return new TelegramError({
		message: error instanceof Error ? error.message : String(error),
	});
}

// Thin shell over raw fetch. Never logs the bot token or the request URL.
export interface SendTelegramOptions {
	replyMarkup?: unknown;
}
export function sendTelegramText(
	text: string,
	telegram: TelegramConfig,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
	options: SendTelegramOptions = {},
): Effect.Effect<void, TelegramError> {
	return Effect.tryPromise({
		try: async () => {
			const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
			const response = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					chat_id: telegram.chatId,
					text,
					parse_mode: "HTML",
					reply_markup: options.replyMarkup ?? TELEGRAM_MAIN_MENU,
				}),
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`telegram send failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
				);
			}
			const payload = (await response.json().catch(() => null)) as {
				ok?: boolean;
				description?: string;
			} | null;
			if (payload?.ok !== true) {
				throw new Error(
					`telegram send failed: ${payload?.description ?? "bad response"}`,
				);
			}
		},
		catch: toTelegramError,
	});
}

export function sendTelegramEvent(
	event: TelegramEvent,
	telegram: TelegramConfig,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
): Effect.Effect<void, TelegramError> {
	return sendTelegramText(formatTelegramMessage(event), telegram, fetchImpl);
}

// Never-failing wrapper for the poll loop. A Telegram outage must never fail
// an iteration, so failures become a console warning (without the token).
export function notifyTelegramEvent(
	event: TelegramEvent,
	telegram: TelegramConfig | undefined,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
): Effect.Effect<void, never> {
	if (!telegram) {
		return Effect.void;
	}
	return Effect.catch(sendTelegramEvent(event, telegram, fetchImpl), (error) =>
		Effect.sync(() => {
			console.warn(`[${nowStamp()}] Telegram send failed: ${error.message}`);
		}),
	);
}

export function notifyTelegramText(
	text: string,
	telegram: TelegramConfig | undefined,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
	options: SendTelegramOptions = {},
): Effect.Effect<void, never> {
	if (!telegram) {
		return Effect.void;
	}
	return Effect.catch(
		sendTelegramText(text, telegram, fetchImpl, options),
		(error) =>
			Effect.sync(() => {
				console.warn(`[${nowStamp()}] Telegram send failed: ${error.message}`);
			}),
	);
}

// Registers the slash-command menu (the "/" button) as a best-effort setup
// step. Failures never throw; the caller logs a warning.
export function setTelegramMenuCommands(
	telegram: TelegramConfig,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
): Effect.Effect<void, TelegramError> {
	return Effect.tryPromise({
		try: async () => {
			const url = `https://api.telegram.org/bot${telegram.botToken}/setMyCommands`;
			const response = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ commands: TELEGRAM_BOT_COMMANDS }),
			});
			if (!response.ok) {
				throw new Error(
					`telegram setMyCommands failed: HTTP ${response.status}`,
				);
			}
		},
		catch: toTelegramError,
	});
}

// Dismisses the inline-button loading spinner. Best-effort, never throws.
export function answerTelegramCallback(
	callbackId: string,
	telegram: TelegramConfig,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
): Effect.Effect<void, TelegramError> {
	return Effect.tryPromise({
		try: async () => {
			const url = `https://api.telegram.org/bot${telegram.botToken}/answerCallbackQuery`;
			await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ callback_query_id: callbackId }),
			});
		},
		catch: toTelegramError,
	});
}
