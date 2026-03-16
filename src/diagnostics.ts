/**
 * Diagnostic events integration — subscribes to OpenClaw's internal diagnostic
 * events to get accurate cost/token data, then enriches our connected traces.
 *
 * This combines the best of both approaches:
 * - Our plugin: Connected traces (request → agent turn → tools)
 * - Official diagnostics: Accurate cost, token counts, context limits
 *
 * Diagnostic events handled:
 * - message.queued: Creates root span for request lifecycle
 * - message.processed: Ends root span after request completion
 * - model.usage: Token usage and cost data
 */

import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
  type Context,
} from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import {
  checkMessageSecurity,
  type SecurityCounters,
  SecurityEvent,
} from "./security.js";

// Import from OpenClaw plugin SDK (loaded lazily)
let onDiagnosticEvent: ((listener: (evt: any) => void) => () => void) | null =
  null;
let sdkLoadAttempted = false;

async function loadSdk(): Promise<void> {
  if (sdkLoadAttempted) return;
  sdkLoadAttempted = true;
  try {
    // Dynamic import to avoid build issues if SDK not available
    // @ts-ignore - openclaw/plugin-sdk types not available at build time
    const sdk = (await import("openclaw/plugin-sdk")) as any;
    onDiagnosticEvent = sdk.onDiagnosticEvent;
  } catch {
    // SDK not available — will use fallback token extraction
  }
}

/** Security event type */
// interface SecurityEventResult {
//   detection: string;
//   description: string;
// }

/** Pending tool span with start time for duration calculation */
export interface PendingToolSpan {
  span: Span;
  startTime: number;
  securityEvent?: SecurityEvent | null;
}

export interface ToolCallInfo {
  name: string;
  arguments?: any;
}

/** Pending LLM span with start time for duration calculation */
export interface PendingLlmSpan {
  span: Span;
  startTime: number;
}

/** Pending usage data waiting to be attached to spans */
interface PendingUsageData {
  costUsd?: number;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  durationMs?: number;
  provider?: string;
  model?: string;
}

/** Map of sessionKey → pending usage data from diagnostic events */
const pendingUsageMap = new Map<string, PendingUsageData>();

/** Map of sessionKey → active agent span (set by hooks.ts) */
// export const activeAgentSpans = new Map<string, Span>();

/** Active trace context for a session — allows connecting spans into one trace. */
export interface SessionTraceContext {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  agentInput?: string;
  startTime: number;
  messageInput?: string;
  messageOutput?: string;
  pendingToolSpans: Map<string, PendingToolSpan>;
  // toolCalls: Map<string, ToolCallInfo>;
  // pendingLlmSpans: Map<string, PendingLlmSpan>;
  startMessagesLength?: number;
}

/** Map of sessionKey → active trace context. Cleaned up on message.processed or agent_end. */
export const sessionContextMap = new Map<string, SessionTraceContext>();

/** Tracer instance — set during registerDiagnosticsListener */
let tracer: ReturnType<typeof trace.getTracer>;

/** Counters for metrics */
let telemetryCounters: TelemetryRuntime["counters"];

/** Guages for metrics */
let telemetryHistograms: TelemetryRuntime["histograms"];

/** Security counters for detection */
let securityCounters: SecurityCounters | null = null;

/** Logger instance */
let diagnosticsLogger: any;

/**
 * Set security counters for message security checks.
 * Called from hooks.ts during initialization.
 */
export function setSecurityCounters(counters: SecurityCounters): void {
  securityCounters = counters;
}

/**
 * Register diagnostic event listener to capture message.queued, message.processed,
 * and model.usage events.
 * Returns unsubscribe function.
 */
export async function registerDiagnosticsListener(
  telemetry: TelemetryRuntime,
  logger: any,
): Promise<() => void> {
  // Load the SDK if not already loaded
  await loadSdk();

  if (!onDiagnosticEvent) {
    logger.debug?.(
      "[otel] onDiagnosticEvent not available — using fallback token extraction",
    );
    return () => {};
  }

  // Initialize global references
  tracer = telemetry.tracer;
  telemetryCounters = telemetry.counters;
  telemetryHistograms = telemetry.histograms;

  diagnosticsLogger = logger;

  const { counters, histograms } = telemetry;

  const unsubscribe = onDiagnosticEvent((evt: any) => {
    const evtType = evt.type;

    // ═══════════════════════════════════════════════════════════════
    // message.queued — Create root span for request lifecycle
    // ═══════════════════════════════════════════════════════════════
    if (evtType === "message.queued") {
      handleMessageQueued(evt);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // message.processed — End root span after request completion
    // ═══════════════════════════════════════════════════════════════
    if (evtType === "message.processed") {
      handleMessageProcessed(evt);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // model.usage — Token usage and cost data
    // ═══════════════════════════════════════════════════════════════
    if (evtType !== "model.usage") return;
    // logger.info?.("[otel] evt JSON:", JSON.stringify(evt, null, 2));
    const sessionKey = evt.sessionKey || "unknown";
    const usage = evt.usage || {};
    const costUsd = evt.costUsd;
    const model = evt.model || "unknown";
    const provider = evt.provider || "unknown";

    // Store for later attachment to agent span
    pendingUsageMap.set(sessionKey, {
      costUsd,
      usage,
      context: evt.context,
      durationMs: evt.durationMs,
      provider,
      model,
    });

    // Record metrics immediately (don't wait for span)
    const metricAttrs = {
      "gen_ai.response.model": model,
      "openclaw.provider": provider,
    };
    const otelMetricAttrs = {
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      "gen_ai.system": provider,
    };

    if (usage.input) {
      counters.tokensPrompt.add(usage.input, metricAttrs);
      histograms.tokenHistogram.record(usage.input, {
        ...otelMetricAttrs,
        "gen_ai.token.type": "input",
      });
    }
    if (usage.output) {
      counters.tokensCompletion.add(usage.output, metricAttrs);
      histograms.tokenHistogram.record(usage.output, {
        ...otelMetricAttrs,
        "gen_ai.token.type": "output",
      });
    }
    if (usage.cacheRead) {
      counters.tokensPrompt.add(usage.cacheRead, {
        ...metricAttrs,
        "token.type": "cache_read",
      });
      histograms.tokenHistogram.record(usage.output, {
        ...otelMetricAttrs,
        "gen_ai.token.type": "cache_read",
      });
    }
    if (usage.cacheWrite) {
      counters.tokensPrompt.add(usage.cacheWrite, {
        ...metricAttrs,
        "token.type": "cache_write",
      });
      histograms.tokenHistogram.record(usage.output, {
        ...otelMetricAttrs,
        "gen_ai.token.type": "cache_write",
      });
    }
    if (usage.total) {
      counters.tokensTotal.add(usage.total, metricAttrs);
    }

    // Record cost metric
    if (typeof costUsd === "number" && costUsd > 0) {
      telemetry.meter
        .createCounter("openclaw.llm.cost.usd", {
          description: "Estimated LLM cost in USD",
          unit: "usd",
        })
        .add(costUsd, metricAttrs);
    }

    // Record LLM duration
    if (typeof evt.durationMs === "number") {
      // histograms.llmDuration.record(evt.durationMs, metricAttrs);
      histograms.llmDurationHistogram.record(
        evt.durationMs / 1000.0,
        otelMetricAttrs,
      );
    }

    counters.llmRequests.add(1, metricAttrs);

    // If we have an active agent span for this session, enrich it now
    // const agentSpan = activeAgentSpans.get(sessionKey);
    const sessionCtx = sessionContextMap.get(sessionKey);

    // End the agent turn span
    if (sessionCtx?.agentSpan) {
      // enrichSpanWithUsage(sessionCtx.agentSpan, evt);
      pendingUsageMap.delete(sessionKey);
    }

    logger.debug?.(
      `[otel] model.usage: session=${sessionKey}, model=${model}, cost=$${costUsd?.toFixed(4) || "?"}, usage=${JSON.stringify(usage) || "?"}`,
    );
  });

  logger.info(
    "[otel] Subscribed to OpenClaw diagnostic events (model.usage, etc.)",
  );
  return unsubscribe;
}

/**
 * Get pending usage data for a session (if any).
 * Called by agent_end hook to attach data to span.
 */
export function getPendingUsage(
  sessionKey: string,
): PendingUsageData | undefined {
  const data = pendingUsageMap.get(sessionKey);
  if (data) {
    pendingUsageMap.delete(sessionKey);
  }
  return data;
}

/**
 * Enrich a span with usage data from diagnostic event.
 */
export function enrichSpanWithUsage(span: Span, data: PendingUsageData): void {
  const usage = data.usage || {};
  let totalTokens = 0;
  // GenAI semantic convention attributes
  if (usage.input !== undefined) {
    totalTokens += usage.input;
    span.setAttribute("gen_ai.usage.input_tokens", usage.input);
  }
  if (usage.output !== undefined) {
    totalTokens += usage.output;
    span.setAttribute("gen_ai.usage.output_tokens", usage.output);
  }
  if (usage.cacheRead !== undefined) {
    totalTokens += usage.cacheRead;
    span.setAttribute("gen_ai.usage.cache_read_tokens", usage.cacheRead);
  }
  if (usage.cacheWrite !== undefined) {
    totalTokens += usage.cacheWrite;
    span.setAttribute("gen_ai.usage.cache_write_tokens", usage.cacheWrite);
  }

  span.setAttribute("gen_ai.usage.total_tokens", totalTokens);
  // Cost (custom attribute — not in GenAI semconv yet)
  if (data.costUsd !== undefined) {
    span.setAttribute("openclaw.llm.cost_usd", data.costUsd);
  }

  // Context window
  if (data.context?.limit !== undefined) {
    span.setAttribute("openclaw.context.limit", data.context.limit);
  }
  if (data.context?.used !== undefined) {
    span.setAttribute("openclaw.context.used", data.context.used);
  }

  // Provider/model
  if (data.provider) {
    span.setAttribute("gen_ai.system", data.provider);
  }
  if (data.model) {
    span.setAttribute("gen_ai.response.model", data.model);
  }
  diagnosticsLogger.debug?.(
    `[otel] enrichSpanWithUsage: usage=${JSON.stringify(data?.usage) || "?"}, calc total=${totalTokens}`,
  );
}

/**
 * Check if diagnostic events are available.
 * Note: Only accurate after registerDiagnosticsListener() has been called.
 */
export function hasDiagnosticsSupport(): boolean {
  return onDiagnosticEvent !== null;
}

/**
 * Async check for diagnostics support (loads SDK if needed).
 */
export async function checkDiagnosticsSupport(): Promise<boolean> {
  await loadSdk();
  return onDiagnosticEvent !== null;
}

/**
 * Handle message.queued diagnostic event — creates root span for request lifecycle.
 * This replaces the message_received hook.
 */
function handleMessageQueued(evt: any): void {
  try {
    const channel = evt?.channel || "unknown";
    const sessionKey = evt?.sessionKey || "unknown";
    const sessionId = evt?.sessionId || sessionKey;
    const source = evt?.source || "unknown";
    const messageText = evt?.text || evt?.message || "";

    // Create root span for this request
    const rootSpan = tracer.startSpan("openclaw.request", {
      kind: SpanKind.SERVER,
      attributes: {
        "openclaw.message.channel": channel,
        "openclaw.session.key": sessionKey,
        "gen_ai.conversation.id": sessionId,
        "openclaw.message.direction": "inbound",
        "openclaw.message.source": source,
      },
    });

    // ═══ SECURITY DETECTION: Prompt Injection ═════════════
    if (
      messageText &&
      typeof messageText === "string" &&
      messageText.length > 0 &&
      securityCounters
    ) {
      const securityEvent = checkMessageSecurity(
        messageText,
        rootSpan,
        securityCounters,
        sessionKey,
      );
      if (securityEvent) {
        diagnosticsLogger.warn?.(
          `[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`,
        );
      }
    }

    // Store the context so child spans can reference it
    const rootContext = trace.setSpan(context.active(), rootSpan);

    sessionContextMap.set(sessionKey, {
      rootSpan,
      rootContext,
      startTime: Date.now(),
      pendingToolSpans: new Map(),
      // toolCalls: new Map(),
      // pendingLlmSpans: new Map(),
    });

    // Record message count metric
    telemetryCounters.messagesReceived.add(1, {
      "openclaw.message.channel": channel,
    });

    diagnosticsLogger.debug?.(
      `[otel] Root span started (message.queued) for session=${sessionKey}`,
    );
  } catch (error) {
    diagnosticsLogger.error?.(`[otel] Error in handleMessageQueued: ${error}`);
  }
}

/**
 * Handle message.processed diagnostic event — ends root span after request completion.
 */
function handleMessageProcessed(evt: any): void {
  const sessionKey = evt?.sessionKey || "unknown";
  try {
    const success = evt?.outcome === "completed";

    const sessionCtx = sessionContextMap.get(sessionKey);
    const totalMs = evt?.durationMs || 0;
    if (sessionCtx?.rootSpan) {
      // const totalMs = Date.now() - sessionCtx.startTime;
      sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);

      if (!success) {
        const errorMsg = evt?.error || "";
        sessionCtx.rootSpan.setAttribute(
          "openclaw.request.error",
          String(errorMsg).slice(0, 500),
        );
        sessionCtx.rootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(errorMsg).slice(0, 200),
        });
      } else {
        sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
      }

      // End agent span if it exists and is different from root and hasn't ended yet
      if (
        sessionCtx.agentSpan &&
        sessionCtx.agentSpan !== sessionCtx.rootSpan
      ) {
        sessionCtx.agentSpan.end();
      }

      if (sessionCtx.messageInput) {
        sessionCtx.rootSpan.setAttribute(
          "traceloop.entity.input",
          sessionCtx.messageInput,
        );
      }
      if (sessionCtx.messageOutput) {
        sessionCtx.rootSpan.setAttribute(
          "traceloop.entity.output",
          sessionCtx.messageOutput,
        );
      }

      sessionCtx.rootSpan.end();

      diagnosticsLogger.debug?.(
        `[otel] Root span ended (message.processed) for session=${sessionKey}, duration=${totalMs}ms`,
      );
    }
    telemetryHistograms.messageDurationHistogram.record(totalMs / 1000.0, {
      success: String(success),
      "request.channel": evt?.channel || "unknown",
      "request.target": "wss://",
    });

    // Clean up
    sessionContextMap.delete(sessionKey);
  } catch (error) {
    diagnosticsLogger.error?.(
      `[otel] Error in handleMessageProcessed: ${error}`,
    );
  } finally {
    // Clean up
    sessionContextMap.delete(sessionKey);
  }
}
