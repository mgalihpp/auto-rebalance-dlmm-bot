import { describe, expect, test } from "bun:test";
import BN from "bn.js";
import { compoundTopUpAmounts } from "../src/rebalance/zap.ts";

describe("compoundTopUpAmounts", () => {
	test("caps each leg at min(fee, balance)", () => {
		const amounts = compoundTopUpAmounts(
			new BN(100),
			new BN(200),
			new BN(60),
			new BN(300),
		);
		expect(amounts?.x.toString()).toBe("60");
		expect(amounts?.y.toString()).toBe("200");
	});

	test("passes fees through when balances cover them", () => {
		const amounts = compoundTopUpAmounts(
			new BN(100),
			new BN(200),
			new BN(1000),
			new BN(1000),
		);
		expect(amounts?.x.toString()).toBe("100");
		expect(amounts?.y.toString()).toBe("200");
	});

	test("returns null when both fees are zero", () => {
		expect(
			compoundTopUpAmounts(new BN(0), new BN(0), new BN(100), new BN(100)),
		).toBeNull();
	});

	test("returns null when balances cover none of the fees", () => {
		expect(
			compoundTopUpAmounts(new BN(100), new BN(200), new BN(0), new BN(0)),
		).toBeNull();
	});

	test("deposits the nonzero leg when the other caps to zero", () => {
		const amounts = compoundTopUpAmounts(
			new BN(100),
			new BN(200),
			new BN(0),
			new BN(50),
		);
		expect(amounts?.x.toString()).toBe("0");
		expect(amounts?.y.toString()).toBe("50");
	});

	test("treats negative fees as zero", () => {
		const amounts = compoundTopUpAmounts(
			new BN(-5),
			new BN(20),
			new BN(100),
			new BN(100),
		);
		expect(amounts?.x.toString()).toBe("0");
		expect(amounts?.y.toString()).toBe("20");
	});

	test("treats negative balances as zero", () => {
		expect(
			compoundTopUpAmounts(new BN(100), new BN(200), new BN(-1), new BN(-2)),
		).toBeNull();
	});
});
