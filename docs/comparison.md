# Comparison to Official Diagnostics-Otel Plugin

OpenClaw provides an official `diagnostics-otel` plugin that offers basic OpenTelemetry observability. This page provides a detailed comparison between the official plugin and this enhanced plugin.

## Comprehensive Comparison Summary

| Dimension | Official Plugin | This Plugin | Notes |
|-----------|:---------------:|:-----------:|-------|
| **Traces Observability** | ⭐⭐ | ⭐⭐⭐⭐⭐ | Official: Independent spans, no hierarchy <br> This: Complete parent-child hierarchy, LLM/Tool calls visible, input/output capture |
| **Metrics Coverage** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Official: Basic Gateway metrics complete <br> This: 100% compatible + Agent/Tool/Security extra metrics |
| **Logs Support** | ⭐⭐⭐ | ⭐⭐⭐ | Same as official |
| **Protocol Support** | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Official: http/protobuf only <br> This: http/protobuf + gRPC dual protocol |
| **Security Detection** | ☆ | ⭐⭐⭐⭐⭐ | Official: No security detection <br> This: Built-in sensitive file access, prompt injection, dangerous command detection exported as span events |

---

## Traces Comparison

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

## Metrics Comparison

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