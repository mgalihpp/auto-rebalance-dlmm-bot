import DLMM from "@meteora-ag/dlmm";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Duration, Effect } from "effect";
import { type BotConfig, type ConfigError, loadConfig } from "./src/config.ts";
import { decide } from "./src/decision.ts";
import {
	DlmmError,
	executeRebalance,
	fetchSnapshot,
	loadKeypair,
	logDryRunPlan,
} from "./src/dlmm.ts";

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
					yield* Effect.sync(() => console.log(`[ERROR] ${e.message}`));
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
				console.log(
					`[${ts}] status=${snapshot.status} active=${snapshot.activeBinId} range=[${snapshot.lowerBinId},${snapshot.upperBinId}] decision=Hold reason="${decision.reason}" dryRun=${config.dryRun}`,
				),
			);
		} else {
			yield* Effect.sync(() =>
				console.log(
					`[${ts}] status=${snapshot.status} active=${snapshot.activeBinId} range=[${snapshot.lowerBinId},${snapshot.upperBinId}] decision=Rebalance strategy=${decision.plan.strategy} dryRun=${config.dryRun}`,
				),
			);
			if (config.dryRun || !owner || !config.positionPubkey) {
				yield* logDryRunPlan(snapshot, decision.plan);
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
							console.log(`[ERROR] ${e.message}`);
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
								console.log(`[ERROR] rebalance failed: ${e.message}`),
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
				console.log(`[CONFIG] ${e.message}`);
				console.log(
					"[CONFIG] Copy .env.example to .env, fill RPC_URL + POOL_ADDRESS (+ POSITION_PUBKEY to track a position). Exiting 0.",
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
				console.log(`[WARN] wallet not loaded (${e.message}), pool-monitor mode`);
				return null;
			}),
		),
	);
	if (!config.dryRun && (!owner || !config.positionPubkey)) {
		console.log(
			"[CONFIG] DRY_RUN=false needs a valid WALLET_PRIVATE_KEY and POSITION_PUBKEY. Set them or keep DRY_RUN=true. Exiting 1.",
		);
		process.exit(1);
	}

	const connection = new Connection(config.rpcUrl, "confirmed");
	yield* Effect.sync(() =>
		console.log(
			`[BOOT] pool=${config.poolAddress} position=${config.positionPubkey ?? "(monitor only)"} ` +
				`strategy=${config.strategy} edgeBuffer=${config.edgeBufferBins} interval=${config.checkIntervalMs}ms dryRun=${config.dryRun}`,
		),
	);

	while (true) {
		yield* oneCycle(connection, config, owner);
		yield* Effect.sleep(Duration.millis(config.checkIntervalMs));
	}
});

Effect.runPromise(main).catch((e) => {
	console.log(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
