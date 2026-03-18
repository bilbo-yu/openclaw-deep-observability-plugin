# Configuration

Configure the OpenClaw Deep Observability Plugin via your `openclaw.json`.

## Full Configuration Example

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
          "protocol": "http/protobuf",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Api-Token dt0c01.xxx"
          },
          "traces": true,
          "metrics": true,
          "logs": true,
          "captureContent": false,
          "metricsIntervalMs": 60000,
          "resourceAttributes": {
            "application.name": "openclaw"
          }
        }
      }
    }
  }
}
```

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

## Endpoint Configuration

### HTTP/Protobuf Protocol (Default)

For OTLP/HTTP endpoints (port 4318):

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "protocol": "http/protobuf"
  }
}
```

The endpoint auto-appends `/v1/traces`, `/v1/metrics`, `/v1/logs` as needed.

### gRPC Protocol

For OTLP/gRPC endpoints (port 4317):

```json
{
  "config": {
    "endpoint": "http://localhost:4317",
    "protocol": "grpc"
  }
}
```

---

## Authentication

### Dynatrace API Token

```json
{
  "config": {
    "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
    "headers": {
      "Authorization": "Api-Token dt0c01.xxx..."
    }
  }
}
```

### Grafana Cloud (Basic Auth)

```json
{
  "config": {
    "endpoint": "https://otlp-gateway-prod-us-central-0.grafana.net/otlp",
    "headers": {
      "Authorization": "Basic base64(instanceId:apiKey)"
    }
  }
}
```

### Bearer Token

```json
{
  "config": {
    "endpoint": "https://api.example.com/otlp",
    "headers": {
      "Authorization": "Bearer your-token-here"
    }
  }
}
```

---

## Selective Export

Enable only specific signals:

### Traces Only

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "traces": true,
    "metrics": false,
    "logs": false
  }
}
```

### Metrics Only

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "traces": false,
    "metrics": true,
    "logs": false
  }
}
```

### Logs Only

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "traces": false,
    "metrics": false,
    "logs": true
  }
}
```

---

## Resource Attributes

Add custom attributes to all telemetry:

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "serviceName": "openclaw-gateway",
    "resourceAttributes": {
      "application.name": "openclaw",
      "deployment.environment": "production",
      "team": "ai-platform"
    }
  }
}
```

---

## Content Capture

Enable capture of LLM prompt/completion content:

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "captureContent": true
  }
}
```

When enabled, spans will include:
- `traceloop.entity.input` — The prompt/input text
- `traceloop.entity.output` — The completion/output text

!!! warning "Privacy Consideration"
    Content capture may record sensitive user data. Disable in production if privacy is a concern.

---

## Metrics Export Interval

Control how often metrics are exported:

```json
{
  "config": {
    "endpoint": "http://localhost:4318",
    "metricsIntervalMs": 30000
  }
}
```

- Default: 60000 (60 seconds)
- Minimum: 1000 (1 second)

---

## Applying Changes

After modifying configuration:

```bash
rm -rf /tmp/jiti
openclaw gateway restart
```

---

## Troubleshooting

### Configuration Not Applied?

Check the current config:

```bash
cat ~/.openclaw/openclaw.json | jq '.plugins.entries."otel-deep-observability"'
```

### Invalid Config Errors?

Validate JSON syntax:

```bash
cat ~/.openclaw/openclaw.json | jq .
```

### Endpoint Unreachable?

Test connectivity:

```bash
curl -v http://localhost:4318/v1/traces