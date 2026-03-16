/**
 * OpenClaw event hooks — captures tool executions, agent turns, messages,
 * and gateway lifecycle as connected OTel traces.
 *
 * Trace structure per request:
 *   openclaw.request (root span, covers full message → reply lifecycle)
 *   ├── openclaw.agent.turn (agent processing span)
 *   │   ├── tool.exec (tool call)
 *   │   ├── tool.Read (tool call)
 *   │   ├── anthropic.chat (auto-instrumented by OpenLLMetry)
 *   │   └── tool.write (tool call)
 *   └── (future: message.sent span)
 *
 * Context propagation:
 *   - message_received: creates root span, stores in sessionContextMap
 *   - before_agent_start: creates child "agent turn" span under root
 *   - tool_result_persist: creates child tool span under agent turn
 *   - agent_end: ends the agent turn span
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook() → event-stream hooks (command:new, gateway:startup)
 *   - api.on()           → typed plugin hooks (tool_result_persist, agent_end)
 */

import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Context,
} from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";
import {
  sessionContextMap,
  getPendingUsage,
  type SessionTraceContext,
  type ToolCallInfo,
} from "./diagnostics.js";
import {
  checkToolSecurity,
  checkMessageSecurity,
  type SecurityCounters,
} from "./security.js";

class TokenUsage {
  inputTokens: number = 0;
  outputTokens: number = 0;
  cacheReadTokens: number = 0;
  cacheWriteTokens: number = 0;
  totalTokens: number = 0;
  model?: string | null;
  provider?: string | null;
}

/** Active trace context for a session — allows connecting spans into one trace. */
// interface SessionTraceContext {
//   rootSpan: Span;
//   rootContext: Context;
//   agentSpan?: Span;
//   agentContext?: Context;
//   startTime: number;
// }

// /** Map of sessionKey → active trace context. Cleaned up on agent_end. */
// const sessionContextMap = new Map<string, SessionTraceContext>();
interface ContentInfo {
  totalChars: number;
  totalParts: number;
  content: string | undefined;
}
function parseContent(contentArray: any): ContentInfo {
  if (contentArray && Array.isArray(contentArray)) {
    const textParts = contentArray
      .filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text || ""));
    const totalChars = textParts.reduce(
      (sum: number, t: string) => sum + t.length,
      0,
    );
    // Record tool output
    const output = textParts.join("\n").slice(0, 2048);
    return {
      totalChars: totalChars,
      totalParts: contentArray.length,
      content: output,
    };
  } else if (typeof contentArray === "string") {
    return {
      totalChars: contentArray.length,
      totalParts: 1,
      content: contentArray.slice(0, 2048),
    };
  } else {
    return {
      totalChars: 0,
      totalParts: 0,
      content: undefined,
    };
  }
}
/**
 * Register all plugin hooks on the OpenClaw plugin API.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig,
): void {
  const { tracer, counters, histograms } = telemetry;
  const logger = api.logger;

  // ═══════════════════════════════════════════════════════════════════
  // TYPED HOOKS — registered via api.on() into registry.typedHooks
  // ═══════════════════════════════════════════════════════════════════

  // ── message_received ─────────────────────────────────────────────
  // Creates the ROOT span for the entire request lifecycle.
  // All subsequent spans (agent, tools) become children of this span.

  // Build security counters object for detection module
  const securityCounters: SecurityCounters = {
    securityEvents: counters.securityEvents,
    sensitiveFileAccess: counters.sensitiveFileAccess,
    promptInjection: counters.promptInjection,
    dangerousCommand: counters.dangerousCommand,
  };

  /**
   * Create an LLM span from an assistant message.
   *
   * @param msg - The assistant message
   * @param prevMsg - The previous message (for input extraction)
   * @param parentContext - Parent context for the span
   * @param sessionKey - Session key for logging
   * @param spanStartTime - The start time of the span
   * @param spanEndTime - The end time of the span
   */
  function createLlmSpanFromMessage(
    msg: any,
    prevMsg: any | undefined,
    parentContext: Context,
    sessionKey: string,
    spanStartTime: number,
    spanEndTime: number,
  ): TokenUsage {
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
    try {
      // LLM input
      let inputText;
      if (prevMsg?.role === "user") {
        inputText = JSON.stringify(prevMsg?.content).slice(0, 2048);
      }

      // Get model and provider from message
      const msgModel = msg.model || "unknown";
      const msgProvider = msg.provider || "unknown";
      tokenUsage.model = msg.model;
      tokenUsage.provider = msg.provider;

      // Create LLM span with correct start time, using agentSpan as parent
      const llmSpan = tracer.startSpan(
        `chat ${msgModel}`,
        {
          kind: SpanKind.CLIENT,
          startTime: spanStartTime,
          attributes: {
            "gen_ai.system": msgProvider,
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": msgModel,
            "gen_ai.response.model": msgModel,
            "openclaw.session.key": sessionKey,
          },
        },
        parentContext,
      );
      if (inputText) {
        llmSpan.setAttribute("traceloop.entity.input", inputText);
      }
      // Set traceloop.entity.output from content
      const contentArray = msg.content;
      if (contentArray) {
        llmSpan.setAttribute(
          "traceloop.entity.output",
          JSON.stringify(contentArray).slice(0, 2048),
        );
      }

      // Set gen_ai.usage.* from message usage
      const msgUsage = msg.usage;
      if (msgUsage) {
        if (typeof msgUsage.input === "number") {
          tokenUsage.inputTokens = msgUsage.input;
          llmSpan.setAttribute("gen_ai.usage.input_tokens", msgUsage.input);
        }
        if (typeof msgUsage.output === "number") {
          tokenUsage.outputTokens = msgUsage.output;
          llmSpan.setAttribute("gen_ai.usage.output_tokens", msgUsage.output);
        }
        if (typeof msgUsage.totalTokens === "number") {
          tokenUsage.totalTokens = msgUsage.totalTokens;
          llmSpan.setAttribute(
            "gen_ai.usage.total_tokens",
            msgUsage.totalTokens,
          );
        }
        if (typeof msgUsage.cacheRead === "number") {
          tokenUsage.cacheReadTokens = msgUsage.cacheRead;
          llmSpan.setAttribute(
            "gen_ai.usage.cache_read_tokens",
            msgUsage.cacheRead,
          );
        }
        if (typeof msgUsage.cacheWrite === "number") {
          tokenUsage.cacheWriteTokens = msgUsage.cacheWrite;
          llmSpan.setAttribute(
            "gen_ai.usage.cache_write_tokens",
            msgUsage.cacheWrite,
          );
        }
      }

      // Set status based on stopReason
      const stopReason = msg.stopReason;
      if (stopReason === "stop" || stopReason === "end_turn") {
        llmSpan.setStatus({ code: SpanStatusCode.OK });
      } else if (stopReason) {
        llmSpan.setStatus({ code: SpanStatusCode.OK });
        llmSpan.setAttribute("gen_ai.response.stop_reason", stopReason);
      } else {
        llmSpan.setStatus({ code: SpanStatusCode.OK });
      }
      const durationMs = spanEndTime - spanStartTime;
      llmSpan.setAttribute("openclaw.llm.duration_ms", durationMs);
      // End span with correct end time
      llmSpan.end(spanEndTime);

      logger.debug?.(
        `[otel] LLM span created from message: model=${msgModel}, startTime=${spanStartTime}, endTime=${spanEndTime}, durationMs=${durationMs}`,
      );
    } catch (spanError) {
      logger.debug?.(
        `[otel] Error creating LLM span from message: msg = ${msg}, error=${spanError}`,
      );
    }
    return tokenUsage;
  }

  /**
   * Create a tool span from a toolResult message.
   *
   * @param msg - The toolResult message
   * @param parentContext - Parent context for the span
   * @param sessionKey - Session key for logging
   * @param toolCallMap - Map of toolCallId to toolCall info
   * @param agentId - Agent ID for security logging
   * @param spanStartTime - The start time of the span
   * @param spanEndTime - The end time of the span
   */
  function createToolSpanFromMessage(
    msg: any,
    parentContext: Context,
    sessionKey: string,
    toolCallMap: Map<string, ToolCallInfo>,
    agentId: string,
    spanStartTime: number,
    spanEndTime: number,
  ): void {
    try {
      const toolCallId = msg.toolCallId;
      const toolName = msg.toolName || "unknown";
      const isError = msg.isError === true;

      // Get tool call info from map
      const toolCallInfo = toolCallMap.get(toolCallId);
      const toolArguments = toolCallInfo?.arguments || {};

      // Create tool span
      const toolSpan = tracer.startSpan(
        `tool.${toolName}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: spanStartTime,
          attributes: {
            "gen_ai.tool.name": toolName,
            "openclaw.session.key": sessionKey,
            "openclaw.tool.call_id": toolCallId || "",
          },
        },
        parentContext,
      );

      // Set tool input from arguments
      const inputStr = JSON.stringify(toolArguments).slice(0, 1000);
      toolSpan.setAttribute("traceloop.entity.input", inputStr);

      // ═══ SECURITY DETECTION: File Access & Dangerous Commands ═══
      logger.debug?.(
        `[otel] Checking tool security for tool=${toolName}, session=${sessionKey}, input=${JSON.stringify(toolArguments)}`,
      );
      const securityEvent = checkToolSecurity(
        toolName,
        toolArguments,
        toolSpan,
        securityCounters,
        sessionKey,
        agentId,
      );
      if (securityEvent) {
        logger.warn?.(
          `[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`,
        );
        // Record security event on span
        toolSpan.setAttribute(
          "openclaw.security.event",
          JSON.stringify(securityEvent),
        );
      }

      // Set tool output from content
      const contentArray = msg.content;
      const { totalChars, totalParts, content } = parseContent(contentArray);
      if (content) {
        toolSpan.setAttribute("traceloop.entity.output", content);
      }
      toolSpan.setAttribute("openclaw.tool.result_chars", totalChars);
      toolSpan.setAttribute("openclaw.tool.result_parts", totalParts);

      // Set status based on isError or securityEvent (unified logic)
      if (isError) {
        toolSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: "Tool execution error",
        });
      } else if (
        securityEvent &&
        (securityEvent.severity === "critical" ||
          securityEvent.severity === "high")
      ) {
        toolSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: `Security Alert: ${securityEvent.detection} - ${securityEvent.description}`,
        });
      } else {
        toolSpan.setStatus({ code: SpanStatusCode.OK });
      }

      // Calculate and record duration
      const durationMs = spanEndTime - spanStartTime;
      toolSpan.setAttribute("openclaw.tool.duration_ms", durationMs);

      // End span with correct end time
      toolSpan.end(spanEndTime);

      logger.debug?.(
        `[otel] Tool span created from message: tool=${toolName}, toolCallId=${toolCallId}, startTime=${spanStartTime}, endTime=${spanEndTime}, duration=${durationMs}ms`,
      );
    } catch (spanError) {
      logger.debug?.(
        `[otel] Error creating tool span from message: msg=${msg}, error=${spanError}`,
      );
    }
  }

  /**
   * Create LLM spans and tool spans from messages in the conversation.
   * This function iterates through messages starting from startIdx and creates:
   * - An LLM span for each assistant message
   * - A tool span for each toolResult message
   *
   * @param tracer - OpenTelemetry tracer instance
   * @param logger - Logger instance for debugging
   * @param messages - Array of messages from agent_end event
   * @param sessionCtx - Session trace context containing agent span and timing info
   * @param sessionKey - Session key for logging
   * @param securityCounters - Security counters for detection
   * @param agentId - Agent ID for security logging
   */
  function createSpansFromMessages(
    messages: any[],
    sessionCtx: SessionTraceContext | undefined,
    sessionKey: string,
    agentId: string,
  ): TokenUsage {
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
    if (!sessionCtx?.agentSpan) {
      logger.debug?.(
        `[otel] No agent span found, skipping span creation for session=${sessionKey}`,
      );
      return tokenUsage;
    }

    const startIdx = sessionCtx.startMessagesLength || 0;
    const agentStartTime = sessionCtx.startTime || Date.now();

    // Use agentContext as parent context for all spans
    const parentContext =
      sessionCtx.agentContext || sessionCtx.rootContext || context.active();

    // Build a map of toolCallId -> toolCall info (name, arguments, assistantMsgTimestamp)
    // const toolCallMap = new Map<string, { name: string; arguments: any; assistantTimestamp: number }>();

    // Iterate through messages and create spans
    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      const prevMsg = i > 0 ? messages[i - 1] : undefined;
      const nextMsg = i < messages.length - 1 ? messages[i + 1] : undefined;
      const spanStartTime = msg.timestamp || agentStartTime;
      let spanEndTime = Date.now();
      if (nextMsg) {
        spanEndTime = nextMsg.timestamp || spanEndTime;
      }

      if (msg?.role === "assistant") {
        const {
          inputTokens = 0,
          outputTokens = 0,
          cacheReadTokens = 0,
          cacheWriteTokens = 0,
          totalTokens = 0,
          model,
          provider,
        } = createLlmSpanFromMessage(
          msg,
          prevMsg,
          parentContext,
          sessionKey,
          spanStartTime,
          spanEndTime,
        );
        tokenUsage.inputTokens += inputTokens;
        tokenUsage.outputTokens += outputTokens;
        tokenUsage.cacheReadTokens += cacheReadTokens;
        tokenUsage.cacheWriteTokens += cacheWriteTokens;
        tokenUsage.totalTokens += totalTokens;
        if (model) {
          tokenUsage.model = model;
        }
        if (provider) {
          tokenUsage.provider = provider;
        }
        // if (Array.isArray(msg?.content)) {
        //   for (const item of msg.content) {
        //     if (item?.type === "toolCall" && item?.id) {
        //       sessionCtx.toolCalls.set(item.id, {
        //         name: item.name || "unknown",
        //         arguments: item.arguments || {},
        //       });
        //     }
        //   }
        // }
      } else if (msg?.role === "toolResult") {
        // 这里计算的tool span的耗时不如通过tool相关hook算的准，所以暂时用hook来创建tool span
        // createToolSpanFromMessage(
        //   msg,
        //   parentContext,
        //   sessionKey,
        //   sessionCtx.toolCalls,
        //   agentId,
        //   spanStartTime,
        //   spanEndTime,
        // );
      }
    }
    return tokenUsage;
  }
  // api.on(
  //   "message_received",
  //   async (event: any, ctx: any) => {
  //     try {
  //       const channel = event?.channel || "unknown";
  //       const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
  //       const from = event?.from || event?.senderId || "unknown";
  //       const messageText = event?.text || event?.message || "";

  //       // Create root span for this request
  //       const rootSpan = tracer.startSpan("openclaw.request", {
  //         kind: SpanKind.SERVER,
  //         attributes: {
  //           "openclaw.message.channel": channel,
  //           "openclaw.session.key": sessionKey,
  //           "openclaw.message.direction": "inbound",
  //           "openclaw.message.from": from,
  //         },
  //       });

  //       // ═══ SECURITY DETECTION 2: Prompt Injection ═══════════════
  //       if (messageText && typeof messageText === "string" && messageText.length > 0) {
  //         const securityEvent = checkMessageSecurity(
  //           messageText,
  //           rootSpan,
  //           securityCounters,
  //           sessionKey
  //         );
  //         if (securityEvent) {
  //           logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`);
  //         }
  //       }

  //       // Store the context so child spans can reference it
  //       const rootContext = trace.setSpan(context.active(), rootSpan);

  //       sessionContextMap.set(sessionKey, {
  //         rootSpan,
  //         rootContext,
  //         startTime: Date.now(),
  //       });

  //       // Record message count metric
  //       counters.messagesReceived.add(1, {
  //         "openclaw.message.channel": channel,
  //       });

  //       logger.debug?.(`[otel] Root span started for session=${sessionKey}`);
  //     } catch {
  //       // Never let telemetry errors break the main flow
  //     }
  //   },
  //   { priority: 100 } // High priority — run first to establish context
  // );

  logger.info("[otel] Registered message_received hook (via api.on)");

  // ── before_agent_start ───────────────────────────────────────────
  // Creates an "agent turn" child span under the root request span.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      try {
        logger.debug?.(`[otel] before_agent_start: event=${JSON.stringify(event)}, ctx=${JSON.stringify(ctx)}`);
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        // const model = event?.model || "unknown";
        const prompt = event?.prompt;
        // logger.debug?.(
        //   `[otel] before_agent_start hook triggered: agentId=${agentId}, session=${sessionKey}`,
        // );

        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        // Create agent turn span as child of root span
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
            },
          },
          parentContext,
        );
        if (prompt) {
          agentSpan.setAttribute("traceloop.entity.input", prompt);
        }

        const agentContext = trace.setSpan(parentContext, agentSpan);

        // Store agent span context for tool spans
        if (sessionCtx) {
          sessionCtx.agentSpan = agentSpan;
          sessionCtx.agentContext = agentContext;
          // Store the length of historical messages before this conversation
          sessionCtx.startMessagesLength = event?.messages?.length || 0;
          // record message Input
          sessionCtx.agentInput = prompt;
        } else {
          // No root span (e.g., heartbeat) — create a standalone context
          sessionContextMap.set(sessionKey, {
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            startTime: Date.now(),
            pendingToolSpans: new Map(),
            // toolCalls: new Map(),
            startMessagesLength: event?.messages?.length || 0,
            agentInput: prompt,
          });
        }

        logger.debug?.(
          `[otel] Agent turn span started: agent=${agentId}, session=${sessionKey}, startMessagesLength=${event?.messages?.length || 0}`,
        );
      } catch {
        // Silently ignore
      }

      // Return undefined — don't modify system prompt
      return undefined;
    },
    { priority: 90 },
  );
  logger.info("[otel] Registered before_agent_start hook (via api.on)");
  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      try {
        logger.debug?.(
          `[otel] Before Tool call: event=${JSON.stringify(event)}, ctx=${JSON.stringify(ctx)}`,
        );

        const toolName = event?.toolName || "unknown";
        const params = event?.params;
        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";
        const startTime = Date.now();

        // Get parent context — prefer agent turn span, fall back to root
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext =
          sessionCtx?.agentContext ||
          sessionCtx?.rootContext ||
          context.active();

        // Create tool span as child of agent turn
        const span = tracer.startSpan(
          `tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "gen_ai.tool.name": toolName,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext,
        );

        // Record tool input
        if (params) {
          if (params.content) {
            params.content = "***";
          }
          const input = JSON.stringify(params).slice(0, 1000);
          span.setAttribute("traceloop.entity.input", input);
        }

        // ═══ SECURITY DETECTION 1 & 3: File Access & Dangerous Commands ═══
        logger.debug?.(
          `[otel] Checking tool security for tool=${toolName}, session=${sessionKey}, input=${JSON.stringify(params)}`,
        );
        const securityEvent = checkToolSecurity(
          toolName,
          params || {},
          span,
          securityCounters,
          sessionKey,
          agentId,
        );
        if (securityEvent) {
          logger.warn?.(
            `[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`,
          );
        }

        // Store span in pendingToolSpans for later ending in tool_result_persist
        if (sessionCtx) {
          sessionCtx.pendingToolSpans.set(toolName, {
            span,
            startTime,
            securityEvent,
          });
        }

        logger.debug?.(
          `[otel] Tool span started: tool=${toolName}, session=${sessionKey}`,
        );
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 },
  );
  logger.info("[otel] Registered before_tool_call hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Ends the pending tool span created in before_tool_call.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        logger.debug?.(
          `[otel] Tool result persist: event=${JSON.stringify(event)}}`,
        );
        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = ctx?.sessionKey || "unknown";

        // Record metric
        counters.toolCalls.add(1, {
          "tool.name": toolName,
          "session.key": sessionKey,
        });

        // Get session context and pending tool span
        const sessionCtx = sessionContextMap.get(sessionKey);
        const pendingToolSpan = sessionCtx?.pendingToolSpans?.get(toolName);

        if (pendingToolSpan) {
          const { span, startTime, securityEvent } = pendingToolSpan;

          // Add additional attributes
          span.setAttribute("openclaw.tool.call_id", toolCallId);
          span.setAttribute("openclaw.tool.is_synthetic", isSynthetic);

          // Inspect the message for result metadata
          const message = event?.message;
          if (message) {
            const contentArray = message?.content;
            const { totalChars, totalParts, content } =
              parseContent(contentArray);
            // Record result_chars and result_parts
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", totalParts);
            // Record tool output
            if (content) {
              span.setAttribute("traceloop.entity.output", content);
            }
          }

          // Set status based on isError or securityEvent (unified logic)
          const isToolError =
            message?.is_error === true || message?.isError === true;
          if (isToolError) {
            counters.toolErrors.add(1, { "tool.name": toolName });
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: "Tool execution error",
            });
          } else if (
            securityEvent &&
            (securityEvent.severity === "critical" ||
              securityEvent.severity === "high")
          ) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `Security Alert: ${securityEvent.detection} - ${securityEvent.description}`,
            });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }

          // End span with correct timestamp
          const endTime = message?.timestamp || Date.now();
          let durationMs = endTime - startTime;
          if (typeof message?.details?.durationMs === "number") {
            durationMs = message.details.durationMs;
          }
          span.setAttribute("openclaw.tool.duration_ms", durationMs);
          span.end(endTime);

          // Remove from pendingToolSpans
          if (sessionCtx) {
            sessionCtx.pendingToolSpans.delete(toolName);
          }

          logger.debug?.(
            `[otel] Tool span ended: tool=${toolName}, session=${sessionKey}, durationMs=${durationMs}`,
          );
        } else {
          logger.debug?.(
            `[otel] No pending tool span found for tool=${toolName}, session=${sessionKey}`,
          );
        }
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 },
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // ── llm_input ────────────────────────────────────────────────────
  // Creates an LLM span for tracking chat operations.

  // api.on(
  //   "llm_input",
  //   (event: any, ctx: any) => {
  //     try {
  //       const runId = event?.runId;
  //       const sessionKey = ctx?.sessionKey || "unknown";
  //       const provider = event?.provider || "unknown";
  //       const model = event?.model || "unknown";
  //       const prompt = event?.prompt || "";
  //       const startTime = Date.now();

  //       // Get parent context — prefer agent turn span, fall back to root
  //       const sessionCtx = sessionContextMap.get(sessionKey);
  //       const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

  //       // Create LLM span with GenAI semantic conventions
  //       const span = tracer.startSpan(
  //         `chat ${model}`,
  //         {
  //           kind: SpanKind.CLIENT,
  //           attributes: {
  //             "gen_ai.system": provider,
  //             "gen_ai.operation.name": "chat",
  //             "gen_ai.request.model": model,
  //             "openclaw.session.key": sessionKey,
  //             "openclaw.run.id": runId,
  //           },
  //         },
  //         parentContext
  //       );

  //       // Set prompt attributes (user message)
  //       if (prompt) {
  //         span.setAttribute("gen_ai.prompt.0.role", "user");
  //         span.setAttribute("gen_ai.prompt.0.content", String(prompt).slice(0, 2048));
  //       }

  //       // Store span in pendingLlmSpans for later ending in llm_output
  //       if (sessionCtx) {
  //         if (!sessionCtx.pendingLlmSpans) {
  //           sessionCtx.pendingLlmSpans = new Map();
  //         }
  //         sessionCtx.pendingLlmSpans.set(runId, { span, startTime });
  //       }

  //       logger.debug?.(`[otel] LLM span started: model=${model}, provider=${provider}, runId=${runId}, session=${sessionKey}`);
  //     } catch {
  //       // Never let telemetry errors break the main flow
  //     }

  //     return undefined;
  //   },
  //   { priority: -100 }
  // );
  // logger.info("[otel] Registered llm_input hook (via api.on)");

  // // ── llm_output ───────────────────────────────────────────────────
  // // Ends the pending LLM span created in llm_input.

  // api.on(
  //   "llm_output",
  //   (event: any, ctx: any) => {
  //     try {
  //       const runId = event?.runId;
  //       const sessionKey = ctx?.sessionKey || "unknown";
  //       const model = event?.model || "unknown";
  //       const lastAssistant = event?.lastAssistant;

  //       // Get session context and pending LLM span
  //       const sessionCtx = sessionContextMap.get(sessionKey);
  //       const pendingLlmSpan = sessionCtx?.pendingLlmSpans?.get(runId);

  //       if (pendingLlmSpan) {
  //         const { span, startTime } = pendingLlmSpan;

  //         // Set response model
  //         span.setAttribute("gen_ai.response.model", model);

  //         // Set completion attributes (assistant response)
  //         if (lastAssistant) {
  //           const role = lastAssistant.role || "assistant";
  //           span.setAttribute("gen_ai.completion.0.role", role);

  //           // Extract content from lastAssistant
  //           const contentArray = lastAssistant.content;
  //           if (contentArray && Array.isArray(contentArray)) {
  //             // Extract text parts from content array
  //             const textParts = contentArray
  //               .filter((c: any) => c.type === "text")
  //               .map((c: any) => String(c.text || ""));
  //             const content = textParts.join("\n");
  //             if (content) {
  //               span.setAttribute("gen_ai.completion.0.content", content.slice(0, 2048));
  //             }
  //           } else if (typeof lastAssistant.content === "string") {
  //             span.setAttribute("gen_ai.completion.0.content", lastAssistant.content.slice(0, 2048));
  //           }
  //         }

  //         // Extract usage from lastAssistant message
  //         const usage = lastAssistant?.usage;
  //         if (usage) {
  //           if (typeof usage.input === "number") {
  //             span.setAttribute("gen_ai.usage.input_tokens", String(usage.input));
  //           }
  //           if (typeof usage.output === "number") {
  //             span.setAttribute("gen_ai.usage.output_tokens", String(usage.output));
  //           }
  //           if (typeof usage.totalTokens === "number") {
  //             span.setAttribute("gen_ai.usage.total_tokens", String(usage.totalTokens));
  //           }
  //           if (typeof usage.cacheRead === "number") {
  //             span.setAttribute("gen_ai.usage.cache_read_tokens", String(usage.cacheRead));
  //           }
  //           if (typeof usage.cacheWrite === "number") {
  //             span.setAttribute("gen_ai.usage.cache_write_tokens", String(usage.cacheWrite));
  //           }
  //         }

  //         // Set span status based on stopReason
  //         const stopReason = lastAssistant?.stopReason;
  //         if (stopReason === "stop" || stopReason === "end_turn") {
  //           span.setStatus({ code: SpanStatusCode.OK });
  //         } else if (stopReason) {
  //           span.setStatus({ code: SpanStatusCode.OK });
  //           span.setAttribute("gen_ai.response.stop_reason", stopReason);
  //         } else {
  //           span.setStatus({ code: SpanStatusCode.OK });
  //         }

  //         // Calculate duration
  //         const durationMs = Date.now() - startTime;
  //         span.setAttribute("openclaw.llm.duration_ms", durationMs);

  //         // End the span
  //         span.end();

  //         // Remove from pendingLlmSpans
  //         if (sessionCtx) {
  //           sessionCtx.pendingLlmSpans.delete(runId);
  //         }

  //         logger.debug?.(`[otel] LLM span ended: model=${model}, runId=${runId}, session=${sessionKey}, duration=${durationMs}ms`);
  //       } else {
  //         logger.debug?.(`[otel] No pending LLM span found for runId=${runId}, session=${sessionKey}`);
  //       }
  //     } catch {
  //       // Never let telemetry errors break the main flow
  //     }

  //     return undefined;
  //   },
  //   { priority: -100 }
  // );
  // logger.info("[otel] Registered llm_output hook (via api.on)");

  // ── agent_end ────────────────────────────────────────────────────
  // Ends the agent turn span AND the root request span.
  // Event shape from OpenClaw:
  //   event: { messages, success, error?, durationMs }
  //   ctx:   { agentId, sessionKey, workspaceDir, messageProvider? }
  // Token usage is embedded in the last assistant message's .usage field.

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      try {
        logger.debug?.(
          `[otel] agent_end event: ${JSON.stringify(event)}, ctx: ${JSON.stringify(ctx)}`,
        );
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;
        const messages: any[] = event?.messages || [];

        // Try to get usage from diagnostic events (includes cost!)
        // const diagUsage = getPendingUsage(sessionKey);

        // Fallback: Extract token usage from the messages array
        // let totalInputTokens = 0;
        // let totalOutputTokens = 0;
        // let cacheReadTokens = 0;
        // let cacheWriteTokens = 0;
        // let model = "unknown";
        // let costUsd: number | undefined;

        // if (diagUsage) {
        //   // Use diagnostic event data (more accurate, includes cost)
        //   totalInputTokens = diagUsage.usage.input || 0;
        //   totalOutputTokens = diagUsage.usage.output || 0;
        //   cacheReadTokens = diagUsage.usage.cacheRead || 0;
        //   cacheWriteTokens = diagUsage.usage.cacheWrite || 0;
        //   model = diagUsage.model || "unknown";
        //   costUsd = diagUsage.costUsd;
        //   logger.debug?.(`[otel] agent_end using diagnostic data: cost=$${costUsd?.toFixed(4) || "?"}`);
        // } else {
        //   // Fallback: parse messages manually
        //   for (const msg of messages) {
        //     if (msg?.role === "assistant" && msg?.usage) {
        //       const u = msg.usage;
        //       // pi-ai stores usage as .input/.output (normalized names)
        //       if (typeof u.input === "number") totalInputTokens += u.input;
        //       else if (typeof u.inputTokens === "number") totalInputTokens += u.inputTokens;
        //       else if (typeof u.input_tokens === "number") totalInputTokens += u.input_tokens;

        //       if (typeof u.output === "number") totalOutputTokens += u.output;
        //       else if (typeof u.outputTokens === "number") totalOutputTokens += u.outputTokens;
        //       else if (typeof u.output_tokens === "number") totalOutputTokens += u.output_tokens;

        //       if (typeof u.cacheRead === "number") cacheReadTokens += u.cacheRead;
        //       if (typeof u.cacheWrite === "number") cacheWriteTokens += u.cacheWrite;
        //     }
        //     if (msg?.role === "assistant" && msg?.model) {
        //       model = msg.model;
        //     }
        //   }
        // }

        // const totalTokens = totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens;
        // logger.debug?.(`[otel] agent_end tokens: input=${totalInputTokens}, output=${totalOutputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, model=${model}`);

        const sessionCtx = sessionContextMap.get(sessionKey);

        // End the agent turn span
        if (sessionCtx?.agentSpan) {
          const agentSpan = sessionCtx.agentSpan;

          // Token usage — GenAI semantic convention attributes
          // agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
          // agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
          // agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
          agentSpan.setAttribute("openclaw.agent.success", success);

          // Cache tokens (custom attributes)
          // if (cacheReadTokens > 0) {
          //   agentSpan.setAttribute("gen_ai.usage.cache_read_tokens", cacheReadTokens);
          // }
          // if (cacheWriteTokens > 0) {
          //   agentSpan.setAttribute("gen_ai.usage.cache_write_tokens", cacheWriteTokens);
          // }

          // Cost (from diagnostic events) — this is the key addition!
          // if (typeof costUsd === "number") {
          //   agentSpan.setAttribute("openclaw.llm.cost_usd", costUsd);
          // }

          // Context window (from diagnostic events)
          // if (diagUsage?.context?.limit) {
          //   agentSpan.setAttribute("openclaw.context.limit", diagUsage.context.limit);
          // }
          // if (diagUsage?.context?.used) {
          //   agentSpan.setAttribute("openclaw.context.used", diagUsage.context.used);
          // }

          const firstMsg = messages[sessionCtx.startMessagesLength || 0] || {};
          const lastMsg = messages[messages.length - 1] || {};
          const input = firstMsg.role === "user" ? firstMsg.content : {};
          const output = lastMsg.role === "assistant" ? lastMsg.content : {};
          const inputInfo = parseContent(input);
          const outputInfo = parseContent(output);

          let securityEvent = null;
          if (!sessionCtx.agentInput){
            sessionCtx.agentInput = inputInfo.content;
          }
          if (sessionCtx.agentInput) {
            agentSpan.setAttribute("traceloop.entity.input", sessionCtx.agentInput);
            if (!sessionCtx.messageInput) {
              //use the first user message as root span input
              sessionCtx.messageInput = sessionCtx.agentInput;
            }
            securityEvent = checkMessageSecurity(
              sessionCtx.agentInput,
              agentSpan,
              securityCounters,
              sessionKey,
            );
            if (securityEvent) {
              logger.warn?.(
                `[otel] SECURITY: ${securityEvent.detection} - ${securityEvent.description}`,
              );
            }
          }
          if (outputInfo.content) {
            agentSpan.setAttribute(
              "traceloop.entity.output",
              outputInfo.content,
            );
            sessionCtx.messageOutput = outputInfo.content;
          }

          // Create LLM spans and tool spans for new messages in this conversation
          const {
            inputTokens = 0,
            outputTokens = 0,
            cacheReadTokens = 0,
            cacheWriteTokens = 0,
            totalTokens = 0,
            model,
            provider,
          } = createSpansFromMessages(
            messages,
            sessionCtx,
            sessionKey,
            agentId,
          );
          agentSpan.setAttribute("gen_ai.system", provider || "unknown");
          agentSpan.setAttribute("gen_ai.response.model", model || "unknown");
          agentSpan.setAttribute("gen_ai.usage.input_tokens", inputTokens);
          agentSpan.setAttribute("gen_ai.usage.output_tokens", outputTokens);
          agentSpan.setAttribute(
            "gen_ai.usage.cache_read_tokens",
            cacheReadTokens,
          );
          agentSpan.setAttribute(
            "gen_ai.usage.cache_write_tokens",
            cacheWriteTokens,
          );
          agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
          logger.debug?.(
            `[otel] agent_end tokens: input=${inputTokens}, output=${outputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, total_tokens=${totalTokens}, model=${model}, provider=${provider}`,
          );
          // Record metrics only if we didn't get them from diagnostics
          // (diagnostics module already records metrics on model.usage event)
          // if (!diagUsage) {
          //   const metricAttrs = {
          //     "gen_ai.response.model": tokenUsage.model,
          //     "openclaw.agent.id": agentId,
          //   };
          //   counters.tokensPrompt.add(tokenUsage.inputTokens + tokenUsage.cacheReadTokens + tokenUsage.cacheWriteTokens, metricAttrs);
          //   // histograms.tokenHistogram.record(totalInputTokens + cacheReadTokens + cacheWriteTokens, { ...metricAttrs, "gen_ai.token.type": "input" });
          //   counters.tokensCompletion.add(tokenUsage.outputTokens, metricAttrs);
          //   // histograms.tokenHistogram.record(totalOutputTokens, { ...metricAttrs, "gen_ai.token.type": "output" });
          //   counters.tokensTotal.add(tokenUsage.totalTokens, metricAttrs);
          //   counters.llmRequests.add(1, metricAttrs);
          // }

          // Record duration histogram
          if (typeof durationMs === "number") {
            agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
            histograms.agentTurnDuration.record(durationMs, {
              "gen_ai.response.model": model || "unknown",
              "openclaw.agent.id": agentId,
            });
          }

          if (errorMsg) {
            agentSpan.setAttribute(
              "openclaw.agent.error",
              String(errorMsg).slice(0, 500),
            );
            agentSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(errorMsg).slice(0, 200),
            });
          } else if (
            securityEvent &&
            (securityEvent.severity === "critical" ||
              securityEvent.severity === "high")
          ) {
            agentSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: `Security Alert: ${securityEvent.detection} - ${securityEvent.description}`,
            });
          } else {
            agentSpan.setStatus({ code: SpanStatusCode.OK });
          }

          agentSpan.end();
          sessionCtx.agentSpan = undefined;
        }

        // End the root request span
        // if (sessionCtx?.rootSpan && sessionCtx.rootSpan !== sessionCtx.agentSpan) {
        //   const totalMs = Date.now() - sessionCtx.startTime;
        //   sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);
        //   sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
        //   sessionCtx.rootSpan.end();
        // }

        // Clean up
        // sessionContextMap.delete(sessionKey);

        logger.debug?.(`[otel] Trace completed for session=${sessionKey}`);
      } catch {
        // Silently ignore
      }
    },
    { priority: -100 },
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const action = event?.action || "unknown";
        const sessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          `openclaw.command.${action}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.command.action": action,
              "openclaw.command.session_key": sessionKey,
              "openclaw.command.source":
                event?.context?.commandSource || "unknown",
            },
          },
          parentContext,
        );

        if (action === "new" || action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event?.context?.commandSource || "unknown",
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore telemetry errors
      }
    },
    {
      name: "otel-command-events",
      description: "Records session command spans via OpenTelemetry",
    },
  );

  logger.info("[otel] Registered command event hooks (via api.registerHook)");

  // ── Gateway startup hook ─────────────────────────────────────────

  api.registerHook(
    "gateway:startup",
    async (event: any) => {
      try {
        const span = tracer.startSpan("openclaw.gateway.startup", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.event.type": "gateway",
            "openclaw.event.action": "startup",
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore
      }
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    },
  );

  logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");

  // ── Periodic cleanup ─────────────────────────────────────────────
  // Safety net: clean up stale session contexts (e.g., if agent_end never fires)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    for (const [key, ctx] of sessionContextMap) {
      if (now - ctx.startTime > maxAge) {
        try {
          ctx.agentSpan?.end();
          if (ctx.rootSpan !== ctx.agentSpan) ctx.rootSpan?.end();
        } catch {
          /* ignore */
        }
        sessionContextMap.delete(key);
        logger.debug?.(
          `[otel] Cleaned up stale trace context for session=${key}`,
        );
      }
    }
  }, 60_000);
}
