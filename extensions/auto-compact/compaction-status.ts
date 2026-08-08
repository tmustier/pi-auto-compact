import {
	keyText,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionThinkingLevel } from "./config.js";

type CompactionReason = SessionBeforeCompactEvent["reason"];
type CompactionIndicator = {
	kind: "compaction";
	setMessage(message: string): void;
};

function isCompactionIndicator(value: unknown): value is CompactionIndicator {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "compaction" &&
		"setMessage" in value &&
		typeof value.setMessage === "function"
	);
}

export function findCompactionIndicator(root: unknown): CompactionIndicator | undefined {
	const pending: unknown[] = [root];
	while (pending.length > 0) {
		const component = pending.pop();
		if (isCompactionIndicator(component)) return component;
		if (
			typeof component === "object" &&
			component !== null &&
			"children" in component &&
			Array.isArray(component.children)
		) {
			pending.push(...component.children);
		}
	}
	return undefined;
}

function compactionLabel(reason: CompactionReason): string {
	switch (reason) {
		case "manual":
			return "Compacting context";
		case "threshold":
			return "Auto-compacting";
		case "overflow":
			return "Context overflow detected, Auto-compacting";
	}
}

export function formatCompactionMessage(
	reason: CompactionReason,
	details?: { modelRef: string; thinking: CompactionThinkingLevel },
	cancelKey = keyText("app.interrupt"),
): string {
	const progress = details ? ` with ${details.modelRef} (${details.thinking} thinking)` : "";
	return `${compactionLabel(reason)}${progress}... (${cancelKey} to cancel)`;
}
