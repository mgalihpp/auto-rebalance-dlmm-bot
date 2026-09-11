export type LogLevel =
	| "BOOT"
	| "HOLD"
	| "REBALANCE"
	| "DRY_RUN"
	| "LIVE"
	| "WARN"
	| "ERROR"
	| "CONFIG"
	| "FATAL";

const COLORS: Record<LogLevel, string> = {
	BOOT: "\u001b[36m",
	HOLD: "\u001b[32m",
	REBALANCE: "\u001b[35m",
	DRY_RUN: "\u001b[33m",
	LIVE: "\u001b[32m",
	WARN: "\u001b[33m",
	ERROR: "\u001b[31m",
	CONFIG: "\u001b[34m",
	FATAL: "\u001b[31;1m",
};

const RESET = "\u001b[0m";

export const supportsColor = (): boolean => {
	if (typeof process === "undefined") return false;
	const env = process.env ?? {};
	if ("NO_COLOR" in env) return false;
	if (env.TERM === "dumb") return false;
	const stdout = process.stdout as unknown as { isTTY?: boolean } | undefined;
	return stdout?.isTTY === true;
};

export const paint = (level: LogLevel, text: string): string => {
	if (!supportsColor()) return text;
	const code = COLORS[level];
	if (!code) return text;
	return `${code}${text}${RESET}`;
};

export const log = (level: LogLevel, msg: string): void => {
	console.log(paint(level, `[${level}] ${msg}`));
};

export const formatAmount = (baseUnit: string, decimals: number): string => {
	const raw = baseUnit.trim();
	if (!/^\d+$/.test(raw)) return raw === "" ? "0" : raw;
	const d = Math.max(0, Math.floor(decimals));
	const stripped = raw.replace(/^0+(?=\d)/, "");
	const normalized = stripped === "" ? "0" : stripped;
	if (d === 0) return groupThousands(normalized);
	const padded = normalized.padStart(d + 1, "0");
	const intPart = padded.slice(0, -d);
	const fracRaw = padded.slice(-d);
	const frac = fracRaw.replace(/0+$/, "");
	const intNorm = intPart.replace(/^0+(?=\d)/, "") || "0";
	const grouped = groupThousands(intNorm);
	if (frac === "") return grouped;
	return `${grouped}.${frac}`;
};

const groupThousands = (intPart: string): string =>
	intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const shortMint = (mint: string): string => {
	if (mint.length <= 8) return mint;
	return `${mint.slice(0, 4)}...${mint.slice(-4)}`;
};

export const txLink = (sig: string): string =>
	`https://solscan.io/tx/${sig}`;

export type DryRunSwap =
	| { readonly kind: "none" }
	| {
			readonly kind: "swap";
			readonly inAmount: string;
			readonly inputMint: string;
			readonly outputMint: string;
			readonly outAmountMin: string;
			readonly inDecimals: number;
			readonly outDecimals: number;
	  };

export interface DryRunBoxArgs {
	readonly pool: string;
	readonly active: number;
	readonly oldLower: number | null;
	readonly oldUpper: number | null;
	readonly newLower: number;
	readonly newUpper: number;
	readonly strategy: string;
	readonly swap: DryRunSwap;
	readonly depositX: string;
	readonly depositY: string;
	readonly decimalsX: number;
	readonly decimalsY: number;
	readonly feeX?: string;
	readonly feeY?: string;
}

const rangeText = (lower: number | null, upper: number | null): string =>
	lower === null || upper === null ? "[?,?]" : `[${lower},${upper}]`;

export const formatDryRunBox = (args: DryRunBoxArgs): string => {
	const oldRange = rangeText(args.oldLower, args.oldUpper);
	const newRange = `[${args.newLower},${args.newUpper}]`;
	const depositX = formatAmount(args.depositX, args.decimalsX);
	const depositY = formatAmount(args.depositY, args.decimalsY);
	const swapLine =
		args.swap.kind === "none"
			? "swap none (already balanced)"
			: `swap ${formatAmount(args.swap.inAmount, args.swap.inDecimals)} ${shortMint(args.swap.inputMint)} -> ${shortMint(args.swap.outputMint)} (min out ${formatAmount(args.swap.outAmountMin, args.swap.outDecimals)})`;
	const lines = [
		`[DRY_RUN] rebalance preview ─ pool=${shortMint(args.pool)} active=${args.active}`,
		`├─ range ${oldRange} -> ${newRange}`,
		`├─ strategy=${args.strategy}`,
		`├─ ${swapLine}`,
	];
	if (args.feeX !== undefined && args.feeY !== undefined) {
		lines.push(
			`├─ fees claimed X=${formatAmount(args.feeX, args.decimalsX)} / Y=${formatAmount(args.feeY, args.decimalsY)} (left in wallet)`,
		);
	}
	lines.push(
		`├─ deposit X=${depositX} / Y=${depositY}`,
		"└─ dry-run only, no tx sent",
	);
	return lines.join("\n");
};
