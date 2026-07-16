import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	resolveThreshold,
	type AutoCompactPolicy,
	type ModelIdentity,
} from "./config.js";

export const AUTO_COMPACT_POLICY_REQUEST_EVENT = "pi-auto-compact:policy-request:v1";
export const AUTO_COMPACT_POLICY_EVENT = "pi-auto-compact:policy:v1";

export type AutoCompactPolicyRequest = {
	protocolVersion: 1;
	model: ModelIdentity;
};

export type AutoCompactPolicySnapshot = {
	protocolVersion: 1;
	model: ModelIdentity;
	thresholdTokens: number;
	source: string;
	configPath: string;
	configError?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): AutoCompactPolicyRequest | undefined {
	if (!isRecord(value) || value.protocolVersion !== 1 || !isRecord(value.model)) return undefined;
	const { api, provider, id } = value.model;
	if (typeof api !== "string" || typeof provider !== "string" || typeof id !== "string") return undefined;
	return { protocolVersion: 1, model: { api, provider, id } };
}

export function registerPolicyEvents(
	pi: Pick<ExtensionAPI, "events">,
	policy: AutoCompactPolicy,
	testThreshold?: number,
): () => void {
	return pi.events.on(AUTO_COMPACT_POLICY_REQUEST_EVENT, (data) => {
		const request = parseRequest(data);
		if (!request) return;

		const resolution = resolveThreshold(policy, request.model, testThreshold);
		const snapshot: AutoCompactPolicySnapshot = {
			protocolVersion: 1,
			model: request.model,
			thresholdTokens: resolution.thresholdTokens,
			source: resolution.source,
			configPath: policy.configPath,
			...(policy.error ? { configError: policy.error } : {}),
		};
		pi.events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot);
	});
}
