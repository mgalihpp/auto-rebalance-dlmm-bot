import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Effect, Ref } from "effect";
import {
	type EnvSource,
	loadConfig,
	tunablesFromConfig,
} from "../src/config.ts";
import {
	AppConfig,
	AppSigner,
	makeAppLive,
	makeAppLiveWithTunables,
	RuntimeTunables,
	SolanaConnection,
} from "../src/services.ts";

function makeEnv(overrides?: EnvSource): EnvSource {
	return {
		RPC_URL: "https://api.mainnet-beta.solana.com",
		POOL_ADDRESS: Keypair.generate().publicKey.toBase58(),
		PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey),
		...overrides,
	};
}

describe("app live layer", () => {
	test("provides config, connection, and signer from env", async () => {
		const secret = Keypair.generate();
		const pool = Keypair.generate().publicKey.toBase58();
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const config = yield* AppConfig;
					const connection = yield* SolanaConnection;
					const signer = yield* AppSigner;
					return {
						poolAddress: config.poolAddress,
						endpoint: connection.rpcEndpoint,
						signer: signer.publicKey.toBase58(),
					};
				}),
				makeAppLive(
					makeEnv({
						POOL_ADDRESS: pool,
						PRIVATE_KEY: bs58.encode(secret.secretKey),
					}),
				),
			),
		);
		expect(result.poolAddress).toBe(pool);
		expect(result.endpoint).toContain("solana.com");
		expect(result.signer).toBe(secret.publicKey.toBase58());
	});

	test("fails when env is invalid", async () => {
		await expect(
			Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						return yield* AppConfig;
					}),
					makeAppLive({}),
				),
			),
		).rejects.toThrow();
	});

	test("shared tunables ref persists across runs", async () => {
		const env = makeEnv({ STRATEGY: "Spot" });
		const config = await Effect.runPromise(loadConfig(env));
		const ref = await Effect.runPromise(Ref.make(tunablesFromConfig(config)));
		const shared = makeAppLiveWithTunables(env, ref);
		await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const tunables = yield* RuntimeTunables;
					const current = yield* Ref.get(tunables);
					yield* Ref.set(tunables, { ...current, strategy: "Curve" as const });
				}),
				shared,
			),
		);
		const after = await Effect.runPromise(
			Effect.provide(
				Effect.gen(function* () {
					const tunables = yield* RuntimeTunables;
					return yield* Ref.get(tunables);
				}),
				shared,
			),
		);
		expect(after.strategy).toBe("Curve");
	});
});
