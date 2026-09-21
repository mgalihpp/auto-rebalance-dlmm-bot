import { config as loadDotenv } from "dotenv";
import { Effect, Ref } from "effect";
import { tunablesFromConfig } from "./config.ts";
import { loadPositionState } from "./rebalance/dlmm.ts";
import { originalHalfRange, shouldRebalance } from "./rebalance/plan.ts";
import {
	planSweepLegs,
	type ReaccumulateInput,
} from "./rebalance/reaccumulate.ts";
import {
	type CompoundFeesInput,
	describeZapSwap,
	executeZapRebalance,
	planZapRebalance,
	type ZapPlan,
} from "./rebalance/zap.ts";
import {
	AppConfig,
	makeAppLive,
	makeAppLiveWithTunables,
	persistEnvKey,
	RuntimeTunables,
} from "./services.ts";
import {
	type BotCommand,
	clearPendingLiveConfirm,
	EDITABLE_KEYS,
	EDITABLE_REGISTRY,
	fetchTelegramUpdates,
	isBotPaused,
	nextUpdatesOffset,
	normalizeEditableKey,
	parseBotCommand,
	queuePendingLiveConfirm,
	setBotPaused,
	shouldDeferLiveConfirm,
	TELEGRAM_HELP_TEXT,
	takePendingLiveConfirm,
} from "./telegram/commands.ts";
import {
	answerTelegramCallback,
	configMenuKeyboard,
	configValueKeyboard,
	confirmInlineKeyboard,
	escapeHtml,
	formatCommandError,
	formatConfigBadValue,
	formatConfigPick,
	formatConfigPreview,
	formatConfigShow,
	formatConfigUnknownKey,
	formatConfigUpdated,
	formatInRangeReply,
	formatPausedReply,
	formatPausedSkip,
	formatPreviewReply,
	formatResumedReply,
	formatStatusReply,
	notifyTelegramEvent,
	notifyTelegramText,
	setTelegramMenuCommands,
	type TelegramEvent,
} from "./telegram/notify.ts";
import {
	formatBinRange,
	formatBn,
	formatSig,
	formatTokenAmount,
	nowStamp,
	shortAddr,
} from "./utils.ts";

loadDotenv();

function printPreview(
	plan: ZapPlan,
	snapshot: {
		pool: string;
		position: string;
		activeBinId: number;
		lowerBinId: number;
		upperBinId: number;
		tokenXMint: string;
		tokenYMint: string;
	},
	compound: CompoundFeesInput,
	reaccumulate: ReaccumulateInput,
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
	if (!reaccumulate.enabled) {
		console.log(`[${nowStamp()}] Reaccumulate to SOL: disabled`);
	} else if (!reaccumulate.feeX.isZero() || !reaccumulate.feeY.isZero()) {
		// Preview has no wallet balance yet; execution re-caps by real balance.
		const legs = planSweepLegs({
			feeX: reaccumulate.feeX,
			feeY: reaccumulate.feeY,
			balX: reaccumulate.feeX,
			balY: reaccumulate.feeY,
			mintX: snapshot.tokenXMint,
			mintY: snapshot.tokenYMint,
		});
		const detail =
			legs === null
				? "no sweepable fees"
				: legs
						.map(
							(leg) =>
								`${leg.kind} ${formatBn(leg.amount)} ${shortAddr(leg.mint)}`,
						)
						.join(", ");
		console.log(
			`[${nowStamp()}] Reaccumulate to SOL: enabled — ${detail} after zap (capped by wallet balance)`,
		);
	} else {
		console.log(
			`[${nowStamp()}] Reaccumulate to SOL: enabled — no claimable fees to sweep`,
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

function replyText(text: string, replyMarkup?: unknown) {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		yield* notifyTelegramText(text, config.telegram, undefined, {
			replyMarkup,
		});
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

const bootLive = makeAppLive(process.env);

const boot = await Effect.runPromise(
	Effect.provide(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			return {
				pollIntervalMs: config.pollIntervalMs,
				telegramPollIntervalMs: config.telegramPollIntervalMs,
				pool: config.poolAddress,
				dryRun: config.dryRun,
				initialTunables: tunablesFromConfig(config),
			};
		}),
		bootLive,
	),
).catch((error): never => {
	console.error(`[${nowStamp()}] Rebalance failed:`, error);
	process.exit(1);
});

// ONE shared Ref for the whole process: every main-loop iteration and every
// telegram poll provides this same appLive, so a Ref.set in one run is
// visible in all later runs. Rebuilding tunablesLive per run would hand each
// run a fresh Ref from startup config and silently drop edits.
const tunablesRef = Effect.runSync(Ref.make(boot.initialTunables));
const appLive = makeAppLiveWithTunables(process.env, tunablesRef);

// Single snapshot read per iteration. Telegram is the only writer.
function getTunables() {
	return Effect.gen(function* () {
		const ref = yield* RuntimeTunables;
		return yield* Ref.get(ref);
	});
}

await Effect.runPromise(
	Effect.provide(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			if (config.telegram) {
				yield* Effect.catch(setTelegramMenuCommands(config.telegram), (error) =>
					Effect.sync(() =>
						console.warn(
							`[${nowStamp()}] Telegram menu setup failed: ${error.message}`,
						),
					),
				);
			}
			yield* notify({
				kind: "startup",
				pool: boot.pool,
				dryRun: boot.dryRun,
			});
		}),
		appLive,
	),
);

function runIteration() {
	return Effect.gen(function* () {
		if (isBotPaused()) {
			console.log(`[${nowStamp()}] ${formatPausedSkip()}`);
			return;
		}
		const config = yield* AppConfig;
		const tunables = yield* getTunables();
		const state = yield* loadPositionState({
			poolAddress: tunables.poolAddress,
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
			poolAddress: tunables.poolAddress,
			positionAddress: snapshot.position,
			strategy: tunables.strategy,
			slippageBps: tunables.slippageBps,
			halfWidth,
			jupiterApiKey: config.jupiterApiKey,
		});
		const compound: CompoundFeesInput = {
			enabled: tunables.compoundFees,
			poolAddress: tunables.poolAddress,
			positionAddress: snapshot.position,
			feeX: snapshot.feeX,
			feeY: snapshot.feeY,
			strategy: tunables.strategy,
			slippageBps: tunables.slippageBps,
		};
		const reaccumulate: ReaccumulateInput = {
			enabled: tunables.reaccumulateFeesToSol,
			poolAddress: tunables.poolAddress,
			feeX: snapshot.feeX,
			feeY: snapshot.feeY,
			slippageBps: tunables.slippageBps,
			jupiterApiKey: config.jupiterApiKey,
		};
		printPreview(
			plan,
			{
				pool: snapshot.pool,
				position: snapshot.position,
				activeBinId: snapshot.activeBinId,
				lowerBinId: snapshot.lowerBinId,
				upperBinId: snapshot.upperBinId,
				tokenXMint: snapshot.tokenXMint,
				tokenYMint: snapshot.tokenYMint,
			},
			compound,
			reaccumulate,
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
			amountXDisplay: formatTokenAmount(
				plan.estimate.result.postSwapX,
				snapshot.tokenXDecimals,
				snapshot.tokenXSymbol,
			),
			amountYDisplay: formatTokenAmount(
				plan.estimate.result.postSwapY,
				snapshot.tokenYDecimals,
				snapshot.tokenYSymbol,
			),
			slippageBps: plan.slippageBps,
			dryRun: config.dryRun,
			swapsDisplay: describeZapSwap(plan.estimate),
		});

		if (config.dryRun) {
			console.log(`[${nowStamp()}] Dry run — no transactions sent.`);
			return;
		}

		const done = yield* executeZapRebalance({ plan, compound, reaccumulate });
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
			const config = yield* AppConfig;
			if (command.callbackId && config.telegram) {
				yield* Effect.catch(
					answerTelegramCallback(command.callbackId, config.telegram),
					() => Effect.void,
				);
			}
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
			if (command.kind === "pause") {
				const already = isBotPaused();
				setBotPaused(true);
				console.log(`[${nowStamp()}] Bot paused via Telegram command.`);
				yield* replyText(formatPausedReply(already));
				return;
			}
			if (command.kind === "resume") {
				const already = !isBotPaused();
				setBotPaused(false);
				console.log(`[${nowStamp()}] Bot resumed via Telegram command.`);
				yield* replyText(formatResumedReply(already));
				return;
			}
			if (command.kind === "config_show") {
				const tunables = yield* getTunables();
				const entries = EDITABLE_KEYS.map((key) => ({
					key,
					display: EDITABLE_REGISTRY[key].getDisplay(tunables),
					describe: EDITABLE_REGISTRY[key].describe(),
					sideEffect: EDITABLE_REGISTRY[key].sideEffect,
				}));
				yield* replyText(
					formatConfigShow(entries),
					configMenuKeyboard(EDITABLE_KEYS),
				);
				return;
			}
			if (command.kind === "config_pick") {
				const entry = EDITABLE_REGISTRY[command.key];
				const tunables = yield* getTunables();
				// Pick never applies anything, not even for POOL_ADDRESS: it only
				// renders the value keyboard. POOL_ADDRESS has no presets, so its
				// keyboard is back-only and its customHint carries the type-in
				// instructions. Never put addresses in buttons.
				yield* replyText(
					formatConfigPick({
						key: command.key,
						display: entry.getDisplay(tunables),
						describe: entry.describe(),
						sideEffect: entry.sideEffect,
						customHint: entry.customHint,
					}),
					configValueKeyboard(command.key, entry.presets),
				);
				return;
			}
			if (command.kind === "config_set") {
				const normalized = normalizeEditableKey(command.key);
				if (normalized === null) {
					const valid = EDITABLE_KEYS.map((key) => ({
						key,
						describe: EDITABLE_REGISTRY[key].describe(),
					}));
					yield* replyText(formatConfigUnknownKey(command.key, valid));
					return;
				}
				const entry = EDITABLE_REGISTRY[normalized];
				const parsedExit = yield* Effect.exit(entry.parse(command.value));
				if (parsedExit._tag === "Failure") {
					yield* replyText(
						formatConfigBadValue(normalized, command.value, entry.describe()),
					);
					return;
				}
				const parsed = parsedExit.value;
				if (entry.needsConfirm && !command.confirmed) {
					const tunables = yield* getTunables();
					const fullValue = entry.formatParsed(parsed);
					yield* replyText(
						formatConfigPreview(
							normalized,
							shortAddr(entry.getDisplay(tunables)),
							shortAddr(fullValue),
							fullValue,
						),
					);
					return;
				}
				const tunables = yield* getTunables();
				const oldDisplay = entry.getDisplay(tunables);
				const updated = yield* entry.apply(tunables, command.value);
				const ref = yield* RuntimeTunables;
				yield* Ref.set(ref, updated);
				const newDisplay = entry.getDisplay(updated);
				// Every editable key persists for restarts. Best-effort and never
				// logs secrets; the in-memory switch already took effect.
				yield* Effect.catch(
					persistEnvKey(entry.key, String(parsed), ".env"),
					(persistError) =>
						Effect.sync(() =>
							console.warn(
								`[${nowStamp()}] Config persist failed: ${persistError.message}`,
							),
						),
				);
				if (entry.needsConfirm) {
					// Pool switch only: invalidate any queued live rebalance for
					// the old pool so it can never fire on the new pool.
					clearPendingLiveConfirm();
					yield* replyText(
						formatConfigUpdated(
							normalized,
							shortAddr(oldDisplay),
							shortAddr(newDisplay),
							entry.sideEffect,
							"Send <code>/status</code> to verify the position in the new pool. Never auto-rebalances on switch.",
						),
					);
					return;
				}
				yield* replyText(
					formatConfigUpdated(
						normalized,
						shortAddr(oldDisplay),
						shortAddr(newDisplay),
						entry.sideEffect,
					),
				);
				return;
			}
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
			const tunables = yield* getTunables();
			const state = yield* loadPositionState({
				poolAddress: tunables.poolAddress,
			});
			const snapshot = state.snapshot;
			if (command.kind === "status") {
				const base = formatStatusReply(snapshot);
				yield* replyText(
					isBotPaused()
						? `${base}\n\n⏸ <b>Paused.</b> Send <code>/resume</code> to continue.`
						: base,
				);
				return;
			}
			if (command.kind === "rebalance") {
				if (
					!shouldRebalance(
						snapshot.activeBinId,
						snapshot.lowerBinId,
						snapshot.upperBinId,
					)
				) {
					yield* replyText(formatInRangeReply(snapshot));
					return;
				}
				const halfWidth = originalHalfRange(
					snapshot.lowerBinId,
					snapshot.upperBinId,
				);
				const plan = yield* planZapRebalance({
					poolAddress: tunables.poolAddress,
					positionAddress: snapshot.position,
					strategy: tunables.strategy,
					slippageBps: tunables.slippageBps,
					halfWidth,
					jupiterApiKey: config.jupiterApiKey,
				});
				const preview = formatPreviewReply({
					header: "🔍 <b>Rebalance preview</b>",
					pool: snapshot.pool,
					position: snapshot.position,
					activeBinId: snapshot.activeBinId,
					lowerBinId: snapshot.lowerBinId,
					upperBinId: snapshot.upperBinId,
					newLowerBinId: snapshot.activeBinId + plan.minDeltaId,
					newUpperBinId: snapshot.activeBinId + plan.maxDeltaId,
					amountXDisplay: formatTokenAmount(
						plan.estimate.result.postSwapX,
						snapshot.tokenXDecimals,
						snapshot.tokenXSymbol,
					),
					amountYDisplay: formatTokenAmount(
						plan.estimate.result.postSwapY,
						snapshot.tokenYDecimals,
						snapshot.tokenYSymbol,
					),
					slippageBps: plan.slippageBps,
					dryRun: config.dryRun,
					swapsDisplay: describeZapSwap(plan.estimate),
				});
				if (!command.confirmed) {
					yield* replyText(
						`${preview}\n${config.dryRun ? "Dry run — no transactions sent. Live execution via chat stays disabled while DRY_RUN=true." : "Tap ✅ Confirm below or send <code>/rebalance confirm</code> to execute live."}`,
						confirmInlineKeyboard(config.dryRun),
					);
					return;
				}
				yield* replyText(
					`${preview}\nDry run — no transactions sent (DRY_RUN=true overrides <code>/rebalance confirm</code>).`,
				);
				// Live confirms defer earlier via shouldDeferLiveConfirm, so reaching
				// here means preview-only. Never execute live in the fast loop.
				return;
			}
			const _exhaustive: never = command;
			return _exhaustive;
		}),
		(error) =>
			Effect.gen(function* () {
				const message = error instanceof Error ? error.message : String(error);
				yield* Effect.sync(() =>
					console.warn(`[${nowStamp()}] Telegram command failed: ${message}`),
				);
				// Console-only failures are invisible in chat. Reply so /status
				// and /rebalance errors (e.g. no funded position in this pool)
				// surface in Telegram. Never fails the caller.
				const exit = yield* Effect.exit(AppConfig);
				if (exit._tag === "Success") {
					yield* notifyTelegramText(
						formatCommandError(message),
						exit.value.telegram,
					);
				}
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
			if (isBotPaused()) {
				console.log(`[${nowStamp()}] Paused — holding queued live confirm.`);
				return;
			}
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
			const tunables = yield* getTunables();
			const state = yield* loadPositionState({
				poolAddress: tunables.poolAddress,
			});
			const snapshot = state.snapshot;
			if (
				!shouldRebalance(
					snapshot.activeBinId,
					snapshot.lowerBinId,
					snapshot.upperBinId,
				)
			) {
				yield* replyText(formatInRangeReply(snapshot));
				return;
			}
			const halfWidth = originalHalfRange(
				snapshot.lowerBinId,
				snapshot.upperBinId,
			);
			const plan = yield* planZapRebalance({
				poolAddress: tunables.poolAddress,
				positionAddress: snapshot.position,
				strategy: tunables.strategy,
				slippageBps: tunables.slippageBps,
				halfWidth,
				jupiterApiKey: config.jupiterApiKey,
			});
			const compound: CompoundFeesInput = {
				enabled: tunables.compoundFees,
				poolAddress: tunables.poolAddress,
				positionAddress: snapshot.position,
				feeX: snapshot.feeX,
				feeY: snapshot.feeY,
				strategy: tunables.strategy,
				slippageBps: tunables.slippageBps,
			};
			const reaccumulate: ReaccumulateInput = {
				enabled: tunables.reaccumulateFeesToSol,
				poolAddress: tunables.poolAddress,
				feeX: snapshot.feeX,
				feeY: snapshot.feeY,
				slippageBps: tunables.slippageBps,
				jupiterApiKey: config.jupiterApiKey,
			};
			printPreview(
				plan,
				{
					pool: snapshot.pool,
					position: snapshot.position,
					activeBinId: snapshot.activeBinId,
					lowerBinId: snapshot.lowerBinId,
					upperBinId: snapshot.upperBinId,
					tokenXMint: snapshot.tokenXMint,
					tokenYMint: snapshot.tokenYMint,
				},
				compound,
				reaccumulate,
			);
			const done = yield* executeZapRebalance({ plan, compound, reaccumulate });
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
			Effect.gen(function* () {
				const message = error instanceof Error ? error.message : String(error);
				yield* Effect.sync(() =>
					console.warn(`[${nowStamp()}] Telegram command failed: ${message}`),
				);
				const exit = yield* Effect.exit(AppConfig);
				if (exit._tag === "Success") {
					yield* notifyTelegramText(
						formatCommandError(message),
						exit.value.telegram,
					);
				}
			}),
	);
}

// Fast command loop on its own TELEGRAM_POLL_INTERVAL_MS timer for no-delay
// replies. Interval is read live per loop so /config edits apply promptly.
// Shares the existing stopped flag with the main loop: SIGINT/SIGTERM
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
		const liveTelegramMs = await Effect.runPromise(
			Effect.provide(getTunables(), appLive),
		).then(
			(tunables) => tunables.telegramPollIntervalMs,
			() => boot.telegramPollIntervalMs,
		);
		await new Promise<void>((resolve) => {
			setTimeout(resolve, liveTelegramMs);
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
	const livePollMs = await Effect.runPromise(
		Effect.provide(getTunables(), appLive),
	).then(
		(tunables) => tunables.pollIntervalMs,
		() => boot.pollIntervalMs,
	);
	await new Promise<void>((resolve) => {
		wake = resolve;
		setTimeout(resolve, livePollMs);
	});
	wake = undefined;
}

await telegramLoop;

await Effect.runPromise(Effect.provide(notify({ kind: "shutdown" }), appLive));
