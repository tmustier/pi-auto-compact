# Changelog

## Unreleased

- Allow dedicated compaction models to omit `provider` and inherit the active Pi session model's provider.

## v0.1.9

- Show dedicated model and thinking progress in Pi's existing compaction spinner, preserving reason-specific labels.
- Normalize nullable provider headers for compatibility with current Pi releases.
- Update Pi development dependencies to 0.84.1 to resolve transitive security advisories.

## v0.1.8

- Support OpenRouter `:nitro` and `:floor` model variants for dedicated compaction models.

## v0.1.7

- Support an ordered `fallbackCompactionModels` list before falling back to the active conversation model.
- Show the dedicated model, thinking level and provider in Pi's working message while compaction runs.

## v0.1.6

- Generate dedicated-model summaries through the underlying API provider, bypassing runtime provider overlays that can interfere with compaction.
- Add regression coverage for dedicated compaction when the runtime provider is wrapped.

## v0.1.5

- Cap the built-in 200,000-token default at Pi's own compaction limit (`context window - reserved tokens`) so smaller-context models keep a reachable threshold.
- Read Pi's effective merged global and project compaction settings.
- Honour `compaction.enabled`: when Pi's native compaction is disabled, the extension does not trigger.
- Show Pi's native compaction state and limit in `/auto-compact` output.
- Recommend an explicit Codex Spark compaction configuration and shorten the README.

Thanks to [@hughcars](https://github.com/hughcars) for the native-threshold work in [#4](https://github.com/tmustier/pi-auto-compact/pull/4).

## v0.1.4

- Support a dedicated compaction model (`compactionModel`): provider, model, thinking level and extra summary instructions.
- Warn when a dedicated compaction model is enabled alongside other compaction extensions.

## v0.1.3

- Intercept Pi 0.80.8 ModelRuntime requests.

## v0.1.2

- Expose the active-model compaction policy to other extensions over the shared event bus.

## v0.1.1

- Direct overflow errors to configuration.

## v0.1.0

- Initial release: proactive native compaction after a tool-bearing turn crosses a configurable token threshold.
