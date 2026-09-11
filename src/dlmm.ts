import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import {
	type Connection,
	Keypair,
	PublicKey,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { Effect } from "effect";
import type { BotConfig } from "./config.ts";
import {
	deriveStatus,
	type PositionSnapshot,
	type RebalancePlan,
} from "./decision.ts";

export class DlmmError extends Error {
	readonly _tag = "DlmmError";
}

const dlmmFail = (msg: string): Effect.Effect<never, DlmmError> =>
	Effect.fail(new DlmmError(msg));

export const loadKeypair = (
	walletPrivateKey: string | null,
): Effect.Effect<Keypair | null, DlmmError> =>
	Effect.tryPromise({
		try: async () => {
			if (!walletPrivateKey) return null;
			const raw = walletPrivateKey.trim();
			const bytes = parseSecretBytes(raw);
			if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
			if (bytes.length === 32) return Keypair.fromSeed(bytes);
			throw new Error(
				`expected 64-byte secret key or 32-byte seed, got ${bytes.length} bytes`,
			);
		},
		catch: (e) =>
			new DlmmError(
				`Failed to load wallet from WALLET_PRIVATE_KEY: ${e instanceof Error ? e.message : String(e)}`,
			),
	});

// why: beacon format is wallet UX, JSON array is solana-keygen UX. Both
// decode to the same bytes, so accept either instead of forcing a conversion.
function parseSecretBytes(raw: string): Uint8Array {
	if (raw.startsWith("[")) {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
			throw new Error("JSON key must be an array of bytes (0-255)");
		}
		return Uint8Array.from(arr as number[]);
	}
	return bs58.decode(raw);
}

export const fetchSnapshot = (
	connection: Connection,
	poolAddress: string,
	positionPubkey: string | null,
	edgeBufferBins: number,
): Effect.Effect<PositionSnapshot, DlmmError> =>
	Effect.tryPromise({
		try: async (): Promise<PositionSnapshot> => {
			const dlmm = await DLMM.create(connection, new PublicKey(poolAddress));
			const active = await dlmm.getActiveBin();
			const activeBinId = active.binId;

			if (!positionPubkey) {
				return {
					poolAddress,
					activeBinId,
					lowerBinId: null,
					upperBinId: null,
					status: "NoPosition",
				};
			}

			const pos = await dlmm.getPosition(new PublicKey(positionPubkey));
			const lowerBinId = pos.positionData.lowerBinId;
			const upperBinId = pos.positionData.upperBinId;
			return {
				poolAddress,
				activeBinId,
				lowerBinId,
				upperBinId,
				status: deriveStatus(
					activeBinId,
					lowerBinId,
					upperBinId,
					edgeBufferBins,
				),
			};
		},
		catch: (e) =>
			new DlmmError(
				`fetchSnapshot failed: ${e instanceof Error ? e.message : String(e)}`,
			),
	});

export interface RebalanceContext {
	connection: Connection;
	dlmm: InstanceType<typeof DLMM>;
	owner: Keypair;
}

const slippagePct = (bps: number): number => bps / 100;

// Native rebalance path: simulate + rebalance_liquidity keeps the same position
// account alive (no close/reopen), so no position rent is burned.
export const planRebalance = (
	ctx: RebalanceContext,
	config: BotConfig,
	snapshot: PositionSnapshot,
	plan: RebalancePlan,
): Effect.Effect<void, DlmmError> => {
	if (
		config.dryRun ||
		snapshot.lowerBinId === null ||
		snapshot.upperBinId === null ||
		!config.positionPubkey
	) {
		return Effect.sync(() => {
			console.log(
				`[DRY_RUN] would rebalance pool=${snapshot.poolAddress} active=${snapshot.activeBinId} ` +
					`oldRange=[${snapshot.lowerBinId},${snapshot.upperBinId}] ` +
					`strategy=${plan.strategy} width follows existing position`,
			);
		});
	}

	return Effect.tryPromise({
		try: async () => {
			const { connection, dlmm, owner } = ctx;
			const position = new PublicKey(config.positionPubkey as string);
			const { positionData } = await dlmm.getPosition(position);
			// why: x/yWithdrawBps are the haircut kept out of redeposit, so 0 with
			// zero top-up means full Spot recenter funded only by withdrawn amounts.
			const response =
				await dlmm.simulateRebalancePositionWithBalancedStrategy(
					position,
					positionData,
					StrategyType.Spot,
					new BN(0),
					new BN(0),
					new BN(0),
					new BN(0),
				);
			const { initBinArrayInstructions, rebalancePositionInstruction } =
				await dlmm.rebalancePosition(
					response,
					new BN(plan.maxActiveBinSlippage),
					owner.publicKey,
					slippagePct(config.slippageBps),
				);
			const sendIxs = async (ixs: TransactionInstruction[]) => {
				const { blockhash, lastValidBlockHeight } =
					await connection.getLatestBlockhash("confirmed");
				const tx = new Transaction({
					feePayer: owner.publicKey,
					blockhash,
					lastValidBlockHeight,
				}).add(...ixs);
				return connection.sendTransaction(tx, [owner], {
					skipPreflight: false,
				});
			};
			if (initBinArrayInstructions.length > 0) {
				const sig = await sendIxs(initBinArrayInstructions);
				console.log(`[LIVE] initBinArrays sent: ${sig}`);
			}
			const sig = await sendIxs(rebalancePositionInstruction);
			console.log(
				`[LIVE] rebalanceLiquidity sent: ${sig} ` +
					`oldRange=[${snapshot.lowerBinId},${snapshot.upperBinId}] ` +
					`strategy=${plan.strategy}`,
			);
		},
		catch: (e) =>
			new DlmmError(
				`planRebalance live execution failed: ${e instanceof Error ? e.message : String(e)}`,
			),
	}).pipe(Effect.catch((e) => dlmmFail(e.message)));
};
