import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import autoCompact from "../extensions/auto-compact/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

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
			model,
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
