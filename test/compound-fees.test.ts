import { describe, expect, test } from "bun:test";
import BN from "bn.js";
import { WSOL_MINT } from "../src/rebalance/reaccumulate.ts";
import {
	compoundSpendableBalance,
	compoundTopUpAmounts,
} from "../src/rebalance/zap.ts";

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

describe("compoundSpendableBalance", () => {
	const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

	test("SOL side spends native lamports when the claim closed the wSOL ATA", () => {
		const feeSol = new BN(5_000_000);
		const amounts = compoundTopUpAmounts(
			new BN(100),
			feeSol,
			compoundSpendableBalance(USDC_MINT, new BN(1000), new BN(2_000_000_000)),
			compoundSpendableBalance(WSOL_MINT, new BN(0), new BN(2_000_000_000)),
		);
		expect(amounts?.x.toString()).toBe("100");
		expect(amounts?.y.toString()).toBe("5000000");
	});

	test("SOL side ignores a stale wSOL ATA balance", () => {
		expect(
			compoundSpendableBalance(WSOL_MINT, new BN(900), new BN(10)).toString(),
		).toBe("10");
	});

	test("non-SOL side spends its ATA balance, not native lamports", () => {
		expect(
			compoundSpendableBalance(
				USDC_MINT,
				new BN(7),
				new BN(2_000_000_000),
			).toString(),
		).toBe("7");
	});
});
