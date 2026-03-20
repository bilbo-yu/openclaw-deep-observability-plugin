# Generic OTLP Backend

Any backend that supports OTLP (OpenTelemetry Protocol) can receive data from this plugin. Here are configuration snippets for popular backends.

## Honeycomb

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
          "endpoint": "https://api.honeycomb.io",
          "protocol": "http/protobuf",
          "captureContent": true,
          "headers": {
            "x-honeycomb-team": "<YOUR_API_KEY>"
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

## New Relic

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
          "endpoint": "https://otlp.nr-data.net",
          "protocol": "http/protobuf",
          "captureContent": true,
          "headers": {
            "api-key": "<YOUR_INGEST_LICENSE_KEY>"
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

!!! note
    For EU data centers, use `https://otlp.eu01.nr-data.net`.

## Datadog

Datadog doesn't support direct OTLP ingest — use the OTel Collector with the Datadog exporter.

### Collector Config

```yaml
exporters:
  datadog:
    api:
      key: "${DD_API_KEY}"
      site: "datadoghq.com"  # or datadoghq.eu, etc.

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [datadog]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [datadog]
```

### Plugin Config

Point at the local collector:

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

## SigNoz

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
          "endpoint": "https://ingest.{region}.signoz.cloud:443",
          "protocol": "http/protobuf",
          "captureContent": true,
          "headers": {
            "signoz-access-token": "<YOUR_SIGNOZ_TOKEN>"
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

Or self-hosted:

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
          "endpoint": "http://{signoz-host}:4318",
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

## Jaeger

Jaeger supports OTLP natively since v1.35:

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
          "endpoint": "http://{jaeger-host}:4318",
          "protocol": "http/protobuf",
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

!!! note
    Jaeger only supports traces, not metrics or logs via OTLP.

## Splunk

Use the OTel Collector with the Splunk HEC exporter:

### Collector Config

```yaml
exporters:
  splunk_hec:
    token: "${SPLUNK_HEC_TOKEN}"
    endpoint: "https://<splunk-host>:8088/services/collector"
    source: "openclaw"
    sourcetype: "otel"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [splunk_hec]
```

## Elastic / Elasticsearch

Use the OTel Collector with the Elasticsearch exporter:

### Collector Config

```yaml
exporters:
  elasticsearch:
    endpoints: ["https://<elastic-host>:9200"]
    user: "${ELASTIC_USER}"
    password: "${ELASTIC_PASSWORD}"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [elasticsearch]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [elasticsearch]
```

## Custom / Self-Hosted Collector

If your backend isn't listed, you can almost certainly connect it via the OTel Collector. The [contrib distribution](https://github.com/open-telemetry/opentelemetry-collector-contrib) includes exporters for 50+ backends.

1. Find your exporter in the [collector contrib registry](https://opentelemetry.io/ecosystem/registry/?language=collector)
2. Add it to the collector config
3. Point the plugin at `http://localhost:4318`
