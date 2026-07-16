import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	getApiProvider,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { loadPolicy, resolveThreshold, type ModelIdentity } from "./config.js";
import { registerPolicyEvents } from "./policy-events.js";

const TEST_THRESHOLD_ENV = "PI_AUTO_COMPACT_TEST_THRESHOLD";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RuntimeProviderStream = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]>;

type ArmedRequest = {
	api: Api;
	provider: string;
	model: string;
	threshold: number;
	policySource: string;
	tokens: number;
	toolCallIds: string[];
};

function readTestThreshold(): number | undefined {
	const raw = process.env[TEST_THRESHOLD_ENV];
	if (raw === undefined) return undefined;

	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`${TEST_THRESHOLD_ENV} must be a non-negative integer; received ${JSON.stringify(raw)}`);
	}
	return parsed;
}

function isArmedActiveRequest(model: Model<Api>, context: Context, request: ArmedRequest): boolean {
	if (model.api !== request.api || model.provider !== request.provider || model.id !== request.model) return false;

	const includedToolResults = new Set(
		context.messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	return request.toolCallIds.every((toolCallId) => includedToolResults.has(toolCallId));
}

export function formatOverflowError(tokens: number, threshold: number, configPath: string): string {
	const estimatedTokens = tokens < 1_000 ? tokens.toString() : `${Math.round(tokens / 1_000).toLocaleString("en-GB")}k`;
	const thresholdTokens =
		threshold < 1_000 ? threshold.toString() : `${Math.round(threshold / 1_000).toLocaleString("en-GB")}k`;
	return `auto-compaction token limit exceeded (est. ${estimatedTokens} > ${thresholdTokens} threshold). Configure auto-compact in ${JSON.stringify(configPath)}, then run /reload.`;
}

function syntheticOverflow(model: Model<Api>, tokens: number, threshold: number, configPath: string) {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "error",
		errorMessage: formatOverflowError(tokens, threshold, configPath),
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}

function modelIdentity(model: Model<Api>): ModelIdentity {
	return { api: model.api, provider: model.provider, id: model.id };
}

export default function autoCompact(pi: ExtensionAPI) {
	const policy = loadPolicy();
	const testThreshold = readTestThreshold();
	let armed: ArmedRequest | undefined;
	let installCount = 0;
	let interceptionCount = 0;
	let compactionCount = 0;
	let lastCompactionTokens: number | undefined;
	let lastCompactionAt: number | undefined;
	let lastInstallError: string | undefined;
	let syntheticAwaitingCompaction = false;
	let wrappedRequestCount = 0;
	let armedRequestMismatchCount = 0;
	let lastToolTurn = "none";
	const installedProviders = new Map<string, Api>();
	const unregisterPolicyEvents = registerPolicyEvents(pi, policy, testThreshold);

	function maybeIntercept(model: Model<Api>, context: Context) {
		wrappedRequestCount += 1;
		if (!armed) return undefined;
		if (!isArmedActiveRequest(model, context, armed)) {
			armedRequestMismatchCount += 1;
			return undefined;
		}

		const request = armed;
		lastCompactionTokens = request.tokens;
		armed = undefined;
		interceptionCount += 1;
		syntheticAwaitingCompaction = true;
		return syntheticOverflow(model, request.tokens, request.threshold, policy.configPath);
	}

	function installProviderWrapper(model: Model<Api>): boolean {
		const installedApi = installedProviders.get(model.provider);
		if (installedApi === model.api) return true;

		const upstream = getApiProvider(model.api);
		if (!upstream) {
			lastInstallError = `No registered API provider for: ${model.api}`;
			return false;
		}

		const streamSimple: RuntimeProviderStream = (requestModel, context, options) =>
			maybeIntercept(requestModel, context) ?? upstream.streamSimple(requestModel, context, options);

		try {
			// Pi 0.80.8 routes requests through ModelRuntime instead of the compat
			// API registry. A provider-level stream overlay reaches that live path
			// while preserving the built-in provider's models and authentication.
			pi.registerProvider(model.provider, { api: model.api, streamSimple });
			installedProviders.set(model.provider, model.api);
			installCount += 1;
			lastInstallError = undefined;
			return true;
		} catch (error) {
			lastInstallError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	function clearArmedState(): void {
		armed = undefined;
	}

	function status(ctx: ExtensionContext): string {
		const usage = ctx.getContextUsage();
		const usageText = usage?.tokens === null || usage?.tokens === undefined ? "unknown" : usage.tokens.toLocaleString();
		const currentResolution = ctx.model
			? resolveThreshold(policy, modelIdentity(ctx.model), testThreshold)
			: undefined;
		const currentPolicyText = currentResolution
			? `tokens > ${currentResolution.thresholdTokens.toLocaleString()} (${currentResolution.source})`
			: "no model selected";
		const armedText = armed
			? `${armed.provider}/${armed.model} at ${armed.tokens.toLocaleString()} tokens; threshold ${armed.threshold.toLocaleString()} (${armed.policySource})`
			: "no";
		const lastCompactionText = lastCompactionAt
			? `${lastCompactionTokens?.toLocaleString() ?? "unknown"} tokens at ${new Date(lastCompactionAt).toISOString()}`
			: "none";
		const currentWrapperActive =
			ctx.model !== undefined && installedProviders.get(ctx.model.provider) === ctx.model.api;

		return [
			`Auto-compact config: ${policy.configPath}${policy.error ? ` (${policy.error})` : ""}`,
			`Default threshold: tokens > ${policy.defaultThresholdTokens.toLocaleString()}; rules: ${policy.rules.length}`,
			`Current policy: ${currentPolicyText}${testThreshold === undefined ? "" : ` via ${TEST_THRESHOLD_ENV}`}`,
			`Current estimated context: ${usageText}`,
			`Provider interception: ModelRuntime overlay on demand; current provider ${currentWrapperActive ? "wrapped" : "delegating until threshold"}; ${installedProviders.size} provider wrapper(s); ${installCount} installation(s)${lastInstallError ? ` (${lastInstallError})` : ""}`,
			`Armed: ${armedText}`,
			`Wrapped requests: ${wrappedRequestCount}; armed mismatches: ${armedRequestMismatchCount}`,
			`Last tool turn: ${lastToolTurn}`,
			`Synthetic overflows: ${interceptionCount}; completed native compactions: ${compactionCount}`,
			`Last trigger: ${lastCompactionText}`,
		].join("\n");
	}

	pi.registerCommand("auto-compact", {
		description: "Show proactive compaction status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(status(ctx), policy.error || lastInstallError ? "error" : "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (policy.error) ctx.ui.notify(policy.error, "error");
	});
	pi.on("session_shutdown", unregisterPolicyEvents);

	pi.on("turn_end", (event, ctx) => {
		if (event.toolResults.length === 0) return;

		const model = ctx.model;
		const modelRef = model ? `${model.provider}/${model.id} (${model.api})` : "none";
		const usage = ctx.getContextUsage();
		const tokens = usage?.tokens;
		if (!model) {
			lastToolTurn = "none; no model selected";
			return;
		}
		if (tokens === null || tokens === undefined) {
			lastToolTurn = `${modelRef}; tokens unknown`;
			return;
		}

		const resolution = resolveThreshold(policy, modelIdentity(model), testThreshold);
		if (tokens <= resolution.thresholdTokens) {
			lastToolTurn = `${modelRef}; ${tokens.toLocaleString()} tokens did not exceed ${resolution.thresholdTokens.toLocaleString()} (${resolution.source})`;
			return;
		}

		// Install immediately before arming so the next active ModelRuntime request
		// cannot bypass the one-shot synthetic overflow.
		if (!installProviderWrapper(model)) {
			lastToolTurn = `${modelRef}; threshold exceeded but provider wrapper installation failed`;
			ctx.ui.notify(`auto-compact: ${lastInstallError ?? "provider wrapper installation failed"}`, "error");
			return;
		}
		lastToolTurn = `${modelRef}; armed at ${tokens.toLocaleString()} tokens with ${event.toolResults.length} tool result(s); threshold ${resolution.thresholdTokens.toLocaleString()} (${resolution.source})`;
		armed = {
			api: model.api,
			provider: model.provider,
			model: model.id,
			threshold: resolution.thresholdTokens,
			policySource: resolution.source,
			tokens,
			toolCallIds: event.toolResults.map((result) => result.toolCallId),
		};
	});

	pi.on("model_select", clearArmedState);
	pi.on("agent_end", clearArmedState);
	pi.on("agent_settled", () => {
		syntheticAwaitingCompaction = false;
	});
	pi.on("session_compact", (event) => {
		clearArmedState();
		if (syntheticAwaitingCompaction && event.reason === "overflow" && event.willRetry) {
			compactionCount += 1;
			lastCompactionAt = Date.now();
		}
		syntheticAwaitingCompaction = false;
	});
}
