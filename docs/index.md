# OpenClaw Deep Observability

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Deep OpenTelemetry observability for OpenClaw AI agents — traces, metrics, and logs.

## What is OpenClaw Deep Observability Plugin?

OpenClaw Deep Observability Plugin is an enterprise-grade OpenTelemetry instrumentation plugin designed specifically for [OpenClaw](https://github.com/openclaw/openclaw) AI agent systems. It provides comprehensive observability into your AI agents' behavior, performance, and security posture.

### Key Capabilities

- **Deep Tracing**: Captures complete request lifecycles with proper parent-child span hierarchies, allowing you to trace every LLM call, tool execution, and agent interaction end-to-end.
- **Rich Metrics**: Exposes detailed metrics covering sessions, messages, queues, tokens, LLM operations, tool executions, webhooks, and security events.
- **Security Detection**: Built-in detection for sensitive file access, prompt injection attempts, and dangerous command executions — all exported as span events for real-time alerting.
- **Flexible Export**: Supports both HTTP/Protobuf and gRPC protocols for maximum compatibility with OTLP backends like Dynatrace, Grafana Cloud, Jaeger, and more.
- **Input/Output Capture**: Configurable capture of LLM and tool inputs/outputs for debugging and auditing purposes.

## Quick Start

1. Clone this repository:
   ```bash
   openclaw plugins install openclaw-deep-observability-plugin
   ```

2. Add to your `openclaw.json`:
   ```json
   {
     "diagnostics": {
        "enabled": true
     },
     "plugins": {
       "allow": [
          "openclaw-deep-observability-plugin"
        ],
       "entries": {
         "openclaw-deep-observability-plugin": {
           "enabled": true,
           "config": {
             "endpoint": "http://localhost:4318",
             "serviceName": "openclaw-gateway",
             "captureContent": true,
             "resourceAttributes": {
                  "application.name": "openclaw"
              }
           }
         }
       }
     }
   }
   ```

3. Restart openclaw gateway:
   ```bash
   openclaw gateway restart
   ```


## Supported Backends

Works with any OTLP-compatible backend. See [Backends Overview](backends/index.md) for a complete comparison.

- [Dynatrace](backends/dynatrace.md) — Direct OTLP ingest
- [Grafana](backends/grafana.md) — Tempo, Loki, Mimir
- [Generic OTLP](backends/generic-otlp.md) — Any OTLP-compatible backend
- [OTel Collector](backends/otel-collector.md) — OpenTelemetry Collector setup

## Documentation

- [Configuration](configuration.md) — All options explained
- [Architecture](architecture.md) — How it works
- [Comparison](comparison.md) — Feature comparison with alternatives
- Jaeger — Distributed tracing
- Prometheus + Grafana — Metrics
- Honeycomb, New Relic, Datadog — Cloud platforms
### Telemetry Reference

- [Traces](telemetry/traces.md) — Distributed tracing details
- [Metrics](telemetry/metrics.md) — Available metrics reference
- [Tokens](telemetry/tokens.md) — Token usage tracking

### Security Monitoring

- [Security Detection](security/detection.md) — Real-time threat detection
- [Tetragon Integration](security/tetragon.md) — Kernel-level monitoring

The plugin includes **real-time security detection** for:

| Detection | Severity | What It Catches |
|-----------|----------|-----------------|
| Sensitive File Access | Critical | Credentials, SSH keys, .env files |
| Prompt Injection | High | Social engineering attacks on the AI |
| Dangerous Commands | Critical | Data exfiltration, rm -rf, crypto mining |
| Token Spike Anomaly | Warning | Unusual usage patterns |

Combined with Tetragon kernel monitoring, this provides defense-in-depth security observability.

## Acknowledgments

This project is built on top of [openclaw-observability-plugin](https://github.com/henrikrexed/openclaw-observability-plugin) by [@henrikrexed](https://github.com/henrikrexed). Thanks to the original author for the foundational work on the basic plugin framework.

## License

MIT
