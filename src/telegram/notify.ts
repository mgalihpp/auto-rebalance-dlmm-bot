import { Data, Effect } from "effect";
import type { TelegramConfig } from "../config.ts";
import { formatBinRange, nowStamp, solscanTxUrl } from "../utils.ts";

export class TelegramError extends Data.TaggedError("TelegramError")<{
	message: string;
}> {}

// Outgoing bot events. inRange is intentionally absent: the poll loop stays
// quiet when the position is healthy to avoid spamming the owner.
export type TelegramEvent =
	| { kind: "startup"; pool: string; dryRun: boolean }
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
			amountX: string;
			amountY: string;
			slippageBps: number;
			dryRun: boolean;
	  }
	| { kind: "rebalanced"; pool: string; position: string; signature: string }
	| { kind: "failed"; message: string };

// Escape dynamic text for Telegram HTML parse_mode. Only &<> need it;
// ">" is escaped too so arrows like "->" never read as markup.
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

// Single formatter table over the union. Add new event kinds here, not with
// scattered conditionals at the call sites.
const telegramFormatters: {
	[K in TelegramEvent["kind"]]: (
		event: Extract<TelegramEvent, { kind: K }>,
	) => string;
} = {
	startup: (event) =>
		`<b>DLMM bot started</b>\nPool: <code>${escapeHtml(event.pool)}</code>\nMode: ${event.dryRun ? "dry run (preview only)" : "<b>LIVE</b> (will send transactions)"}`,
	shutdown: () => "<b>DLMM bot stopped.</b>",
	rebalanceNeeded: (event) =>
		`<b>Rebalance needed</b>\nPool: <code>${escapeHtml(event.pool)}</code>\nPosition: <code>${escapeHtml(event.position)}</code>\nActive: <code>${event.activeBinId}</code>\nRange: <code>${escapeHtml(formatBinRange(event.lowerBinId, event.upperBinId))}</code> → <code>${escapeHtml(formatBinRange(event.newLowerBinId, event.newUpperBinId))}</code>\nBalances: X=<code>${escapeHtml(event.amountX)}</code> Y=<code>${escapeHtml(event.amountY)}</code>\nSlippage: <code>${event.slippageBps} bps</code>\n${event.dryRun ? "Dry run — no transactions sent." : "<b>LIVE</b> — executing."}`,
	rebalanced: (event) =>
		`<b>Rebalanced</b>\nPool: <code>${escapeHtml(event.pool)}</code>\nPosition: <code>${escapeHtml(event.position)}</code>\nTx: <a href="${solscanTxUrl(event.signature)}"><code>${escapeHtml(event.signature)}</code></a>`,
	failed: (event) =>
		`<b>Rebalance failed</b>\n<code>${escapeHtml(event.message.slice(0, 1000))}</code>`,
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
export function sendTelegramText(
	text: string,
	telegram: TelegramConfig,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
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
): Effect.Effect<void, never> {
	if (!telegram) {
		return Effect.void;
	}
	return Effect.catch(sendTelegramText(text, telegram, fetchImpl), (error) =>
		Effect.sync(() => {
			console.warn(`[${nowStamp()}] Telegram send failed: ${error.message}`);
		}),
	);
}
