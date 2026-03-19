# OpenClaw Deep Observability

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

📖 **[Full Documentation](https://github.com/bilbo-yu/openclaw-deep-observability-plugin/)** — Setup guides, configuration reference, and backend examples.

## What is OpenClaw Deep Observability Plugin?

OpenClaw Deep Observability Plugin is an enterprise-grade OpenTelemetry instrumentation plugin designed specifically for [OpenClaw](https://github.com/openclaw/openclaw) AI agent systems. It provides comprehensive observability into your AI agents' behavior, performance, and security posture.

### Key Capabilities

- **Deep Tracing**: Captures complete request lifecycles with proper parent-child span hierarchies, allowing you to trace every LLM call, tool execution, and agent interaction end-to-end.
- **Rich Metrics**: Exposes detailed metrics covering sessions, messages, queues, tokens, LLM operations, tool executions, webhooks, and security events.
- **Security Detection**: Built-in detection for sensitive file access, prompt injection attempts, and dangerous command executions — all exported as span events for real-time alerting.
- **Flexible Export**: Supports both HTTP/Protobuf and gRPC protocols for maximum compatibility with OTLP backends like Dynatrace, Grafana Cloud, Jaeger, and more.
- **Input/Output Capture**: Configurable capture of LLM and tool inputs/outputs for debugging and auditing purposes.

### Use Cases

- **Performance Monitoring**: Identify slow LLM calls, bottlenecks in tool chains, and optimize agent response times.
- **Cost Tracking**: Monitor token usage and associated costs across all agents and models.
- **Security Auditing**: Detect and investigate suspicious agent behaviors in real-time.
- **Debugging**: Trace exact execution flows when troubleshooting agent issues.

## Why OpenClaw Deep Observability Plugin?

OpenClaw provides an official `diagnostics-otel` plugin that offers basic OpenTelemetry observability. However, its capabilities are limited in several critical areas:

### Limitations of the Official Plugin

| Area | Official Plugin Limitation |
|------|---------------------------|
| **Traces** | Spans are independent with no parent-child hierarchy, making it impossible to trace request flows |
| **LLM Calls** | Aggregated into a single span, no per-call visibility |
| **Tool Calls** | Not captured at all |
| **Protocol** | HTTP/Protobuf only, no gRPC support |
| **Security** | No security event detection |
| **Context** | No context propagation between spans |

### What This Plugin Provides

This plugin was developed to address these gaps and provide **comprehensive, production-ready observability** for OpenClaw deployments:

- ✅ **Complete Span Hierarchy**: Every operation is properly linked, giving you full visibility into request flows
- ✅ **Per-Call Granularity**: Each LLM call and tool execution is captured as a distinct span with timing and attributes
- ✅ **Dual Protocol Support**: Choose between HTTP/Protobuf or gRPC based on your infrastructure
- ✅ **Built-in Security Detection**: Automatic detection of sensitive file access, prompt injection, and dangerous commands
- ✅ **Full Context Propagation**: Proper OTel context flow for distributed tracing scenarios

### Comparison to Official Diagnostics-Otel Plugin

#### Comprehensive Comparison Summary

| Dimension | Official Plugin | This Plugin | Notes |
|-----------|:---------------:|:-----------:|-------|
| **Traces Observability** | ⭐⭐ | ⭐⭐⭐⭐⭐ | Official: Independent spans, no hierarchy <br> This: Complete parent-child hierarchy, LLM/Tool calls visible, input/output capture |
| **Metrics Coverage** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Official: Basic Gateway metrics complete <br> This: 100% compatible + Agent/Tool/Security extra metrics |
| **Logs Support** | ⭐⭐⭐ | ⭐⭐⭐ | Same as official |
| **Protocol Support** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Official: http/protobuf only <br> This: http/protobuf + gRPC dual protocol |
| **Security Detection** | ☆ | ⭐⭐⭐⭐⭐ | Official: No security detection <br> This: Built-in sensitive file access, prompt injection, dangerous command detection exported as span events |


---

#### Traces Comparison

| Feature | Official Plugin | This Plugin |
|---------|-----------------|-------------|
| **Export Protocol** | http/protobuf | http/protobuf, gRPC |
| **Span Structure** | Independent spans (no parent-child) | Chained spans with hierarchy |
| **Message Span** | ✅ Independent span `openclaw.message.processed` | ✅ `openclaw.request` (root span) |
| **Agent Span** | ❌ No | ✅ `openclaw.agent.turn` (child of root) |
| **Per-LLM Call Spans** | ❌ Aggregated independent span "openclaw.model.usage" | ✅ `chat <model>` child spans |
| **Per-Tool Call Spans** | ❌ No | ✅ `tool.<name>` child spans |
| **Webhook Spans** | ✅ Yes, independent span `openclaw.webhook.processed` `openclaw.webhook.error` | ✅ Same as official plugin |
| **Stuck Session Detection** | ✅ Yes, independent span `openclaw.session.stuck` | ✅ Same as official plugin |
| **Input/Output Capture** | ❌ No | ✅ `traceloop.entity.input/output` (configurable) |
| **Security Event Attributes** | ❌ No | ✅ `openclaw.security.event` JSON on tool/agent spans |
| **Context Propagation** | ❌ No | ✅ Full parent-child context via OTel API |

**Trace Structure Example (This Plugin):**
```
openclaw.request (root span)
  ├── openclaw.agent.turn
      ├── chat claude-sonnet-4 (LLM call #1)
      ├── tool.Read (file read)
      ├── chat claude-sonnet-4 (LLM call #2)
      ├── tool.exec (shell command)
      ├── chat claude-sonnet-4 (LLM call #3)
      ├── tool.Write (file write)
      ├── chat claude-sonnet-4 (LLM call #4)
      └── tool.web_search
```

---

#### Metrics Comparison

| Category | Metric Description | Metric Name | Type | Official Plugin | This Plugin |
|----------|-------------------|-------------|------|-----------------|-------------|
| **Session** | Session Resets | `openclaw.session.resets` | Counter | ❌ | ✅ |
| **Session** | Session State Transitions | `openclaw.session.state` | Counter | ✅ | ✅ |
| **Session** | Stuck Sessions | `openclaw.session.stuck` | Counter | ✅ | ✅ |
| **Session** | Stuck Session Age | `openclaw.session.stuck_age_ms` | Histogram | ✅ | ✅ |
| **Message** | Message Queued | `openclaw.message.queued` | Counter | ✅ | ✅ |
| **Message** | Message Processed | `openclaw.message.processed` | Counter | ✅ | ✅ |
| **Message** | Message Process Duration | `openclaw.message.duration_ms` | Histogram | ✅ | ✅ |
| **Message** | Message Process Duration | `gen_ai.agent.request.duration` | Histogram | ❌ | ✅ |
| **Queue** | Queue Depth | `openclaw.queue.depth` | Histogram | ✅ | ✅ |
| **Queue** | Queue Wait Time | `openclaw.queue.wait_ms` | Histogram | ✅ | ✅ |
| **Queue** | Lane Enqueue | `openclaw.queue.lane.enqueue` | Counter | ✅ | ✅ |
| **Queue** | Lane Dequeue | `openclaw.queue.lane.dequeue` | Counter | ✅ | ✅ |
| **Agent** | Run Attempts | `openclaw.run.attempt` (Note: This metric is always zero currently.) | Counter | ✅ | ✅ |
| **Agent** | Agent Run Duration (success/fail) | `openclaw.agent.turn_duration` | Histogram | ❌ | ✅ |
| **Token** | Token Usage Counter | `openclaw.tokens` | Counter | ✅ | ✅ |
| **Token** | Token Usage Distribution | `gen_ai.client.token.usage` | Histogram | ❌ | ✅ |
| **Token** | Token Cost (USD) | `openclaw.cost.usd` | Counter | ✅ | ✅ |
| **Token** | Context Window | `openclaw.context.tokens` | Histogram | ✅ | ✅ |
| **LLM** | LLM Request Duration | `openclaw.run.duration_ms` | Histogram | ✅ | ✅ |
| **LLM** | LLM Request Duration | `gen_ai.client.operation.duration` | Histogram | ❌ | ✅ |
| **Tool** | Tool Duration (success/fail) | `openclaw.tool.duration` | Histogram | ❌ | ✅ |
| **Webhook** | Webhook Received | `openclaw.webhook.received` | Counter | ✅ | ✅ |
| **Webhook** | Webhook Errors | `openclaw.webhook.error` | Counter | ✅ | ✅ |
| **Webhook** | Webhook Duration | `openclaw.webhook.duration_ms` | Histogram | ✅ | ✅ |
| **Security** | Security Events | `openclaw.security.events` | Counter | ❌ | ✅ |
| **Security** | Sensitive File Access | `openclaw.security.sensitive_file_access` | Counter | ❌ | ✅ |
| **Security** | Prompt Injection Detection | `openclaw.security.prompt_injection` | Counter | ❌ | ✅ |
| **Security** | Dangerous Command Detection | `openclaw.security.dangerous_command` | Counter | ❌ | ✅ |

---

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/bilbo-yu/openclaw-deep-observability-plugin.git
   ```

2. Add to your `openclaw.json`:
   ```json
   {
     "diagnostics": {
        "enabled": true
     },
     "plugins": {
       "load": {
         "paths": ["/path/to/openclaw-deep-observability-plugin"]
       },
       "entries": {
         "otel-deep-observability": {
           "enabled": true,
           "config": {
             "endpoint": "http://localhost:4318",
             "serviceName": "openclaw-gateway",
             "resourceAttributes": {
                  "application.name": "openclaw"
              }
           }
         }
       }
     }
   }
   ```

3. Clear cache and restart:
   ```bash
   rm -rf /tmp/jiti
   openclaw gateway restart
   ```

---

### Configuration Examples For Different Backends

#### Dynatrace (Direct)

```json
{
  "diagnostics": {
    "enabled": true
  },
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-deep-observability-plugin"]
    },
    "entries": {
      "otel-deep-observability": {
        "enabled": true,
        "config": {
          "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Api-Token {your-token}"
          },
          "resourceAttributes": {
            "application.name": "openclaw"
          }
        }
      }
    }
  }
}
```

#### Grafana Cloud

```json
{
  "diagnostics": {
    "enabled": true
  },
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-deep-observability-plugin"]
    },
    "entries": {
      "otel-deep-observability": {
        "enabled": true,
        "config": {
          "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Basic {base64-credentials}"
          },
          "resourceAttributes": {
            "application.name": "openclaw"
          }
        }
      }
    }
  }
}
```

#### Local OTel Collector

```json
{
  "diagnostics": {
    "enabled": true
  },
  "plugins": {
    "load": {
      "paths": ["/path/to/openclaw-deep-observability-plugin"]
    },
    "entries": {
      "otel-deep-observability": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "serviceName": "openclaw-gateway",
          "resourceAttributes": {
            "application.name": "openclaw"
          }
        }
      }
    }
  }
}
```

---

## Configuration Reference


### Plugin Options

| Option | Type | Description |
|--------|------|-------------|
| `endpoint` | string | OTLP endpoint URL (e.g., `http://localhost:4318` for HTTP, `http://localhost:4317` for gRPC) |
| `protocol` | string | OTLP export protocol: `"http/protobuf"` or `"grpc"` |
| `serviceName` | string | OpenTelemetry service name |
| `headers` | object | Custom headers for OTLP export (e.g., `{"Authorization": "Api-Token xxx"}` for Dynatrace) |
| `traces` | boolean | Enable trace export |
| `metrics` | boolean | Enable metrics export |
| `logs` | boolean | Enable log export |
| `captureContent` | boolean | Capture prompt/completion content in spans |
| `metricsIntervalMs` | integer | Metrics export interval in milliseconds (minimum 1000) |
| `resourceAttributes` | object | Additional OTel resource attributes (e.g., `{"application.name": "openclaw"}`) |

---

## Documentation

- [Getting Started](./docs/getting-started.md) — Setup guide
- [Configuration](./docs/configuration.md) — All options
- [Architecture](./docs/architecture.md) — How it works
- [Limitations](./docs/limitations.md) — Known constraints
- [Backends](./docs/backends/) — Backend-specific guides

---

## Known Limitations

**Auto-instrumentation not possible:** OpenLLMetry/IITM breaks `@mariozechner/pi-ai` named exports due to ESM/CJS module isolation. All telemetry is captured via hooks, not direct SDK instrumentation.

**Per-LLM-call spans have no input:** per LLM call spans has no input.

See [Limitations](./docs/limitations.md) for details.

---
## Acknowledgments

This project is built on top of [openclaw-observability-plugin](https://github.com/henrikrexed/openclaw-observability-plugin) by [@henrikrexed](https://github.com/henrikrexed). Thanks to the original author for the foundational work on the basic plugin framework.

---
## License

Apache 2.0