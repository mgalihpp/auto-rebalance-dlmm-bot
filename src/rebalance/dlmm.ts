import DLMM, { type LbPosition, StrategyType } from "@meteora-ag/dlmm";
import {
	type Connection,
	Keypair,
	PublicKey,
	type Transaction,
} from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { Data, Effect } from "effect";
import type { PositionSnapshot, StrategyKind } from "./plan.ts";
import { sendManualTransaction } from "./send.ts";

export class DlmmError extends Data.TaggedError("DlmmError")<{
	message: string;
}> {}

export type PositionAmount = string | number | BN;

export interface PositionCandidate {
	publicKey: { toBase58(): string };
	positionData: {
		totalXAmount: PositionAmount;
		totalYAmount: PositionAmount;
		feeX?: PositionAmount;
		feeY?: PositionAmount;
	};
}

function toAmount(value: PositionAmount | undefined): BN {
	if (value === undefined) return new BN(0);
	if (typeof value === "number") return new BN(Math.trunc(value));
	if (typeof value === "string") {
		const text = value.trim();
		if (text === "" || text === "-" || text === ".") return new BN(0);
		const dot = text.indexOf(".");
		const head = dot < 0 ? text : text.slice(0, dot);
		if (head === "" || head === "-") return new BN(0);
		return new BN(head);
	}
	return value;
}

function isFunded(candidate: PositionCandidate): boolean {
	const total = toAmount(candidate.positionData.totalXAmount)
		.add(toAmount(candidate.positionData.totalYAmount))
		.add(toAmount(candidate.positionData.feeX))
		.add(toAmount(candidate.positionData.feeY));
	return total.gt(new BN(0));
}

export function resolvePosition<T extends PositionCandidate>(
	candidates: T[],
): T {
	const funded = candidates.filter(isFunded);
	if (funded.length === 0) {
		throw new DlmmError({
			message: "no DLMM position found for owner in this pool",
		});
	}
	const [pick] = funded;
	if (pick !== undefined && funded.length === 1) {
		return pick;
	}
	throw new DlmmError({
		message: `multiple funded positions found in this pool: ${funded.map((c) => c.publicKey.toBase58()).join(", ")}; run one bot instance per pool or withdraw the extra position`,
	});
}

export interface LoadStateInput {
	connection: Connection;
	poolAddress: string;
	owner: PublicKey;
}

export interface LoadedState {
	dlmm: DLMM;
	position: LbPosition;
	snapshot: PositionSnapshot;
}

export interface ClaimFeesInput {
	connection: Connection;
	dlmm: DLMM;
	signer: Keypair;
	position: LbPosition;
}

export interface ExitPositionInput {
	connection: Connection;
	dlmm: DLMM;
	signer: Keypair;
	position: LbPosition;
}

export interface EnterPositionInput {
	connection: Connection;
	dlmm: DLMM;
	signer: Keypair;
	totalX: BN;
	totalY: BN;
	minBinId: number;
	maxBinId: number;
	strategy: StrategyKind;
}

export function toStrategyType(kind: StrategyKind): StrategyType {
	switch (kind) {
		case "Spot":
			return StrategyType.Spot;
		case "Curve":
			return StrategyType.Curve;
		case "BidAsk":
			return StrategyType.BidAsk;
	}
}

function toDlmmError(error: unknown): DlmmError {
	return new DlmmError({
		message: error instanceof Error ? error.message : String(error),
	});
}

function sendAll(
	connection: Connection,
	txs: Transaction[],
	signers: Keypair[],
): Effect.Effect<string[], DlmmError> {
	return Effect.gen(function* () {
		const signatures: string[] = [];
		for (const tx of txs) {
			const signature = yield* Effect.mapError(
				sendManualTransaction({ connection, tx, signers }),
				(error) => toDlmmError(error),
			);
			signatures.push(signature);
		}
		return signatures;
	});
}

export function loadPositionState(
	input: LoadStateInput,
): Effect.Effect<LoadedState, DlmmError> {
	return Effect.gen(function* () {
		const dlmm = yield* Effect.tryPromise({
			try: async () =>
				DLMM.create(input.connection, new PublicKey(input.poolAddress)),
			catch: toDlmmError,
		});
		const { activeBin, userPositions } = yield* Effect.tryPromise({
			try: () => dlmm.getPositionsByUserAndLbPair(input.owner),
			catch: toDlmmError,
		});

		const position = yield* Effect.try({
			try: () => resolvePosition(userPositions),
			catch: (error) =>
				error instanceof DlmmError ? error : toDlmmError(error),
		});
		console.log(
			`Auto-selected position ${position.publicKey.toBase58()} (${userPositions.length} position(s) in pool)`,
		);

		const data = position.positionData;
		let activeBinPrice = activeBin.price;
		try {
			activeBinPrice = new Decimal(
				dlmm.fromPricePerLamport(Number(activeBin.price)),
			)
				.toSignificantDigits(6)
				.toString();
		} catch {
			activeBinPrice = activeBin.price;
		}

		const snapshot: PositionSnapshot = {
			pool: dlmm.pubkey.toBase58(),
			position: position.publicKey.toBase58(),
			owner: input.owner.toBase58(),
			activeBinId: activeBin.binId,
			lowerBinId: data.lowerBinId,
			upperBinId: data.upperBinId,
			amountX: new BN(data.totalXAmount),
			amountY: new BN(data.totalYAmount),
			feeX: data.feeX,
			feeY: data.feeY,
			claimedFeeX: data.totalClaimedFeeXAmount,
			claimedFeeY: data.totalClaimedFeeYAmount,
			tokenXMint: dlmm.lbPair.tokenXMint.toBase58(),
			tokenYMint: dlmm.lbPair.tokenYMint.toBase58(),
			activeBinPrice,
		};
		return { dlmm, position, snapshot };
	});
}

export function claimFees(
	input: ClaimFeesInput,
): Effect.Effect<string[], DlmmError> {
	const data = input.position.positionData;
	const pending = data.feeX
		.add(data.feeY)
		.add(data.rewardOne)
		.add(data.rewardTwo);
	if (pending.lte(new BN(0))) {
		return Effect.succeed([]);
	}
	return Effect.gen(function* () {
		const txs = yield* Effect.tryPromise({
			try: () =>
				input.dlmm.claimAllRewardsByPosition({
					owner: input.signer.publicKey,
					position: input.position,
				}),
			catch: toDlmmError,
		});
		return yield* sendAll(input.connection, txs, [input.signer]);
	});
}

export function exitPosition(
	input: ExitPositionInput,
): Effect.Effect<string[], DlmmError> {
	return Effect.gen(function* () {
		const { lowerBinId, upperBinId } = input.position.positionData;
		const txs = yield* Effect.tryPromise({
			try: () =>
				input.dlmm.removeLiquidity({
					user: input.signer.publicKey,
					position: input.position.publicKey,
					fromBinId: lowerBinId,
					toBinId: upperBinId,
					bps: new BN(10_000),
					shouldClaimAndClose: true,
				}),
			catch: toDlmmError,
		});
		return yield* sendAll(input.connection, txs, [input.signer]);
	});
}

export function enterPosition(
	input: EnterPositionInput,
): Effect.Effect<{ position: string; signature: string }, DlmmError> {
	return Effect.gen(function* () {
		const positionKeypair = Keypair.generate();
		const tx = yield* Effect.tryPromise({
			try: () =>
				input.dlmm.initializePositionAndAddLiquidityByStrategy({
					positionPubKey: positionKeypair.publicKey,
					user: input.signer.publicKey,
					totalXAmount: input.totalX,
					totalYAmount: input.totalY,
					strategy: {
						minBinId: input.minBinId,
						maxBinId: input.maxBinId,
						strategyType: toStrategyType(input.strategy),
					},
				}),
			catch: toDlmmError,
		});
		const signatures = yield* sendAll(
			input.connection,
			[tx],
			[input.signer, positionKeypair],
		);
		return {
			position: positionKeypair.publicKey.toBase58(),
			signature: signatures[0] ?? "",
		};
	});
}
