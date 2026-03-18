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
 * - webhook.received: Webhook requests received
 * - webhook.processed: Webhook processing completed
 * - webhook.error: Webhook processing errors
 * - queue.lane.enqueue: Command queue lane enqueue events
 * - queue.lane.dequeue: Command queue lane dequeue events
 * - session.state: Session state transitions
 * - session.stuck: Sessions stuck in processing
 * - run.attempt: Run attempts
 * - diagnostic.heartbeat: Periodic heartbeat with queue stats
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
  redactText,
} from "./security.js";
import { OtelObservabilityConfig } from "./config.js";

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

/** Histograms for metrics */
let telemetryHistograms: TelemetryRuntime["histograms"];

/** Security counters for detection */
let securityCounters: SecurityCounters | null = null;

/** Logger instance */
let diagnosticsLogger: any;

/** Whether traces are enabled */
let tracesEnabled: boolean = true;

/**
 * Set security counters for message security checks.
 * Called from hooks.ts during initialization.
 */
export function setSecurityCounters(counters: SecurityCounters): void {
  securityCounters = counters;
}

/**
 * Helper to add session identity attributes to span attributes.
 */
function addSessionIdentityAttrs(
  spanAttrs: Record<string, string | number>,
  evt: { sessionKey?: string; sessionId?: string },
): void {
  if (evt.sessionKey) {
    spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
  }
  if (evt.sessionId) {
    spanAttrs["openclaw.sessionId"] = evt.sessionId;
  }
}

/**
 * Helper to create a span with duration (for retrospective spans).
 */
function spanWithDuration(
  name: string,
  attributes: Record<string, string | number>,
  durationMs?: number,
): Span {
  const startTime =
    typeof durationMs === "number"
      ? Date.now() - Math.max(0, durationMs)
      : undefined;
  const span = tracer.startSpan(name, {
    attributes,
    ...(startTime ? { startTime } : {}),
  });
  return span;
}

/**
 * Register diagnostic event listener to capture all diagnostic events.
 * Returns unsubscribe function.
 */
export async function registerDiagnosticsListener(
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig,
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
  tracesEnabled = config.traces;

  diagnosticsLogger = logger;

  const { counters, histograms } = telemetry;

  const unsubscribe = onDiagnosticEvent((evt: any) => {
    const evtType = evt.type;

    try {
      switch (evtType) {
        case "message.queued":
          handleMessageQueued(evt, config.captureContent);
          return;
        case "message.processed":
          handleMessageProcessed(evt, config.captureContent);
          return;
        case "model.usage":
          handleModelUsage(evt, counters, histograms);
          return;
        case "webhook.received":
          handleWebhookReceived(evt);
          return;
        case "webhook.processed":
          handleWebhookProcessed(evt);
          return;
        case "webhook.error":
          handleWebhookError(evt);
          return;
        case "queue.lane.enqueue":
          handleLaneEnqueue(evt);
          return;
        case "queue.lane.dequeue":
          handleLaneDequeue(evt);
          return;
        case "session.state":
          handleSessionState(evt);
          return;
        case "session.stuck":
          handleSessionStuck(evt);
          return;
        case "run.attempt":
          handleRunAttempt(evt);
          return;
        case "diagnostic.heartbeat":
          handleHeartbeat(evt);
          return;
      }
    } catch (err) {
      logger.error?.(
        `[otel] Event handler failed (${evtType}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  logger.info(
    "[otel] Subscribed to OpenClaw diagnostic events (all event types)",
  );
  return unsubscribe;
}

// ════════════════════════════════════════════════════════════════════════════
// Event Handlers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handle model.usage diagnostic event — Token usage and cost data.
 */
function handleModelUsage(
  evt: any,
  counters: TelemetryRuntime["counters"],
  histograms: TelemetryRuntime["histograms"],
): void {
  const sessionKey = evt.sessionKey || "unknown";
  const usage = evt.usage || {};
  const costUsd = evt.costUsd;
  const model = evt.model || "unknown";
  const provider = evt.provider || "unknown";
  const channel = evt.channel || "unknown";

  // Record metrics immediately (don't wait for span)
  const otelMetricAttrs = {
    "gen_ai.request.model": model,
    "gen_ai.response.model": model,
    "gen_ai.system": provider,
  };

  // Official diagnostics-otel style attributes
  const officialAttrs = {
    "openclaw.channel": channel,
    "openclaw.provider": provider,
    "openclaw.model": model,
  };

  // Record token metrics (official style only)
  if (usage.input) {
    histograms.tokenHistogram.record(usage.input, {
      ...otelMetricAttrs,
      "gen_ai.token.type": "input",
    });
    counters.tokens.add(usage.input, {
      ...officialAttrs,
      "openclaw.token": "input",
    });
  }
  if (usage.output) {
    histograms.tokenHistogram.record(usage.output, {
      ...otelMetricAttrs,
      "gen_ai.token.type": "output",
    });
    counters.tokens.add(usage.output, {
      ...officialAttrs,
      "openclaw.token": "output",
    });
  }
  if (usage.cacheRead) {
    histograms.tokenHistogram.record(usage.cacheRead, {
      ...otelMetricAttrs,
      "gen_ai.token.type": "cache_read",
    });
    counters.tokens.add(usage.cacheRead, {
      ...officialAttrs,
      "openclaw.token": "cache_read",
    });
  }
  if (usage.cacheWrite) {
    histograms.tokenHistogram.record(usage.cacheWrite, {
      ...otelMetricAttrs,
      "gen_ai.token.type": "cache_write",
    });
    counters.tokens.add(usage.cacheWrite, {
      ...officialAttrs,
      "openclaw.token": "cache_write",
    });
  }
  if (usage.promptTokens) {
    counters.tokens.add(usage.promptTokens, {
      ...officialAttrs,
      "openclaw.token": "prompt",
    });
  }
  if (usage.total) {
    counters.tokens.add(usage.total, {
      ...officialAttrs,
      "openclaw.token": "total",
    });
  }

  // Record cost metric (official style)
  if (typeof costUsd === "number" && costUsd > 0) {
    counters.costUsd.add(costUsd, officialAttrs);
  }

  // Record LLM duration (original style)
  if (typeof evt.durationMs === "number") {
    histograms.llmDurationHistogram.record(
      evt.durationMs / 1000.0,
      otelMetricAttrs,
    );
    // Official style
    histograms.runDuration.record(evt.durationMs, officialAttrs);
  }

  // Record context window usage (official style)
  if (evt.context?.limit) {
    histograms.contextTokens.record(evt.context.limit, {
      ...officialAttrs,
      "openclaw.context": "limit",
    });
  }
  if (evt.context?.used) {
    histograms.contextTokens.record(evt.context.used, {
      ...officialAttrs,
      "openclaw.context": "used",
    });
  }

  diagnosticsLogger.debug?.(
    `[otel] model.usage: session=${sessionKey}, model=${model}, cost=$${costUsd?.toFixed(4) || "?"}, usage=${JSON.stringify(usage) || "?"}`,
  );
}

/**
 * Handle webhook.received diagnostic event.
 */
function handleWebhookReceived(evt: any): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  telemetryCounters.webhookReceived.add(1, attrs);
  diagnosticsLogger.debug?.(
    `[otel] webhook.received: channel=${evt.channel}, type=${evt.updateType}`,
  );
}

/**
 * Handle webhook.processed diagnostic event.
 */
function handleWebhookProcessed(evt: any): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  if (typeof evt.durationMs === "number") {
    telemetryHistograms.webhookDuration.record(evt.durationMs, attrs);
  }

  // Create trace span (official style)
  if (tracesEnabled) {
    const spanAttrs: Record<string, string | number> = { ...attrs };
    if (evt.chatId !== undefined) {
      spanAttrs["openclaw.chatId"] = String(evt.chatId);
    }
    const span = spanWithDuration(
      "openclaw.webhook.processed",
      spanAttrs,
      evt.durationMs,
    );
    span.end();
  }

  diagnosticsLogger.debug?.(
    `[otel] webhook.processed: channel=${evt.channel}, type=${evt.updateType}, duration=${evt.durationMs}ms`,
  );
}

/**
 * Handle webhook.error diagnostic event.
 */
function handleWebhookError(evt: any): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  telemetryCounters.webhookError.add(1, attrs);

  // Create trace span with error status (official style)
  if (tracesEnabled) {
    const redactedError = redactText(evt.error || "unknown error");
    const spanAttrs: Record<string, string | number> = {
      ...attrs,
      "openclaw.error": redactedError,
    };
    if (evt.chatId !== undefined) {
      spanAttrs["openclaw.chatId"] = String(evt.chatId);
    }
    const span = tracer.startSpan("openclaw.webhook.error", {
      attributes: spanAttrs,
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: redactedError });
    span.end();
  }

  diagnosticsLogger.warn?.(
    `[otel] webhook.error: channel=${evt.channel}, type=${evt.updateType}, error=${evt.error}`,
  );
}

/**
 * Handle queue.lane.enqueue diagnostic event.
 */
function handleLaneEnqueue(evt: any): void {
  const attrs = { "openclaw.lane": evt.lane };
  telemetryCounters.laneEnqueue.add(1, attrs);
  telemetryHistograms.queueDepth.record(evt.queueSize, attrs);
  diagnosticsLogger.debug?.(
    `[otel] queue.lane.enqueue: lane=${evt.lane}, queueSize=${evt.queueSize}`,
  );
}

/**
 * Handle queue.lane.dequeue diagnostic event.
 */
function handleLaneDequeue(evt: any): void {
  const attrs = { "openclaw.lane": evt.lane };
  telemetryCounters.laneDequeue.add(1, attrs);
  telemetryHistograms.queueDepth.record(evt.queueSize, attrs);
  if (typeof evt.waitMs === "number") {
    telemetryHistograms.queueWait.record(evt.waitMs, attrs);
  }
  diagnosticsLogger.debug?.(
    `[otel] queue.lane.dequeue: lane=${evt.lane}, queueSize=${evt.queueSize}, waitMs=${evt.waitMs}`,
  );
}

/**
 * Handle session.state diagnostic event.
 */
function handleSessionState(evt: any): void {
  const attrs: Record<string, string> = { "openclaw.state": evt.state };
  if (evt.reason) {
    attrs["openclaw.reason"] = redactText(evt.reason);
  }
  telemetryCounters.sessionState.add(1, attrs);
  diagnosticsLogger.debug?.(
    `[otel] session.state: state=${evt.state}, reason=${evt.reason}`,
  );
}

/**
 * Handle session.stuck diagnostic event.
 */
function handleSessionStuck(evt: any): void {
  const attrs: Record<string, string> = { "openclaw.state": evt.state };
  telemetryCounters.sessionStuck.add(1, attrs);
  if (typeof evt.ageMs === "number") {
    telemetryHistograms.sessionStuckAge.record(evt.ageMs, attrs);
  }

  // Create trace span (official style)
  if (tracesEnabled) {
    const spanAttrs: Record<string, string | number> = { ...attrs };
    addSessionIdentityAttrs(spanAttrs, evt);
    spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
    spanAttrs["openclaw.ageMs"] = evt.ageMs ?? 0;
    const span = tracer.startSpan("openclaw.session.stuck", {
      attributes: spanAttrs,
    });
    span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
    span.end();
  }

  diagnosticsLogger.warn?.(
    `[otel] session.stuck: state=${evt.state}, ageMs=${evt.ageMs}, queueDepth=${evt.queueDepth}`,
  );
}

/**
 * Handle run.attempt diagnostic event.
 */
function handleRunAttempt(evt: any): void {
  telemetryCounters.runAttempt.add(1, { "openclaw.attempt": evt.attempt });
  diagnosticsLogger.debug?.(`[otel] run.attempt: attempt=${evt.attempt}`);
}

/**
 * Handle diagnostic.heartbeat diagnostic event.
 */
function handleHeartbeat(evt: any): void {
  telemetryHistograms.queueDepth.record(evt.queued, {
    "openclaw.channel": "heartbeat",
  });
  diagnosticsLogger.debug?.(
    `[otel] diagnostic.heartbeat: queued=${evt.queued}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Utility Functions
// ════════════════════════════════════════════════════════════════════════════

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
function handleMessageQueued(evt: any, captureContent: boolean): void {
  try {
    const channel = evt?.channel || "unknown";
    const sessionKey = evt?.sessionKey || "unknown";
    const sessionId = evt?.sessionId || sessionKey;
    const source = evt?.source || "unknown";
    const messageText = evt?.text || evt?.message || "";

    // Record official style metrics
    const attrs = {
      "openclaw.channel": channel,
      "openclaw.source": source,
    };
    telemetryCounters.messageQueued.add(1, attrs);
    if (typeof evt.queueDepth === "number") {
      telemetryHistograms.queueDepth.record(evt.queueDepth, attrs);
    }

    // Create root span for this request
    const rootSpan = tracer.startSpan("openclaw.request", {
      kind: SpanKind.SERVER,
      attributes: {
        "openclaw.message.channel": channel,
        "openclaw.session.key": sessionKey,
        "gen_ai.conversation.id": sessionKey,
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
function handleMessageProcessed(evt: any, captureContent: boolean): void {
  const sessionKey = evt?.sessionKey || "unknown";
  try {
    const success = evt?.outcome === "completed";
    const channel = evt?.channel || "unknown";
    const outcome = evt?.outcome || "unknown";

    // Record official style metrics
    const attrs = {
      "openclaw.channel": channel,
      "openclaw.outcome": outcome,
    };
    telemetryCounters.messageProcessed.add(1, attrs);
    const totalMs = evt?.durationMs || 0;
    if (typeof totalMs === "number") {
      telemetryHistograms.messageDuration.record(totalMs, attrs);
      telemetryHistograms.messageDurationHistogram.record(totalMs / 1000.0, {
        success: String(success),
        "request.channel": channel,
        "request.target": "wss://",
      });
    }

    const sessionCtx = sessionContextMap.get(sessionKey);
    if (sessionCtx?.rootSpan) {
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

      if (captureContent && sessionCtx.messageInput) {
        sessionCtx.rootSpan.setAttribute(
          "traceloop.entity.input",
          redactText(sessionCtx.messageInput),
        );
      }
      if (captureContent && sessionCtx.messageOutput) {
        sessionCtx.rootSpan.setAttribute(
          "traceloop.entity.output",
          redactText(sessionCtx.messageOutput),
        );
      }

      sessionCtx.rootSpan.end();

      diagnosticsLogger.debug?.(
        `[otel] Root span ended (message.processed) for session=${sessionKey}, duration=${totalMs}ms`,
      );
    }

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
