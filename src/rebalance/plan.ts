import BN from "bn.js";
import { Data, Effect } from "effect";

export class PlanError extends Data.TaggedError("PlanError")<{
	message: string;
}> {}

export type StrategyKind = "Spot" | "Curve" | "BidAsk";

export interface StrategyRange {
	kind: StrategyKind;
	minBinId: number;
	maxBinId: number;
}

export type SwapDirection = "XtoY" | "YtoX" | "None";

export interface SwapLeg {
	direction: SwapDirection;
	inMint: string;
	outMint: string;
	inAmount: BN;
	minOutAmount: BN;
}

export interface PositionSnapshot {
	pool: string;
	position: string;
	owner: string;
	activeBinId: number;
	lowerBinId: number;
	upperBinId: number;
	amountX: BN;
	amountY: BN;
	feeX: BN;
	feeY: BN;
	claimedFeeX: BN;
	claimedFeeY: BN;
	tokenXMint: string;
	tokenYMint: string;
	activeBinPrice?: string;
}

export interface RebalancePlan {
	pool: string;
	position: string;
	activeBinId: number;
	currentX: BN;
	currentY: BN;
	claimedFeeX: BN;
	claimedFeeY: BN;
	targetX: BN;
	targetY: BN;
	strategy: StrategyRange;
	swap: SwapLeg;
	slippageBps: number;
}

export interface PlanOptions {
	slippageBps: number;
	compoundFees: boolean;
	strategy: StrategyKind;
}

export interface TokenMints {
	xMint: string;
	yMint: string;
}

export const DUST_THRESHOLD = new BN(1000);
const BPS_BASE = new BN(10_000);

export function rangeForActiveBin(
	activeBinId: number,
	halfRange: number,
): { minBinId: number; maxBinId: number } {
	return {
		minBinId: activeBinId - halfRange,
		maxBinId: activeBinId + halfRange,
	};
}

export function originalHalfRange(
	lowerBinId: number,
	upperBinId: number,
): number {
	return Math.max(1, Math.floor((upperBinId - lowerBinId) / 2));
}

export function shouldRebalance(
	activeBinId: number,
	lowerBinId: number,
	upperBinId: number,
): boolean {
	return activeBinId < lowerBinId || activeBinId > upperBinId;
}

function applySlippage(inAmount: BN, slippageBps: number): BN {
	return inAmount.mul(new BN(10_000 - slippageBps)).div(BPS_BASE);
}

function noneLeg(mints: TokenMints): SwapLeg {
	return {
		direction: "None",
		inMint: mints.xMint,
		outMint: mints.yMint,
		inAmount: new BN(0),
		minOutAmount: new BN(0),
	};
}

export function previewSwapDelta(
	haveX: BN,
	haveY: BN,
	targetX: BN,
	targetY: BN,
	mints: TokenMints,
	slippageBps = 50,
): SwapLeg {
	const excessX = haveX.sub(targetX);
	const excessY = haveY.sub(targetY);
	const zero = new BN(0);
	if (excessX.gt(zero) && excessY.lte(zero)) {
		return {
			direction: "XtoY",
			inMint: mints.xMint,
			outMint: mints.yMint,
			inAmount: excessX,
			minOutAmount: applySlippage(excessX, slippageBps),
		};
	}
	if (excessY.gt(zero) && excessX.lte(zero)) {
		return {
			direction: "YtoX",
			inMint: mints.yMint,
			outMint: mints.xMint,
			inAmount: excessY,
			minOutAmount: applySlippage(excessY, slippageBps),
		};
	}
	return noneLeg(mints);
}

export function buildRebalancePlan(
	snapshot: PositionSnapshot,
	opts: PlanOptions,
): Effect.Effect<RebalancePlan, PlanError> {
	return Effect.gen(function* () {
		if (
			!Number.isInteger(snapshot.lowerBinId) ||
			!Number.isInteger(snapshot.upperBinId) ||
			snapshot.upperBinId <= snapshot.lowerBinId
		) {
			return yield* new PlanError({
				message: `invalid position range: ${snapshot.lowerBinId}-${snapshot.upperBinId}`,
			});
		}
		const halfWidth = originalHalfRange(
			snapshot.lowerBinId,
			snapshot.upperBinId,
		);
		if (!Number.isInteger(halfWidth) || halfWidth < 1 || halfWidth > 1024) {
			return yield* new PlanError({
				message: `invalid halfWidth: ${halfWidth}`,
			});
		}
		if (
			!Number.isInteger(opts.slippageBps) ||
			opts.slippageBps < 0 ||
			opts.slippageBps > 10_000
		) {
			return yield* new PlanError({
				message: `invalid slippageBps: ${opts.slippageBps}`,
			});
		}

		// Unclaimed fees are withdrawn on exit but only redeposited when compounding.
		const haveX = opts.compoundFees
			? snapshot.amountX.add(snapshot.feeX)
			: snapshot.amountX;
		const haveY = opts.compoundFees
			? snapshot.amountY.add(snapshot.feeY)
			: snapshot.amountY;
		const hasX = haveX.gt(DUST_THRESHOLD);
		const hasY = haveY.gt(DUST_THRESHOLD);
		if (!hasX && !hasY) {
			return yield* new PlanError({ message: "position holds no liquidity" });
		}

		const mints: TokenMints = {
			xMint: snapshot.tokenXMint,
			yMint: snapshot.tokenYMint,
		};
		let desiredX: BN;
		let desiredY: BN;
		if (hasX && hasY) {
			desiredX = haveX;
			desiredY = haveY;
		} else if (hasX) {
			// Raw-unit split is an estimate; Jupiter's quote sets the real out amount.
			desiredX = haveX.div(new BN(2));
			desiredY = haveX.sub(desiredX);
		} else {
			desiredY = haveY.div(new BN(2));
			desiredX = haveY.sub(desiredY);
		}

		let swap = previewSwapDelta(
			haveX,
			haveY,
			desiredX,
			desiredY,
			mints,
			opts.slippageBps,
		);
		if (swap.inAmount.lte(DUST_THRESHOLD)) {
			swap = noneLeg(mints);
		}

		// Post-swap estimates: minOut is a lower bound, so targets never exceed
		// what the wallet can hold after exit + swap.
		const targetX =
			swap.direction === "XtoY"
				? haveX.sub(swap.inAmount)
				: swap.direction === "YtoX"
					? haveX.add(swap.minOutAmount)
					: haveX;
		const targetY =
			swap.direction === "XtoY"
				? haveY.add(swap.minOutAmount)
				: swap.direction === "YtoX"
					? haveY.sub(swap.inAmount)
					: haveY;

		const { minBinId, maxBinId } = rangeForActiveBin(
			snapshot.activeBinId,
			halfWidth,
		);
		return {
			pool: snapshot.pool,
			position: snapshot.position,
			activeBinId: snapshot.activeBinId,
			currentX: haveX,
			currentY: haveY,
			claimedFeeX: snapshot.claimedFeeX,
			claimedFeeY: snapshot.claimedFeeY,
			targetX,
			targetY,
			strategy: { kind: opts.strategy, minBinId, maxBinId },
			swap,
			slippageBps: opts.slippageBps,
		} satisfies RebalancePlan;
	});
}
