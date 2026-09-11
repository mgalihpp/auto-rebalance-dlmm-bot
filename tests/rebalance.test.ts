import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DlmmError } from "../src/dlmm.ts";
import {
	actualSwapOut,
	addBaseUnits,
	type BalancedPlanInputs,
	centerRange,
	completeRebalanceFromWallet,
	computeBalancedPlan,
	capTopUpToBalances,
	deriveTopUp,
	excludeFees,
	redepositAfterHaircut,
	resolveWidth,
	sizeFromWalletDelta,
	wrapAmountForReserve,
} from "../src/rebalance.ts";

const X_MINT = "So11111111111111111111111111111111111111112";
const Y_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const inputs = (over: Partial<BalancedPlanInputs>): BalancedPlanInputs => ({
	activeBinId: 100,
	widthBins: 5,
	strategy: "Spot",
	tokenXMint: X_MINT,
	tokenYMint: Y_MINT,
	withdrawnX: "0",
	withdrawnY: "0",
	activePrice: "1",
	slippageBps: 100,
	...over,
});

const run = <A>(eff: Effect.Effect<A, DlmmError>): Promise<A> =>
	Effect.runPromise(eff);

const runError = (eff: Effect.Effect<unknown, DlmmError>): Promise<DlmmError> =>
	Effect.runPromise(Effect.flip(eff));

describe("resolveWidth", () => {
	it("prefers an explicit override", () => {
		expect(resolveWidth(90, 110, 7)).toBe(7);
	});

	it("follows the snapshot range width", () => {
		expect(resolveWidth(90, 110, null)).toBe(21);
	});

	it("falls back to a minimal window without a snapshot range", () => {
		expect(resolveWidth(null, null, null)).toBe(3);
	});
});

describe("centerRange", () => {
	it("centers an odd width on the active bin", () => {
		expect(centerRange(100, 5)).toEqual({ lowerBinId: 98, upperBinId: 102 });
	});

	it("clamps degenerate widths to one bin", () => {
		expect(centerRange(100, 0)).toEqual({ lowerBinId: 100, upperBinId: 100 });
	});
});

describe("computeBalancedPlan", () => {
	it("X-only needs a swap from X to Y", async () => {
		const plan = await run(
			computeBalancedPlan(inputs({ withdrawnX: "1000", withdrawnY: "0" })),
		);
		expect(plan.swap.kind).toBe("swap");
		if (plan.swap.kind === "swap") {
			expect(plan.swap.inputMint).toBe(X_MINT);
			expect(plan.swap.outputMint).toBe(Y_MINT);
			expect(plan.swap.inAmount).toBe("500");
		}
	});

	it("Y-only needs a swap from Y to X", async () => {
		const plan = await run(
			computeBalancedPlan(inputs({ withdrawnX: "0", withdrawnY: "1000" })),
		);
		expect(plan.swap.kind).toBe("swap");
		if (plan.swap.kind === "swap") {
			expect(plan.swap.inputMint).toBe(Y_MINT);
			expect(plan.swap.outputMint).toBe(X_MINT);
			expect(plan.swap.inAmount).toBe("500");
		}
	});

	it("balanced deposits need no swap", async () => {
		const plan = await run(
			computeBalancedPlan(inputs({ withdrawnX: "100", withdrawnY: "100" })),
		);
		expect(plan.swap).toEqual({ kind: "none" });
		expect(plan.depositX).toBe("100");
		expect(plan.depositY).toBe("100");
	});

	it("empty withdrawals fail with a typed error", async () => {
		const err = await runError(
			computeBalancedPlan(inputs({ withdrawnX: "0", withdrawnY: "0" })),
		);
		expect(err).toBeInstanceOf(DlmmError);
		expect(err.message).toContain("nothing withdrawn");
	});

	it("a non-numeric price fails with a typed error", async () => {
		const err = await runError(
			computeBalancedPlan(
				inputs({ withdrawnX: "100", withdrawnY: "100", activePrice: "abc" }),
			),
		);
		expect(err).toBeInstanceOf(DlmmError);
		expect(err.message).toContain("not numeric");
	});

	it("sizes the swap on total+fee when compounding, principal-only otherwise", async () => {
		const compounded = addBaseUnits("1000", "200");
		expect(compounded).toBe("1200");
		const planCompound = await run(
			computeBalancedPlan(inputs({ withdrawnX: compounded, withdrawnY: "0" })),
		);
		expect(planCompound.swap.kind).toBe("swap");
		if (planCompound.swap.kind === "swap") {
			expect(planCompound.swap.inAmount).toBe("600");
		}
		// COMPOUND_FEES=false: caller passes principal only "1000"/"0".
		const planPrincipal = await run(
			computeBalancedPlan(inputs({ withdrawnX: "1000", withdrawnY: "0" })),
		);
		expect(planPrincipal.swap.kind).toBe("swap");
		if (planPrincipal.swap.kind === "swap") {
			expect(planPrincipal.swap.inAmount).toBe("500");
		}
	});
});

describe("addBaseUnits", () => {
	it("adds total and fee amounts", () => {
		expect(addBaseUnits("1000", "200")).toBe("1200");
		expect(addBaseUnits("0", "0")).toBe("0");
	});
});

describe("redepositAfterHaircut", () => {
	it("a full 10000 bps haircut redeposits nothing", () => {
		expect(redepositAfterHaircut("1200", 10000)).toBe("0");
	});

	it("a zero haircut redeposits the full total", () => {
		expect(redepositAfterHaircut("1200", 0)).toBe("1200");
	});
});

describe("excludeFees", () => {
	it("subtracts the fee from the wallet delta", () => {
		expect(excludeFees("1200", "200")).toBe("1000");
		expect(excludeFees("500", "0")).toBe("500");
	});

	it("floors at zero when the fee exceeds the delta", () => {
		expect(excludeFees("100", "200")).toBe("0");
		expect(excludeFees("0", "50")).toBe("0");
	});

	it("rejects non-base-unit input with a typed error", () => {
		expect(() => excludeFees("1.5", "10")).toThrow(DlmmError);
		expect(() => excludeFees("100", "-5")).toThrow(DlmmError);
		expect(() => excludeFees("abc", "10")).toThrow(DlmmError);
	});

	it("leaves the fee in the wallet when COMPOUND_FEES=false", () => {
		const delta = deriveTopUp({
			beforeX: "50",
			afterX: "1250",
			beforeY: "30",
			afterY: "730",
		});
		const topUpX = excludeFees(delta.topUpX, "200");
		const topUpY = excludeFees(delta.topUpY, "100");
		expect(topUpX).toBe("1000");
		expect(topUpY).toBe("600");
	});
});

describe("sizeFromWalletDelta", () => {
	it("sizes principal-only when COMPOUND_FEES=false", () => {
		expect(
			sizeFromWalletDelta({
				deltaX: "1200",
				deltaY: "700",
				feeX: "200",
				feeY: "100",
				compoundFees: false,
			}),
		).toEqual({ sizedX: "1000", sizedY: "600" });
	});

	it("sizes total+fee when compounding", () => {
		expect(
			sizeFromWalletDelta({
				deltaX: "1200",
				deltaY: "700",
				feeX: "200",
				feeY: "100",
				compoundFees: true,
			}),
		).toEqual({ sizedX: "1200", sizedY: "700" });
	});

	it("floors at zero when the fee exceeds the delta", () => {
		expect(
			sizeFromWalletDelta({
				deltaX: "100",
				deltaY: "0",
				feeX: "200",
				feeY: "0",
				compoundFees: false,
			}),
		).toEqual({ sizedX: "0", sizedY: "0" });
	});
});

describe("actualSwapOut", () => {
	it("prefers the actual totalOutputAmount from /execute", () => {
		expect(actualSwapOut("985", "990")).toBe("985");
	});

	it("falls back to the order outAmount when execute omits totals", () => {
		expect(actualSwapOut("0", "990")).toBe("990");
		expect(actualSwapOut("", "990")).toBe("990");
	});
});

describe("completeRebalanceFromWallet split", () => {
	it("is exported for the standalone recovery script", () => {
		expect(typeof completeRebalanceFromWallet).toBe("function");
	});

	it("recovery math: zero snapshot treats the full wallet as withdrawn", () => {
		const current = { x: "11814000000", y: "171000000" };
		const delta = deriveTopUp({
			beforeX: "0",
			afterX: current.x,
			beforeY: "0",
			afterY: current.y,
		});
		expect(delta).toEqual({
			topUpX: "11814000000",
			topUpY: "171000000",
		});
		const { sizedX, sizedY } = sizeFromWalletDelta({
			deltaX: delta.topUpX,
			deltaY: delta.topUpY,
			feeX: "0",
			feeY: "0",
			compoundFees: false,
		});
		expect(sizedX).toBe("11814000000");
		expect(sizedY).toBe("171000000");
	});

	it("normal math: wallet delta minus snapshot equals withdrawn principal", () => {
		const delta = deriveTopUp({
			beforeX: "50",
			afterX: "1250",
			beforeY: "30",
			afterY: "730",
		});
		const { sizedX, sizedY } = sizeFromWalletDelta({
			deltaX: delta.topUpX,
			deltaY: delta.topUpY,
			feeX: "200",
			feeY: "100",
			compoundFees: false,
		});
		expect(sizedX).toBe("1000");
		expect(sizedY).toBe("600");
	});
});

describe("deriveTopUp", () => {
	it("derives the topUp from post-swap minus pre-withdraw snapshot", () => {
		expect(
			deriveTopUp({
				beforeX: "50",
				afterX: "1250",
				beforeY: "30",
				afterY: "730",
			}),
		).toEqual({ topUpX: "1200", topUpY: "700" });
	});

	it("floors at zero when fees eat into the snapshot", () => {
		expect(
			deriveTopUp({
				beforeX: "100",
				afterX: "90",
				beforeY: "0",
				afterY: "0",
			}),
		).toEqual({ topUpX: "0", topUpY: "0" });
	});
});

describe("wrapAmountForReserve", () => {
	it("wraps everything above the reserve", () => {
		expect(
			wrapAmountForReserve({
				nativeLamports: "171000000",
				reserveLamports: 20000000,
			}),
		).toBe("151000000");
	});

	it("returns zero exactly at the reserve", () => {
		expect(
			wrapAmountForReserve({
				nativeLamports: "20000000",
				reserveLamports: 20000000,
			}),
		).toBe("0");
	});

	it("returns zero below the reserve, never negative", () => {
		expect(
			wrapAmountForReserve({
				nativeLamports: "5290026",
				reserveLamports: 20000000,
			}),
		).toBe("0");
	});
});

describe("capTopUpToBalances", () => {
	it("passes topUp within ATA balances through", () => {
		expect(
			capTopUpToBalances({
				topUpX: "1000",
				topUpY: "700",
				balanceX: "1200",
				balanceY: "700",
			}),
		).toEqual({ topUpX: "1000", topUpY: "700" });
	});

	it("throws when X exceeds the ATA balance", () => {
		expect(() =>
			capTopUpToBalances({
				topUpX: "1201",
				topUpY: "700",
				balanceX: "1200",
				balanceY: "700",
			}),
		).toThrow(DlmmError);
	});

	it("throws when Y exceeds the ATA balance", () => {
		expect(() =>
			capTopUpToBalances({
				topUpX: "1000",
				topUpY: "701",
				balanceX: "1200",
				balanceY: "700",
			}),
		).toThrow(DlmmError);
	});
});
