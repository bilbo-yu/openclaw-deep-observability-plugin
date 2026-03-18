# Architecture

How the OpenClaw Deep Observability Plugin works.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenClaw Gateway                             │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                      Agent Execution                         │   │
│  │  message_received → before_agent_start → tool_calls →       │   │
│  │                     tool_result_persist → agent_end          │   │
│  └──────────────────────────┬──────────────────────────────────┘   │
│                              │                                      │
│         ┌────────────────────┼────────────────────┐                │
│         │                    │                    │                │
│         ▼                    ▼                    ▼                │
│  ┌─────────────┐    ┌───────────────┐    ┌─────────────────┐      │
│  │  Diagnostic │    │  Typed Hooks  │    │   Log Output    │      │
│  │   Events    │    │  (api.on())   │    │                 │      │
│  │ (model.usage│    │               │    │                 │      │
│  │  message.*) │    │               │    │                 │      │
│  └──────┬──────┘    └───────┬───────┘    └────────┬────────┘      │
│         │                   │                     │                │
│         ▼                   ▼                     ▼                │
│  ┌─────────────┐    ┌─────────────────┐   ┌──────────────┐        │
│  │  OFFICIAL   │    │     CUSTOM      │   │ Log Forward  │        │
│  │   PLUGIN    │    │     PLUGIN      │   │ (via official│        │
│  │ diagnostics │    │ otel-observ...  │   │   plugin)    │        │
│  │    -otel    │    │                 │   │              │        │
│  └──────┬──────┘    └───────┬─────────┘   └──────┬───────┘        │
│         │                   │                    │                 │
│         └───────────────────┼────────────────────┘                 │
│                             ▼                                      │
│                   ┌─────────────────┐                              │
│                   │ OTLP Exporters  │                              │
│                   │ (HTTP/protobuf) │                              │
│                   └────────┬────────┘                              │
└────────────────────────────┼────────────────────────────────────────┘
                             │
                             ▼
                   ┌─────────────────┐
                   │  OTLP Endpoint  │
                   │ (Collector or   │
                   │  Direct Ingest) │
                   └─────────────────┘
```

## Implementation Details

### How It Works

The custom plugin uses **typed plugin hooks** — direct callbacks into the agent lifecycle.

```
Gateway Agent Loop              Custom Plugin
     │                               │
     │  on("message_received")       │
     │ ─────────────────────────────>│  ──> create ROOT span
     │                               │      store in sessionContextMap
     │                               │
     │  on("before_agent_start")     │
     │ ─────────────────────────────>│  ──> create AGENT TURN span
     │                               │      (child of root)
     │                               │
     │  on("tool_result_persist")    │
     │ ─────────────────────────────>│  ──> create TOOL span
     │  (called for each tool)       │      (child of agent turn)
     │                               │
     │  on("agent_end")              │
     │ ─────────────────────────────>│  ──> end agent turn span
     │                               │      end root span
     │                               │      extract tokens from messages
```

### Trace Context Propagation

The key difference is **trace context propagation**. The custom plugin maintains a session-to-context map:

```typescript
interface SessionTraceContext {
  rootSpan: Span;           // openclaw.request
  rootContext: Context;     // OTel context with root span
  agentSpan?: Span;         // openclaw.agent.turn
  agentContext?: Context;   // OTel context with agent span
  startTime: number;
}

const sessionContextMap = new Map<string, SessionTraceContext>();
```

When creating child spans, it uses the stored context:

```typescript
// Tool span becomes child of agent turn
const span = tracer.startSpan(
  `tool.${toolName}`,
  { kind: SpanKind.INTERNAL },
  sessionCtx.agentContext  // <-- parent context
);
```

### Resulting Trace Structure

```
openclaw.request (root)
│   openclaw.session.key: "main@whatsapp:+123..."
│   openclaw.message.channel: "whatsapp"
│   openclaw.request.duration_ms: 4523
│
└── openclaw.agent.turn (child)
    │   gen_ai.usage.input_tokens: 1234
    │   gen_ai.usage.output_tokens: 567
    │   gen_ai.response.model: "claude-opus-4-5-..."
    │   openclaw.agent.duration_ms: 4100
    │
    ├── tool.Read (child)
    │       openclaw.tool.name: "Read"
    │       openclaw.tool.result_chars: 2048
    │
    ├── tool.exec (child)
    │       openclaw.tool.name: "exec"
    │       openclaw.tool.result_chars: 156
    │
    └── tool.Write (child)
            openclaw.tool.name: "Write"
            openclaw.tool.result_chars: 0
```

---

## Data Flow

### Token Tracking

```
1. Agent calls LLM via pi-ai
2. pi-ai returns response with .usage
3. Gateway fires agent_end hook with:
   - messages: [...including assistant messages with .usage]
4. Plugin:
   - Parses messages for usage data
   - Checks for pending diagnostic data (if available)
   - Adds attributes to existing agent turn span
   - Updates counters
5. Ends spans (agent turn, then root)
6. Batches and exports via OTLP
```

---

## Resource and Attributes

### Common Attributes

| Attribute | Description |
|-----------|-------------|
| `service.name` | Service name from config |
| `openclaw.channel` | Channel (whatsapp, telegram, etc.) |
| `openclaw.session.key` | Session identifier |

### Plugin Attributes

| Attribute | Description |
|-----------|-------------|
| `openclaw.agent.id` | Agent identifier |
| `openclaw.tool.name` | Tool name |
| `openclaw.tool.call_id` | Tool call UUID |
| `openclaw.tool.result_chars` | Result size |
| `gen_ai.usage.input_tokens` | Input token count |
| `gen_ai.usage.output_tokens` | Output token count |
| `gen_ai.response.model` | Model used |

---

## Performance Considerations

### Batching

The plugin uses batched export:
- **Traces:** BatchSpanProcessor (default 5s or 512 spans)
- **Metrics:** PeriodicExportingMetricReader (default 60s)
- **Logs:** BatchLogRecordProcessor (default 5s)

### Overhead

The plugin is lightweight — the OTel SDK handles batching efficiently. Overhead comes from:
- Hook interception
- Context map management

---

## Use Cases

| Use Case | Supported |
|----------|-------------|
| Production monitoring | ✅ |
| Cost/token dashboards | ✅ |
| Gateway health alerts | ✅ |
| Debugging specific requests | ✅ |
| Understanding agent behavior | ✅ |
| Tool execution analysis | ✅ |
| Security event detection | ✅ |
