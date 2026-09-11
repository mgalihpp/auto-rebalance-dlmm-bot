import { describe, expect, test } from "bun:test";
import { StrategyType } from "@meteora-ag/dlmm";
import BN from "bn.js";
import { Effect } from "effect";
import { toStrategyType } from "../src/rebalance/dlmm.ts";
import {
	buildRebalancePlan,
	originalHalfRange,
	type PositionSnapshot,
	previewSwapDelta,
	rangeForActiveBin,
	shouldRebalance,
} from "../src/rebalance/plan.ts";

const MINTS = { xMint: "MintX111", yMint: "MintY111" };

function makeSnapshot(overrides?: Partial<PositionSnapshot>): PositionSnapshot {
	return {
		pool: "Pool111",
		position: "Position111",
		owner: "Owner111",
		activeBinId: 1000,
		lowerBinId: 966,
		upperBinId: 1034,
		amountX: new BN(1_000_000),
		amountY: new BN(2_000_000),
		feeX: new BN(0),
		feeY: new BN(0),
		claimedFeeX: new BN(10_000),
		claimedFeeY: new BN(20_000),
		tokenXMint: MINTS.xMint,
		tokenYMint: MINTS.yMint,
		...overrides,
	};
}

describe("rangeForActiveBin", () => {
	test("centers the range on the active bin", () => {
		expect(rangeForActiveBin(1000, 34)).toEqual({
			minBinId: 966,
			maxBinId: 1034,
		});
	});
});

describe("shouldRebalance", () => {
	test("stays put when centered", () => {
		expect(shouldRebalance(1000, 966, 1034, 10)).toBe(false);
	});

	test("fires near the edge", () => {
		expect(shouldRebalance(970, 966, 1034, 10)).toBe(true);
		expect(shouldRebalance(1030, 966, 1034, 10)).toBe(true);
	});

	test("fires outside the range", () => {
		expect(shouldRebalance(900, 966, 1034, 10)).toBe(true);
		expect(shouldRebalance(1100, 966, 1034, 10)).toBe(true);
	});
});

describe("previewSwapDelta", () => {
	test("no swap when targets match holdings", () => {
		const leg = previewSwapDelta(
			new BN(1_000_000),
			new BN(2_000_000),
			new BN(1_000_000),
			new BN(2_000_000),
			MINTS,
			50,
		);
		expect(leg.direction).toBe("None");
		expect(leg.inAmount.isZero()).toBe(true);
		expect(leg.minOutAmount.isZero()).toBe(true);
	});

	test("XtoY when X exceeds its target", () => {
		const leg = previewSwapDelta(
			new BN(1_000_000),
			new BN(0),
			new BN(500_000),
			new BN(500_000),
			MINTS,
			50,
		);
		expect(leg.direction).toBe("XtoY");
		expect(leg.inMint).toBe(MINTS.xMint);
		expect(leg.outMint).toBe(MINTS.yMint);
		expect(leg.inAmount.toString()).toBe("500000");
		expect(leg.minOutAmount.toString()).toBe("497500");
	});

	test("YtoX when Y exceeds its target", () => {
		const leg = previewSwapDelta(
			new BN(0),
			new BN(2_000_000),
			new BN(1_000_000),
			new BN(1_000_000),
			MINTS,
			50,
		);
		expect(leg.direction).toBe("YtoX");
		expect(leg.inMint).toBe(MINTS.yMint);
		expect(leg.outMint).toBe(MINTS.xMint);
		expect(leg.inAmount.toString()).toBe("1000000");
		expect(leg.minOutAmount.toString()).toBe("995000");
	});
});

describe("buildRebalancePlan", () => {
	test("maps a Curve strategy around the active bin", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(makeSnapshot(), {
				slippageBps: 50,
				compoundFees: true,
				strategy: "Curve",
			}),
		);
		expect(plan.strategy).toEqual({
			kind: "Curve",
			minBinId: 966,
			maxBinId: 1034,
		});
		expect(plan.activeBinId).toBe(1000);
		expect(plan.slippageBps).toBe(50);
	});

	test("balanced holdings need no swap and keep targets", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(makeSnapshot(), {
				slippageBps: 50,
				compoundFees: true,
				strategy: "Curve",
			}),
		);
		expect(plan.swap.direction).toBe("None");
		expect(plan.currentX.toString()).toBe("1000000");
		expect(plan.currentY.toString()).toBe("2000000");
		expect(plan.targetX.toString()).toBe("1000000");
		expect(plan.targetY.toString()).toBe("2000000");
		expect(plan.claimedFeeX.toString()).toBe("10000");
		expect(plan.claimedFeeY.toString()).toBe("20000");
	});

	test("single-sided X plans an XtoY swap with slippage floor", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(
				makeSnapshot({ amountY: new BN(0), feeY: new BN(0) }),
				{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
			),
		);
		expect(plan.swap.direction).toBe("XtoY");
		expect(plan.swap.inAmount.toString()).toBe("500000");
		expect(plan.swap.minOutAmount.toString()).toBe("497500");
		expect(plan.targetX.toString()).toBe("500000");
		expect(plan.targetY.toString()).toBe("497500");
	});

	test("single-sided Y plans a YtoX swap", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(
				makeSnapshot({ amountX: new BN(0), feeX: new BN(0) }),
				{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
			),
		);
		expect(plan.swap.direction).toBe("YtoX");
		expect(plan.swap.inAmount.toString()).toBe("1000000");
		expect(plan.swap.minOutAmount.toString()).toBe("995000");
		expect(plan.targetX.toString()).toBe("995000");
		expect(plan.targetY.toString()).toBe("1000000");
	});

	test("unclaimed fees count toward redeposit totals", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(
				makeSnapshot({ amountX: new BN(900_000), feeX: new BN(100_000) }),
				{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
			),
		);
		expect(plan.currentX.toString()).toBe("1000000");
	});

	test("compoundFees true includes unclaimed fees in targets", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(
				makeSnapshot({
					amountX: new BN(900_000),
					feeX: new BN(100_000),
					feeY: new BN(200_000),
				}),
				{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
			),
		);
		expect(plan.currentX.toString()).toBe("1000000");
		expect(plan.currentY.toString()).toBe("2200000");
		expect(plan.targetX.toString()).toBe("1000000");
		expect(plan.targetY.toString()).toBe("2200000");
	});

	test("compoundFees false excludes unclaimed fees from targets", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(
				makeSnapshot({
					amountX: new BN(900_000),
					feeX: new BN(100_000),
					feeY: new BN(200_000),
				}),
				{ slippageBps: 50, compoundFees: false, strategy: "Curve" },
			),
		);
		expect(plan.currentX.toString()).toBe("900000");
		expect(plan.currentY.toString()).toBe("2000000");
		expect(plan.targetX.toString()).toBe("900000");
		expect(plan.targetY.toString()).toBe("2000000");
		expect(plan.claimedFeeX.toString()).toBe("10000");
		expect(plan.claimedFeeY.toString()).toBe("20000");
	});

	test("rejects an empty position", async () => {
		await expect(
			Effect.runPromise(
				buildRebalancePlan(
					makeSnapshot({
						amountX: new BN(0),
						amountY: new BN(0),
						feeX: new BN(0),
						feeY: new BN(0),
					}),
					{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
				),
			),
		).rejects.toThrow("position holds no liquidity");
	});

	test("rejects a derived half range above the max", async () => {
		await expect(
			Effect.runPromise(
				buildRebalancePlan(
					makeSnapshot({
						activeBinId: 1500,
						lowerBinId: 0,
						upperBinId: 3000,
					}),
					{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
				),
			),
		).rejects.toThrow("invalid halfWidth");
	});

	test("preserves the original width around the new active bin", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(makeSnapshot({ activeBinId: 1040 }), {
				slippageBps: 50,
				compoundFees: true,
				strategy: "Curve",
			}),
		);
		expect(plan.strategy).toEqual({
			kind: "Curve",
			minBinId: 1006,
			maxBinId: 1074,
		});
	});

	test("floors the half range on odd widths", () => {
		expect(originalHalfRange(0, 9)).toBe(4);
		expect(originalHalfRange(966, 1034)).toBe(34);
	});

	test("odd widths floor in the plan", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(
				makeSnapshot({
					activeBinId: 100,
					lowerBinId: 0,
					upperBinId: 9,
				}),
				{ slippageBps: 50, compoundFees: true, strategy: "Curve" },
			),
		);
		expect(plan.strategy).toEqual({
			kind: "Curve",
			minBinId: 96,
			maxBinId: 104,
		});
	});

	test("rejects an invalid snapshot range", async () => {
		await expect(
			Effect.runPromise(
				buildRebalancePlan(makeSnapshot({ lowerBinId: 100, upperBinId: 100 }), {
					slippageBps: 50,
					compoundFees: true,
					strategy: "Curve",
				}),
			),
		).rejects.toThrow("invalid position range");
		await expect(
			Effect.runPromise(
				buildRebalancePlan(makeSnapshot({ lowerBinId: 200, upperBinId: 100 }), {
					slippageBps: 50,
					compoundFees: true,
					strategy: "Curve",
				}),
			),
		).rejects.toThrow("invalid position range");
	});

	test("Spot kind flows through to plan.strategy.kind", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(makeSnapshot(), {
				slippageBps: 50,
				compoundFees: true,
				strategy: "Spot",
			}),
		);
		expect(plan.strategy).toEqual({
			kind: "Spot",
			minBinId: 966,
			maxBinId: 1034,
		});
	});

	test("BidAsk kind flows through to plan.strategy.kind", async () => {
		const plan = await Effect.runPromise(
			buildRebalancePlan(makeSnapshot(), {
				slippageBps: 50,
				compoundFees: true,
				strategy: "BidAsk",
			}),
		);
		expect(plan.strategy).toEqual({
			kind: "BidAsk",
			minBinId: 966,
			maxBinId: 1034,
		});
	});
});

describe("toStrategyType", () => {
	test("maps every StrategyKind to the SDK enum", () => {
		expect(toStrategyType("Spot")).toBe(StrategyType.Spot);
		expect(toStrategyType("Curve")).toBe(StrategyType.Curve);
		expect(toStrategyType("BidAsk")).toBe(StrategyType.BidAsk);
	});
});
