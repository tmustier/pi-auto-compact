import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	createEventBus,
	keyText,
	ModelRegistry,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionContext,
	type ProviderConfig,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	registerFauxProvider,
	type Api,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai/compat";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const configPath = join(tmpdir(), `pi-auto-compact-${process.pid}-${Date.now()}.json`);
const previousConfig = process.env.PI_AUTO_COMPACT_CONFIG;
writeFileSync(
	configPath,
	JSON.stringify({
		compactionModel: {
			provider: "openrouter",
			model: "faux-1:nitro",
			thinking: "off",
			instructions: "Preserve primary instructions.",
		},
		fallbackCompactionModels: [
			{
				provider: "openrouter",
				model: "faux-2:floor",
				thinking: "off",
			},
			{
				provider: "openrouter",
				model: "faux-3:nitro",
				thinking: "off",
			},
		],
	}),
);
process.env.PI_AUTO_COMPACT_CONFIG = configPath;
const { default: autoCompact } = await import("../extensions/auto-compact/index.js");
const { formatCompactionMessage } = await import("../extensions/auto-compact/compaction-status.js");
after(() => {
	rmSync(configPath, { force: true });
	if (previousConfig === undefined) delete process.env.PI_AUTO_COMPACT_CONFIG;
	else process.env.PI_AUTO_COMPACT_CONFIG = previousConfig;
});

test("formats reason-specific compaction spinner messages", () => {
	const cases: Array<{ reason: SessionBeforeCompactEvent["reason"]; label: string }> = [
		{ reason: "manual", label: "Compacting context" },
		{ reason: "threshold", label: "Auto-compacting" },
		{ reason: "overflow", label: "Context overflow detected, Auto-compacting" },
	];
	for (const { reason, label } of cases) {
		assert.equal(
			formatCompactionMessage(reason, { modelRef: "openrouter/faux-1:nitro", thinking: "high" }, "esc"),
			`${label} with openrouter/faux-1:nitro (high thinking)... (esc to cancel)`,
		);
		assert.equal(formatCompactionMessage(reason, undefined, "esc"), `${label}... (esc to cancel)`);
	}
});

test("dedicated compaction bypasses runtime provider overlays", async () => {
	const faux = registerFauxProvider({
		provider: "openrouter",
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
	});
	let requestModelId: string | undefined;
	faux.setResponses([
		(_context, _options, _state, requestModel) => {
			requestModelId = requestModel.id;
			return fauxAssistantMessage("dedicated summary");
		},
	]);

	try {
		const handlers = new Map<string, EventHandler[]>();
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		autoCompact(pi);

		let runtimeProviderReads = 0;
		const notifications: string[] = [];
		const model = faux.getModel();
		const ctx = {
			mode: "rpc",
			model,
			modelRegistry: {
				find: (provider: string, id: string) =>
					provider === model.provider && id === model.id ? model : undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
				getProviderAuth: async () => undefined,
				getProvider: () => {
					runtimeProviderReads += 1;
					return {
						streamSimple() {
							throw new Error("broken runtime overlay");
						},
					};
				},
			},
			ui: {
				notify(message: string) { notifications.push(message); },
			},
		} as unknown as ExtensionContext;
		const beforeCompact = handlers.get("session_before_compact")?.[0];
		assert.ok(beforeCompact, "session_before_compact handler should be registered");

		const result = (await beforeCompact(
			{
				reason: "manual",
				willRetry: false,
				preparation: {
					firstKeptEntryId: "entry-keep",
					messagesToSummarize: [{ role: "user", content: "summarize me", timestamp: Date.now() }],
					turnPrefixMessages: [],
					isSplitTurn: false,
					tokensBefore: 100,
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20 },
				},
				signal: new AbortController().signal,
			},
			ctx,
		)) as { compaction?: { summary?: string } };

		assert.ok(result, notifications.join("\n"));
		assert.equal(runtimeProviderReads, 0);
		assert.match(result.compaction?.summary ?? "", /dedicated summary/);
		assert.equal(faux.state.callCount, 1);
		assert.equal(requestModelId, "faux-1:nitro");
	} finally {
		faux.unregister();
	}
});

test("tries configured fallback compaction models in order", async () => {
	const faux = registerFauxProvider({
		provider: "openrouter",
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
	});
	let inheritedPrimaryInstructions = false;
	let requestModelId: string | undefined;
	faux.setResponses([
		(context, _options, _state, requestModel) => {
			inheritedPrimaryInstructions = JSON.stringify(context).includes("Preserve primary instructions.");
			requestModelId = requestModel.id;
			return fauxAssistantMessage("fallback summary");
		},
	]);

	try {
		const handlers = new Map<string, EventHandler[]>();
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerCommand() {},
		} as unknown as ExtensionAPI;
		autoCompact(pi);

		let authCalls = 0;
		let failAll = false;
		let abortOnNextAuth: AbortController | undefined;
		const attemptedModels: string[] = [];
		const notifications: string[] = [];
		const compactionMessages: string[] = [];
		const model = faux.getModel();
		const compactionIndicator = {
			kind: "compaction",
			setMessage(message: string) {
				compactionMessages.push(message);
			},
		};
		const tuiRoot = { children: [{ children: [compactionIndicator] }] };
		const ctx = {
			mode: "tui",
			model: { ...model, provider: "active", id: "conversation" },
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider ? faux.getModel(id) : undefined,
				getApiKeyAndHeaders: async (requestedModel: Model<Api>) => {
					authCalls += 1;
					attemptedModels.push(requestedModel.id);
					abortOnNextAuth?.abort();
					abortOnNextAuth = undefined;
					return failAll || authCalls % 3 !== 0
						? { ok: false as const, error: `model ${authCalls} quota exhausted` }
						: { ok: true as const, apiKey: "test-key", headers: {} };
				},
				getProviderAuth: async () => undefined,
			},
			ui: {
				notify(message: string) { notifications.push(message); },
				setWidget(_key: string, content: unknown) {
					if (typeof content === "function") content(tuiRoot, {});
				},
			},
		} as unknown as ExtensionContext;
		const beforeCompact = handlers.get("session_before_compact")?.[0];
		assert.ok(beforeCompact, "session_before_compact handler should be registered");

		const compactionEvent = {
			reason: "manual",
			willRetry: false,
			preparation: {
				firstKeptEntryId: "entry-keep",
				messagesToSummarize: [{ role: "user", content: "summarize me", timestamp: Date.now() }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20 },
			},
			signal: new AbortController().signal,
		};
		const result = (await beforeCompact(compactionEvent, ctx)) as { compaction?: { summary?: string } };

		assert.equal(authCalls, 3);
		assert.deepEqual(attemptedModels, ["faux-1", "faux-2", "faux-3"]);
		assert.equal(faux.state.callCount, 1);
		assert.equal(inheritedPrimaryInstructions, true);
		assert.equal(requestModelId, "faux-3:nitro");
		assert.match(result.compaction?.summary ?? "", /fallback summary/);
		const cancelKey = keyText("app.interrupt");
		const progressMessages = [
			`Compacting context with openrouter/faux-1:nitro (off thinking)... (${cancelKey} to cancel)`,
			`Compacting context with openrouter/faux-2:floor (off thinking)... (${cancelKey} to cancel)`,
			`Compacting context with openrouter/faux-3:nitro (off thinking)... (${cancelKey} to cancel)`,
		];
		assert.deepEqual(compactionMessages, progressMessages);
		assert.equal(
			notifications.filter((message) => /quota exhausted.*falling back to openrouter\/faux-[23]/.test(message))
				.length,
			2,
		);
		assert.equal(notifications.some((message) => message.startsWith("auto-compact: compacting with")), false);

		failAll = true;
		const failedResult = await beforeCompact(compactionEvent, ctx);
		assert.equal(failedResult, undefined);
		assert.equal(authCalls, 6);
		assert.deepEqual(attemptedModels.slice(3), ["faux-1", "faux-2", "faux-3"]);
		assert.deepEqual(compactionMessages.slice(3), [
			...progressMessages,
			`Compacting context... (${cancelKey} to cancel)`,
		]);
		assert.match(notifications.at(-1) ?? "", /falling back to active\/conversation/);

		const abortController = new AbortController();
		abortOnNextAuth = abortController;
		const messageCountBeforeAbort = compactionMessages.length;
		const abortedResult = await beforeCompact({ ...compactionEvent, signal: abortController.signal }, ctx);
		assert.equal(abortedResult, undefined);
		assert.deepEqual(compactionMessages.slice(messageCountBeforeAbort), progressMessages.slice(0, 1));
	} finally {
		faux.unregister();
	}
});

test("preserves a native OAuth provider while intercepting ModelRuntime requests", async () => {
	const previousThreshold = process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
	process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = "1";

	try {
		const credentials = new InMemoryCredentialStore();
		const oauthCredential = {
			type: "oauth" as const,
			refresh: "refresh-token",
			access: "access-token",
			expires: Date.now() + 60 * 60 * 1_000,
		};
		await credentials.modify("xiangliang", async () => oauthCredential);
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({
			api: "openai-codex-responses",
			provider: "xiangliang",
			models: [{ id: "gpt-5.6-sol", contextWindow: 400_000 }],
		});
		faux.setResponses([fauxAssistantMessage("delegated request"), fauxAssistantMessage("stream request")]);
		let getModelsReceiver: unknown;
		let filterModelsReceiver: unknown;
		let simpleStreamReceiver: unknown;
		let streamReceiver: unknown;
		let delegatedApiKey: string | undefined;
		let oauthResolutionCount = 0;
		const upstream: Provider = {
			...faux.provider,
			auth: {
				oauth: {
					name: "Cloned Codex OAuth",
					isSubscription: true,
					async login() {
						return oauthCredential;
					},
					async refresh(credential) {
						return credential;
					},
					async toAuth(credential) {
						oauthResolutionCount += 1;
						return { apiKey: credential.access, baseUrl: "https://clone.example.test/codex" };
					},
				},
			},
			getModels() {
				getModelsReceiver = this;
				return faux.provider.getModels();
			},
			filterModels(models) {
				filterModelsReceiver = this;
				return models;
			},
			stream(model, context, options) {
				streamReceiver = this;
				return faux.provider.stream(model, context, options);
			},
			streamSimple(model, context, options) {
				simpleStreamReceiver = this;
				delegatedApiKey = options?.apiKey;
				return faux.provider.streamSimple(model, context, options);
			},
		};
		runtime.registerNativeProvider(upstream);
		const modelRegistry = new ModelRegistry(runtime);
		const model = modelRegistry.find("xiangliang", "gpt-5.6-sol");
		assert.ok(model);

		const handlers = new Map<string, EventHandler[]>();
		let providerRegistrationCount = 0;
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerCommand() {},
			registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
				providerRegistrationCount += 1;
				if (typeof providerOrName === "string") {
					assert.ok(config);
					runtime.registerProvider(providerOrName, config);
				} else {
					runtime.registerNativeProvider(providerOrName);
				}
			},
			unregisterProvider(name: string) {
				runtime.unregisterProvider(name);
			},
		} as unknown as ExtensionAPI;

		autoCompact(pi);

		const ctx = {
			cwd: tmpdir(),
			model,
			modelRegistry,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: 10, contextWindow: model.contextWindow, percent: 0 }),
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		const turnEnd = handlers.get("turn_end")?.[0];
		assert.ok(turnEnd, "turn_end handler should be registered");

		await turnEnd(
			{
				type: "turn_end",
				message: { role: "assistant", content: [], timestamp: Date.now() },
				toolResults: [{ toolCallId: "tool-1" }],
			},
			ctx,
		);

		assert.equal(providerRegistrationCount, 1);
		const wrapper = modelRegistry.getProvider("xiangliang");
		assert.ok(wrapper);
		assert.notEqual(wrapper, upstream);
		assert.equal(runtime.getRegisteredNativeProvider("xiangliang"), wrapper);
		assert.equal(runtime.getRegisteredProviderConfig("xiangliang"), undefined);
		assert.equal(wrapper.auth, upstream.auth);
		assert.deepEqual(wrapper.getModels(), upstream.getModels());
		assert.equal(getModelsReceiver, upstream, "getModels should keep its upstream this binding");
		assert.deepEqual(wrapper.filterModels?.(wrapper.getModels(), oauthCredential), wrapper.getModels());
		assert.equal(filterModelsReceiver, upstream, "filterModels should keep its upstream this binding");
		assert.equal(typeof wrapper.stream, "function");
		assert.equal(typeof wrapper.streamSimple, "function");
		await turnEnd(
			{
				type: "turn_end",
				message: { role: "assistant", content: [], timestamp: Date.now() },
				toolResults: [{ toolCallId: "tool-1" }],
			},
			ctx,
		);
		assert.equal(providerRegistrationCount, 1, "re-arming must reuse the still-active wrapper by object identity");

		await runtime.refresh({ allowNetwork: false });
		const auth = await runtime.getAuth(model);
		assert.equal(auth?.auth.apiKey, "access-token");
		assert.equal(auth?.auth.baseUrl, "https://clone.example.test/codex");
		assert.equal(runtime.isUsingOAuth("xiangliang"), true);

		const stream = runtime.streamSimple(
			model,
			{
				systemPrompt: "",
				messages: [
					{
						role: "toolResult",
						toolCallId: "tool-1",
						toolName: "bash",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{},
		);
		const result = await stream.result();

		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /auto-compaction token limit exceeded/);
		assert.equal(result.provider, model.provider);
		assert.equal(result.model, model.id);
		assert.equal(simpleStreamReceiver, undefined, "an intercepted request should not reach the upstream provider");
		assert.equal(modelRegistry.getProvider("xiangliang"), upstream, "the one-shot wrapper should restore immediately");
		assert.equal(runtime.getRegisteredNativeProvider("xiangliang"), upstream);
		assert.equal(providerRegistrationCount, 2);

		const delegated = await runtime
			.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, {})
			.result();
		assert.equal(delegated.stopReason, "stop");
		assert.equal(delegated.provider, model.provider);
		assert.equal(simpleStreamReceiver, upstream, "ordinary shared-runtime requests should delegate to the live provider");
		assert.equal(delegatedApiKey, "access-token");

		await runtime.stream(model, { systemPrompt: "", messages: [], tools: [] }, {}).result();
		assert.equal(streamReceiver, upstream, "the provider's full stream API should remain bound to the upstream provider");
		assert.ok(oauthResolutionCount >= 4);

		let replacementDelegations = 0;
		const replacement: Provider = {
			...upstream,
			name: "Replacement OAuth clone",
			streamSimple(requestModel, context, options) {
				replacementDelegations += 1;
				return upstream.streamSimple(requestModel, context, options);
			},
		};
		runtime.registerNativeProvider(replacement);
		await turnEnd(
			{
				type: "turn_end",
				message: { role: "assistant", content: [], timestamp: Date.now() },
				toolResults: [{ toolCallId: "tool-3" }],
			},
			ctx,
		);
		const replacementWrapper = modelRegistry.getProvider("xiangliang");
		assert.ok(replacementWrapper);
		assert.notEqual(replacementWrapper, replacement);
		assert.notEqual(replacementWrapper, wrapper);
		assert.equal(providerRegistrationCount, 3, "a replaced wrapper should be recaptured from the live runtime");
		await replacementWrapper.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, {}).result();
		assert.equal(replacementDelegations, 1);

		const shutdown = handlers.get("session_shutdown")?.[0];
		assert.ok(shutdown, "session_shutdown handler should be registered");
		await shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
		assert.equal(modelRegistry.getProvider("xiangliang"), replacement);
		assert.equal(runtime.getRegisteredNativeProvider("xiangliang"), replacement);
		assert.equal(providerRegistrationCount, 4);
	} finally {
		if (previousThreshold === undefined) delete process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
		else process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = previousThreshold;
	}
});

test("a replacement extension instance unwraps the previous auto-compact wrapper", async () => {
	const previousThreshold = process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
	process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = "1";

	try {
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({
			provider: "shared-runtime",
			models: [{ id: "shared-1", contextWindow: 400_000 }],
		});
		faux.setResponses([fauxAssistantMessage("delegated once")]);
		runtime.registerNativeProvider(faux.provider);
		const modelRegistry = new ModelRegistry(runtime);
		const model = faux.getModel();
		const handlers = new Map<string, EventHandler[]>();
		let providerRegistrationCount = 0;
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerCommand() {},
			registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
				providerRegistrationCount += 1;
				if (typeof providerOrName === "string") {
					assert.ok(config);
					runtime.registerProvider(providerOrName, config);
				} else {
					runtime.registerNativeProvider(providerOrName);
				}
			},
			unregisterProvider(name: string) {
				runtime.unregisterProvider(name);
			},
		} as unknown as ExtensionAPI;
		const ctx = {
			cwd: tmpdir(),
			model,
			modelRegistry,
			isProjectTrusted: () => false,
			getContextUsage: () => ({ tokens: 10, contextWindow: model.contextWindow, percent: 0 }),
			ui: { notify() {} },
		} as unknown as ExtensionContext;
		const event = {
			type: "turn_end",
			message: { role: "assistant", content: [], timestamp: Date.now() },
			toolResults: [{ toolCallId: "tool-shared" }],
		};

		autoCompact(pi);
		const firstTurnEnd = handlers.get("turn_end")?.[0];
		assert.ok(firstTurnEnd);
		await firstTurnEnd(event, ctx);
		const firstWrapper = modelRegistry.getProvider(model.provider);
		assert.ok(firstWrapper);

		autoCompact(pi);
		const secondTurnEnd = handlers.get("turn_end")?.[1];
		assert.ok(secondTurnEnd);
		await secondTurnEnd(event, ctx);
		const secondWrapper = modelRegistry.getProvider(model.provider);
		assert.ok(secondWrapper);
		assert.notEqual(secondWrapper, firstWrapper);
		assert.equal(providerRegistrationCount, 2);

		await secondWrapper.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, {}).result();
		assert.equal(faux.state.callCount, 1);

		const shutdownHandlers = handlers.get("session_shutdown") ?? [];
		assert.equal(shutdownHandlers.length, 2);
		for (const shutdown of shutdownHandlers) {
			await shutdown({ type: "session_shutdown", reason: "reload" }, ctx);
		}
		assert.equal(modelRegistry.getProvider(model.provider), faux.provider);
		assert.equal(runtime.getRegisteredNativeProvider(model.provider), faux.provider);
		assert.equal(providerRegistrationCount, 3);
	} finally {
		if (previousThreshold === undefined) delete process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
		else process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = previousThreshold;
	}
});

test("restores named and inherited providers without overwriting a later owner", async () => {
	const previousThreshold = process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
	process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = "1";

	try {
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const namedFaux = fauxProvider({
			provider: "ordinary-named",
			models: [{ id: "ordinary-1", contextWindow: 400_000 }],
		});
		const namedModel = namedFaux.getModel();
		const namedConfig: ProviderConfig = {
			name: "Ordinary named provider",
			baseUrl: namedModel.baseUrl,
			apiKey: "test-key",
			api: namedModel.api,
			models: [namedModel],
			streamSimple: namedFaux.provider.streamSimple.bind(namedFaux.provider),
		};
		runtime.registerProvider(namedModel.provider, namedConfig);
		const savedNamedConfig = runtime.getRegisteredProviderConfig(namedModel.provider);
		assert.ok(savedNamedConfig);

		const ownedFaux = fauxProvider({
			provider: "later-owned",
			models: [{ id: "owned-1", contextWindow: 400_000 }],
		});
		ownedFaux.setResponses([fauxAssistantMessage("foreign wrapper delegated")]);
		runtime.registerNativeProvider(ownedFaux.provider);
		const ownedModel = ownedFaux.getModel();
		const inheritedModel = runtime.getModels("openai")[0];
		assert.ok(inheritedModel, "the Pi runtime should include its built-in OpenAI provider");
		const inheritedProvider = runtime.getProvider(inheritedModel.provider);
		assert.ok(inheritedProvider);

		const modelRegistry = new ModelRegistry(runtime);
		const handlers = new Map<string, EventHandler[]>();
		let providerRegistrationCount = 0;
		let providerUnregistrationCount = 0;
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerCommand() {},
			registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
				providerRegistrationCount += 1;
				if (typeof providerOrName === "string") {
					assert.ok(config);
					runtime.registerProvider(providerOrName, config);
				} else {
					runtime.registerNativeProvider(providerOrName);
				}
			},
			unregisterProvider(name: string) {
				providerUnregistrationCount += 1;
				runtime.unregisterProvider(name);
			},
		} as unknown as ExtensionAPI;
		autoCompact(pi);

		const contextFor = (model: Model<Api>) =>
			({
				cwd: tmpdir(),
				model,
				modelRegistry,
				isProjectTrusted: () => false,
				getContextUsage: () => ({ tokens: 10, contextWindow: model.contextWindow, percent: 0 }),
				ui: { notify() {} },
			}) as unknown as ExtensionContext;
		const turnEnd = handlers.get("turn_end")?.[0];
		assert.ok(turnEnd);
		for (const [index, model] of [namedModel, inheritedModel, ownedModel].entries()) {
			await turnEnd(
				{
					type: "turn_end",
					message: { role: "assistant", content: [], timestamp: Date.now() },
					toolResults: [{ toolCallId: `tool-${index}` }],
				},
				contextFor(model),
			);
		}
		assert.equal(providerRegistrationCount, 3);
		assert.equal(runtime.getRegisteredProviderConfig(namedModel.provider), undefined);
		assert.ok(runtime.getRegisteredNativeProvider(inheritedModel.provider));

		const ownedWrapper = runtime.getProvider(ownedModel.provider);
		assert.ok(ownedWrapper);
		const laterProvider: Provider = {
			...ownedFaux.provider,
			name: "Later extension wrapper",
			streamSimple(model, context, options) {
				return ownedWrapper.streamSimple(model, context, options);
			},
		};
		runtime.registerNativeProvider(laterProvider);

		const shutdown = handlers.get("session_shutdown")?.[0];
		assert.ok(shutdown);
		await shutdown({ type: "session_shutdown", reason: "reload" }, contextFor(namedModel));

		assert.deepEqual(runtime.getRegisteredProviderConfig(namedModel.provider), savedNamedConfig);
		assert.equal(runtime.getRegisteredNativeProvider(namedModel.provider), undefined);
		assert.equal(runtime.getProvider(ownedModel.provider), laterProvider);
		assert.equal(runtime.getRegisteredNativeProvider(ownedModel.provider), laterProvider);
		assert.equal(runtime.getProvider(inheritedModel.provider), inheritedProvider);
		assert.equal(runtime.getRegisteredNativeProvider(inheritedModel.provider), undefined);
		assert.equal(runtime.getRegisteredProviderConfig(inheritedModel.provider), undefined);
		assert.equal(providerRegistrationCount, 4, "only the owned named registration should be restored");
		assert.equal(providerUnregistrationCount, 1, "the inherited provider should be restored by unregistering");

		const delegatedAfterShutdown = await runtime
			.streamSimple(
				ownedModel,
				{
					systemPrompt: "",
					messages: [
						{
							role: "toolResult",
							toolCallId: "tool-2",
							toolName: "bash",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: Date.now(),
						},
					],
					tools: [],
				},
				{},
			)
			.result();
		assert.equal(delegatedAfterShutdown.stopReason, "stop", "shutdown must disarm captured stale wrappers");
	} finally {
		if (previousThreshold === undefined) delete process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
		else process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = previousThreshold;
	}
});
