# Pi auto-compact

Pi auto-compact compacts long Pi sessions after a tool turn, then continues the same request. The default threshold is 200,000 estimated tokens, capped at Pi's own compaction limit (`context window - reserved tokens`) for smaller-context models.

## Install

```sh
pi install git:github.com/tmustier/pi-auto-compact
```

Restart Pi or run `/reload`. Run `/auto-compact` to see the active threshold and compaction model.

Pi packages have full system access. Review the source before installing.

## Recommended setup

The extension works without configuration. It uses the active conversation model and a 200,000-token threshold. When a model's context window is smaller than that, the extension uses Pi's own limit for the model instead.

We recommend using Codex Spark for compaction. This keeps the conversation model unchanged and tells the summary to preserve unfinished work.

Create `~/.pi/agent/auto-compact.json`:

```json
{
  "compactionModel": {
    "provider": "openai-codex",
    "model": "gpt-5.3-codex-spark",
    "thinking": "medium",
    "instructions": "Do not drop unfinished work, and do not make unfinished work sound finished. Keep every pending check, tentative finding, candidate, blocker and unresolved question in the summary. The next agent may otherwise act on unverified conclusions."
  },
  "fallbackCompactionModels": [
    {
      "provider": "openrouter",
      "model": "google/gemini-3.1-flash-lite:nitro",
      "thinking": "off"
    },
    {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinking": "low"
    }
  ],
  "rules": []
}
```

The same configuration is available in [`config.example.json`](config.example.json). Spark must be available and authenticated in Pi.

Run `/reload` after changing the file.

## Customise thresholds

Add rules when different models need different limits. Rules run from top to bottom. The first match wins.

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

A rule can match:

- `api`, `provider` or `model` by exact value
- `providerPattern` or `modelPattern` with a JavaScript regular expression
- the first numeric model version with `lt`, `lte`, `gt` or `gte`

Each rule needs `thresholdTokens`. An optional `name` appears in `/auto-compact` output. An explicit top-level `defaultThresholdTokens` replaces the built-in capped default for unmatched models.

Set `PI_AUTO_COMPACT_CONFIG` to use another config path. Set `PI_CODING_AGENT_DIR` to move the Pi agent directory.

## Compaction model options

`compactionModel` supports:

- `provider` and `model`, both required
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`
- `instructions`: extra instructions appended to `/compact` instructions

`fallbackCompactionModels` is an optional ordered array with the same fields and requires `compactionModel`. If the primary model fails, the extension tries each fallback in order. A fallback without `instructions` inherits the primary model's instructions. If every configured model fails, Pi uses the active conversation model.

Interactive dedicated-model compactions show the model and thinking level in Pi's existing spinner while preserving its manual, threshold and overflow labels.

For OpenRouter models, append `:nitro` to prioritize the highest-throughput inference provider or `:floor` to prioritize price. Auto-compact resolves authentication and metadata from the base model, then sends the variant suffix to OpenRouter.

Disable other compaction extensions when you set `compactionModel`. Pi runs every registered compaction handler.

## How it behaves

After a tool turn crosses the threshold, the extension makes Pi handle the next request as a native context overflow. Pi saves the compaction and continues without adding a user message.

The extension follows Pi's merged global and project compaction settings. When Pi's native compaction is disabled (`compaction.enabled: false`), the extension does not trigger.

The extension does not change the model context window, switch the conversation model or send the intercepted request upstream.

To test compaction with a low threshold:

```sh
PI_AUTO_COMPACT_TEST_THRESHOLD=1 pi
```

## Compatibility

Requires Pi 0.82.1 or newer.

Auto-compact wraps the live Pi runtime provider as a complete native provider. This preserves custom providers' authentication, model catalogs, filtering, refresh and stream behavior, including OAuth provider clones. The one-shot wrapper is removed as soon as it triggers, or on session shutdown/reload when auto-compact still owns it.

Pi allows one extension stream override per provider. Another extension can replace auto-compact's override, or auto-compact can replace one loaded earlier.

Other extensions can request the active threshold by emitting `pi-auto-compact:policy-request:v1`. Auto-compact responds on `pi-auto-compact:policy:v1` with the model, threshold, policy source and config path.

## Develop

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
