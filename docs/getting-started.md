# Getting Started

Get OpenTelemetry observability for your OpenClaw AI agents.

## Prerequisites

- OpenClaw v2026.2.0 or later
- An OTLP endpoint (local collector, Dynatrace, Grafana, etc.)

## Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/bilbo-yu/openclaw-deep-observability-plugin.git
```

### Step 2: Configure OpenClaw

Add to your `openclaw.json`:

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

### Step 3: Clear Cache and Restart

```bash
rm -rf /tmp/jiti
openclaw gateway restart
```

### Step 4: Verify

Send a message to your agent and check your backend for connected traces:

```
openclaw.agent.turn (root span)
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

## Backend Quick Setup

### Local OTel Collector

1. Install:
   ```bash
   # Ubuntu/Debian
   wget https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.144.0/otelcol-contrib_0.144.0_linux_amd64.deb
   sudo dpkg -i otelcol-contrib_0.144.0_linux_amd64.deb
   ```

2. Configure (`/etc/otelcol-contrib/config.yaml`):
   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318

   processors:
     batch:

   exporters:
     debug:
       verbosity: detailed
     # Add your backend exporter

   service:
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
   ```

3. Start:
   ```bash
   sudo systemctl start otelcol-contrib
   ```

### Dynatrace (Direct)

No collector needed:

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

**Required scopes:** `metrics.ingest`, `logs.ingest`, `openTelemetryTrace.ingest`

### Grafana Cloud

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

---

## Troubleshooting

### No data appearing?

1. Check Gateway logs:
   ```bash
   journalctl --user -u openclaw-gateway -f
   ```

2. Verify endpoint is reachable:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

3. Check diagnostics config:
   ```bash
   cat ~/.openclaw/openclaw.json | jq '.diagnostics'
   ```

### Custom plugin not loading?

1. Check plugin discovery:
   ```bash
   openclaw plugins list
   ```

2. Clear jiti cache:
   ```bash
   rm -rf /tmp/jiti
   ```

3. Check for TypeScript errors in Gateway logs

### Traces not connected?

The custom plugin requires messages to flow through the normal pipeline. Heartbeats and some internal events may not have full trace context.

---

## Next Steps

- [Configuration Reference](./configuration.md) — All options
- [Architecture](./architecture.md) — How it works
- [Limitations](./limitations.md) — Known constraints
- [Backend Guides](./backends/) — Specific backend setup
