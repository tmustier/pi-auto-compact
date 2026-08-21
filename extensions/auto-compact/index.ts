import { compact, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	getApiProvider,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai/compat";
import { findCompactionIndicator, formatCompactionMessage } from "./compaction-status.js";
import {
	cappedDefaultThreshold,
	DEFAULT_THRESHOLD_TOKENS,
	loadPolicy,
	resolveConfiguredThreshold,
	resolveThreshold,
	type ModelIdentity,
} from "./config.js";
import { loadNativeCompactionThreshold } from "./native-threshold.js";
import { registerPolicyEvents } from "./policy-events.js";

const TEST_THRESHOLD_ENV = "PI_AUTO_COMPACT_TEST_THRESHOLD";
const TUI_CAPTURE_WIDGET_KEY = "pi-auto-compact:tui-capture";

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

const PROVIDER_WRAPPER = Symbol.for("pi-auto-compact:provider-wrapper:v1");

type ProviderRegistration =
	| { type: "native"; provider: Provider }
	| { type: "named"; config: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]>> }
	| { type: "inherited" };

type ProviderWrapperMetadata = {
	upstream: Provider;
	registration: ProviderRegistration;
};

type WrappedProvider = Provider & {
	[PROVIDER_WRAPPER]?: ProviderWrapperMetadata;
};

type InstalledProvider = ProviderWrapperMetadata & {
	wrapper: Provider;
};

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

function providerWrapperMetadata(provider: Provider): ProviderWrapperMetadata | undefined {
	return (provider as WrappedProvider)[PROVIDER_WRAPPER];
}

function providerWrapperIsActive(ctx: ExtensionContext, providerId: string, wrapper: Provider): boolean {
	return (
		ctx.modelRegistry.getProvider(providerId) === wrapper ||
		ctx.modelRegistry.getRegisteredNativeProvider(providerId) === wrapper
	);
}

function createProviderWrapper(
	upstream: Provider,
	registration: ProviderRegistration,
	intercept: (model: Model<Api>, context: Context) => ReturnType<Provider["streamSimple"]> | undefined,
): Provider {
	const wrapper: Provider = {
		id: upstream.id,
		name: upstream.name,
		...(upstream.baseUrl === undefined ? {} : { baseUrl: upstream.baseUrl }),
		...(upstream.headers === undefined ? {} : { headers: upstream.headers }),
		auth: upstream.auth,
		getModels: upstream.getModels.bind(upstream),
		...(upstream.refreshModels ? { refreshModels: upstream.refreshModels.bind(upstream) } : {}),
		...(upstream.filterModels ? { filterModels: upstream.filterModels.bind(upstream) } : {}),
		stream: upstream.stream.bind(upstream) as Provider["stream"],
		streamSimple: (model, context, options) =>
			intercept(model, context) ?? upstream.streamSimple(model, context, options),
		...(upstream.fetchDeferred ? { fetchDeferred: upstream.fetchDeferred.bind(upstream) } : {}),
		...(upstream.cancelDeferred ? { cancelDeferred: upstream.cancelDeferred.bind(upstream) } : {}),
	};
	Object.defineProperty(wrapper, PROVIDER_WRAPPER, {
		value: { upstream, registration } satisfies ProviderWrapperMetadata,
	});
	return wrapper;
}

export default function autoCompact(pi: ExtensionAPI) {
	const policy = loadPolicy();
	const fallbackCompactionModels = policy.fallbackCompactionModels ?? [];
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
	let activeContext: ExtensionContext | undefined;
	const installedProviders = new Map<string, InstalledProvider>();

	function resolveRuntimeThreshold(ctx: ExtensionContext, model: Model<Api>) {
		const native = loadNativeCompactionThreshold(ctx, model.contextWindow);
		const fallback = cappedDefaultThreshold({
			thresholdTokens: native.thresholdTokens,
			source: `Pi native limit (${native.contextWindow.toLocaleString()} context - ${native.reserveTokens.toLocaleString()} reserve)`,
		});
		return {
			native,
			resolution: resolveThreshold(policy, modelIdentity(model), fallback, testThreshold),
		};
	}

	const unregisterPolicyEvents = registerPolicyEvents(pi, policy, (identity) => {
		const ctx = activeContext;
		const model = ctx?.modelRegistry.find(identity.provider, identity.id);
		if (ctx && model?.api === identity.api) return resolveRuntimeThreshold(ctx, model).resolution;
		return (
			resolveConfiguredThreshold(policy, identity, testThreshold) ?? {
				thresholdTokens: DEFAULT_THRESHOLD_TOKENS,
				source: "default",
			}
		);
	});

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
		if (activeContext) restoreProviderWrapper(request.provider, activeContext);
		return syntheticOverflow(model, request.tokens, request.threshold, policy.configPath);
	}

	function installProviderWrapper(model: Model<Api>, ctx: ExtensionContext): boolean {
		const current = ctx.modelRegistry.getProvider(model.provider);
		const installed = installedProviders.get(model.provider);
		if (installed && providerWrapperIsActive(ctx, model.provider, installed.wrapper)) return true;
		if (!current) {
			lastInstallError = `No registered runtime provider for: ${model.provider}`;
			return false;
		}

		// Replacing a stale wrapper from an earlier extension instance must not
		// create a delegation chain back into invalidated session state.
		const previousWrapper = providerWrapperMetadata(current);
		const upstream = previousWrapper?.upstream ?? current;
		const registration =
			previousWrapper?.registration ??
			((): ProviderRegistration => {
				const native = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
				if (native) return { type: "native", provider: native };
				const named = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
				if (named) return { type: "named", config: named };
				return { type: "inherited" };
			})();
		const wrapper = createProviderWrapper(upstream, registration, maybeIntercept);

		try {
			// Pi 0.80.8 routes requests through ModelRuntime instead of the compat
			// API registry. Registering a complete native provider reaches that live
			// path without replacing custom provider auth/models with a named overlay.
			pi.registerProvider(wrapper);
			installedProviders.set(model.provider, { wrapper, upstream, registration });
			installCount += 1;
			lastInstallError = undefined;
			return true;
		} catch (error) {
			lastInstallError = error instanceof Error ? error.message : String(error);
			return false;
		}
	}

	function restoreProviderWrapper(providerId: string, ctx: ExtensionContext): boolean {
		const installed = installedProviders.get(providerId);
		if (!installed || !providerWrapperIsActive(ctx, providerId, installed.wrapper)) return false;
		try {
			switch (installed.registration.type) {
				case "native":
					pi.registerProvider(installed.registration.provider);
					break;
				case "named":
					pi.registerProvider(providerId, installed.registration.config);
					break;
				case "inherited":
					pi.unregisterProvider(providerId);
					break;
			}
		} catch {
			return false;
		}
		installedProviders.delete(providerId);
		return true;
	}

	function restoreProviderWrappers(ctx: ExtensionContext): void {
		for (const providerId of installedProviders.keys()) restoreProviderWrapper(providerId, ctx);
		installedProviders.clear();
	}

	function clearArmedState(): void {
		armed = undefined;
	}

	function status(ctx: ExtensionContext): string {
		activeContext = ctx;
		const usage = ctx.getContextUsage();
		const usageText = usage?.tokens === null || usage?.tokens === undefined ? "unknown" : usage.tokens.toLocaleString();
		const current = ctx.model ? resolveRuntimeThreshold(ctx, ctx.model) : undefined;
		const currentPolicyText = current
			? `tokens > ${current.resolution.thresholdTokens.toLocaleString()} (${current.resolution.source})`
			: "no model selected";
		const armedText = armed
			? `${armed.provider}/${armed.model} at ${armed.tokens.toLocaleString()} tokens; threshold ${armed.threshold.toLocaleString()} (${armed.policySource})`
			: "no";
		const lastCompactionText = lastCompactionAt
			? `${lastCompactionTokens?.toLocaleString() ?? "unknown"} tokens at ${new Date(lastCompactionAt).toISOString()}`
			: "none";
		const currentInstallation = ctx.model ? installedProviders.get(ctx.model.provider) : undefined;
		const currentWrapperActive =
			ctx.model !== undefined &&
			currentInstallation !== undefined &&
			providerWrapperIsActive(ctx, ctx.model.provider, currentInstallation.wrapper);
		const compactionModelText = policy.compactionModel
			? `${policy.compactionModel.provider}/${policy.compactionModel.model} (${policy.compactionModel.thinking} thinking)`
			: "active model";
		const fallbackCompactionModelText =
			fallbackCompactionModels.length > 0
				? fallbackCompactionModels
						.map((model) => `${model.provider}/${model.model} (${model.thinking} thinking)`)
						.join(" → ")
				: "active model";

		return [
			`Auto-compact config: ${policy.configPath}${policy.error ? ` (${policy.error})` : ""}`,
			`Default threshold: ${policy.defaultThresholdTokens === undefined ? `tokens > min(${DEFAULT_THRESHOLD_TOKENS.toLocaleString()}, Pi native limit)` : `tokens > ${policy.defaultThresholdTokens.toLocaleString()}`}; rules: ${policy.rules.length}`,
			`Pi native compaction: ${current ? `${current.native.enabled ? "enabled" : "disabled"}; tokens > ${current.native.thresholdTokens.toLocaleString()}` : "no model selected"}`,
			`Compaction model: ${compactionModelText}`,
			`Fallback compaction models: ${fallbackCompactionModelText}`,
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
		activeContext = ctx;
		if (policy.error) ctx.ui.notify(policy.error, "error");
		if (policy.compactionModel) {
			const overrideRef = `${policy.compactionModel.provider}/${policy.compactionModel.model}`;
			const fallbackRef = fallbackCompactionModels
				.map((model) => `${model.provider}/${model.model}`)
				.join(", then ");
			ctx.ui.notify(
				`auto-compact: dedicated compaction model ${overrideRef}${fallbackRef ? `, then ${fallbackRef}` : ""} is enabled; disable other compaction extensions because Pi runs every compaction handler`,
				"warning",
			);
		}
	});
	pi.on("session_before_compact", async (event, ctx) => {
		const primary = policy.compactionModel;
		if (!primary) return;

		let tuiRoot: unknown;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(TUI_CAPTURE_WIDGET_KEY, (tui) => {
				tuiRoot = tui;
				return { render: () => [], invalidate() {} };
			});
			ctx.ui.setWidget(TUI_CAPTURE_WIDGET_KEY, undefined);
		}
		const compactionIndicator = findCompactionIndicator(tuiRoot);

		const overrides = [primary, ...fallbackCompactionModels];
		const activeRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the active model";
		for (const [index, override] of overrides.entries()) {
			const overrideRef = `${override.provider}/${override.model}`;
			compactionIndicator?.setMessage(
				formatCompactionMessage(event.reason, { modelRef: overrideRef, thinking: override.thinking }),
			);
			try {
				let model = ctx.modelRegistry.find(override.provider, override.model);
				if (!model && override.provider === "openrouter") {
					const baseModelId = override.model.replace(/:(?:nitro|floor)$/, "");
					if (baseModelId !== override.model) model = ctx.modelRegistry.find(override.provider, baseModelId);
				}
				if (!model) throw new Error("model is not available");

				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				const providerAuth = await ctx.modelRegistry.getProviderAuth(model.provider);
				const requestModel = {
					...model,
					...(providerAuth?.auth.baseUrl ? { baseUrl: providerAuth.auth.baseUrl } : {}),
					...(model.id !== override.model ? { id: override.model } : {}),
				};
				const provider = getApiProvider(model.api);
				if (!provider) throw new Error("API provider is not available");

				const customInstructions = [override.instructions ?? primary.instructions, event.customInstructions]
					.filter(Boolean)
					.join("\n\n");
				let headers: Record<string, string> | undefined;
				if (auth.headers) {
					headers = {};
					for (const [name, value] of Object.entries(auth.headers)) {
						if (value !== null) headers[name] = value;
					}
				}
				const result = await compact(
					event.preparation,
					requestModel,
					auth.apiKey,
					headers,
					customInstructions || undefined,
					event.signal,
					override.thinking,
					provider.streamSimple.bind(provider),
					auth.env,
				);
				return { compaction: result };
			} catch (error) {
				if (event.signal.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				const next = overrides[index + 1];
				const nextRef = next ? `${next.provider}/${next.model}` : activeRef;
				ctx.ui.notify(
					`auto-compact: ${overrideRef} compaction failed (${message}); falling back to ${nextRef}`,
					"warning",
				);
			}
		}
		compactionIndicator?.setMessage(formatCompactionMessage(event.reason));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		clearArmedState();
		syntheticAwaitingCompaction = false;
		restoreProviderWrappers(ctx);
		unregisterPolicyEvents();
		activeContext = undefined;
	});

	pi.on("turn_end", (event, ctx) => {
		activeContext = ctx;
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

		const current = resolveRuntimeThreshold(ctx, model);
		if (!current.native.enabled) {
			lastToolTurn = `${modelRef}; Pi native auto-compaction is disabled`;
			return;
		}
		const { resolution } = current;
		if (tokens <= resolution.thresholdTokens) {
			lastToolTurn = `${modelRef}; ${tokens.toLocaleString()} tokens did not exceed ${resolution.thresholdTokens.toLocaleString()} (${resolution.source})`;
			return;
		}

		// Install immediately before arming so the next active ModelRuntime request
		// cannot bypass the one-shot synthetic overflow.
		if (!installProviderWrapper(model, ctx)) {
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

	pi.on("model_select", (_event, ctx) => {
		activeContext = ctx;
		clearArmedState();
	});
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
