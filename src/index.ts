import { config as loadDotenv } from "dotenv";
import { Effect } from "effect";
import { loadPositionState } from "./rebalance/dlmm.ts";
import { originalHalfRange, shouldRebalance } from "./rebalance/plan.ts";
import {
	type CompoundFeesInput,
	describeZapSwap,
	executeZapRebalance,
	planZapRebalance,
	type ZapPlan,
} from "./rebalance/zap.ts";
import { AppConfig, makeAppLive } from "./services.ts";
import {
	type BotCommand,
	fetchTelegramUpdates,
	nextUpdatesOffset,
	parseBotCommand,
	queuePendingLiveConfirm,
	shouldDeferLiveConfirm,
	TELEGRAM_HELP_TEXT,
	takePendingLiveConfirm,
} from "./telegram/commands.ts";
import {
	escapeHtml,
	notifyTelegramEvent,
	notifyTelegramText,
	type TelegramEvent,
} from "./telegram/notify.ts";
import { formatBinRange, formatBn, formatSig, nowStamp } from "./utils.ts";

loadDotenv();

function printPreview(
	plan: ZapPlan,
	snapshot: {
		pool: string;
		position: string;
		activeBinId: number;
		lowerBinId: number;
		upperBinId: number;
	},
	compound: CompoundFeesInput,
) {
	const result = plan.estimate.result;
	console.log(`[${nowStamp()}] === DLMM auto-rebalance preview (zap) ===`);
	console.log(`[${nowStamp()}] Pool:            ${snapshot.pool}`);
	console.log(`[${nowStamp()}] Position:        ${snapshot.position}`);
	console.log(`[${nowStamp()}] Active bin:      ${snapshot.activeBinId}`);
	console.log(
		`[${nowStamp()}] Current range:   ${formatBinRange(snapshot.lowerBinId, snapshot.upperBinId)}`,
	);
	console.log(
		`[${nowStamp()}] New range:       ${formatBinRange(snapshot.activeBinId + plan.minDeltaId, snapshot.activeBinId + plan.maxDeltaId)} ` +
			`(active ${snapshot.activeBinId} delta ${plan.minDeltaId}..${plan.maxDeltaId})`,
	);
	console.log(
		`[${nowStamp()}] Rebalanced:      X=${formatBn(result.postSwapX)} Y=${formatBn(result.postSwapY)}`,
	);
	console.log(
		`[${nowStamp()}] Swaps required:  ${describeZapSwap(plan.estimate)}`,
	);
	console.log(`[${nowStamp()}] Slippage:        ${plan.slippageBps} bps`);
	if (!compound.enabled) {
		console.log(
			`[${nowStamp()}] Compound fees:  disabled — claimed fees stay in the wallet`,
		);
	} else if (!compound.feeX.isZero() || !compound.feeY.isZero()) {
		console.log(
			`[${nowStamp()}] Compound fees:  enabled — top-up X=${formatBn(compound.feeX)} Y=${formatBn(compound.feeY)} after zap (capped by wallet balance)`,
		);
	} else {
		console.log(
			`[${nowStamp()}] Compound fees:  enabled — no claimable fees to top up`,
		);
	}
}

// Telegram send that never fails the caller. Disabled when telegram is unset.
function notify(event: TelegramEvent) {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		yield* notifyTelegramEvent(event, config.telegram);
	});
}

function replyText(text: string) {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		yield* notifyTelegramText(text, config.telegram);
	});
}

let stopped = false;
let wake: (() => void) | undefined;

function requestShutdown() {
	console.log(`[${nowStamp()}] Shutting down...`);
	stopped = true;
	wake?.();
}

process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);

const appLive = makeAppLive(process.env);

const boot = await Effect.runPromise(
	Effect.provide(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			return {
				pollIntervalMs: config.pollIntervalMs,
				telegramPollIntervalMs: config.telegramPollIntervalMs,
				pool: config.poolAddress,
				dryRun: config.dryRun,
			};
		}),
		appLive,
	),
).catch((error): never => {
	console.error(`[${nowStamp()}] Rebalance failed:`, error);
	process.exit(1);
});

const pollIntervalMs = boot.pollIntervalMs;
const telegramPollIntervalMs = boot.telegramPollIntervalMs;

await Effect.runPromise(
	Effect.provide(
		notify({ kind: "startup", pool: boot.pool, dryRun: boot.dryRun }),
		appLive,
	),
);

function runIteration() {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		const state = yield* loadPositionState({
			poolAddress: config.poolAddress,
		});
		const snapshot = state.snapshot;

		if (
			!shouldRebalance(
				snapshot.activeBinId,
				snapshot.lowerBinId,
				snapshot.upperBinId,
			)
		) {
			console.log(
				`[${nowStamp()}] Position in range (active ${snapshot.activeBinId} within ${formatBinRange(snapshot.lowerBinId, snapshot.upperBinId)}) — no rebalance needed.`,
			);
			return;
		}

		const halfWidth = originalHalfRange(
			snapshot.lowerBinId,
			snapshot.upperBinId,
		);
		const plan = yield* planZapRebalance({
			poolAddress: config.poolAddress,
			positionAddress: snapshot.position,
			strategy: config.strategy,
			slippageBps: config.slippageBps,
			halfWidth,
			jupiterApiKey: config.jupiterApiKey,
		});
		const compound: CompoundFeesInput = {
			enabled: config.compoundFees,
			dlmm: state.dlmm,
			positionAddress: snapshot.position,
			feeX: snapshot.feeX,
			feeY: snapshot.feeY,
			minBinId: snapshot.activeBinId - halfWidth,
			maxBinId: snapshot.activeBinId + halfWidth,
			strategy: config.strategy,
			slippageBps: config.slippageBps,
		};
		printPreview(
			plan,
			{
				pool: snapshot.pool,
				position: snapshot.position,
				activeBinId: snapshot.activeBinId,
				lowerBinId: snapshot.lowerBinId,
				upperBinId: snapshot.upperBinId,
			},
			compound,
		);
		yield* notify({
			kind: "rebalanceNeeded",
			pool: snapshot.pool,
			position: snapshot.position,
			activeBinId: snapshot.activeBinId,
			lowerBinId: snapshot.lowerBinId,
			upperBinId: snapshot.upperBinId,
			newLowerBinId: snapshot.activeBinId + plan.minDeltaId,
			newUpperBinId: snapshot.activeBinId + plan.maxDeltaId,
			amountX: formatBn(plan.estimate.result.postSwapX),
			amountY: formatBn(plan.estimate.result.postSwapY),
			slippageBps: plan.slippageBps,
			dryRun: config.dryRun,
		});

		if (config.dryRun) {
			console.log(`[${nowStamp()}] Dry run — no transactions sent.`);
			return;
		}

		const done = yield* executeZapRebalance({ plan, compound });
		console.log(
			`[${nowStamp()}] Rebalanced via zap position ${snapshot.position}: ${formatSig(done.signature)}`,
		);
		yield* notify({
			kind: "rebalanced",
			pool: snapshot.pool,
			position: snapshot.position,
			signature: done.signature,
		});
	});
}

// Chat commands run on the fast TELEGRAM_POLL_INTERVAL_MS loop for no-delay
// replies. Read-only commands execute immediately there; a confirmed-live
// /rebalance confirm is queued as pending and consumed serialized with the
// main iteration so two live executes can never overlap.
let telegramOffset: number | undefined;

function handleBotCommand(command: BotCommand) {
	return Effect.catch(
		Effect.gen(function* () {
			if (command.kind === "help") {
				yield* replyText(TELEGRAM_HELP_TEXT);
				return;
			}
			if (command.kind === "unknown") {
				yield* replyText(
					`<b>Unknown command</b>\n<code>${escapeHtml(command.text)}</code>\n\n${TELEGRAM_HELP_TEXT}`,
				);
				return;
			}
			const config = yield* AppConfig;
			if (
				command.kind === "rebalance" &&
				shouldDeferLiveConfirm(command, config.dryRun)
			) {
				queuePendingLiveConfirm(command);
				yield* replyText(
					`<b>Rebalance queued</b>\nLive execution will run in the main loop within one poll interval.`,
				);
				return;
			}
			const state = yield* loadPositionState({
				poolAddress: config.poolAddress,
			});
			const snapshot = state.snapshot;
			if (command.kind === "status") {
				yield* replyText(
					`<b>Position snapshot</b>\nPool: <code>${escapeHtml(snapshot.pool)}</code>\nPosition: <code>${escapeHtml(snapshot.position)}</code>\nActive: <code>${snapshot.activeBinId}</code>\nRange: <code>${escapeHtml(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}</code>\nBalances: X=<code>${escapeHtml(formatBn(snapshot.amountX))}</code> Y=<code>${escapeHtml(formatBn(snapshot.amountY))}</code>`,
				);
				return;
			}
			if (
				!shouldRebalance(
					snapshot.activeBinId,
					snapshot.lowerBinId,
					snapshot.upperBinId,
				)
			) {
				yield* replyText(
					`<b>In range</b> — no rebalance needed.\nActive: <code>${snapshot.activeBinId}</code> within <code>${escapeHtml(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}</code>`,
				);
				return;
			}
			const halfWidth = originalHalfRange(
				snapshot.lowerBinId,
				snapshot.upperBinId,
			);
			const plan = yield* planZapRebalance({
				poolAddress: config.poolAddress,
				positionAddress: snapshot.position,
				strategy: config.strategy,
				slippageBps: config.slippageBps,
				halfWidth,
				jupiterApiKey: config.jupiterApiKey,
			});
			const preview = `<b>Rebalance preview</b>\nPool: <code>${escapeHtml(snapshot.pool)}</code>\nPosition: <code>${escapeHtml(snapshot.position)}</code>\nActive: <code>${snapshot.activeBinId}</code>\nRange: <code>${escapeHtml(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}</code> → <code>${escapeHtml(formatBinRange(snapshot.activeBinId + plan.minDeltaId, snapshot.activeBinId + plan.maxDeltaId))}</code>\nBalances: X=<code>${escapeHtml(formatBn(plan.estimate.result.postSwapX))}</code> Y=<code>${escapeHtml(formatBn(plan.estimate.result.postSwapY))}</code>\nSlippage: <code>${plan.slippageBps} bps</code>\nSwaps: <code>${escapeHtml(describeZapSwap(plan.estimate))}</code>`;
			if (!command.confirmed) {
				yield* replyText(
					`${preview}\n${config.dryRun ? "Dry run — no transactions sent. Live execution via chat stays disabled while DRY_RUN=true." : "Send <code>/rebalance confirm</code> to execute live."}`,
				);
				return;
			}
			yield* replyText(
				`${preview}\nDry run — no transactions sent (DRY_RUN=true overrides <code>/rebalance confirm</code>).`,
			);
			// Live confirms defer earlier via shouldDeferLiveConfirm, so reaching
			// here means preview-only. Never execute live in the fast loop.
			return;
		}),
		(error) =>
			Effect.sync(() => {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[${nowStamp()}] Telegram command failed: ${message}`);
			}),
	);
}

function drainTelegramCommands() {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		const telegram = config.telegram;
		if (!telegram) {
			return;
		}
		const rawUpdates = yield* Effect.catch(
			fetchTelegramUpdates(telegram, telegramOffset),
			(error) =>
				Effect.sync(() => {
					console.warn(
						`[${nowStamp()}] Telegram poll failed: ${error.message}`,
					);
					return [] as unknown[];
				}),
		);
		telegramOffset = nextUpdatesOffset(rawUpdates, telegramOffset);
		for (const raw of rawUpdates) {
			const command = parseBotCommand(raw, telegram.chatId);
			if (!command) {
				continue;
			}
			yield* handleBotCommand(command);
		}
	});
}

// Consume one queued live confirm serialized with the main iteration so two
// live executes can never overlap. Never fails the iteration: errors become
// a warning, like any other Telegram failure.
function drainPendingConfirm() {
	return Effect.catch(
		Effect.gen(function* () {
			const pending = takePendingLiveConfirm();
			if (!pending) {
				return;
			}
			const config = yield* AppConfig;
			if (config.dryRun) {
				// Defensive: config is fixed at startup, so queue-time and
				// consume-time dryRun always agree. Stay preview-only rather
				// than ever sending live while DRY_RUN=true.
				yield* handleBotCommand(pending);
				return;
			}
			const state = yield* loadPositionState({
				poolAddress: config.poolAddress,
			});
			const snapshot = state.snapshot;
			if (
				!shouldRebalance(
					snapshot.activeBinId,
					snapshot.lowerBinId,
					snapshot.upperBinId,
				)
			) {
				yield* replyText(
					`<b>In range</b> — no rebalance needed.\nActive: <code>${snapshot.activeBinId}</code> within <code>${escapeHtml(formatBinRange(snapshot.lowerBinId, snapshot.upperBinId))}</code>`,
				);
				return;
			}
			const halfWidth = originalHalfRange(
				snapshot.lowerBinId,
				snapshot.upperBinId,
			);
			const plan = yield* planZapRebalance({
				poolAddress: config.poolAddress,
				positionAddress: snapshot.position,
				strategy: config.strategy,
				slippageBps: config.slippageBps,
				halfWidth,
				jupiterApiKey: config.jupiterApiKey,
			});
			const compound: CompoundFeesInput = {
				enabled: config.compoundFees,
				dlmm: state.dlmm,
				positionAddress: snapshot.position,
				feeX: snapshot.feeX,
				feeY: snapshot.feeY,
				minBinId: snapshot.activeBinId - halfWidth,
				maxBinId: snapshot.activeBinId + halfWidth,
				strategy: config.strategy,
				slippageBps: config.slippageBps,
			};
			printPreview(
				plan,
				{
					pool: snapshot.pool,
					position: snapshot.position,
					activeBinId: snapshot.activeBinId,
					lowerBinId: snapshot.lowerBinId,
					upperBinId: snapshot.upperBinId,
				},
				compound,
			);
			const done = yield* executeZapRebalance({ plan, compound });
			console.log(
				`[${nowStamp()}] Rebalanced via chat command position ${snapshot.position}: ${formatSig(done.signature)}`,
			);
			yield* notify({
				kind: "rebalanced",
				pool: snapshot.pool,
				position: snapshot.position,
				signature: done.signature,
			});
		}),
		(error) =>
			Effect.sync(() => {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[${nowStamp()}] Telegram command failed: ${message}`);
			}),
	);
}

// Fast command loop on its own TELEGRAM_POLL_INTERVAL_MS timer for no-delay
// replies. Shares the existing stopped flag with the main loop: SIGINT/SIGTERM
// sets stopped and wakes the main sleep; the fast loop then exits promptly,
// worst case within one telegram interval. No second shutdown path.
async function telegramFastLoop() {
	while (!stopped) {
		await Effect.runPromise(
			Effect.provide(drainTelegramCommands(), appLive),
		).catch((error) => {
			console.warn(`[${nowStamp()}] Telegram poll failed:`, error);
		});
		if (stopped) {
			break;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, telegramPollIntervalMs);
		});
	}
}

const telegramLoop = telegramFastLoop();

while (!stopped) {
	try {
		await Effect.runPromise(Effect.provide(runIteration(), appLive));
		// Serialize queued live confirms with the main iteration.
		await Effect.runPromise(Effect.provide(drainPendingConfirm(), appLive));
	} catch (error) {
		console.error(`[${nowStamp()}] Rebalance failed:`, error);
		const message = error instanceof Error ? error.message : String(error);
		await Effect.runPromise(
			Effect.provide(notify({ kind: "failed", message }), appLive),
		);
	}
	if (stopped) {
		break;
	}
	await new Promise<void>((resolve) => {
		wake = resolve;
		setTimeout(resolve, pollIntervalMs);
	});
	wake = undefined;
}

await telegramLoop;

await Effect.runPromise(Effect.provide(notify({ kind: "shutdown" }), appLive));
