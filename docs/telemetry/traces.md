# Traces Reference

The plugin generates connected distributed traces using OpenClaw's hook-based plugin API and diagnostic events.

## Trace Structure

Every user message produces a trace tree:

```
openclaw.request (SERVER span — full message lifecycle)
├── openclaw.agent.turn (INTERNAL — agent processing)
│   ├── gen_ai.system: anthropic
│   ├── gen_ai.provider.name: anthropic
│   ├── gen_ai.request.model: claude-opus-4-5
│   ├── gen_ai.response.model: claude-opus-4-5
│   ├── gen_ai.usage.input_tokens: 4521
│   ├── gen_ai.usage.output_tokens: 892
│   ├── gen_ai.usage.cache_read_tokens: 918174
│   ├── gen_ai.usage.cache_write_tokens: 62437
│   ├── gen_ai.usage.total_tokens: 998598
│   ├── chat claude-opus-4-5 (CLIENT span — LLM call)
│   │   └── traceloop.entity.input/output (if captureContent enabled)
│   ├── tool.exec (INTERNAL — tool execution)
│   ├── tool.Read (INTERNAL — file read)
│   └── tool.Write (INTERNAL — file write)
└── openclaw.command.new (INTERNAL — if session reset)
```

All spans within a request share the same `traceId` and are linked via parent-child relationships.

## Request Span

Created by the `message.queued` diagnostic event. This is the root span for the entire request lifecycle.

| Field | Value |
|-------|-------|
| **Span Name** | `openclaw.request` |
| **Kind** | `SERVER` |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.message.channel` | string | Source channel (`whatsapp`, `telegram`, `discord`, etc.) |
| `openclaw.session.key` | string | Session identifier |
| `gen_ai.conversation.id` | string | Conversation ID (same as session key) |
| `openclaw.message.direction` | string | Always `"inbound"` |
| `openclaw.message.source` | string | Message source |
| `openclaw.request.duration_ms` | int | Total request duration |
| `traceloop.entity.input` | string | User message (if `captureContent` enabled) |
| `traceloop.entity.output` | string | Agent response (if `captureContent` enabled) |

**Status:** `OK` on success, `ERROR` with message on failure.

## Agent Turn Span

Created by `before_agent_start`, ended by `agent_end`. Child of the request span.

| Field | Value |
|-------|-------|
| **Span Name** | `openclaw.agent.turn` |
| **Kind** | `INTERNAL` |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.agent.id` | string | Agent identifier |
| `gen_ai.conversation.id` | string | Session/conversation identifier |
| `gen_ai.system` | string | LLM provider (anthropic, openai, etc.) |
| `gen_ai.provider.name` | string | Same as gen_ai.system |
| `gen_ai.request.model` | string | Model requested |
| `gen_ai.response.model` | string | Actual model used |
| `gen_ai.usage.input_tokens` | int | Input tokens (excluding cache) |
| `gen_ai.usage.output_tokens` | int | Output tokens |
| `gen_ai.usage.cache_read_tokens` | int | Tokens read from cache |
| `gen_ai.usage.cache_write_tokens` | int | Tokens written to cache |
| `gen_ai.usage.total_tokens` | int | Sum of all token types |
| `openclaw.agent.duration_ms` | int | Turn duration in milliseconds |
| `gen_ai.agent.used_skills` | string | Comma-separated list of skills used by the agent (if any skills were used) |
| `traceloop.entity.input` | string | User message (if `captureContent` enabled) |
| `traceloop.entity.output` | string | Agent response (if `captureContent` enabled) |

!!! note "Token Counts"
    Token counts are **summed across all assistant messages** in the turn. If the agent makes multiple LLM calls (e.g., tool use loop), the totals reflect all calls combined.

!!! note "Security Detection"
    If a security event is detected (prompt injection in user message), the span status will be set to `ERROR` with the security alert details.

## LLM Chat Spans

Created retrospectively from assistant messages during `agent_end`. Child of the agent turn span.

| Field | Value |
|-------|-------|
| **Span Name** | `chat <model>` (e.g., `chat claude-opus-4-5`) |
| **Kind** | `CLIENT` |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.operation.name` | string | Always `"chat"` |
| `gen_ai.provider.name` | string | LLM provider |
| `gen_ai.system` | string | Same as provider |
| `gen_ai.request.model` | string | Model requested |
| `gen_ai.response.model` | string | Model used |
| `gen_ai.usage.input_tokens` | int | Input tokens for this call |
| `gen_ai.usage.output_tokens` | int | Output tokens for this call |
| `gen_ai.usage.total_tokens` | int | Total tokens for this call |
| `gen_ai.usage.cache_read_tokens` | int | Cache read tokens |
| `gen_ai.usage.cache_write_tokens` | int | Cache write tokens |
| `gen_ai.response.stop_reason` | string | Stop reason (if not `end_turn`) |
| `traceloop.entity.input` | string | Prompt content (if `captureContent` enabled) |
| `traceloop.entity.output` | string | Response content (if `captureContent` enabled) |

**Status:** `OK` on success (stop_reason is `stop` or `end_turn`), otherwise includes stop_reason as attribute.

## Tool Execution Spans

Created by `before_tool_call` and ended by `tool_result_persist`. Child of the agent turn span.

| Field | Value |
|-------|-------|
| **Span Name** | `tool.<tool_name>` |
| **Kind** | `INTERNAL` |

**Examples:** `tool.exec`, `tool.web_fetch`, `tool.browser`, `tool.Read`, `tool.Write`, `tool.Edit`, `tool.memory_search`

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.operation.name` | string | Always `"execute_tool"` |
| `gen_ai.tool.name` | string | Tool name |
| `gen_ai.tool.call.id` | string | Unique tool call identifier |
| `openclaw.tool.call_id` | string | Same as gen_ai.tool.call.id |
| `openclaw.tool.is_synthetic` | boolean | Whether the tool call is synthetic |
| `openclaw.tool.result_chars` | int | Total characters in result |
| `openclaw.tool.result_parts` | int | Number of content parts in result |
| `openclaw.tool.duration_ms` | int | Tool execution duration |
| `traceloop.entity.input` | string | Tool input (if `captureContent` enabled) |
| `traceloop.entity.output` | string | Tool output (if `captureContent` enabled) |

**Status:** `OK` on success, `ERROR` if the tool returned an error or security event was detected.

!!! warning "Security Detection"
    Tool spans are checked for security events:
    - **Sensitive file access** for `Read`, `Write`, `Edit` tools
    - **Dangerous commands** for `exec` tool
    
    If detected, span status becomes `ERROR` with security alert details.

## Command Spans

Created when session commands are issued.

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.command.new` | INTERNAL | `/new` command |
| `openclaw.command.reset` | INTERNAL | `/reset` command |
| `openclaw.command.stop` | INTERNAL | `/stop` command |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.command.action` | string | Command name |
| `openclaw.command.session_key` | string | Session identifier |
| `openclaw.command.source` | string | Command source |

## Gateway Spans

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.gateway.startup` | INTERNAL | Gateway startup event |

## Webhook Spans

Created by diagnostic events for webhook processing.

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.webhook.processed` | INTERNAL | Successful webhook processing |
| `openclaw.webhook.error` | INTERNAL | Webhook processing error |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.channel` | string | Source channel |
| `openclaw.webhook` | string | Update type |
| `openclaw.chatId` | string | Chat ID (if available) |
| `openclaw.error` | string | Error message (error span only) |

## Session Stuck Spans

Created when a session is detected as stuck.

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.session.stuck` | INTERNAL | Session stuck in processing |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.state` | string | Session state |
| `openclaw.sessionKey` | string | Session key |
| `openclaw.sessionId` | string | Session ID |
| `openclaw.queueDepth` | int | Current queue depth |
| `openclaw.ageMs` | int | Age of stuck session |

**Status:** Always `ERROR` with message "session stuck".

## Trace Context Propagation

The plugin maintains a `sessionContextMap` keyed by `sessionKey`:

1. `message.queued` (diagnostic event) creates a root span and stores its context
2. `before_agent_start` creates an agent turn span as a child of the root
3. `before_tool_call` creates pending tool spans as children of the agent turn
4. `tool_result_persist` ends the pending tool spans
5. `agent_end` creates LLM spans from messages, ends the agent turn span
6. `message.processed` (diagnostic event) ends the root span, cleans up the context

Stale contexts (no completion within 5 minutes) are automatically cleaned up by a periodic cleanup interval.

## Hook Events vs Diagnostic Events

The plugin uses two complementary event systems:

### Hook Events (via `api.on()`)

| Hook | Description |
|------|-------------|
| `before_agent_start` | Creates agent turn span |
| `agent_end` | Ends agent turn, creates LLM spans from messages |
| `before_tool_call` | Creates pending tool span |
| `tool_result_persist` | Ends pending tool span |

### Diagnostic Events (via `onDiagnosticEvent`)

| Event | Description |
|-------|-------------|
| `message.queued` | Creates root request span |
| `message.processed` | Ends root request span |
| `model.usage` | Records token and cost metrics |
| `webhook.received` | Records webhook received counter |
| `webhook.processed` | Creates webhook processed span |
| `webhook.error` | Creates webhook error span |
| `queue.lane.enqueue` | Records queue enqueue counter |
| `queue.lane.dequeue` | Records queue dequeue counter |
| `session.state` | Records session state counter |
| `session.stuck` | Creates session stuck span |
| `run.attempt` | Records run attempt counter |
| `diagnostic.heartbeat` | Records heartbeat queue depth |

## Example DQL Queries (Dynatrace)

**Token usage per agent turn:**

```sql
fetch spans, samplingRatio:1
| filter contains(span.name, "openclaw.agent.turn")
| fields start_time, duration, 
         gen_ai.usage.input_tokens,
         gen_ai.usage.output_tokens, 
         gen_ai.usage.cache_read_tokens,
         gen_ai.usage.cache_write_tokens,
         gen_ai.usage.total_tokens,
         gen_ai.response.model
| sort start_time desc
| limit 20
```

**Tool execution breakdown:**

```sql
fetch spans, samplingRatio:1
| filter startsWith(span.name, "tool.")
| fields start_time, span.name, duration, openclaw.tool.result_chars
| sort start_time desc
| limit 50
```

**Full trace for a session:**

```sql
fetch spans, samplingRatio:1
| filter openclaw.session.key == "agent:main:main"
| fields start_time, span.name, duration, span.kind, trace.id
| sort start_time desc
```

**Security events in traces:**

```sql
fetch spans, samplingRatio:1
| filter security.event.detected == true
| fields start_time, span.name, security.event.detection, 
         security.event.severity, security.event.description
| sort start_time desc
```

## Semantic Conventions

The plugin follows [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for:

- `gen_ai.usage.*` - Token usage attributes
- `gen_ai.system` / `gen_ai.provider.name` - Provider identification
- `gen_ai.request.model` / `gen_ai.response.model` - Model identification
- `gen_ai.operation.name` - Operation type (chat, execute_tool)
- `gen_ai.tool.*` - Tool-related attributes
- `gen_ai.conversation.id` - Conversation/session tracking

Custom OpenClaw attributes use the `openclaw.*` namespace.

## Content Capture

When `captureContent: true` is configured, spans include:

- `traceloop.entity.input` - Input content (prompts, tool arguments)
- `traceloop.entity.output` - Output content (responses, tool results)

!!! warning "Privacy Consideration"
    Enabling content capture will send user messages and AI responses to your observability backend. Consider privacy implications before enabling in production.