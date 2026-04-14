# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [2.1.0](https://dg.starstao.top/ads/openclaw-observability-plugin/compare/v2.0.1...v2.1.0) (2026-04-14)


### Features

* handle subagent case, create "openclaw.subagent.session" child span to rootSpan; set rootSpan's output to all llm_output's last assistant texts ([964ee9e](https://dg.starstao.top/ads/openclaw-observability-plugin/commit/964ee9e0a7588a7480be785f162d937752ece764))


### Bug Fixes

* agentSpan status should be the same as the last child span status ([c688600](https://dg.starstao.top/ads/openclaw-observability-plugin/commit/c688600c277cd9fa888eca7365edb80a488e19ec))
* if the stopReason includes 'error', set llm span and agent span to error ([2e0d7f7](https://dg.starstao.top/ads/openclaw-observability-plugin/commit/2e0d7f76f8154a2c75d29a46860950ac4c0d6f82))

### [2.0.1](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/compare/v2.0.0...v2.0.1) (2026-04-13)


### Bug Fixes

*  tool span missing sometimes issue. the reason is that sometimes there is no sessionkey in before_tool_call event ctx ([ab2eb6c](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/commit/ab2eb6cc9abb48bfc489b54b6a4cf0d6c0bdb84c))

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