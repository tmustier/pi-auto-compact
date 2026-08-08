export function normalizeProviderHeaders(
	headers: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> | undefined {
	if (headers === undefined) return undefined;

	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== null) normalized[name] = value;
	}
	return normalized;
}
