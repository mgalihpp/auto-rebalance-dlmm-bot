import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	formatAmount,
	formatDryRunBox,
	paint,
	shortMint,
	supportsColor,
	txLink,
} from "../src/log.ts";

const X_MINT = "So11111111111111111111111111111111111111112";
const Y_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("formatAmount", () => {
	it("formats 9-decimal amounts", () => {
		expect(formatAmount("1000000000", 9)).toBe("1");
		expect(formatAmount("1500000000", 9)).toBe("1.5");
	});

	it("formats 6-decimal amounts and trims trailing zeros", () => {
		expect(formatAmount("2500000", 6)).toBe("2.5");
		expect(formatAmount("1000000", 6)).toBe("1");
		expect(formatAmount("1500000", 6)).toBe("1.5");
	});

	it("formats zero", () => {
		expect(formatAmount("0", 9)).toBe("0");
		expect(formatAmount("0", 6)).toBe("0");
	});

	it("groups thousands for large amounts", () => {
		expect(formatAmount("1234567890123456789", 9)).toBe(
			"1,234,567,890.123456789",
		);
		expect(formatAmount("1234567890000000", 6)).toBe("1,234,567,890");
	});
});

describe("shortMint", () => {
	it("shortens to 4 + 4", () => {
		expect(shortMint(X_MINT)).toBe("So11...1112");
		expect(shortMint(Y_MINT)).toBe("EPjF...Dt1v");
	});

	it("leaves short strings untouched", () => {
		expect(shortMint("abc")).toBe("abc");
	});
});

describe("txLink", () => {
	it("builds a solscan link", () => {
		expect(txLink("abc123")).toBe("https://solscan.io/tx/abc123");
	});
});

describe("paint without color", () => {
	const prevNoColor = process.env.NO_COLOR;
	const prevTerm = process.env.TERM;

	beforeEach(() => {
		process.env.NO_COLOR = "1";
	});

	afterEach(() => {
		if (prevNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prevNoColor;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
	});

	it("returns plain text when NO_COLOR is set", () => {
		expect(supportsColor()).toBe(false);
		expect(paint("ERROR", "hello")).toBe("hello");
		expect(paint("HOLD", "[HOLD] hi")).toBe("[HOLD] hi");
	});
});

describe("formatDryRunBox", () => {
	it("contains oldRange, newRange, swap and deposits", () => {
		const box = formatDryRunBox({
			pool: X_MINT,
			active: 500,
			oldLower: 480,
			oldUpper: 520,
			newLower: 498,
			newUpper: 502,
			strategy: "Spot",
			swap: {
				kind: "swap",
				inAmount: "1500000000",
				inputMint: X_MINT,
				outputMint: Y_MINT,
				outAmountMin: "740000",
				inDecimals: 9,
				outDecimals: 6,
			},
			depositX: "1500000000",
			depositY: "2500000",
			decimalsX: 9,
			decimalsY: 6,
		});
		expect(box).toContain("[480,520]");
		expect(box).toContain("[498,502]");
		expect(box).toContain("swap");
		expect(box).toContain("1.5");
		expect(box).toContain("deposit");
		expect(box).toContain("2.5");
	});

	it("renders a no-swap plan", () => {
		const box = formatDryRunBox({
			pool: Y_MINT,
			active: 100,
			oldLower: 98,
			oldUpper: 102,
			newLower: 98,
			newUpper: 102,
			strategy: "Curve",
			swap: { kind: "none" },
			depositX: "1000000",
			depositY: "2000000",
			decimalsX: 6,
			decimalsY: 6,
		});
		expect(box).toContain("[98,102]");
		expect(box).toContain("swap none");
		expect(box).toContain("deposit");
	});

	it("omits the fees line by default", () => {
		const box = formatDryRunBox({
			pool: X_MINT,
			active: 500,
			oldLower: 480,
			oldUpper: 520,
			newLower: 498,
			newUpper: 502,
			strategy: "Spot",
			swap: { kind: "none" },
			depositX: "1000000000",
			depositY: "1000000",
			decimalsX: 9,
			decimalsY: 6,
		});
		expect(box).not.toContain("fees claimed");
	});

	it("shows claimed fees left in the wallet when COMPOUND_FEES=false", () => {
		const box = formatDryRunBox({
			pool: X_MINT,
			active: 500,
			oldLower: 480,
			oldUpper: 520,
			newLower: 498,
			newUpper: 502,
			strategy: "Spot",
			swap: { kind: "none" },
			depositX: "1000000000",
			depositY: "1000000",
			decimalsX: 9,
			decimalsY: 6,
			feeX: "200000000",
			feeY: "100000",
		});
		expect(box).toContain("fees claimed");
		expect(box).toContain("0.2");
		expect(box).toContain("0.1");
		expect(box).toContain("left in wallet");
	});
});
