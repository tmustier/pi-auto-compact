import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_THRESHOLD_TOKENS = 200_000;
export const CONFIG_PATH = process.env.PI_AUTO_COMPACT_CONFIG
	? resolve(process.env.PI_AUTO_COMPACT_CONFIG)
	: join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auto-compact.json");

export type ModelIdentity = {
	api: string;
	provider: string;
	id: string;
};

export type CompactionThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CompactionModelOverride = {
	provider?: string;
	model: string;
	thinking: CompactionThinkingLevel;
	instructions?: string;
};

type ModelVersion = {
	major: number;
	minor: number;
};

type VersionRange = {
	lt?: ModelVersion;
	lte?: ModelVersion;
	gt?: ModelVersion;
	gte?: ModelVersion;
};

type CompiledRule = {
	name: string;
	api?: string;
	provider?: string;
	providerPattern?: RegExp;
	model?: string;
	modelPattern?: RegExp;
	version?: VersionRange;
	thresholdTokens: number;
};

export type AutoCompactPolicy = {
	configPath: string;
	defaultThresholdTokens?: number;
	rules: CompiledRule[];
	compactionModel?: CompactionModelOverride;
	fallbackCompactionModels?: CompactionModelOverride[];
	error?: string;
};

export type ThresholdResolution = {
	thresholdTokens: number;
	source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedKeys = new Set(allowed);
	const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(`${path} contains unknown field(s): ${unknownKeys.join(", ")}`);
	}
}

function parseThreshold(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${path} must be a non-negative integer`);
	}
	return value;
}

function parseOptionalString(value: unknown, path: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

function parseRequiredString(value: unknown, path: string): string {
	const parsed = parseOptionalString(value, path);
	if (parsed === undefined) throw new Error(`${path} is required`);
	return parsed;
}

function parsePattern(value: unknown, path: string): RegExp | undefined {
	const pattern = parseOptionalString(value, path);
	if (pattern === undefined) return undefined;
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new Error(`${path} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseVersion(value: unknown, path: string): ModelVersion {
	if (typeof value !== "string") {
		throw new Error(`${path} must be a major.minor string such as "4.6"`);
	}
	const match = /^(\d+)\.(\d+)$/.exec(value);
	if (!match) {
		throw new Error(`${path} must be a major.minor string such as "4.6"`);
	}
	return { major: Number(match[1]), minor: Number(match[2]) };
}

function parseVersionRange(value: unknown, path: string): VersionRange | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	assertKnownKeys(value, ["lt", "lte", "gt", "gte"], path);
	const range: VersionRange = {
		lt: value.lt === undefined ? undefined : parseVersion(value.lt, `${path}.lt`),
		lte: value.lte === undefined ? undefined : parseVersion(value.lte, `${path}.lte`),
		gt: value.gt === undefined ? undefined : parseVersion(value.gt, `${path}.gt`),
		gte: value.gte === undefined ? undefined : parseVersion(value.gte, `${path}.gte`),
	};
	if (Object.values(range).every((bound) => bound === undefined)) {
		throw new Error(`${path} must contain at least one of lt, lte, gt, or gte`);
	}
	return range;
}

function parseCompactionModel(value: unknown, path: string): CompactionModelOverride | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	assertKnownKeys(value, ["provider", "model", "thinking", "instructions"], path);
	const thinking = value.thinking ?? "medium";
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(thinking))) {
		throw new Error(`${path}.thinking must be one of off, minimal, low, medium, high, xhigh, or max`);
	}
	return {
		provider: parseOptionalString(value.provider, `${path}.provider`),
		model: parseRequiredString(value.model, `${path}.model`),
		thinking: thinking as CompactionThinkingLevel,
		instructions: parseOptionalString(value.instructions, `${path}.instructions`),
	};
}

function parseRule(value: unknown, index: number): CompiledRule {
	const path = `rules[${index}]`;
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	assertKnownKeys(
		value,
		["name", "api", "provider", "providerPattern", "model", "modelPattern", "version", "thresholdTokens"],
		path,
	);
	return {
		name: parseOptionalString(value.name, `${path}.name`) ?? `rule ${index + 1}`,
		api: parseOptionalString(value.api, `${path}.api`),
		provider: parseOptionalString(value.provider, `${path}.provider`),
		providerPattern: parsePattern(value.providerPattern, `${path}.providerPattern`),
		model: parseOptionalString(value.model, `${path}.model`),
		modelPattern: parsePattern(value.modelPattern, `${path}.modelPattern`),
		version: parseVersionRange(value.version, `${path}.version`),
		thresholdTokens: parseThreshold(value.thresholdTokens, `${path}.thresholdTokens`),
	};
}

export function parsePolicy(value: unknown, configPath = CONFIG_PATH): AutoCompactPolicy {
	if (!isRecord(value)) {
		throw new Error("configuration must be a JSON object");
	}
	assertKnownKeys(
		value,
		["defaultThresholdTokens", "rules", "compactionModel", "fallbackCompactionModels"],
		"configuration",
	);
	if (value.fallbackCompactionModels !== undefined && !Array.isArray(value.fallbackCompactionModels)) {
		throw new Error("fallbackCompactionModels must be an array");
	}
	if ((value.fallbackCompactionModels?.length ?? 0) > 0 && value.compactionModel === undefined) {
		throw new Error("fallbackCompactionModels requires compactionModel");
	}

	const defaultThresholdTokens =
		value.defaultThresholdTokens === undefined
			? undefined
			: parseThreshold(value.defaultThresholdTokens, "defaultThresholdTokens");
	if (value.rules !== undefined && !Array.isArray(value.rules)) {
		throw new Error("rules must be an array");
	}

	return {
		configPath,
		defaultThresholdTokens,
		rules: (value.rules ?? []).map(parseRule),
		compactionModel: parseCompactionModel(value.compactionModel, "compactionModel"),
		fallbackCompactionModels: (value.fallbackCompactionModels ?? []).map((model, index) => {
			const path = `fallbackCompactionModels[${index}]`;
			const parsed = parseCompactionModel(model, path);
			if (!parsed) throw new Error(`${path} must be an object`);
			return parsed;
		}),
	};
}

export function loadPolicy(configPath = CONFIG_PATH): AutoCompactPolicy {
	if (!existsSync(configPath)) {
		return { configPath, rules: [], fallbackCompactionModels: [] };
	}
	try {
		return parsePolicy(JSON.parse(readFileSync(configPath, "utf8")) as unknown, configPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			configPath,
			rules: [],
			fallbackCompactionModels: [],
			error: `Could not load auto-compact configuration at ${configPath}: ${message}`,
		};
	}
}

function extractVersion(modelId: string): ModelVersion | undefined {
	const match = /(?:^|[-_.])(\d+)[-_.](\d+)(?=$|[-_.])/.exec(modelId);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

function compareVersions(left: ModelVersion, right: ModelVersion): number {
	if (left.major !== right.major) return left.major - right.major;
	return left.minor - right.minor;
}

function matchesVersion(version: ModelVersion | undefined, range: VersionRange | undefined): boolean {
	if (!range) return true;
	if (!version) return false;
	if (range.lt && compareVersions(version, range.lt) >= 0) return false;
	if (range.lte && compareVersions(version, range.lte) > 0) return false;
	if (range.gt && compareVersions(version, range.gt) <= 0) return false;
	if (range.gte && compareVersions(version, range.gte) < 0) return false;
	return true;
}

function matchesRule(rule: CompiledRule, model: ModelIdentity): boolean {
	if (rule.api !== undefined && rule.api !== model.api) return false;
	if (rule.provider !== undefined && rule.provider !== model.provider) return false;
	if (rule.providerPattern !== undefined && !rule.providerPattern.test(model.provider)) return false;
	if (rule.model !== undefined && rule.model !== model.id) return false;
	if (rule.modelPattern !== undefined && !rule.modelPattern.test(model.id)) return false;
	return matchesVersion(extractVersion(model.id), rule.version);
}

export function resolveConfiguredThreshold(
	policy: AutoCompactPolicy,
	model: ModelIdentity,
	testThreshold?: number,
): ThresholdResolution | undefined {
	if (testThreshold !== undefined) {
		return { thresholdTokens: testThreshold, source: "test override" };
	}
	const rule = policy.rules.find((candidate) => matchesRule(candidate, model));
	if (rule) {
		return { thresholdTokens: rule.thresholdTokens, source: `rule "${rule.name}"` };
	}
	if (policy.defaultThresholdTokens !== undefined) {
		return { thresholdTokens: policy.defaultThresholdTokens, source: "default" };
	}
	return undefined;
}

/**
 * The built-in default: 200,000 tokens, capped at Pi's native limit for
 * models whose context window sits below the default.
 */
export function cappedDefaultThreshold(nativeThreshold: ThresholdResolution): ThresholdResolution {
	if (nativeThreshold.thresholdTokens < DEFAULT_THRESHOLD_TOKENS) return nativeThreshold;
	return { thresholdTokens: DEFAULT_THRESHOLD_TOKENS, source: "default" };
}

export function resolveThreshold(
	policy: AutoCompactPolicy,
	model: ModelIdentity,
	fallback: ThresholdResolution,
	testThreshold?: number,
): ThresholdResolution {
	return resolveConfiguredThreshold(policy, model, testThreshold) ?? fallback;
}
