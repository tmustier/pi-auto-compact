import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_THRESHOLD_TOKENS,
	loadPolicy,
	parsePolicy,
	resolveThreshold,
} from "../extensions/auto-compact/config.js";
import { formatOverflowError } from "../extensions/auto-compact/index.js";
import {
	AUTO_COMPACT_POLICY_EVENT,
	AUTO_COMPACT_POLICY_REQUEST_EVENT,
	registerPolicyEvents,
	type AutoCompactPolicySnapshot,
} from "../extensions/auto-compact/policy-events.js";

const examplePolicy = parsePolicy({
	defaultThresholdTokens: 200_000,
	rules: [
		{
			name: "specific Opus exception",
			provider: "anthropic",
			model: "claude-opus-4-8",
			thresholdTokens: 275_000,
		},
		{
			name: "Anthropic 4.6 and earlier",
			provider: "anthropic",
			modelPattern: "^claude-",
			version: { lte: "4.6" },
			thresholdTokens: 120_000,
		},
		{
			name: "GPT 5.5 and newer",
			modelPattern: "^gpt-",
			version: { gte: "5.5" },
			thresholdTokens: 250_000,
		},
	],
});

test("uses the first matching rule", () => {
	assert.deepEqual(
		resolveThreshold(examplePolicy, {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		}),
		{ thresholdTokens: 275_000, source: 'rule "specific Opus exception"' },
	);
});

test("matches Anthropic model versions through 4.6", () => {
	for (const id of ["claude-3-5-sonnet", "claude-sonnet-4-5", "claude-opus-4-6"]) {
		assert.equal(
			resolveThreshold(examplePolicy, { api: "anthropic-messages", provider: "anthropic", id }).thresholdTokens,
			120_000,
		);
	}
	assert.equal(
		resolveThreshold(examplePolicy, {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-7",
		}).thresholdTokens,
		DEFAULT_THRESHOLD_TOKENS,
	);
});

test("matches GPT 5.5 and newer independently of provider", () => {
	assert.equal(
		resolveThreshold(examplePolicy, {
			api: "bedrock-converse-stream",
			provider: "bedrock",
			id: "gpt-5.6-luna",
		}).thresholdTokens,
		250_000,
	);
	assert.equal(
		resolveThreshold(examplePolicy, {
			api: "openai-codex-responses",
			provider: "openai-codex",
			id: "gpt-5.5",
		}).thresholdTokens,
		250_000,
	);
	assert.equal(
		resolveThreshold(examplePolicy, {
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5.4",
		}).thresholdTokens,
		DEFAULT_THRESHOLD_TOKENS,
	);
});

test("uses the process test override ahead of configured rules", () => {
	assert.deepEqual(
		resolveThreshold(
			examplePolicy,
			{ api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-8" },
			1,
		),
		{ thresholdTokens: 1, source: "test override" },
	);
});

test("publishes the resolved active-model threshold to other extensions", () => {
	const events = createEventBus();
	let snapshot: AutoCompactPolicySnapshot | undefined;
	let responseCount = 0;
	const unsubscribeResponse = events.on(AUTO_COMPACT_POLICY_EVENT, (data) => {
		snapshot = data as AutoCompactPolicySnapshot;
		responseCount += 1;
	});
	const unsubscribeRequest = registerPolicyEvents({ events }, examplePolicy);

	events.emit(AUTO_COMPACT_POLICY_REQUEST_EVENT, {
		protocolVersion: 1,
		model: {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		},
	});

	assert.deepEqual(snapshot, {
		protocolVersion: 1,
		model: {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		},
		thresholdTokens: 275_000,
		source: 'rule "specific Opus exception"',
		configPath: examplePolicy.configPath,
	});

	events.emit(AUTO_COMPACT_POLICY_REQUEST_EVENT, { protocolVersion: 1, model: null });
	assert.equal(responseCount, 1);
	unsubscribeRequest();
	unsubscribeResponse();
});

test("returns defaults when the user configuration file is absent", () => {
	const policy = loadPolicy(join(tmpdir(), `missing-auto-compact-${process.pid}.json`));
	assert.equal(policy.defaultThresholdTokens, DEFAULT_THRESHOLD_TOKENS);
	assert.deepEqual(policy.rules, []);
	assert.equal(policy.error, undefined);
});

test("the overflow error directs users to configuration", () => {
	assert.equal(
		formatOverflowError(203_400, 200_000, "/tmp/auto-compact.json"),
		'auto-compaction token limit exceeded (est. 203k > 200k threshold). Configure auto-compact in "/tmp/auto-compact.json", then run /reload.',
	);
});

test("rejects malformed configuration", () => {
	assert.throws(() => parsePolicy({ rules: [{ thresholdTokens: 1, modelPattern: "[" }] }), /valid regular expression/);
	assert.throws(() => parsePolicy({ rules: [{ thresholdTokens: 1, version: { gte: "5" } }] }), /major\.minor/);
	assert.throws(() => parsePolicy({ rules: [{ thresholdTokens: -1 }] }), /non-negative integer/);
	assert.throws(() => parsePolicy({ unexpected: true }), /unknown field/);
});
