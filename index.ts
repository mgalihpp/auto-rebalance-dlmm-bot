import DLMM from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Duration, Effect } from "effect";
import { type BotConfig, type ConfigError, loadConfig } from "./src/config.ts";
import { decide, type PositionSnapshot, type RebalancePlan } from "./src/decision.ts";
import { DlmmError, fetchSnapshot, loadKeypair } from "./src/dlmm.ts";
import { log } from "./src/log.ts";
import {
	executeRebalance,
	logDryRunBalancedPlan,
	previewBalancedPlan,
} from "./src/rebalance.ts";

const logPlanDryRun = (
	connection: Connection,
	config: BotConfig,
	snapshot: PositionSnapshot,
	plan: RebalancePlan,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const dlmm: InstanceType<typeof DLMM> | null = yield* Effect.tryPromise({
			try: () => DLMM.create(connection, new PublicKey(config.poolAddress)),
			catch: () => new DlmmError("preview DLMM.create failed"),
		}).pipe(Effect.catch(() => Effect.succeed(null)));
		if (!dlmm) {
			yield* Effect.sync(() =>
				log(
					"DRY_RUN",
					`would rebalance pool=${snapshot.poolAddress} active=${snapshot.activeBinId} ` +
						`oldRange=[${snapshot.lowerBinId},${snapshot.upperBinId}] strategy=${plan.strategy} (preview unavailable)`,
				),
			);
			return;
		}
		yield* previewBalancedPlan({ dlmm, config, snapshot }).pipe(
			Effect.flatMap((balancedPlan) =>
				logDryRunBalancedPlan(
					snapshot,
					balancedPlan,
					{
						tokenXMint: dlmm.tokenX.publicKey.toBase58(),
						tokenYMint: dlmm.tokenY.publicKey.toBase58(),
						decimalsX: dlmm.tokenX.mint.decimals,
						decimalsY: dlmm.tokenY.mint.decimals,
					},
					config.compoundFees
						? undefined
						: { feeX: balancedPlan.feeX, feeY: balancedPlan.feeY },
				),
			),
			Effect.catch((e: DlmmError) =>
				Effect.sync(() => log("DRY_RUN", `preview failed: ${e.message}`)),
			),
		);
	});

const oneCycle = (
	connection: Connection,
	config: BotConfig,
	owner: Keypair | null,
): Effect.Effect<void, never> =>
	Effect.gen(function* () {
		const snapshot = yield* fetchSnapshot(
			connection,
			config.poolAddress,
			config.positionPubkey,
			config.edgeBufferBins,
		).pipe(
			Effect.catch((e: DlmmError) =>
				Effect.gen(function* () {
					yield* Effect.sync(() => log("ERROR", e.message));
					return {
						poolAddress: config.poolAddress,
						activeBinId: -1,
						lowerBinId: null as number | null,
						upperBinId: null as number | null,
						status: "Error" as const,
					};
				}),
			),
		);

		const decision = decide(snapshot, {
			edgeBufferBins: config.edgeBufferBins,
			strategy: config.strategy,
		});
		const ts = new Date().toISOString();
		if (decision._tag === "Hold") {
			yield* Effect.sync(() =>
				log(
					"HOLD",
					`ts=${ts} status=${snapshot.status} active=${snapshot.activeBinId} range=[${snapshot.lowerBinId},${snapshot.upperBinId}] reason="${decision.reason}"`,
				),
			);
		} else {
			yield* Effect.sync(() =>
				log(
					"REBALANCE",
					`ts=${ts} status=${snapshot.status} active=${snapshot.activeBinId} range=[${snapshot.lowerBinId},${snapshot.upperBinId}] strategy=${decision.plan.strategy}`,
				),
			);
			if (config.dryRun || !owner || !config.positionPubkey) {
				yield* logPlanDryRun(connection, config, snapshot, decision.plan);
			} else {
				const dlmm: InstanceType<typeof DLMM> | null = yield* Effect.tryPromise(
					{
						try: () => DLMM.create(connection, new PublicKey(config.poolAddress)),
						catch: (e) =>
							new DlmmError(
								`DLMM.create failed: ${e instanceof Error ? e.message : String(e)}`,
							),
					},
				).pipe(
					Effect.catch((e: DlmmError) =>
						Effect.sync(() => {
							log("ERROR", e.message);
							return null;
						}),
					),
				);
				if (dlmm) {
					yield* executeRebalance(
						{ connection, dlmm, owner },
						config,
						snapshot,
						decision.plan,
					).pipe(
						Effect.catch((e: DlmmError) =>
							Effect.sync(() =>
								log("ERROR", `rebalance failed: ${e.message}`),
							),
						),
					);
				}
			}
		}
	});

const main: Effect.Effect<void, never> = Effect.gen(function* () {
	const maybeConfig = yield* loadConfig().pipe(
		Effect.map((c): BotConfig | null => c),
		Effect.catch((e: ConfigError) =>
			Effect.sync(() => {
				log("CONFIG", e.message);
				log(
					"CONFIG",
					"Copy .env.example to .env, fill RPC_URL + POOL_ADDRESS (+ POSITION_PUBKEY to track a position). Exiting 0.",
				);
				process.exit(0);
				return null;
			}),
		),
	);
	if (!maybeConfig) return;
	const config = maybeConfig;

	const owner = yield* loadKeypair(config.walletPrivateKey).pipe(
		Effect.map((k): Keypair | null => k),
		Effect.catch((e: DlmmError) =>
			Effect.sync(() => {
				log("WARN", `wallet not loaded (${e.message}), pool-monitor mode`);
				return null;
			}),
		),
	);
	if (!config.dryRun && (!owner || !config.positionPubkey)) {
		log(
			"CONFIG",
			"DRY_RUN=false needs a valid WALLET_PRIVATE_KEY and POSITION_PUBKEY. Set them or keep DRY_RUN=true. Exiting 1.",
		);
		process.exit(1);
	}

	const connection = new Connection(config.rpcUrl, "confirmed");
	yield* Effect.sync(() =>
		log(
			"BOOT",
			`pool=${config.poolAddress} position=${config.positionPubkey ?? "(monitor only)"} ` +
				`strategy=${config.strategy} edgeBuffer=${config.edgeBufferBins} interval=${config.checkIntervalMs}ms dryRun=${config.dryRun}`,
		),
	);

	while (true) {
		yield* oneCycle(connection, config, owner);
		yield* Effect.sleep(Duration.millis(config.checkIntervalMs));
	}
});

Effect.runPromise(main).catch((e) => {
	log("FATAL", e instanceof Error ? e.message : String(e));
	process.exit(1);
});
