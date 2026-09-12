import { Connection, Keypair } from "@solana/web3.js";
import { Context, Effect, Layer } from "effect";
import { type BotConfig, type EnvSource, loadConfig } from "./config.ts";

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

export function makeAppLive(env: EnvSource) {
	const configLive = makeConfigLive(env);
	return Layer.merge(
		configLive,
		Layer.provide(Layer.merge(connectionLive, signerLive), configLive),
	);
}
