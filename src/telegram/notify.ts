import { Data, Effect } from "effect";
import type { ActivityEntry, ActivityKind } from "../activity.ts";
import type { TelegramConfig } from "../config.ts";
import type { PositionSnapshot } from "../rebalance/types.ts";
import {
	formatBinRange,
	formatTokenAmount,
	meteoraPoolUrl,
	nowStamp,
	rangeDirection,
	redactSecrets,
	renderRangeBar,
	shortAddr,
	solscanAccountUrl,
	solscanTxUrl,
} from "../utils.ts";
import type { EditableKey } from "./commands.ts";

export class TelegramError extends Data.TaggedError("TelegramError")<{
	message: string;
}> {}

export type FailureStage = "rebalance" | "fee claim" | "command";

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
			pair: string;
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
	| {
			kind: "rebalanced";
			pool: string;
			position: string;
			pair: string;
			signature: string;
	  }
	| {
			kind: "feesClaimed";
			action: "compound" | "sweep";
			pool: string;
			position: string;
			pair: string;
			valueDisplay: string;
			signature: string;
	  }
	| { kind: "failed"; stage: FailureStage; message: string };

// Inline menu attached to bot messages. callback_data values are parsed back
// by CALLBACK_DATA in commands.ts. One toggle shows Pause or Resume.
export function mainMenuKeyboard(paused: boolean) {
	return {
		inline_keyboard: [
			[
				{ text: "📊 Status", callback_data: "status" },
				{ text: "👁 Preview", callback_data: "rebalance_preview" },
			],
			[
				{ text: "📜 Logs", callback_data: "logs" },
				{ text: "⚙️ Config", callback_data: "config_show" },
			],
			[
				paused
					? { text: "▶️ Resume", callback_data: "resume" }
					: { text: "⏸ Pause", callback_data: "pause" },
				{ text: "❓ Help", callback_data: "help" },
			],
		],
	};
}

// Telegram clients keep an old reply keyboard until a message removes it.
export const REMOVE_REPLY_KEYBOARD = { remove_keyboard: true } as const;

export const TELEGRAM_BOT_COMMANDS = [
	{ command: "status", description: "show position snapshot (read-only)" },
	{ command: "logs", description: "show recent bot activity" },
	{ command: "menu", description: "show the button menu" },
	{ command: "help", description: "show help" },
	{ command: "pause", description: "pause auto-rebalance loop" },
	{ command: "resume", description: "resume auto-rebalance loop" },
	{ command: "rebalance", description: "preview rebalance (no transactions)" },
	{
		command: "config",
		description: "show editable config (/config set KEY VALUE)",
	},
] as const;

// Live-mode previews put a confirm row above the main menu. Tapping it emits
// "rebalance_confirm", parsed as a confirmed rebalance.
export function previewKeyboard(dryRun: boolean, paused: boolean) {
	const menu = mainMenuKeyboard(paused);
	if (dryRun) {
		return menu;
	}
	return {
		inline_keyboard: [
			[{ text: "✅ Confirm live", callback_data: "rebalance_confirm" }],
			...menu.inline_keyboard,
		],
	};
}

// Tap-to-edit menu: one pick button per editable key. Tapping emits
// "config_pick:<KEY>", parsed as config_pick. No values in buttons.
export function configMenuKeyboard(keys: ReadonlyArray<EditableKey>) {
	return {
		inline_keyboard: keys.map((key) => [
			{ text: key, callback_data: `config_pick:${key}` },
		]),
	};
}

// Value keyboard for one key: one set button per preset plus a back button.
// Tapping a preset emits "config_set:<KEY>:<VALUE>"; back emits "config_show".
// POOL_ADDRESS has no presets, so its keyboard is back-only: tapping it never
// applies anything, the pick reply carries the type-in instructions instead.
export function configValueKeyboard(
	key: EditableKey,
	presets: ReadonlyArray<string>,
) {
	return {
		inline_keyboard: [
			...presets.map((value) => [
				{ text: value, callback_data: `config_set:${key}:${value}` },
			]),
			[{ text: "⬅️ Config", callback_data: "config_show" }],
		],
	};
}
// Escape dynamic text for Telegram HTML parse_mode.
// ">" is escaped too so arrows like "->" never read as markup.
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

type Link = readonly [label: string, url: string];

const code = (value: string) => `<code>${escapeHtml(value)}</code>`;
const poolLink = (pool: string): Link => ["Pool", meteoraPoolUrl(pool)];
const positionLink = (position: string): Link => [
	"Position",
	solscanAccountUrl(position),
];
const txLink = (signature: string): Link => ["Tx", solscanTxUrl(signature)];

function titleLine(emoji: string, title: string, pair?: string): string {
	return `${emoji} <b>${escapeHtml(title)}</b>${pair ? ` ${code(pair)}` : ""}`;
}

// Every message reads the same on a phone: title, blank line, short
// `Label: value` rows, then all links on one final line.
function layout(
	title: string,
	rows: ReadonlyArray<string | undefined>,
	links: ReadonlyArray<Link> = [],
): string {
	const body = rows.filter((row): row is string => row !== undefined);
	const parts = [title];
	if (body.length > 0) {
		parts.push("", ...body);
	}
	if (links.length > 0) {
		const anchors = links.map(
			([label, url]) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
		);
		parts.push("", `🔗 ${anchors.join(" · ")}`);
	}
	return parts.join("\n");
}

export function pairOf(snapshot: {
	tokenXSymbol: string;
	tokenYSymbol: string;
}): string {
	return `${snapshot.tokenXSymbol}/${snapshot.tokenYSymbol}`;
}

export function activeSummary(
	active: number,
	lower: number,
	upper: number,
): string {
	const direction = rangeDirection(active, lower, upper);
	if (direction === "above") {
		return `${active} · ${active - upper} bins ABOVE range`;
	}
	if (direction === "below") {
		return `${active} · ${lower - active} bins BELOW range`;
	}
	return `${active} · inside range`;
}

const modeValue = (dryRun: boolean) => (dryRun ? "dry run" : "<b>LIVE</b>");

export interface PreviewReplyInput {
	pool: string;
	position: string;
	pair?: string;
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
	// Chat-requested preview vs the loop's automatic notice.
	preview?: boolean;
	// Trusted HTML shown after the Mode row.
	note?: string;
}

export function formatPreviewReply(input: PreviewReplyInput): string {
	const bar = renderRangeBar(
		input.lowerBinId,
		input.upperBinId,
		input.newLowerBinId,
		input.newUpperBinId,
		input.activeBinId,
	);
	return layout(
		input.preview
			? titleLine("🔍", "Rebalance preview", input.pair)
			: titleLine("⚠️", "Rebalance needed", input.pair),
		[
			`Active: ${escapeHtml(activeSummary(input.activeBinId, input.lowerBinId, input.upperBinId))}`,
			`Range: ${code(formatBinRange(input.lowerBinId, input.upperBinId))} → ${code(formatBinRange(input.newLowerBinId, input.newUpperBinId))}`,
			`<pre>${escapeHtml(bar)}</pre>`,
			"<i>= old range · + new range · ^ active</i>",
			`Balances: ${code(input.amountXDisplay)} · ${code(input.amountYDisplay)}`,
			input.swapsDisplay ? `Swaps: ${code(input.swapsDisplay)}` : undefined,
			`Slippage: ${input.slippageBps} bps`,
			`Mode: ${modeValue(input.dryRun)}`,
			input.note,
		],
		[poolLink(input.pool), positionLink(input.position)],
	);
}

export function formatStatusReply(
	snapshot: PositionSnapshot,
	state: { dryRun: boolean; paused: boolean },
): string {
	const bar = renderRangeBar(
		snapshot.lowerBinId,
		snapshot.upperBinId,
		snapshot.lowerBinId,
		snapshot.upperBinId,
		snapshot.activeBinId,
	);
	return layout(
		titleLine("📊", "Position", pairOf(snapshot)),
		[
			`Active: ${escapeHtml(activeSummary(snapshot.activeBinId, snapshot.lowerBinId, snapshot.upperBinId))}`,
			`Range: ${code(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}`,
			`<pre>${escapeHtml(bar)}</pre>`,
			"<i>* range · ^ active</i>",
			`Balances: ${code(formatTokenAmount(snapshot.amountX, snapshot.tokenXDecimals, snapshot.tokenXSymbol))} · ${code(formatTokenAmount(snapshot.amountY, snapshot.tokenYDecimals, snapshot.tokenYSymbol))}`,
			`Mode: ${modeValue(state.dryRun)}${state.paused ? " · ⏸ paused" : ""}`,
			state.paused ? "Send <code>/resume</code> to continue." : undefined,
		],
		[poolLink(snapshot.pool), positionLink(snapshot.position)],
	);
}

export function formatInRangeReply(snapshot: PositionSnapshot): string {
	return layout(titleLine("✅", "In range", pairOf(snapshot)), [
		`Active: ${escapeHtml(activeSummary(snapshot.activeBinId, snapshot.lowerBinId, snapshot.upperBinId))}`,
		`Range: ${code(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}`,
		"No rebalance needed.",
	]);
}

export function formatPausedReply(already: boolean): string {
	return layout(titleLine("⏸", already ? "Already paused" : "Paused"), [
		"Auto-rebalance loop is paused. No checks and no live executes until resume.",
		"/status stays available. Send <code>/resume</code> to continue.",
	]);
}

export function formatResumedReply(already: boolean): string {
	return layout(titleLine("▶️", already ? "Already running" : "Resumed"), [
		"Auto-rebalance loop is active. Send <code>/pause</code> to pause.",
	]);
}

export function formatPausedSkip(): string {
	return `⏸ <b>Paused</b> — skipping rebalance check.\nSend <code>/resume</code> to continue the loop.`;
}

export function formatQueuedReply(): string {
	return layout(titleLine("⏳", "Rebalance queued"), [
		"Live execution runs in the main loop within one poll interval.",
	]);
}

export function formatMenuReply(): string {
	return titleLine("📋", "Menu");
}

export function formatHelpReply(helpText: string): string {
	return layout(titleLine("❓", "Help"), [escapeHtml(helpText)]);
}

export function formatUnknownCommandReply(
	text: string,
	helpText: string,
): string {
	return layout(titleLine("❓", "Unknown command"), [
		code(text),
		"",
		escapeHtml(helpText),
	]);
}

export interface ConfigShowEntry {
	key: string;
	display: string;
	describe: string;
	sideEffect: string;
}

// Show all editable values. Entries come from the commands.ts registry so
// bounds never drift; this formatter only lays out escaped HTML.
export function formatConfigShow(
	entries: ReadonlyArray<ConfigShowEntry>,
): string {
	const rows = entries
		.map(
			(entry) =>
				`${code(entry.key)} = ${code(entry.display)}\n<i>${escapeHtml(entry.describe)} — ${escapeHtml(entry.sideEffect)}</i>`,
		)
		.join("\n\n");
	return (
		`⚙️ <b>Editable config</b>\n\n${rows}\n\n` +
		`Tap a key below to edit, or set with <code>/config set KEY VALUE</code> (POOL_ADDRESS needs a <code>confirm</code> suffix).\n` +
		`<i>DRY_RUN, RPC_URL, PRIVATE_KEY, TELEGRAM_* and JUPITER_API_KEY stay startup-only.</i>`
	);
}

export interface ConfigPickEntry extends ConfigShowEntry {
	customHint?: string;
}

// Single-key view for a config_pick tap. Keeps the free-type fallback line
// so keyboards never strand the owner without a typed path. POOL_ADDRESS
// type-in instructions arrive via customHint from the registry; this
// formatter never puts addresses in buttons.
export function formatConfigPick(entry: ConfigPickEntry): string {
	return layout(titleLine("⚙️", `Config ${entry.key}`), [
		`${code(entry.key)} = ${code(entry.display)}`,
		`<i>${escapeHtml(entry.describe)} — ${escapeHtml(entry.sideEffect)}</i>`,
		"",
		`Tap a value below, or set with <code>/config set ${escapeHtml(entry.key)} VALUE</code>.`,
		entry.customHint ? `<i>${escapeHtml(entry.customHint)}</i>` : undefined,
	]);
}

// Pool-switch preview: no state change. Displays are pre-shortened by the
// caller; fullValue is the exact value to resend (never truncated).
export function formatConfigPreview(
	key: string,
	oldDisplay: string,
	newDisplay: string,
	fullValue: string,
): string {
	return layout(titleLine("⚠️", "Config preview"), [
		"No change applied.",
		`${code(key)}: ${code(oldDisplay)} → ${code(newDisplay)}`,
		"Send again with a <code>confirm</code> suffix to apply:",
		code(`/config set ${key} ${fullValue} confirm`),
	]);
}

export function formatConfigUpdated(
	key: string,
	oldDisplay: string,
	newDisplay: string,
	sideEffect: string,
	hint?: string,
): string {
	return layout(titleLine("✅", "Config updated"), [
		`${code(key)}: ${code(oldDisplay)} → ${code(newDisplay)}`,
		`<i>${escapeHtml(sideEffect)}</i>`,
		hint,
	]);
}

export function formatConfigUnknownKey(
	rawKey: string,
	valid: ReadonlyArray<{ key: string; describe: string }>,
): string {
	return layout(titleLine("❌", "Unknown config key"), [
		code(rawKey || "(empty)"),
		"Valid keys:",
		...valid.map(
			(entry) => `${code(entry.key)} — ${escapeHtml(entry.describe)}`,
		),
		"",
		"No state changed.",
	]);
}

export function formatConfigBadValue(
	key: string,
	raw: string,
	describe: string,
): string {
	return layout(titleLine("❌", `Invalid value for ${key}`), [
		code(raw || "(empty)"),
		`Expected: ${escapeHtml(describe)}`,
		"",
		"No state changed.",
	]);
}

export const FAILURE_TITLES: Record<FailureStage, string> = {
	rebalance: "Rebalance failed",
	"fee claim": "Fee claim failed",
	command: "Command failed",
};

// Single formatter table over the union. Add new event kinds here, not with
// scattered conditionals at the call sites.
const telegramFormatters: {
	[K in TelegramEvent["kind"]]: (
		event: Extract<TelegramEvent, { kind: K }>,
	) => string;
} = {
	startup: (event) =>
		layout(
			titleLine("🤖", "Bot started"),
			[
				`Mode: ${event.dryRun ? "dry run (preview only)" : "<b>LIVE</b> (sends transactions)"}`,
				`Pool: ${code(shortAddr(event.pool))}`,
			],
			[poolLink(event.pool)],
		),
	shutdown: () => titleLine("🛑", "Bot stopped"),
	rebalanceNeeded: (event) =>
		formatPreviewReply({
			...event,
			note: event.dryRun ? "No transactions sent." : "Executing now.",
		}),
	rebalanced: (event) =>
		layout(
			titleLine("✅", "Rebalanced", event.pair),
			[`Tx: ${code(shortAddr(event.signature))}`],
			[
				txLink(event.signature),
				poolLink(event.pool),
				positionLink(event.position),
			],
		),
	feesClaimed: (event) =>
		layout(
			event.action === "sweep"
				? titleLine("💰", "Fees swept to SOL", event.pair)
				: titleLine("♻️", "Fees compounded", event.pair),
			[
				`Value: ~${escapeHtml(event.valueDisplay)}`,
				`Tx: ${code(shortAddr(event.signature))}`,
			],
			[
				txLink(event.signature),
				poolLink(event.pool),
				positionLink(event.position),
			],
		),
	failed: (event) =>
		layout(titleLine("❌", FAILURE_TITLES[event.stage]), [
			`Error: ${code(redactSecrets(event.message).slice(0, 1000))}`,
			event.message.includes("no DLMM position found")
				? "No funded position in this pool. Check <code>POOL_ADDRESS</code> with /config, then retry /status."
				: undefined,
		]),
};

const ACTIVITY_EMOJI: Record<ActivityKind, string> = {
	startup: "🤖",
	shutdown: "🛑",
	rebalanceNeeded: "⚠️",
	rebalanced: "✅",
	feesClaimed: "💰",
	failed: "❌",
	paused: "⏸",
	resumed: "▶️",
	configChanged: "⚙️",
};

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

// Local "07 Oct 09:02".
export function activityStamp(iso: string): string {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Long details are cut so 15 lines stay under Telegram's 4096-char limit.
export function formatActivityLine(entry: ActivityEntry): string {
	const detail =
		entry.detail === undefined
			? ""
			: ` · ${escapeHtml(entry.detail.length > 80 ? `${entry.detail.slice(0, 79)}…` : entry.detail)}`;
	const tx = entry.signature
		? ` · tx <a href="${escapeHtml(solscanTxUrl(entry.signature))}">${escapeHtml(shortAddr(entry.signature))}</a>`
		: "";
	const count = (entry.count ?? 1) > 1 ? ` ×${entry.count}` : "";
	return `${activityStamp(entry.at)} ${ACTIVITY_EMOJI[entry.kind]} ${escapeHtml(entry.title)}${detail}${tx}${count}`;
}

// Entries arrive newest first.
export function formatActivityReply(
	entries: ReadonlyArray<ActivityEntry>,
): string {
	return layout(
		titleLine("📜", "Recent activity"),
		entries.length === 0
			? ["No activity yet."]
			: entries.map(formatActivityLine),
	);
}

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
					link_preview_options: { is_disabled: true },
					reply_markup: options.replyMarkup,
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

// Never-failing wrapper for the poll loop. A Telegram outage must never fail
// an iteration, so failures become a console warning (without the token).
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
