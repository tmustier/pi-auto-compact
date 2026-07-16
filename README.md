# Pi auto-compact

Pi auto-compact persists native compaction after a tool-bearing turn crosses a configurable token threshold. Pi then continues the active request without adding a user continuation message.

The default threshold is 200,000 estimated tokens. You can override it by API, provider, exact model, model ID pattern or numeric model version.

## Install

Install the public Git package:

```sh
pi install git:github.com/tmustier/pi-auto-compact@v0.1.3
```

Omit `@v0.1.3` if you want to track the latest commit on `main`.

Restart Pi or run `/reload`. Use `/auto-compact` to check the loaded policy and current model threshold.

Pi packages run with full system access. Review the extension source before installing it.

## Configure thresholds

The extension reads this optional user configuration file:

```text
~/.pi/agent/auto-compact.json
```

Set `PI_CODING_AGENT_DIR` to move the Pi agent directory. Set `PI_AUTO_COMPACT_CONFIG` to use a specific configuration file.

If the file does not exist, the extension uses this policy:

```json
{
  "defaultThresholdTokens": 200000,
  "rules": []
}
```

Rules run from top to bottom. The first matching rule wins. Every matcher in that rule must match.

This example uses 120,000 tokens for Anthropic model versions up to and including 4.6. It uses 250,000 tokens for GPT 5.5 and newer:

```json
{
  "defaultThresholdTokens": 200000,
  "rules": [
    {
      "name": "Anthropic 4.6 and earlier",
      "provider": "anthropic",
      "modelPattern": "^claude-",
      "version": { "lte": "4.6" },
      "thresholdTokens": 120000
    },
    {
      "name": "GPT 5.5 and newer",
      "modelPattern": "^gpt-",
      "version": { "gte": "5.5" },
      "thresholdTokens": 250000
    }
  ]
}
```

The GPT rule does not constrain the provider or API. It therefore matches an ID such as `gpt-5.6-luna` whether it runs through OpenAI, Bedrock or another provider.

Copy [`config.example.json`](config.example.json) to `~/.pi/agent/auto-compact.json` to use this policy. Run `/reload` after editing the file.

## Match models

A rule can contain these fields:

- `name`: label shown by `/auto-compact`
- `api`: exact Pi API identifier
- `provider`: exact provider identifier
- `providerPattern`: JavaScript regular expression for the provider identifier
- `model`: exact model identifier
- `modelPattern`: JavaScript regular expression for the model identifier
- `version`: bounds using `lt`, `lte`, `gt` or `gte`
- `thresholdTokens`: non-negative integer threshold

Put exact exceptions before broad rules:

```json
{
  "name": "Opus 4.8 exception",
  "provider": "anthropic",
  "model": "claude-opus-4-8",
  "thresholdTokens": 275000
}
```

Version rules compare the first 2-part numeric version in the model ID:

- `claude-opus-4-8` becomes `4.8`
- `claude-3-5-sonnet` becomes `3.5`
- `gpt-5.6-sol` becomes `5.6`

This is numeric model ID ordering. It is not release-date metadata. Use `model` or `modelPattern` when an ID does not contain a 2-part numeric version.

The extension validates the whole file on load. Unknown fields, malformed regular expressions, invalid versions and invalid thresholds produce a visible error. The extension then falls back to 200,000 tokens with no rules.

## How continuation works

The extension follows this sequence:

```text
finish tool batch
→ persist tool results
→ resolve the model threshold
→ install a stream overlay for the active ModelRuntime provider
→ intercept the next matching provider request
→ emit a synthetic context-overflow response
→ let Pi persist native compaction
→ let Pi call agent.continue()
```

The interception checks the API, provider, model and completed tool result IDs. This stops Pi's separate compaction-summary request from consuming the one-shot trigger.

The visible synthetic error looks like this:

```text
auto-compaction token limit exceeded (est. 203k > 200k threshold). Configure auto-compact in "/home/you/.pi/agent/auto-compact.json", then run /reload.
```

Pi recognises `token limit exceeded` as context overflow. It saves the error for history, removes it from active context, persists compaction and continues from the retained tool result.

The extension does not:

- change a model's logical context window
- call `ctx.compact()`
- abort the active run
- add a user or custom continuation message
- send the intercepted request to the upstream provider

## Test a low threshold

Override every resolved threshold for one Pi process:

```sh
PI_AUTO_COMPACT_TEST_THRESHOLD=1 pi
```

Use this only for controlled testing. A fresh session may still be too small for Pi to find a compaction cut point with the default `keepRecentTokens: 20000`; use a session with enough history or temporarily lower `keepRecentTokens` in project settings for the smoke test.

## Extension integration

Other Pi extensions can request the threshold resolved for a model through Pi's shared event bus. Emit `pi-auto-compact:policy-request:v1` with this payload:

```json
{
  "protocolVersion": 1,
  "model": {
    "api": "openai-codex-responses",
    "provider": "openai-codex",
    "id": "gpt-5.6-sol"
  }
}
```

Auto-compact responds synchronously on `pi-auto-compact:policy:v1` with the matching model identity, `thresholdTokens`, policy source and configuration path. If auto-compact is not loaded, no response is emitted. This lets UI extensions use the active policy without duplicating its rule parser.

## Compatibility

The extension requires Pi 0.80.8 or newer and is tested with Pi 0.80.8. Pi 0.80.8 moved live requests from the temporary `@earendil-works/pi-ai/compat` registry to `ModelRuntime`. The extension therefore uses `pi.registerProvider()` to add a `streamSimple` overlay to the active provider, while delegating ordinary requests and compaction summaries to the underlying API implementation.

Pi currently exposes one extension `streamSimple` overlay per provider. If another extension supplies a custom stream implementation for the same provider, loading auto-compact after it will replace that stream implementation. Built-in providers and providers configured through `models.json` continue to work.

After upgrading Pi, check that:

- `/auto-compact` loads without a configuration error
- the active ModelRuntime provider wraps when a threshold is crossed
- Pi recognises the synthetic error as context overflow
- the session contains a persisted compaction entry
- Pi resumes without adding a user continuation message

## Develop

Install dependencies without lifecycle scripts:

```sh
npm install --ignore-scripts
npm run check
npm test
```

Load the checkout directly:

```sh
pi --no-extensions --extension ./extensions/auto-compact/index.ts
```

## License

[MIT](LICENSE)
