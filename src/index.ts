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
	TELEGRAM_HELP_TEXT,
} from "./telegram/commands.ts";
import {
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

// Chat commands share the main poll cadence: one short-poll getUpdates per
// iteration, no loop of their own. /rebalance is preview-only unless
// DRY_RUN=false and the second step "/rebalance confirm" arrives.
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
					`Unknown command: ${command.text}\n\n${TELEGRAM_HELP_TEXT}`,
				);
				return;
			}
			const config = yield* AppConfig;
			const state = yield* loadPositionState({
				poolAddress: config.poolAddress,
			});
			const snapshot = state.snapshot;
			if (command.kind === "status") {
				yield* replyText(
					`Position snapshot\nPool: ${snapshot.pool}\nPosition: ${snapshot.position}\nActive: ${snapshot.activeBinId}\nRange: ${formatBinRange(snapshot.lowerBinId, snapshot.upperBinId)}\nBalances: X=${formatBn(snapshot.amountX)} Y=${formatBn(snapshot.amountY)}`,
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
					`In range (active ${snapshot.activeBinId} within ${formatBinRange(snapshot.lowerBinId, snapshot.upperBinId)}) — no rebalance needed.`,
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
			const preview = `Rebalance preview\nPool: ${snapshot.pool}\nPosition: ${snapshot.position}\nActive: ${snapshot.activeBinId}\nRange: ${formatBinRange(snapshot.lowerBinId, snapshot.upperBinId)} -> ${formatBinRange(snapshot.activeBinId + plan.minDeltaId, snapshot.activeBinId + plan.maxDeltaId)}\nBalances: X=${formatBn(plan.estimate.result.postSwapX)} Y=${formatBn(plan.estimate.result.postSwapY)}\nSlippage: ${plan.slippageBps} bps\nSwaps: ${describeZapSwap(plan.estimate)}`;
			if (!command.confirmed) {
				yield* replyText(
					`${preview}\n${config.dryRun ? "Dry run — no transactions sent. Live execution via chat stays disabled while DRY_RUN=true." : "Send /rebalance confirm to execute live."}`,
				);
				return;
			}
			if (config.dryRun) {
				yield* replyText(
					`${preview}\nDry run — no transactions sent (DRY_RUN=true overrides /rebalance confirm).`,
				);
				return;
			}
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

while (!stopped) {
	try {
		await Effect.runPromise(Effect.provide(runIteration(), appLive));
	} catch (error) {
		console.error(`[${nowStamp()}] Rebalance failed:`, error);
		const message = error instanceof Error ? error.message : String(error);
		await Effect.runPromise(
			Effect.provide(notify({ kind: "failed", message }), appLive),
		);
	}
	if (!stopped) {
		await Effect.runPromise(
			Effect.provide(drainTelegramCommands(), appLive),
		).catch((error) => {
			console.warn(`[${nowStamp()}] Telegram poll failed:`, error);
		});
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

await Effect.runPromise(Effect.provide(notify({ kind: "shutdown" }), appLive));
