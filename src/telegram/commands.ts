import { Data, Effect } from "effect";
import type { TelegramConfig } from "../config.ts";
import { nowStamp } from "../utils.ts";
import type { TelegramFetch } from "./notify.ts";
import { TelegramError } from "./notify.ts";

export class TelegramPollError extends Data.TaggedError("TelegramPollError")<{
	message: string;
}> {}

// Commands parsed once at the boundary from raw getUpdates payloads.
// `unknown` carries the raw text for the help hint reply.
export type BotCommand =
	| { kind: "status"; chatId: string; updateId: number }
	| { kind: "help"; chatId: string; updateId: number }
	| { kind: "rebalance"; chatId: string; updateId: number; confirmed: boolean }
	| { kind: "unknown"; chatId: string; updateId: number; text: string };

export const TELEGRAM_HELP_TEXT =
	"DLMM bot commands:\n/status - show position snapshot (read-only)\n/help - show this help\n/rebalance - preview rebalance (no transactions)\n/rebalance confirm - execute live (only when DRY_RUN=false, otherwise still preview only)";

// Parse one raw update. Returns null for anything to ignore: malformed
// payloads, non-message updates, non-command text, and any chat id that does
// not equal the allowlisted chatId.
export function parseBotCommand(
	rawUpdate: unknown,
	allowedChatId: string,
): BotCommand | null {
	if (typeof rawUpdate !== "object" || rawUpdate === null) {
		return null;
	}
	const record = rawUpdate as Record<string, unknown>;
	const updateId = record.update_id;
	if (!Number.isInteger(updateId)) {
		return null;
	}
	const message = record.message;
	if (typeof message !== "object" || message === null) {
		return null;
	}
	const msg = message as Record<string, unknown>;
	const chat = msg.chat;
	if (typeof chat !== "object" || chat === null) {
		return null;
	}
	const chatId = (chat as Record<string, unknown>).id;
	if (typeof chatId !== "number" && typeof chatId !== "string") {
		return null;
	}
	if (String(chatId) !== allowedChatId) {
		return null;
	}
	const textRaw = msg.text;
	if (typeof textRaw !== "string") {
		return null;
	}
	const text = textRaw.trim();
	if (text === "") {
		return null;
	}
	const parts = text.split(/\s+/);
	const first = parts[0] ?? "";
	const base = (first.split("@")[0] ?? "").toLowerCase();
	const id = updateId as number;
	if (base === "/status") {
		return { kind: "status", chatId: allowedChatId, updateId: id };
	}
	if (base === "/help") {
		return { kind: "help", chatId: allowedChatId, updateId: id };
	}
	if (base === "/rebalance") {
		const confirmed = (parts[1] ?? "").toLowerCase() === "confirm";
		return {
			kind: "rebalance",
			chatId: allowedChatId,
			updateId: id,
			confirmed,
		};
	}
	if (base.startsWith("/")) {
		return { kind: "unknown", chatId: allowedChatId, updateId: id, text };
	}
	return null;
}

// Next getUpdates offset from raw updates. Advances past ignored updates too
// so a rejected chat id cannot pin the poller on the same payload forever.
export function nextUpdatesOffset(
	updates: unknown[],
	current: number | undefined,
): number | undefined {
	let max: number | undefined;
	for (const update of updates) {
		if (typeof update !== "object" || update === null) {
			continue;
		}
		const id = (update as Record<string, unknown>).update_id;
		if (!Number.isInteger(id)) {
			continue;
		}
		const numeric = id as number;
		if (max === undefined || numeric > max) {
			max = numeric;
		}
	}
	if (max === undefined) {
		return current;
	}
	const next = max + 1;
	if (current === undefined || next > current) {
		return next;
	}
	return current;
}

// Pending live-confirm handoff. The fast command loop queues confirmed-live
// /rebalance here without touching RPC; the main loop consumes and executes
// so two live executes can never overlap. Single slot: a second confirm
// overwrites the first. Pure in-memory, never touches the network.
let pendingLiveConfirm: Extract<BotCommand, { kind: "rebalance" }> | undefined;

// True only for the live path: a confirmed /rebalance that may actually send.
// DRY_RUN=true confirms stay preview-only and run immediately in the fast loop.
export function shouldDeferLiveConfirm(
	command: BotCommand,
	dryRun: boolean,
): boolean {
	return command.kind === "rebalance" && command.confirmed && !dryRun;
}

export function queuePendingLiveConfirm(
	command: Extract<BotCommand, { kind: "rebalance" }>,
): void {
	if (!command.confirmed) {
		return;
	}
	pendingLiveConfirm = command;
}

export function takePendingLiveConfirm():
	| Extract<BotCommand, { kind: "rebalance" }>
	| undefined {
	const pending = pendingLiveConfirm;
	pendingLiveConfirm = undefined;
	return pending;
}

export function hasPendingLiveConfirm(): boolean {
	return pendingLiveConfirm !== undefined;
}

export function clearPendingLiveConfirm(): void {
	pendingLiveConfirm = undefined;
}

function toPollError(error: unknown): TelegramError | TelegramPollError {
	if (error instanceof TelegramError || error instanceof TelegramPollError) {
		return error;
	}
	return new TelegramPollError({
		message: error instanceof Error ? error.message : String(error),
	});
}

// Single short-poll of getUpdates. Called from the fast command loop on its
// own TELEGRAM_POLL_INTERVAL_MS timer, not from the main iteration.
// Never logs the bot token or the request URL.
export function fetchTelegramUpdates(
	telegram: TelegramConfig,
	offset: number | undefined,
	fetchImpl: TelegramFetch = globalThis.fetch as TelegramFetch,
): Effect.Effect<unknown[], TelegramError | TelegramPollError> {
	return Effect.tryPromise({
		try: async () => {
			const params = new URLSearchParams({
				timeout: "0",
				allowed_updates: JSON.stringify(["message"]),
			});
			if (offset !== undefined) {
				params.set("offset", String(offset));
			}
			const url = `https://api.telegram.org/bot${telegram.botToken}/getUpdates?${params.toString()}`;
			const response = await fetchImpl(url, { method: "GET" });
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`telegram getUpdates failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`,
				);
			}
			const payload = (await response.json().catch(() => null)) as {
				ok?: boolean;
				result?: unknown;
				description?: string;
			} | null;
			if (payload?.ok !== true || !Array.isArray(payload?.result)) {
				throw new Error(
					`telegram getUpdates failed: ${payload?.description ?? "bad response"}`,
				);
			}
			return payload.result as unknown[];
		},
		catch: toPollError,
	});
}

export function warnTelegramCommandFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.warn(`[${nowStamp()}] Telegram command failed: ${message}`);
}
