# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [2.0.1](https://dg.starstao.top/ads/openclaw-observability-plugin/compare/v2.0.0...v2.0.1) (2026-04-13)


### Bug Fixes

*  tool span missing sometimes issue. the reason is that sometimes there is no sessionkey in before_tool_call event ctx ([ab2eb6c](https://dg.starstao.top/ads/openclaw-observability-plugin/commit/ab2eb6cc9abb48bfc489b54b6a4cf0d6c0bdb84c))

## [2.0.0](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.4...v2.0.0) (2026-04-13)

### Changed

- Changed to use openclaw's new plugin SDK (2026-03-22)

### [1.0.4](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.3...v1.0.4) (2026-03-30)

#### Added

- Add skill counter metrics
- Add `llm_input` & `llm_output` hooks for message input/output recording
- Add `gen_ai.agent.used_skills` on agent span

#### Changed

- Security check now runs on root span instead of agent span
- Root span output now uses last assistant message only
- Uniform all input/output format across spans
- Rename metric names and metric attributes for consistency
- Fix logging issues
- Update documentation

### [1.0.1](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.0...v1.0.1) (2026-03-20)

#### Added

- Record tool call in `gen_ai.client.operation.duration` metric
- Add all basic metrics from official plugin
- Remove duplicate or unused metrics

#### Changed

- Remove token usage in agent span
- Update protocol schema
- Code refactor and optimization
- Fix documentation

## 1.0.0 (2026-03-16)

### Added

- Initial release of OpenClaw Deep Observability Plugin
- OpenTelemetry integration for traces, metrics, and logs
- Real-time threat detection module
- MkDocs documentation site

### Features

- **Traces**: Agent spans, LLM spans, Tool spans with input/output tracking
- **Metrics**: Token usage, operation duration, request counters
- **Logs**: OTel logs support with tslog integration
- **Security**: Message security check, threat detection, Tetragon policies

[2.0.0]: https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.4...v2.0.0
[1.0.4]: https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v0.9.0...v1.0.0