import { Data, Effect } from "effect";
import type { TelegramConfig } from "../config.ts";
import {
	type ConfigError,
	parseCompoundFeesValue,
	parsePollIntervalValue,
	parsePoolAddressValue,
	parsePriorityLevelValue,
	parseSlippageBpsValue,
	parseStrategyValue,
	parseTelegramPollIntervalValue,
	type Tunables,
} from "../config.ts";
import { nowStamp } from "../utils.ts";
import type { TelegramFetch } from "./notify.ts";
import { TelegramError } from "./notify.ts";

export class TelegramPollError extends Data.TaggedError("TelegramPollError")<{
	message: string;
}> {}

// Commands parsed once at the boundary from raw getUpdates payloads.
// `unknown` carries the raw text for the help hint reply.
export type BotCommand =
	| { kind: "status"; chatId: string; updateId: number; callbackId?: string }
	| { kind: "help"; chatId: string; updateId: number; callbackId?: string }
	| {
			kind: "rebalance";
			chatId: string;
			updateId: number;
			confirmed: boolean;
			callbackId?: string;
	  }
	| {
			kind: "config_show";
			chatId: string;
			updateId: number;
			callbackId?: string;
	  }
	| {
			kind: "config_pick";
			chatId: string;
			updateId: number;
			key: EditableKey;
			callbackId?: string;
	  }
	| {
			kind: "config_set";
			chatId: string;
			updateId: number;
			key: string;
			value: string;
			confirmed: boolean;
			callbackId?: string;
	  }
	| {
			kind: "unknown";
			chatId: string;
			updateId: number;
			text: string;
			callbackId?: string;
	  };

// Single source of truth for Telegram-editable config. All validation reuses
// the exact parsers/bounds in config.ts; handlers stay generic over this
// table with no per-key branches. DRY_RUN, RPC_URL, PRIVATE_KEY,
// TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID and JUPITER_API_KEY are intentionally
// absent: DRY_RUN stays startup-only so chat can never flip preview into live.
export type EditableKey =
	| "SLIPPAGE_BPS"
	| "POLL_INTERVAL_MS"
	| "TELEGRAM_POLL_INTERVAL_MS"
	| "STRATEGY"
	| "COMPOUND_FEES"
	| "PRIORITY_LEVEL"
	| "POOL_ADDRESS";

export const EDITABLE_KEYS: readonly EditableKey[] = [
	"SLIPPAGE_BPS",
	"POLL_INTERVAL_MS",
	"TELEGRAM_POLL_INTERVAL_MS",
	"STRATEGY",
	"COMPOUND_FEES",
	"PRIORITY_LEVEL",
	"POOL_ADDRESS",
];

export interface EditableEntry {
	readonly key: EditableKey;
	readonly parse: (raw: string) => Effect.Effect<unknown, ConfigError>;
	readonly apply: (
		tunables: Tunables,
		raw: string,
	) => Effect.Effect<Tunables, ConfigError>;
	readonly describe: () => string;
	readonly needsConfirm: boolean;
	readonly sideEffect: string;
	readonly getDisplay: (tunables: Tunables) => string;
	readonly formatParsed: (parsed: unknown) => string;
	readonly presets: ReadonlyArray<string>;
	readonly customHint?: string;
}

// Stateless tap-to-edit menu model derived from the registry. No session
// state: every tap carries its full intent in callback_data.
export type ConfigMenuAction =
	| { kind: "config_show" }
	| { kind: "config_pick"; key: EditableKey }
	| { kind: "config_set"; key: EditableKey; value: string; confirmed: boolean };

export const EDITABLE_REGISTRY: Record<EditableKey, EditableEntry> = {
	SLIPPAGE_BPS: {
		key: "SLIPPAGE_BPS",
		parse: (raw) =>
			Effect.map(parseSlippageBpsValue(raw), (value): unknown => value),
		apply: (tunables, raw) =>
			Effect.map(parseSlippageBpsValue(raw), (slippageBps) => ({
				...tunables,
				slippageBps,
			})),
		describe: () => "integer in [0, 10000] bps",
		needsConfirm: false,
		sideEffect: "applies to the next zap estimate",
		getDisplay: (tunables) => `${tunables.slippageBps} bps`,
		formatParsed: (parsed) =>
			typeof parsed === "number" ? `${parsed} bps` : "invalid",
		presets: ["10", "25", "50", "100"],
		customHint: "Custom: type /config set SLIPPAGE_BPS <value>",
	},
	POLL_INTERVAL_MS: {
		key: "POLL_INTERVAL_MS",
		parse: (raw) =>
			Effect.map(parsePollIntervalValue(raw), (value): unknown => value),
		apply: (tunables, raw) =>
			Effect.map(parsePollIntervalValue(raw), (pollIntervalMs) => ({
				...tunables,
				pollIntervalMs,
			})),
		describe: () => "integer in [5000, 3600000] ms",
		needsConfirm: false,
		sideEffect: "applies to the next main-loop sleep",
		getDisplay: (tunables) => `${tunables.pollIntervalMs} ms`,
		formatParsed: (parsed) =>
			typeof parsed === "number" ? `${parsed} ms` : "invalid",
		presets: ["15000", "30000", "60000", "300000"],
		customHint: "Custom: type /config set POLL_INTERVAL_MS <value>",
	},
	TELEGRAM_POLL_INTERVAL_MS: {
		key: "TELEGRAM_POLL_INTERVAL_MS",
		parse: (raw) =>
			Effect.map(
				parseTelegramPollIntervalValue(raw),
				(value): unknown => value,
			),
		apply: (tunables, raw) =>
			Effect.map(
				parseTelegramPollIntervalValue(raw),
				(telegramPollIntervalMs) => ({
					...tunables,
					telegramPollIntervalMs,
				}),
			),
		describe: () => "integer in [1000, 60000] ms",
		needsConfirm: false,
		sideEffect: "applies to the next telegram-loop sleep",
		getDisplay: (tunables) => `${tunables.telegramPollIntervalMs} ms`,
		formatParsed: (parsed) =>
			typeof parsed === "number" ? `${parsed} ms` : "invalid",
		presets: ["2000", "3000", "5000"],
		customHint: "Custom: type /config set TELEGRAM_POLL_INTERVAL_MS <value>",
	},
	STRATEGY: {
		key: "STRATEGY",
		parse: (raw) =>
			Effect.map(parseStrategyValue(raw), (value): unknown => value),
		apply: (tunables, raw) =>
			Effect.map(parseStrategyValue(raw), (strategy) => ({
				...tunables,
				strategy,
			})),
		describe: () => "Spot|Curve|BidAsk, case-insensitive, plus bid-ask/bid_ask",
		needsConfirm: false,
		sideEffect: "applies to the next zap estimate",
		getDisplay: (tunables) => tunables.strategy,
		formatParsed: (parsed) => (typeof parsed === "string" ? parsed : "invalid"),
		presets: ["Spot", "Curve", "BidAsk"],
	},
	COMPOUND_FEES: {
		key: "COMPOUND_FEES",
		parse: (raw) =>
			Effect.map(parseCompoundFeesValue(raw), (value): unknown => value),
		apply: (tunables, raw) =>
			Effect.map(parseCompoundFeesValue(raw), (compoundFees) => ({
				...tunables,
				compoundFees,
			})),
		describe: () => "true/false (also 1/0, yes/no)",
		needsConfirm: false,
		sideEffect: "applies to the next rebalance",
		getDisplay: (tunables) => (tunables.compoundFees ? "true" : "false"),
		formatParsed: (parsed) =>
			typeof parsed === "boolean" ? (parsed ? "true" : "false") : "invalid",
		presets: ["true", "false"],
	},
	PRIORITY_LEVEL: {
		key: "PRIORITY_LEVEL",
		parse: (raw) =>
			Effect.map(parsePriorityLevelValue(raw), (value): unknown => value),
		apply: (tunables, raw) =>
			Effect.map(parsePriorityLevelValue(raw), (priorityLevel) => ({
				...tunables,
				priorityLevel,
			})),
		describe: () => "Auto|Min|Low|Medium|High|VeryHigh|UnsafeMax",
		needsConfirm: false,
		sideEffect: "applies to the next send",
		getDisplay: (tunables) => tunables.priorityLevel,
		formatParsed: (parsed) => (typeof parsed === "string" ? parsed : "invalid"),
		presets: ["Auto", "Min", "Low", "Medium", "High", "VeryHigh", "UnsafeMax"],
	},
	POOL_ADDRESS: {
		key: "POOL_ADDRESS",
		parse: (raw) =>
			Effect.map(parsePoolAddressValue(raw), (value): unknown => value),
		apply: (tunables, raw) =>
			Effect.map(parsePoolAddressValue(raw), (poolAddress) => ({
				...tunables,
				poolAddress,
			})),
		describe: () => "valid Solana base58 address",
		needsConfirm: true,
		sideEffect:
			"switches pool; clears a queued live confirm; persists to .env; verify with /status",
		getDisplay: (tunables) => tunables.poolAddress,
		formatParsed: (parsed) => (typeof parsed === "string" ? parsed : "invalid"),
		presets: [],
		customHint:
			"Type /config set POOL_ADDRESS <addr> then add confirm to switch",
	},
};

export function isEditableKey(key: string): key is EditableKey {
	return key.trim().toUpperCase() in EDITABLE_REGISTRY;
}

export function normalizeEditableKey(key: string): EditableKey | null {
	const normalized = key.trim().toUpperCase();
	if (isEditableKey(normalized)) {
		return normalized;
	}
	return null;
}

// Stateless callback parser for the tap-to-edit menu. Accepts only the five
// shapes in the scheme: "config", "config_show", "config_pick:<KEY>",
// "config_set:<KEY>:<VALUE>", "config_set:<KEY>:<VALUE>:confirm". KEY is
// normalized case-insensitively, VALUE keeps its case for the registry
// parsers. Returns null for anything else (caller maps to unknown).
export function parseConfigMenuAction(data: string): ConfigMenuAction | null {
	const trimmed = data.trim();
	const parts = trimmed.split(":");
	if (parts.length === 1) {
		const head = (parts[0] ?? "").toLowerCase();
		if (head === "config" || head === "config_show") {
			return { kind: "config_show" };
		}
		return null;
	}
	const head = (parts[0] ?? "").toLowerCase();
	if (head === "config_pick") {
		if (parts.length !== 2) {
			return null;
		}
		const key = normalizeEditableKey(parts[1] ?? "");
		if (key === null) {
			return null;
		}
		return { kind: "config_pick", key };
	}
	if (head === "config_set") {
		if (parts.length !== 3 && parts.length !== 4) {
			return null;
		}
		const key = normalizeEditableKey(parts[1] ?? "");
		if (key === null) {
			return null;
		}
		const value = (parts[2] ?? "").trim();
		if (value === "" || /\s/.test(value)) {
			return null;
		}
		if (parts.length === 3) {
			return { kind: "config_set", key, value, confirmed: false };
		}
		if ((parts[3] ?? "").toLowerCase() !== "confirm") {
			return null;
		}
		return { kind: "config_set", key, value, confirmed: true };
	}
	return null;
}

export const TELEGRAM_HELP_TEXT =
	"DLMM bot commands (atau pakai tombol menu di bawah):\n/status - show position snapshot (read-only)\n/help - show this help\n/rebalance - preview rebalance (no transactions)\n/rebalance confirm - execute live (only when DRY_RUN=false, otherwise still preview only)\n/config - show editable config values\n/config set KEY VALUE - update one value (POOL_ADDRESS needs a confirm suffix)\n/config set POOL_ADDRESS <addr> confirm - switch pool (clears queued live confirm, persists to .env)";

// Menu button labels resolve to the same commands as their slash equivalents.
const MENU_LABELS: Record<string, BotCommand["kind"]> = {
	"📊 status": "status",
	status: "status",
	"❓ help": "help",
	help: "help",
	"👁 preview": "rebalance",
	preview: "rebalance",
	"✅ confirm": "rebalance",
	confirm: "rebalance",
	"⚙️ config": "config_show",
	config: "config_show",
};

const CALLBACK_DATA: Record<string, BotCommand["kind"]> = {
	status: "status",
	help: "help",
	rebalance_preview: "rebalance",
	rebalance: "rebalance",
	rebalance_confirm: "rebalance",
	config: "config_show",
	config_show: "config_show",
};

function commandFromMenuLabel(
	normalized: string,
	chatId: string,
	id: number,
	callbackId?: string,
): BotCommand | null {
	const kind = MENU_LABELS[normalized];
	if (!kind) {
		return null;
	}
	if (kind === "status") {
		return { kind: "status", chatId, updateId: id, callbackId };
	}
	if (kind === "help") {
		return { kind: "help", chatId, updateId: id, callbackId };
	}
	if (kind === "config_show") {
		return { kind: "config_show", chatId, updateId: id, callbackId };
	}
	return {
		kind: "rebalance",
		chatId,
		updateId: id,
		confirmed: normalized.includes("confirm"),
		callbackId,
	};
}

// Parse one raw update. Returns null for anything to ignore: malformed
// payloads, non-message updates, non-command text, and any chat id that does
// not equal the allowlisted chatId. Handles message text (slash commands and
// menu button labels) plus callback_query from inline buttons.
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
	const id = updateId as number;
	const callback = record.callback_query;
	if (typeof callback === "object" && callback !== null) {
		const cb = callback as Record<string, unknown>;
		const callbackId =
			typeof cb.id === "string" ? (cb.id as string) : undefined;
		const rawData = typeof cb.data === "string" ? cb.data.trim() : "";
		const data = rawData.toLowerCase();
		const msg = cb.message as Record<string, unknown> | undefined;
		const chat = msg?.chat as Record<string, unknown> | undefined;
		const chatId = chat?.id;
		if (typeof chatId !== "number" && typeof chatId !== "string") {
			return null;
		}
		if (String(chatId) !== allowedChatId) {
			return null;
		}
		const kind = CALLBACK_DATA[data];
		if (kind === "status") {
			return {
				kind: "status",
				chatId: allowedChatId,
				updateId: id,
				callbackId,
			};
		}
		if (kind === "help") {
			return { kind: "help", chatId: allowedChatId, updateId: id, callbackId };
		}
		if (kind === "config_show") {
			return {
				kind: "config_show",
				chatId: allowedChatId,
				updateId: id,
				callbackId,
			};
		}
		if (kind === "rebalance") {
			return {
				kind: "rebalance",
				chatId: allowedChatId,
				updateId: id,
				confirmed: data.includes("confirm"),
				callbackId,
			};
		}
		const menu = parseConfigMenuAction(rawData);
		if (menu?.kind === "config_show") {
			return {
				kind: "config_show",
				chatId: allowedChatId,
				updateId: id,
				callbackId,
			};
		}
		if (menu?.kind === "config_pick") {
			return {
				kind: "config_pick",
				chatId: allowedChatId,
				updateId: id,
				key: menu.key,
				callbackId,
			};
		}
		if (menu?.kind === "config_set") {
			return {
				kind: "config_set",
				chatId: allowedChatId,
				updateId: id,
				key: menu.key,
				value: menu.value,
				confirmed: menu.confirmed,
				callbackId,
			};
		}
		return {
			kind: "unknown",
			chatId: allowedChatId,
			updateId: id,
			text: typeof cb.data === "string" ? cb.data : "",
			callbackId,
		};
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
	if (base === "/config") {
		const sub = (parts[1] ?? "").toLowerCase();
		if (parts.length === 1) {
			return { kind: "config_show", chatId: allowedChatId, updateId: id };
		}
		if (sub === "set") {
			const key = (parts[2] ?? "").trim();
			if (parts.length === 3) {
				return {
					kind: "config_set",
					chatId: allowedChatId,
					updateId: id,
					key,
					value: "",
					confirmed: false,
				};
			}
			if (parts.length === 4) {
				return {
					kind: "config_set",
					chatId: allowedChatId,
					updateId: id,
					key,
					value: (parts[3] ?? "").trim(),
					confirmed: false,
				};
			}
			if (parts.length === 5 && (parts[4] ?? "").toLowerCase() === "confirm") {
				return {
					kind: "config_set",
					chatId: allowedChatId,
					updateId: id,
					key,
					value: (parts[3] ?? "").trim(),
					confirmed: true,
				};
			}
			if (parts.length === 2) {
				return {
					kind: "config_set",
					chatId: allowedChatId,
					updateId: id,
					key: "",
					value: "",
					confirmed: false,
				};
			}
			return { kind: "unknown", chatId: allowedChatId, updateId: id, text };
		}
		return { kind: "unknown", chatId: allowedChatId, updateId: id, text };
	}
	if (base.startsWith("/")) {
		return { kind: "unknown", chatId: allowedChatId, updateId: id, text };
	}
	const menu = commandFromMenuLabel(text.toLowerCase(), allowedChatId, id);
	if (menu) {
		return menu;
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
				allowed_updates: JSON.stringify(["message", "callback_query"]),
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
