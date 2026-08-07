import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, registerFauxProvider, type Api, type Model } from "@earendil-works/pi-ai/compat";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

const configPath = join(tmpdir(), `pi-auto-compact-${process.pid}-${Date.now()}.json`);
const previousConfig = process.env.PI_AUTO_COMPACT_CONFIG;
writeFileSync(
	configPath,
	JSON.stringify({
		compactionModel: {
			provider: "faux",
			model: "faux-1",
			thinking: "off",
			instructions: "Preserve primary instructions.",
		},
		fallbackCompactionModels: [
			{
				provider: "faux",
				model: "faux-2",
				thinking: "off",
			},
			{
				provider: "faux",
				model: "faux-3",
				thinking: "off",
			},
		],
	}),
);
process.env.PI_AUTO_COMPACT_CONFIG = configPath;
const { default: autoCompact } = await import("../extensions/auto-compact/index.js");
after(() => {
	rmSync(configPath, { force: true });
	if (previousConfig === undefined) delete process.env.PI_AUTO_COMPACT_CONFIG;
	else process.env.PI_AUTO_COMPACT_CONFIG = previousConfig;
});

test("dedicated compaction bypasses runtime provider overlays", async () => {
	const faux = registerFauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] });
	faux.setResponses([fauxAssistantMessage("dedicated summary")]);

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
				setWorkingMessage() {},
			},
		} as unknown as ExtensionContext;
		const beforeCompact = handlers.get("session_before_compact")?.[0];
		assert.ok(beforeCompact, "session_before_compact handler should be registered");

		const result = (await beforeCompact(
			{
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
	} finally {
		faux.unregister();
	}
});

test("tries configured fallback compaction models in order", async () => {
	const faux = registerFauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] });
	let inheritedPrimaryInstructions = false;
	faux.setResponses([
		(context) => {
			inheritedPrimaryInstructions = JSON.stringify(context).includes("Preserve primary instructions.");
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
		const attemptedModels: string[] = [];
		const notifications: string[] = [];
		const workingMessages: Array<string | undefined> = [];
		const model = faux.getModel();
		const ctx = {
			model: { ...model, provider: "active", id: "conversation" },
			modelRegistry: {
				find: (provider: string, id: string) => provider === model.provider ? faux.getModel(id) : undefined,
				getApiKeyAndHeaders: async (requestedModel: Model<Api>) => {
					authCalls += 1;
					attemptedModels.push(requestedModel.id);
					return failAll || authCalls % 3 !== 0
						? { ok: false as const, error: `model ${authCalls} quota exhausted` }
						: { ok: true as const, apiKey: "test-key", headers: {} };
				},
				getProviderAuth: async () => undefined,
			},
			ui: {
				notify(message: string) { notifications.push(message); },
				setWorkingMessage(message?: string) { workingMessages.push(message); },
			},
		} as unknown as ExtensionContext;
		const beforeCompact = handlers.get("session_before_compact")?.[0];
		assert.ok(beforeCompact, "session_before_compact handler should be registered");

		const compactionEvent = {
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
		assert.match(result.compaction?.summary ?? "", /fallback summary/);
		assert.deepEqual(workingMessages, [
			"Compacting with faux-1 on off (faux)...",
			"Compacting with faux-2 on off (faux)...",
			"Compacting with faux-3 on off (faux)...",
			undefined,
		]);
		assert.equal(
			notifications.filter((message) => /quota exhausted.*falling back to faux\/faux-[23]/.test(message)).length,
			2,
		);

		failAll = true;
		const failedResult = await beforeCompact(compactionEvent, ctx);
		assert.equal(failedResult, undefined);
		assert.equal(authCalls, 6);
		assert.deepEqual(attemptedModels.slice(3), ["faux-1", "faux-2", "faux-3"]);
		assert.deepEqual(workingMessages.slice(4), [
			"Compacting with faux-1 on off (faux)...",
			"Compacting with faux-2 on off (faux)...",
			"Compacting with faux-3 on off (faux)...",
			undefined,
		]);
		assert.match(notifications.at(-1) ?? "", /falling back to active\/conversation/);
	} finally {
		faux.unregister();
	}
});

test("intercepts the next ModelRuntime provider request after a tool turn crosses the threshold", async () => {
	const previousThreshold = process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
	process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = "1";

	try {
		const handlers = new Map<string, EventHandler[]>();
		const providerRegistrations: Array<{ name: string; config: ProviderConfig }> = [];
		const pi = {
			events: createEventBus(),
			on(event: string, handler: EventHandler) {
				const registered = handlers.get(event) ?? [];
				registered.push(handler);
				handlers.set(event, registered);
			},
			registerCommand() {},
			registerProvider(name: string, config: ProviderConfig) {
				providerRegistrations.push({ name, config });
			},
		} as unknown as ExtensionAPI;

		autoCompact(pi);

		const model = {
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		} as Model<Api>;
		const ctx = {
			cwd: tmpdir(),
			model,
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

		assert.equal(providerRegistrations.length, 1);
		assert.equal(providerRegistrations[0]?.name, model.provider);
		const streamSimple = providerRegistrations[0]?.config.streamSimple;
		assert.ok(streamSimple, "ModelRuntime provider overlay should supply streamSimple");

		const stream = streamSimple(
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
	} finally {
		if (previousThreshold === undefined) delete process.env.PI_AUTO_COMPACT_TEST_THRESHOLD;
		else process.env.PI_AUTO_COMPACT_TEST_THRESHOLD = previousThreshold;
	}
});
