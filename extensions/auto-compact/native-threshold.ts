import { SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type NativeCompactionThreshold = {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	contextWindow: number;
	thresholdTokens: number;
};

/** Read Pi's effective settings and mirror its native compaction boundary. */
export function loadNativeCompactionThreshold(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	contextWindow: number,
): NativeCompactionThreshold {
	const settings = SettingsManager.create(ctx.cwd, undefined, {
		projectTrusted: ctx.isProjectTrusted(),
	}).getCompactionSettings();
	return {
		...settings,
		contextWindow,
		thresholdTokens: contextWindow - settings.reserveTokens,
	};
}
