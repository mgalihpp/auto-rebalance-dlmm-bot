import { describe, expect, test } from "bun:test";
import { StrategyType } from "@meteora-ag/dlmm";
import type { DlmmDirectRebalanceEstimate } from "@meteora-ag/zap-sdk";
import { DlmmSwapType } from "@meteora-ag/zap-sdk";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { describeZapSwap } from "../src/rebalance/zap.ts";

function makeEstimate(
	swapType: DlmmSwapType,
	swapAmount: string,
	expectedOutput: string,
): DlmmDirectRebalanceEstimate {
	return {
		result: {
			swapType,
			swapAmount: new BN(swapAmount),
			expectedOutput: new BN(expectedOutput),
			postSwapX: new BN("902690000"),
			postSwapY: new BN("756000000"),
			quote: null,
		},
		context: {
			lbPair: PublicKey.default,
			position: PublicKey.default,
			swapSlippageBps: 50,
			minDeltaId: -2,
			maxDeltaId: 2,
			strategy: StrategyType.Spot,
		},
	};
}

describe("describeZapSwap", () => {
	test("XToY prints amount and expected output", () => {
		expect(
			describeZapSwap(
				makeEstimate(DlmmSwapType.XToY, "671350000", "559000000"),
			),
		).toBe("X -> Y amount=671350000 expectedOut=559000000");
	});

	test("YToX prints the reverse arrow", () => {
		expect(
			describeZapSwap(makeEstimate(DlmmSwapType.YToX, "1000000", "990000")),
		).toBe("Y -> X amount=1000000 expectedOut=990000");
	});

	test("NoSwap prints none", () => {
		expect(describeZapSwap(makeEstimate(DlmmSwapType.NoSwap, "0", "0"))).toBe(
			"none",
		);
	});
});
