# Dynatrace Setup

Send OpenClaw telemetry directly to Dynatrace using OTLP.

## Prerequisites

- Dynatrace environment (SaaS or Managed)
- API token with ingest permissions

## Create API Token

1. Go to **Settings** → **Access tokens**
2. Click **Generate new token**
3. Add scopes:
   - `metrics.ingest`
   - `logs.ingest`
   - `openTelemetryTrace.ingest`
4. Copy the token (starts with `dt0c01.`)

## Configure OpenClaw

Add to your `openclaw.json`:

```json
{
  "diagnostics": {
     "enabled": true
  },
  "plugins": {
    
    "entries": {
      "openclaw-deep-observability-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Api-Token dt0c01.XXXXXXXX"
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

Replace:
- `{env-id}` — Your Dynatrace environment ID (e.g., `abc12345`)
- `dt0c01.XXXXXXXX` — Your API token

### Dynatrace Managed

For Dynatrace Managed, use your ActiveGate URL:

```json
{
  "diagnostics": {
     "enabled": true
  },
  "plugins": {
    
    "entries": {
      "openclaw-deep-observability-plugin": {
        "enabled": true,
        "config": {
          "endpoint": "https://{your-activegate}/e/{environment-id}/api/v2/otlp",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Api-Token dt0c01.XXXXXXXX"
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

## Restart Gateway

```bash
rm -rf /tmp/jiti
openclaw gateway restart
```

## Verify in Dynatrace

### Find Your Service

1. Go to **Services** in Dynatrace
2. Search for `openclaw-gateway`
3. Click to view service details

### View Traces

1. Go to **Distributed traces**
2. Filter by service: `openclaw-gateway`
3. Click a trace to see spans

### View Metrics

1. Go to **Explore** → **Metrics**
2. Search for `openclaw.`
3. Available metrics:
   - `openclaw.tokens` — Token usage
   - `openclaw.cost.usd` — Cost tracking
   - `openclaw.run.duration_ms` — Agent run times
   - `openclaw.message.*` — Message processing
   - `openclaw.queue.*` — Queue metrics

### Create Dashboard

Create a dashboard with:

```sql
-- Token usage by model
timeseries sum(openclaw.tokens), by:{openclaw.model, openclaw.token}

-- Cost over time
timeseries sum(openclaw.cost.usd), by:{openclaw.model}

-- Agent run duration
timeseries avg(openclaw.run.duration_ms), by:{openclaw.model}
```

### View Logs

1. Go to **Logs**
2. Filter: `dt.entity.service = "openclaw-gateway"`
3. View log records with severity and attributes

## Example DQL Queries

### Token Usage by Model
```sql
fetch spans
| filter dt.entity.service == "openclaw-gateway"
| summarize tokens = sum(openclaw.tokens.total), by:{openclaw.model}
| sort tokens desc
```

### Average Run Duration
```sql
fetch spans
| filter dt.entity.service == "openclaw-gateway"
| filter matchesPhrase(span.name, "model")
| summarize avg_duration = avg(openclaw.run.duration_ms)
```

### Error Rate
```sql
fetch logs
| filter dt.entity.service == "openclaw-gateway"
| filter loglevel == "ERROR"
| summarize count = count()
```

## Troubleshooting

### No Data in Dynatrace?

1. **Check token permissions**: Ensure all three scopes are enabled
2. **Verify endpoint URL**: Should be `https://{env-id}.live.dynatrace.com/api/v2/otlp`
3. **Test connectivity**:
   ```bash
   curl -v "https://{env-id}.live.dynatrace.com/api/v2/otlp/v1/traces" \
     -H "Authorization: Api-Token dt0c01.xxx"
   ```

### Service Not Appearing?

- Wait 2-5 minutes for service detection
- Send a few messages to generate telemetry
- Check Dynatrace logs for ingest errors

### 403 Forbidden?

Token lacks required scopes. Regenerate with all three:
- `metrics.ingest`
- `logs.ingest`
- `openTelemetryTrace.ingest`
