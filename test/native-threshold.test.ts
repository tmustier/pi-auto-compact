import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNativeCompactionThreshold } from "../extensions/auto-compact/native-threshold.js";

test("uses Pi's configured reserve for a one-million-token model", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-auto-compact-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { enabled: true, reserveTokens: 16_384 } }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const result = loadNativeCompactionThreshold(
			{ cwd: tmpdir(), isProjectTrusted: () => false },
			1_000_000,
		);
		assert.equal(result.thresholdTokens, 983_616);
		assert.equal(result.enabled, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
