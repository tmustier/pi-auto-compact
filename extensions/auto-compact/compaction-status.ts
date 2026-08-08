import {
	keyText,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionThinkingLevel } from "./config.js";

type CompactionReason = SessionBeforeCompactEvent["reason"];
type MutableCompactionIndicator = {
	kind: "compaction";
	setMessage(message: string): void;
};

const TUI_CAPTURE_WIDGET_KEY = "pi-auto-compact:tui-capture";
const EMPTY_TUI_COMPONENT = {
	render: (_width: number): string[] => [],
	invalidate: (): void => {},
};

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function getChildComponents(value: unknown): readonly unknown[] {
	if (!isObject(value) || !("children" in value) || !Array.isArray(value.children)) return [];
	return value.children;
}

function isMutableCompactionIndicator(value: unknown): value is MutableCompactionIndicator {
	return (
		isObject(value) &&
		"kind" in value &&
		value.kind === "compaction" &&
		"setMessage" in value &&
		typeof value.setMessage === "function"
	);
}

/**
 * Update Pi's mounted compaction loader through the TUI component tree.
 * The traversal is structural so incompatible Pi layouts fail closed.
 */
export function setCompactionStatusMessage(root: unknown, message: string): boolean {
	const pending: unknown[] = [root];
	const visited = new Set<object>();
	const matches: MutableCompactionIndicator[] = [];

	while (pending.length > 0) {
		const component = pending.pop();
		if (!isObject(component) || visited.has(component)) continue;
		visited.add(component);

		if (isMutableCompactionIndicator(component)) matches.push(component);
		pending.push(...getChildComponents(component));
	}

	const [indicator] = matches;
	if (matches.length !== 1 || indicator === undefined) return false;
	indicator.setMessage(message);
	return true;
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

function interruptKey(): string {
	return keyText("app.interrupt") || "esc";
}

export function formatCompactionProgressMessage(
	reason: CompactionReason,
	modelRef: string,
	thinking: CompactionThinkingLevel,
	cancelKey = interruptKey(),
): string {
	return `${compactionLabel(reason)} with ${modelRef} (${thinking} thinking)... (${cancelKey} to cancel)`;
}

export function formatDefaultCompactionMessage(
	reason: CompactionReason,
	cancelKey = interruptKey(),
): string {
	return `${compactionLabel(reason)}... (${cancelKey} to cancel)`;
}

export class CompactionStatusBridge {
	private tuiRoot: unknown;

	capture(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || this.tuiRoot !== undefined) return;
		ctx.ui.setWidget(TUI_CAPTURE_WIDGET_KEY, (tui) => {
			this.tuiRoot = tui;
			return EMPTY_TUI_COMPONENT;
		});
		ctx.ui.setWidget(TUI_CAPTURE_WIDGET_KEY, undefined);
	}

	update(message: string): void {
		if (this.tuiRoot !== undefined) setCompactionStatusMessage(this.tuiRoot, message);
	}

	clear(): void {
		this.tuiRoot = undefined;
	}
}
