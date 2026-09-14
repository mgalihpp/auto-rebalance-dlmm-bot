import { readFile, rename, writeFile } from "node:fs/promises";
import { Connection, Keypair } from "@solana/web3.js";
import { Context, Effect, Layer, Ref } from "effect";
import {
	type BotConfig,
	ConfigError,
	type EnvSource,
	loadConfig,
	type Tunables,
	tunablesFromConfig,
} from "./config.ts";

export class AppConfig extends Context.Service<AppConfig, BotConfig>()(
	"bot/AppConfig",
) {}

export class SolanaConnection extends Context.Service<
	SolanaConnection,
	Connection
>()("bot/SolanaConnection") {}

export class AppSigner extends Context.Service<AppSigner, Keypair>()(
	"bot/AppSigner",
) {}

// Mutable runtime tunables. Telegram is the single writer, the loops only
// read a snapshot per iteration, so no shared-write races.
export class RuntimeTunables extends Context.Service<
	RuntimeTunables,
	Ref.Ref<Tunables>
>()("bot/RuntimeTunables") {}

export function makeConfigLive(env: EnvSource) {
	return Layer.effect(AppConfig, loadConfig(env));
}

const connectionLive = Layer.effect(
	SolanaConnection,
	Effect.gen(function* () {
		const config = yield* AppConfig;
		return new Connection(config.rpcUrl, "confirmed");
	}),
);

const signerLive = Layer.effect(
	AppSigner,
	Effect.gen(function* () {
		const config = yield* AppConfig;
		return Keypair.fromSecretKey(config.secretKey);
	}),
);

const tunablesLive = Layer.effect(
	RuntimeTunables,
	Effect.gen(function* () {
		const config = yield* AppConfig;
		return yield* Ref.make(tunablesFromConfig(config));
	}),
);

export function makeTunablesLive(ref: Ref.Ref<Tunables>) {
	return Layer.succeed(RuntimeTunables, ref);
}

export function makeAppLive(env: EnvSource) {
	const configLive = makeConfigLive(env);
	const depsLive = Layer.merge(
		Layer.merge(connectionLive, signerLive),
		tunablesLive,
	);
	return Layer.merge(configLive, Layer.provide(depsLive, configLive));
}

// Shared-Ref construction for the long-lived poll loop: ONE Ref instance is
// injected so every Effect.runPromise(Effect.provide(..., appLive)) in the
// main loop and the telegram fast loop reads and writes the same tunables.
export function makeAppLiveWithTunables(
	env: EnvSource,
	ref: Ref.Ref<Tunables>,
) {
	const configLive = makeConfigLive(env);
	const depsLive = Layer.merge(
		Layer.merge(connectionLive, signerLive),
		makeTunablesLive(ref),
	);
	return Layer.merge(configLive, Layer.provide(depsLive, configLive));
}

// Atomically persist one KEY=VALUE line to the dotenv file: read, replace or
// append, write tmp + rename. Creates the file when missing, preserves all
// other lines. Never logs file contents or secrets; failures surface as
// ConfigError with the reason only.
export const persistEnvKey = Effect.fn("persistEnvKey")(function* (
	key: string,
	value: string,
	envPath = ".env",
): Effect.fn.Return<void, ConfigError, never> {
	const line = `${key}=${value}`;
	const escapeRegExp = (text: string) =>
		text.replace(/[*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^\\s*(export\\s+)?${escapeRegExp(key)}\\s*=`);
	const previous: string | null = yield* Effect.catch(
		Effect.tryPromise({
			try: () => readFile(envPath, "utf8"),
			catch: (error: unknown) => error,
		}),
		(failure: unknown) => {
			const code =
				typeof failure === "object" &&
				failure !== null &&
				"code" in failure &&
				typeof failure.code === "string"
					? failure.code
					: "";
			if (code === "ENOENT") {
				return Effect.succeed(null);
			}
			const reason =
				failure instanceof Error ? failure.message : String(failure);
			return Effect.fail(
				new ConfigError({ message: `failed to persist ${key}: ${reason}` }),
			);
		},
	);
	let next: string;
	if (previous === null || previous === "") {
		next = `${line}\n`;
	} else {
		const lines = previous.split("\n");
		let found = false;
		const replaced = lines.map((entry) => {
			if (!found && pattern.test(entry)) {
				found = true;
				return line;
			}
			return entry;
		});
		if (!found) {
			const joined = replaced.join("\n");
			next = previous.endsWith("\n")
				? `${joined}${line}\n`
				: `${joined}\n${line}\n`;
		} else {
			const joined = replaced.join("\n");
			next = joined.endsWith("\n") ? joined : `${joined}\n`;
		}
	}
	const tmpPath = `${envPath}.tmp`;
	yield* Effect.mapError(
		Effect.tryPromise({
			try: async () => {
				await writeFile(tmpPath, next, "utf8");
				await rename(tmpPath, envPath);
			},
			catch: (error: unknown) => error,
		}),
		(failure: unknown) =>
			new ConfigError({
				message: `failed to persist ${key}: ${failure instanceof Error ? failure.message : String(failure)}`,
			}),
	);
});

export const persistPoolAddressToEnv = Effect.fn("persistPoolAddressToEnv")(
	function* (
		poolAddress: string,
		envPath = ".env",
	): Effect.fn.Return<void, ConfigError, never> {
		yield* persistEnvKey("POOL_ADDRESS", poolAddress, envPath);
	},
);
