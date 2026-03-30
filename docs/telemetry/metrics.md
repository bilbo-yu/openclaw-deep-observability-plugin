# Metrics Reference

All metrics use the `openclaw.*` or `gen_ai.*` namespace and are exported via OTLP at the configured interval (default: 30 seconds).

## GenAI Semantic Convention Metrics

These metrics follow the [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

### `gen_ai.client.token.usage`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | token |
| **Description** | Measures number of input and output tokens used |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `gen_ai.request.model` | Model requested |
| `gen_ai.response.model` | Model used for response |
| `gen_ai.system` | Provider name (anthropic, openai, etc.) |
| `gen_ai.token.type` | Token type: `input`, `output`, `cache_read`, `cache_write` |

---

### `gen_ai.client.operation.duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | s |
| **Description** | GenAI operation duration in seconds |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `gen_ai.operation.name` | Operation type: `execute_tool` (tool execution), `chat` (LLM calls) |
| `gen_ai.request.model` | Model requested (LLM calls only) |
| `gen_ai.response.model` | Model used for response (LLM calls only) |
| `gen_ai.system` | Provider name (LLM calls only) |
| `gen_ai.tool.name` | Tool name (tool execution only) |
| `error.type` | Error type: `tool_error` if tool execution failed, empty otherwise (tool execution only) |

**Bucket Boundaries (seconds):** 0, 1, 2, 4, 6, 8, 10, 15, 20, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000

This metric is recorded for two operation types:
- **LLM calls**: Uses `gen_ai.operation.name="chat"`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.system` attributes
- **Tool executions**: Uses `gen_ai.operation.name="execute_tool"`, `gen_ai.tool.name`, `error.type` attributes

---

### `gen_ai.agent.request.duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | s |
| **Description** | Agent request processing duration in seconds |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `success` | Whether the request succeeded |
| `request.channel` | Source channel |
| `request.target` | Target type |

## Agent Metrics

### `openclaw.agent.turn_duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Full agent turn duration (LLM + tools + processing) |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `success` | Whether the turn succeeded |
| `gen_ai.response.model` | Model used |
| `gen_ai.agent.id` | Agent identifier |

End-to-end time for a complete agent turn. This is the user-perceived latency.

---

### `openclaw.run.duration_ms`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Agent run duration |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.provider` | LLM provider |
| `openclaw.model` | Model name |

---

### `openclaw.run.attempt`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Run attempts |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.attempt` | Attempt number |

---

### `gen_ai.agent.skill_usage_total`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Skill usage counter - records each skill used by the agent |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `gen_ai.skill.name` | Name of the skill used |
| `gen_ai.agent.id` | Agent identifier |

This counter is incremented for each unique skill used during an agent turn. Skills are extracted from the LLM's response when it outputs `Skills Used: skill_name_1, skill_name_2`.

## Token & Cost Metrics

### `openclaw.tokens`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Token usage by type |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.provider` | LLM provider |
| `openclaw.model` | Model name |
| `openclaw.token` | Token type: `input`, `output`, `cache_read`, `cache_write`, `prompt`, `total` |

---

### `openclaw.cost.usd`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Estimated model cost (USD) |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.provider` | LLM provider |
| `openclaw.model` | Model name |

---

### `openclaw.context.tokens`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | 1 |
| **Description** | Context window size and usage |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.provider` | LLM provider |
| `openclaw.model` | Model name |
| `openclaw.context` | Context type: `limit`, `used` |

## Tool Metrics

### `openclaw.tool.duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Tool execution duration in milliseconds |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `tool.name` | Tool name |
| `success` | Whether execution succeeded |

**Example tool names:** `exec`, `Read`, `Write`, `Edit`, `web_fetch`, `web_search`, `browser`, `memory_search`

## Session Metrics

### `openclaw.session.resets`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | resets |
| **Description** | Total session resets |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `command.source` | Command source |

How often sessions are reset via `/new` or `/reset`.

---

### `openclaw.session.state`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Session state transitions |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.state` | New state |
| `openclaw.reason` | Transition reason |

---

### `openclaw.session.stuck`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Sessions stuck in processing |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.state` | Session state |

---

### `openclaw.session.stuck_age_ms`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Age of stuck sessions |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.state` | Session state |

## Message Metrics

### `openclaw.message.queued`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Messages queued for processing |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.source` | Message source |

---

### `openclaw.message.processed`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Messages processed by outcome |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.outcome` | Processing outcome (`completed`, `error`, etc.) |

---

### `openclaw.message.duration_ms`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Message processing duration |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.outcome` | Processing outcome |

## Webhook Metrics

### `openclaw.webhook.received`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Webhook requests received |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.webhook` | Update type |

---

### `openclaw.webhook.error`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Webhook processing errors |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.webhook` | Update type |

---

### `openclaw.webhook.duration_ms`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Webhook processing duration |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.channel` | Source channel |
| `openclaw.webhook` | Update type |

## Queue Metrics

### `openclaw.queue.lane.enqueue`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Command queue lane enqueue events |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.lane` | Queue lane name |

---

### `openclaw.queue.lane.dequeue`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | 1 |
| **Description** | Command queue lane dequeue events |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.lane` | Queue lane name |

---

### `openclaw.queue.depth`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | 1 |
| **Description** | Queue depth on enqueue/dequeue |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.lane` | Queue lane name |
| `openclaw.channel` | Source channel |

---

### `openclaw.queue.wait_ms`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Queue wait time before execution |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `openclaw.lane` | Queue lane name |

## Security Metrics

### `openclaw.security.events`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Description** | Total security events detected across all detection types |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `detection` | Detection type (`sensitive_file_access`, `prompt_injection`, `dangerous_command`) |
| `severity` | Severity level (`critical`, `high`, `warning`, `info`) |

The umbrella counter for all security detections.

---

### `openclaw.security.sensitive_file_access`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Description** | Attempts to access sensitive files (credentials, SSH keys, .env, etc.) |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `file_pattern` | Regex pattern that matched |

Triggers when the agent reads, writes, or edits files matching sensitive patterns (`.env`, `.ssh/`, `credentials`, `api_key`, etc.).

---

### `openclaw.security.prompt_injection`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Description** | Prompt injection attempts detected in inbound messages |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `pattern_count` | Number of patterns matched |

Detects social engineering patterns like "ignore previous instructions", fake `[SYSTEM]` tags, role manipulation, and jailbreak attempts.

---

### `openclaw.security.dangerous_command`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Description** | Dangerous shell command executions detected |

**Attributes:**

| Attribute | Description |
|-----------|-------------|
| `command_type` | Type of threat detected |

Catches data exfiltration (`curl -d`, `nc -e`), destructive commands (`rm -rf /`, `mkfs`), privilege escalation (`chmod +s`), crypto mining (`xmrig`), and persistence mechanisms.

## Dashboard Examples

### Token Usage Over Time

Track cost by monitoring token usage over time. In Dynatrace:

```sql
timeseries sum(openclaw.tokens), by:{openclaw.model, openclaw.token}
```

### LLM Latency Percentiles

```sql
timeseries percentile(gen_ai.client.operation.duration, 50, 95, 99)
```

### Tool Duration by Tool Name

```sql
timeseries avg(openclaw.tool.duration), by:{tool.name}
```

### Most Used Tools

```sql
timeseries count(openclaw.tool.duration), by:{tool.name}
```

### Security Events Over Time

```sql
timeseries sum(openclaw.security.events), by:{detection, severity}
```

### Sensitive File Access by Pattern

```sql
timeseries sum(openclaw.security.sensitive_file_access), by:{file_pattern}
```

### Dangerous Commands by Type

```sql
timeseries sum(openclaw.security.dangerous_command), by:{command_type}
```

### Queue Depth Monitoring

```sql
timeseries avg(openclaw.queue.depth), by:{openclaw.lane}
```

### Webhook Processing Time

```sql
timeseries avg(openclaw.webhook.duration_ms), by:{openclaw.channel, openclaw.webhook}
```

### Message Processing Outcome Distribution

```sql
timeseries sum(openclaw.message.processed), by:{openclaw.outcome}
```

### Cost Tracking by Model

```sql
timeseries sum(openclaw.cost.usd), by:{openclaw.model, openclaw.provider}