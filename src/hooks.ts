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
  ContentInfo,
  sessionContextMap,
  pendingToolSpansMap,
  type SessionTraceContext,
  type PendingToolSpan,
} from "./session-context.js";
import {
  checkToolSecurity,
  checkMessageSecurity,
  type SecurityCounters,
  redactText,
} from "./security.js";

class TokenUsage {
  inputTokens: number = 0;
  outputTokens: number = 0;
  cacheReadTokens: number = 0;
  cacheWriteTokens: number = 0;
  totalTokens: number = 0;
  model?: string | null;
  provider?: string | null;
  usedSkills: string[] = [];
}

// ═══════════════════════════════════════════════════════════════════
// Stale session cleanup — managed by start/stopAutoCleanupStaleSessions
// ═══════════════════════════════════════════════════════════════════
let cleanupIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic cleanup of stale session contexts and pending tool spans.
 * Should be called from service.start().
 */
export function startAutoCleanupStaleSessions(logger: any): void {
  if (cleanupIntervalHandle) return; // already started
  cleanupIntervalHandle = setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    // Clean up stale session contexts
    for (const [key, ctx] of sessionContextMap) {
      if (now - ctx.startTime > maxAge) {
        try {
          if (ctx.agentSpan) {
            logger.debug?.(`[otel] Span ending (stale cleanup): name=openclaw.agent.turn, session=${key}`);
            ctx.agentSpan.end();
          }
          if (ctx.rootSpan && ctx.rootSpan !== ctx.agentSpan) {
            logger.debug?.(`[otel] Span ending (stale cleanup): name=openclaw.request, session=${key}`);
            ctx.rootSpan.end();
          }
        } catch {
          /* ignore */
        }
        sessionContextMap.delete(key);
        logger.debug?.(
          `[otel] Cleaned up stale trace context for session=${key}`,
        );
      }
    }

    // Clean up stale pending tool spans
    for (const [toolCallId, pending] of pendingToolSpansMap) {
      const pendingAge = now - pending.startTime;
      if (pendingAge > maxAge) {
        pendingToolSpansMap.delete(toolCallId);
        logger.debug?.(
          `[otel] Cleaned up stale pending tool span: toolCallId=${toolCallId}, toolName=${pending.toolName}`,
        );
      }
    }
  }, 60_000);
  logger.info("[otel] Stale session cleanup interval started");
}

/**
 * Stop periodic cleanup of stale session contexts.
 * Should be called from service.stop().
 */
export function stopAutoCleanupStaleSessions(): void {
  if (cleanupIntervalHandle) {
    clearInterval(cleanupIntervalHandle);
    cleanupIntervalHandle = null;
  }
}

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 * Hooks are registered at plugin register time, but telemetry is obtained
 * lazily via getTelemetry() so that it's only accessed after service.start().
 */
export function registerHooks(
  api: any,
  getTelemetry: () => TelemetryRuntime | null,
  config: OtelObservabilityConfig,
): void {
  const captureContent = config.captureContent || false;
  const logger = api.logger;

  // Helper to build security counters from telemetry counters
  function buildSecurityCounters(counters: TelemetryRuntime["counters"]): SecurityCounters {
    return {
      securityEvents: counters.securityEvents,
      sensitiveFileAccess: counters.sensitiveFileAccess,
      promptInjection: counters.promptInjection,
      dangerousCommand: counters.dangerousCommand,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // TYPED HOOKS — registered via api.on() into registry.typedHooks
  // ═══════════════════════════════════════════════════════════════════

  // ── before_agent_start ───────────────────────────────────────────
  // Creates an "agent turn" child span under the root request span.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      return handleBeforeAgentStart(event, ctx);
    },
    { priority: 90 },
  );
  // logger.info("[otel] Registered before_agent_start hook (via api.on)");
  // ── agent_end ────────────────────────────────────────────────────
  // Ends the agent turn span AND the root request span.
  // Event shape from OpenClaw:
  //   event: { messages, success, error?, durationMs }
  //   ctx:   { agentId, sessionKey, workspaceDir, messageProvider? }
  // Token usage is embedded in the last assistant message's .usage field.

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      handleAgentEnd(event, ctx);
    },
    { priority: -100 },
  );
  // logger.info("[otel] Registered agent_end hook (via api.on)");

  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      return handleBeforeToolCall(event, ctx);
    },
    { priority: -100 },
  );
  // logger.info("[otel] Registered before_tool_call hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Ends the pending tool span created in before_tool_call.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      return handleToolResultPersist(event, ctx);
    },
    { priority: -100 },
  );
  // logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // ── llm_input ────────────────────────────────────────────────────
  // Creates an LLM span for tracking chat operations.

  api.on(
    "llm_input",
    (event: any, ctx: any) => {
      return handleLLMInput(event, ctx);
    },
    { priority: -100 }
  );
  // logger.info("[otel] Registered llm_input hook (via api.on)");

  // ── llm_output ───────────────────────────────────────────────────
  // Ends the pending LLM span created in llm_input.
  // Sets messageOutput for use in message.processed handler.

  api.on(
    "llm_output",
    (event: any, ctx: any) => {
      return handleLLMOutput(event, ctx);
    },
    { priority: -100 }
  );
  // logger.info("[otel] Registered llm_output hook (via api.on)");

  // ── before_prompt_build ─────────────────────────────────────────
  // Injects skill tracking instructions into the prompt context.

  api.on(
    "before_prompt_build",
    (event: any, ctx: any) => {
      return handleBeforePromptBuild(event, ctx);
    },
    { priority: -100 }
  );
  // logger.info("[otel] Registered before_prompt_build hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────
  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      handleCommandEvents(event);
    },
    {
      name: "otel-command-events",
      description: "Records session command spans via OpenTelemetry",
    },
  );
  // logger.info("[otel] Registered command event hooks (via api.registerHook)");

  // ── Gateway startup hook ─────────────────────────────────────────
  api.registerHook(
    "gateway:startup",
    async (event: any) => {
      handleGatewayStartup();
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    },
  );
  // logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");

  // ════════════════════════════════════════════════════════════════════════════
  // Hook Handlers
  // ════════════════════════════════════════════════════════════════════════════

  function handleLLMInput(event: any, ctx: any) {
    try {
        logger.debug?.(`[otel] llm_input event :  ctx=${JSON.stringify(ctx)}`);
        const sessionKey = ctx?.sessionKey || "unknown";
        const systemPrompt = event?.systemPrompt || "";
        const prompt = event?.prompt || "";
        const messages = event?.historyMessages || [];
        const sessionCtx = sessionContextMap.get(sessionKey);
        const agentSpan = sessionCtx?.agentSpan;
        // Set messageInput from prompt
        if (sessionCtx && prompt) {
          sessionCtx.messageInput = prompt;
        }

        // Extract skills from systemPrompt and save to sessionCtx
        if (sessionCtx && systemPrompt) {
          const skills = extractSkillsFromSystemPrompt(systemPrompt);
          if (skills.length > 0) {
            sessionCtx.skills = skills;
            logger.debug?.(`[otel] Extracted skills from systemPrompt: ${JSON.stringify(skills)}`);
          }
        }

        if (agentSpan) {
          const { messageList: promptList, totalChars } = buildMessageListForSpan(messages, systemPrompt, prompt);

          // 设置统计属性（始终设置）
          agentSpan.setAttribute("gen_ai.system_instructions.chars", systemPrompt.length);
          agentSpan.setAttribute("gen_ai.input.messages.chars", totalChars);
          agentSpan.setAttribute("gen_ai.input.messages.size", promptList.length);

          // 只有 captureContent 为 true 时才设置详细内容
          if (captureContent) {
            agentSpan.setAttribute("traceloop.entity.input", JSON.stringify(promptList));
          }
          
        }
      } catch {
        // Never let telemetry errors break the main flow
      }

      return undefined;
  }


  function handleLLMOutput(event: any, ctx: any) {
    try {
      logger.debug?.(`[otel] llm_output event : ctx=${JSON.stringify(ctx)}`);
      const sessionKey = ctx?.sessionKey || "unknown";
      const lastAssistantTexts = event?.assistantTexts;

      // Set messageOutput from assistantTexts (redacted)
      const sessionCtx = sessionContextMap.get(sessionKey);
      if (sessionCtx && lastAssistantTexts && Array.isArray(lastAssistantTexts) && lastAssistantTexts.length > 0) {
        sessionCtx.messageOutput = lastAssistantTexts[lastAssistantTexts.length-1];
      }

    } catch {
      // Never let telemetry errors break the main flow
    }

    return undefined;
  }

  function handleBeforePromptBuild(event: any, ctx: any) {
    try {
      logger.debug?.(`[otel] before_prompt_build event: ctx=${JSON.stringify(ctx)}`);
    } catch {
      // Never let telemetry errors break the main flow
    }

    // Return tracking instructions to be append to system prompt
    return {
      appendSystemContext: `
\n
## Core Instructions
As the core agent of the OpenClaw system, you must adhere to the following logic when processing every user request:

- **Self-Reflection and Analysis**: Before generating the final response, internally evaluate the specific skills required to complete the task.
- **Skill Disclosure Requirement**: Upon completing your reasoning and response, you **must** identify and disclose the specific skills employed.
- **Mandatory Format**: Append the list of skills to the end of your response, strictly following the format specified below:

### Format:
---

*Skills Used: \`skill_name_1\`, \`skill_name_2\`*
\n
`
    };
  }

  function handleBeforeAgentStart(event: any, ctx: any) {
    try {
      const telemetry = getTelemetry();
      if (!telemetry) {
        logger.error?.(
          "[otel] Telemetry not initialized. Skipping before_agent_start hook."
        );
        return undefined;
      }
      const { tracer } = telemetry;
      logger.debug?.(
        `[otel] before_agent_start event : ${JSON.stringify(ctx)}`
      );
      const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
      const sessionId = event?.sessionId || sessionKey;
      const agentId = event?.agentId || ctx?.agentId || "unknown";
      // const model = event?.model || "unknown";
      // const prompt = event?.prompt;
      // logger.debug?.(
      //   `[otel] before_agent_start hook triggered: agentId=${agentId}, session=${sessionKey}`,
      // );
      const sessionCtx = sessionContextMap.get(sessionKey);
      const parentContext = sessionCtx?.rootContext || context.active();
      let agentSpan = sessionCtx?.agentSpan;
      if (!agentSpan) {
        // Create agent turn span as child of root span
        agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "gen_ai.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "gen_ai.conversation.id": sessionId,
            },
          },
          parentContext
        );

        logger.debug?.(
          `[otel] Span starting: name=openclaw.agent.turn, session=${sessionKey}`
        );
      }

      const agentContext = trace.setSpan(parentContext, agentSpan);

      // Store agent span context for tool spans
      if (sessionCtx) {
        sessionCtx.agentSpan = agentSpan;
        sessionCtx.agentContext = agentContext;
        // Store the length of historical messages before this conversation
        sessionCtx.startMessagesLength = event?.messages?.length || 0;
      } else {
        logger.warn?.(
          `[otel] No root span found for session=${sessionKey}, setting agent span as root span`
        );
        // No root span (e.g., heartbeat) — create a standalone context
        sessionContextMap.set(sessionKey, {
          rootSpan: agentSpan,
          rootContext: agentContext,
          agentSpan,
          agentContext,
          startTime: Date.now(),
          startMessagesLength: event?.messages?.length || 0,
        });
      }

    } catch {
      logger.warn?.(
        `[otel] before_agent_start hook failed: event=${JSON.stringify(event)}, ctx=${JSON.stringify(ctx)}`
      );
    }

    // Return undefined — don't modify system prompt
    return undefined;
  }

  function handleGatewayStartup() {
    try {
      const telemetry = getTelemetry();
      if (!telemetry) return;
      const { tracer } = telemetry;
      const spanName = "openclaw.gateway.startup";
      logger.debug?.(`[otel] Span starting: name=${spanName}`);
      const span = tracer.startSpan(spanName, {
        kind: SpanKind.INTERNAL,
        attributes: {
          "openclaw.event.type": "gateway",
          "openclaw.event.action": "startup",
        },
      });
      span.setStatus({ code: SpanStatusCode.OK });
      logger.debug?.(`[otel] Span ending: name=${spanName}`);
      span.end();
    } catch {
      logger.warn?.(
        `[otel] gateway:startup hook failed`
      );
    }
  }

  function handleCommandEvents(event: any) {
    try {
      const telemetry = getTelemetry();
      if (!telemetry) return;
      const { tracer, counters } = telemetry;
      const action = event?.action || "unknown";
      const sessionKey = event?.sessionKey || "unknown";
      const spanName = `openclaw.command.${action}`;

      // Get parent context if available
      const sessionCtx = sessionContextMap.get(sessionKey);
      const parentContext = sessionCtx?.rootContext || context.active();

      logger.debug?.(`[otel] Span starting: name=${spanName}, session=${sessionKey}`);
      const span = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.command.action": action,
            "openclaw.command.session_key": sessionKey,
            "openclaw.command.source": event?.context?.commandSource || "unknown",
          },
        },
        parentContext
      );

      if (action === "new" || action === "reset") {
        counters.sessionResets.add(1, {
          "command.source": event?.context?.commandSource || "unknown",
        });
      }

      span.setStatus({ code: SpanStatusCode.OK });
      logger.debug?.(`[otel] Span ending: name=${spanName}, session=${sessionKey}`);
      span.end();
    } catch {
      logger.warn?.(
        `[otel] command event hook failed: event=${JSON.stringify(event)}}`
      );
    }
  }

  function handleAgentEnd(event: any, ctx: any) {
    try {
      const telemetry = getTelemetry();
      if (!telemetry) {
        logger.error?.(
          "[otel] Telemetry not initialized. Skipping before_agent_start hook."
        );
        return undefined;
      }
      logger.debug?.(
        `[otel] agent_end event: ctx: ${JSON.stringify(ctx)}`
      );
      const { tracer, counters, histograms } = telemetry;
      const securityCounters = buildSecurityCounters(counters);

      const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
      const agentId = event?.agentId || ctx?.agentId || "unknown";
      const durationMs = event?.durationMs;
      let success = event?.success !== false;
      const errorMsg = event?.error;
      const messages: any[] = event?.messages || [];
      const sessionCtx = sessionContextMap.get(sessionKey);
      const agentSpan = sessionCtx?.agentSpan;

      // End the agent turn span
      if (agentSpan) {
        const lastMsg = messages[messages.length - 1] || {};
        const output = lastMsg.role === "assistant" ? lastMsg.content : {};
        sessionCtx.messageOutput = toString(redactContent(output).content);

        const startOutputMsgOffset = (sessionCtx.startMessagesLength||0) + 1
        if (messages.length > startOutputMsgOffset){
          const { messageList, totalChars } = buildMessageListForSpan(messages.slice(startOutputMsgOffset))
          agentSpan.setAttribute("gen_ai.output.messages.size", messageList.length);
          agentSpan.setAttribute("gen_ai.output.messages.chars", totalChars);
          if (captureContent) {
              agentSpan.setAttribute(
                "traceloop.entity.output",
                JSON.stringify(messageList)
              );
          }
        }else{
          agentSpan.setAttribute("gen_ai.output.messages.size", 0);
          agentSpan.setAttribute("gen_ai.output.messages.chars", 0);
        }
        

        // Create LLM spans and tool spans for new messages in this conversation
        const {
          inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, totalTokens = 0, model, provider, usedSkills = [],
        } = createSpansFromMessages(
          messages,
          sessionCtx,
          sessionKey,
          agentId,
          telemetry
        );

        // Set used_skills attribute on agent span
        if (usedSkills.length > 0) {
          // Deduplicate usedSkills
          const uniqueSkills = [...new Set(usedSkills)];
          agentSpan.setAttribute("gen_ai.agent.used_skills", uniqueSkills.join(","));
          logger.debug?.(`[otel] agent_end used_skills: ${uniqueSkills.join(",")}`);

          // Increment skill usage counter for each skill
          for (const skill of uniqueSkills) {
            counters.skillUsed.add(1, {
              "gen_ai.skill.name": skill,
              "gen_ai.agent.id": agentId,
            });
          }
        }
        // agentSpan.setAttribute("gen_ai.system", provider || "unknown");
        // agentSpan.setAttribute("gen_ai.provider.name", provider || "unknown");
        // agentSpan.setAttribute("gen_ai.request.model", model || "unknown");
        // agentSpan.setAttribute("gen_ai.response.model", model || "unknown");
        // agentSpan.setAttribute("gen_ai.usage.input_tokens", inputTokens);
        // agentSpan.setAttribute("gen_ai.usage.output_tokens", outputTokens);
        // agentSpan.setAttribute(
        //   "gen_ai.usage.cache_read_tokens",
        //   cacheReadTokens
        // );
        // agentSpan.setAttribute(
        //   "gen_ai.usage.cache_write_tokens",
        //   cacheWriteTokens
        // );
        // agentSpan.setAttribute("gen_ai.usage.total_tokens", totalTokens);
        logger.debug?.(
          `[otel] agent_end tokens: input=${inputTokens}, output=${outputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, total_tokens=${totalTokens}, model=${model}, provider=${provider}`
        );

        if (errorMsg) {
          agentSpan.setAttribute(
            "openclaw.agent.error",
            String(errorMsg).slice(0, 500)
          );
          agentSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(errorMsg).slice(0, 200),
          });
          success = false;
        } else {
          agentSpan.setStatus({ code: SpanStatusCode.OK });
        }
        // Record duration histogram
        if (typeof durationMs === "number") {
          agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
          histograms.agentTurnDuration.record(durationMs, {
            success: String(success),
            "gen_ai.response.model": model || "unknown",
            "gen_ai.agent.id": agentId,
          });
        }

        logger.debug?.(`[otel] Span ending: name=openclaw.agent.turn, session=${sessionKey}, success=${success}`);
        agentSpan.end();
        sessionCtx.agentSpan = undefined;
      } else {
        logger.warn?.(`[otel] No agent span found for session=${sessionKey}, cannot end`);
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
      logger.warn?.(`[otel] agent_end hook failed: event=${JSON.stringify(event)}, ctx=${JSON.stringify(ctx)}`);
    }
  }

  function handleToolResultPersist(event: any, ctx: any) {
    try {
      logger.debug?.(
        `[otel] Tool result persist: ctx=${JSON.stringify(ctx)}}`
      );
      const toolCallId = event?.toolCallId || "";
      const isSynthetic = event?.isSynthetic === true;
      const message = event?.message;
      const endTime = message?.timestamp || Date.now();

      // Update pending tool span data with end time, output, and isSynthetic
      const pending = pendingToolSpansMap.get(toolCallId);
      if (pending) {
        pending.endTime = endTime;
        pending.output = message;
        pending.isSynthetic = isSynthetic;
        logger.debug?.(
          `[otel] Updated pending tool span: toolCallId=${toolCallId}, toolName=${pending.toolName}, endTime=${endTime}`
        );
      } else {
        logger.debug?.(
          `[otel] No pending tool span found for toolCallId=${toolCallId}`
        );
      }
    } catch {
      logger.warn?.(
        `[otel] tool_result_persist hook failed: event=${JSON.stringify(event)}, ctx=${JSON.stringify(ctx)}`
      );
    }

    // Return undefined to keep the tool result unchanged
    return undefined;
  }

  function handleBeforeToolCall(event: any, ctx: any) {
    try {
      logger.debug?.(
        `[otel] before_tool_call event: event=${JSON.stringify(event)} ctx=${JSON.stringify(ctx)}`
      );

      const toolName = event?.toolName || "unknown";
      const params = event?.params;
      const toolCallId = ctx?.toolCallId || "";
      const startTime = Date.now();

      // Store pending tool data in global map keyed by toolCallId
      pendingToolSpansMap.set(toolCallId, {
        startTime,
        toolName,
        input: params,
      });

      logger.debug?.(
        `[otel] Recorded pending tool call: toolName=${toolName}, toolCallId=${toolCallId}`
      );
    } catch {
      logger.warn?.(
        `[otel] before_tool_call hook failed: event=${JSON.stringify(event)}, ctx=${JSON.stringify(ctx)}`
      );
    }

    // Return undefined to keep the tool result unchanged
    return undefined;
  }


  // ════════════════════════════════════════════════════════════════════════════
  // Utility Functions
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * 从 systemPrompt 中提取所有 skills 名字列表
   * @param systemPrompt - 系统提示内容
   * @returns skills 名字数组
   */
  function extractSkillsFromSystemPrompt(systemPrompt: string): string[] {
    const skillsMatch = systemPrompt.match(/<available_skills>[\s\S]*?<\/available_skills>/);
    if (skillsMatch) {
      const nameMatches = skillsMatch[0].matchAll(/<name>([^<]+)<\/name>/g);
      return Array.from(nameMatches, m => m[1]);
    }
    return [];
  }

  /**
   * 从内容中提取技能名称列表，支持以下四种格式：
   * 1. Skills Used: skill_1, skill_2
   * 2. Skills Used: `skill_1`, `skill_2`
   * 3. *Skills Used: skill_1, skill_2*
   * 4. *Skills Used: `skill_1`, `skill_2`*
   * @param content - 消息内容（字符串或数组）
   * @returns 技能名称数组
   */
  function extractSkillsFromContent(content: any): string[] {
    const skills: string[] = [];
    const extractFromString = (text: string) => {
      // Match all four formats (case insensitive):
      // 1. Skills Used: skill_1, skill_2
      // 2. Skills Used: `skill_1`, `skill_2`
      // 3. *Skills Used: skill_1, skill_2*
      // 4. *Skills Used: `skill_1`, `skill_2`*
      const match = text.match(/\*?Skills Used:\s*([^*\n]+)\*?/i);
      if (match && match[1]) {
        // Remove backticks and split by comma
        const skillNames = match[1]
          .replace(/`/g, '')  // Remove backticks
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        skills.push(...skillNames);
      }
    };

    if (typeof content === "string") {
      extractFromString(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === "text" && typeof item?.text === "string") {
          extractFromString(item.text);
        } else if (item?.type === "thinking" && typeof item?.thinking === "string") {
          extractFromString(item.thinking);
        }
      }
    }
    return [...new Set(skills)]; // 去重
  }

  /**
   * Create an LLM span from an assistant message.
   * Also creates skill spans for skills referenced in the content.
   *
   * @param msg - The assistant message
   * @param prevMsg - The previous message (for input extraction)
   * @param parentContext - Parent context for the span
   * @param sessionCtx - Session trace context for accessing skills list
   * @param sessionKey - Session key for logging
   * @param spanStartTime - The start time of the span
   * @param spanEndTime - The end time of the span
   */
  function createLlmSpanFromMessage(
    msg: any,
    prevMsg: any | undefined,
    parentContext: Context,
    sessionCtx: SessionTraceContext | undefined,
    sessionKey: string,
    spanStartTime: number,
    spanEndTime: number,
    telemetry: TelemetryRuntime,
  ): TokenUsage {
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      usedSkills: [],
    };
    try {
      const { tracer } = telemetry;

      let inputText: ContentInfo | undefined;
      if (prevMsg?.role === "user") {
        inputText = redactContent(prevMsg?.content || []);
      }

      // Get model and provider from message
      const msgModel = msg.model || "unknown";
      const msgProvider = msg.provider || "unknown";
      tokenUsage.model = msg.model;
      tokenUsage.provider = msg.provider;

      // Create LLM span with correct start time, using agentSpan as parent
      const spanName = `chat ${msgModel}`;
      logger.debug?.(`[otel] Span starting: name=${spanName}, session=${sessionKey}, startTime=${spanStartTime}`);
      const llmSpan = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.CLIENT,
          startTime: spanStartTime,
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": msgProvider,
            "gen_ai.system": msgProvider,
            "gen_ai.request.model": msgModel,
            "gen_ai.response.model": msgModel,
          },
        },
        parentContext,
      );
      if (inputText){
        llmSpan.setAttribute("gen_ai.input.messages.chars", inputText.totalChars);
        if (captureContent) {
          llmSpan.setAttribute("traceloop.entity.input", toString(inputText.content));
        }
      }

      // Set traceloop.entity.output from content
      const contentArray = msg.content;
      if (contentArray) {
        const outputText = redactContent(contentArray);
        llmSpan.setAttribute("gen_ai.output.messages.chars", outputText.totalChars);
        if (captureContent) {
          llmSpan.setAttribute("traceloop.entity.output", toString(outputText.content));
        }
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

      

      // ═══════════════════════════════════════════════════════════════
      // Extract skills from thinking and text fields in the content
      // ═══════════════════════════════════════════════════════════════
      if (sessionCtx?.skills && sessionCtx.skills.length > 0) {
        const contentSkills = extractSkillsFromContent(contentArray);
        if (contentSkills.length > 0) {
          // Filter skills that exist in sessionCtx.skills
          const matchedSkills = contentSkills.filter(skill =>
            sessionCtx.skills!.includes(skill)
          );

          if (matchedSkills.length > 0) {
            logger.debug?.(`[otel] Creating skill spans for matched skills: ${JSON.stringify(matchedSkills)}, session=${sessionKey}`);
            
            // Store matched skills in tokenUsage for return
            tokenUsage.usedSkills = matchedSkills;
            
            // Create skill spans with LLM span end time as start time (instant spans)
            // const llmSpanContext = trace.setSpan(parentContext, llmSpan);
            // for (const skillName of matchedSkills) {
            //   const skillSpanName = `skill.${skillName}`;
            //   logger.debug?.(`[otel] Span starting: name=${skillSpanName}, session=${sessionKey}, startTime=${spanEndTime}`);
            //   const skillSpan = tracer.startSpan(
            //     skillSpanName,
            //     {
            //       kind: SpanKind.INTERNAL,
            //       startTime: spanEndTime,
            //       attributes: {
            //         "gen_ai.operation.name": "skill",
            //         "gen_ai.skill.name": skillName,
            //         "openclaw.session.key": sessionKey,
            //       },
            //     },
            //     llmSpanContext,
            //   );
            //   skillSpan.setStatus({ code: SpanStatusCode.OK });
            //   // End span immediately (instant span)
            //   logger.debug?.(`[otel] Span ending: name=${skillSpanName}, session=${sessionKey}, endTime=${spanEndTime}`);
            //   skillSpan.end(spanEndTime);
            // }
          }
        }
      }
      llmSpan.end(spanEndTime);
      // End span with correct end time
      logger.debug?.(`[otel] Span ending: name=${spanName}, session=${sessionKey}, endTime=${spanEndTime}, durationMs=${spanEndTime - spanStartTime}`);
    } catch (spanError) {
      logger.debug?.(
        `[otel] Error creating LLM span from message: msg = ${msg}, error=${spanError}`,
      );
    }
    return tokenUsage;
  }

  /**
   * Create a tool span from a toolResult message, using data collected
   * by before_tool_call and tool_result_persist hooks.
   *
   * All span attributes are reproduced here to match the original behavior:
   * - Input: gen_ai.tool.call.arguments.chars, traceloop.entity.input (with content="***" redaction + redactText)
   * - Security: checkToolSecurity on input
   * - Output: gen_ai.tool.call.result.chars, traceloop.entity.output (with redactContent)
   * - Status: isError / details.status / securityEvent
   * - Duration: openclaw.tool.duration_ms, histogram record
   *
   * @param msg - The toolResult message
   * @param parentContext - Parent context for the span
   * @param sessionKey - Session key for logging
   * @param agentId - Agent ID for security logging
   * @param msgStartTime - Fallback start time from message timestamp
   * @param msgEndTime - Fallback end time from next message timestamp
   */
  function createToolSpanFromMessage(
    msg: any,
    parentContext: Context,
    sessionKey: string,
    agentId: string,
    msgStartTime: number,
    msgEndTime: number,
    telemetry: TelemetryRuntime,
  ): void {
    const toolCallId = msg.toolCallId;
    try {
      const { tracer, counters, histograms } = telemetry;
      const securityCounters = buildSecurityCounters(counters);

      
      const toolName = msg.toolName || "unknown";

      // Get pending data from hooks (startTime, input, endTime, output, isSynthetic)
      const pendingData = pendingToolSpansMap.get(toolCallId);

      // Use hook-collected timing if available, fall back to message timing
      const spanStartTime = pendingData?.startTime || msgStartTime;
      const spanEndTime = pendingData?.endTime || msgEndTime;

      // Get input params from hooks (before_tool_call)
      const inputParams = pendingData?.input;
      // Get output message from hooks (tool_result_persist)
      const outputMessage = pendingData?.output || msg;
      const isSynthetic = pendingData?.isSynthetic;

      // Determine isError from output message
      const isError = outputMessage?.is_error === true || outputMessage?.isError === true;

      // Create tool span
      const spanName = `tool.${toolName}`;
      logger.debug?.(`[otel] Span starting: name=${spanName}, session=${sessionKey}, startTime=${spanStartTime}`);
      const toolSpan = tracer.startSpan(
        spanName,
        {
          kind: SpanKind.INTERNAL,
          startTime: spanStartTime,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": toolName,
          },
        },
        parentContext,
      );

      // Set tool call IDs
      toolSpan.setAttribute("openclaw.tool.call_id", toolCallId || "");
      toolSpan.setAttribute("gen_ai.tool.call.id", toolCallId || "");
      toolSpan.setAttribute("openclaw.session.key", sessionKey);
      if (isSynthetic !== undefined) {
        toolSpan.setAttribute("openclaw.tool.is_synthetic", isSynthetic);
      }

      // ── Input attributes (from before_tool_call) ──
      if (inputParams) {
        const inputSize = JSON.stringify(inputParams).length;
        toolSpan.setAttribute("gen_ai.tool.call.arguments.chars", inputSize);
        if (captureContent) {
          const paramsClone = { ...inputParams };
          if (paramsClone.content) {
            paramsClone.content = "***";
          }
          toolSpan.setAttribute("traceloop.entity.input", redactText(JSON.stringify(paramsClone)));
        }
      }

      // ═══ SECURITY DETECTION: File Access & Dangerous Commands ═══
      logger.debug?.(
        `[otel] Checking tool security for tool=${toolName}, session=${sessionKey}, input=${JSON.stringify(inputParams || {})}`,
      );
      const securityEvent = checkToolSecurity(
        toolName,
        inputParams || {},
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

      if (outputMessage) {
        const contentArray = outputMessage.content;
        if (contentArray) {
          const contentInfo = redactContent(contentArray);
          toolSpan.setAttribute("gen_ai.tool.call.result.chars", contentInfo.totalChars);
          if (captureContent) {
            toolSpan.setAttribute("traceloop.entity.output", toString(contentInfo.content));
          }
        }
      }

      // ── Status (unified logic from original handleToolResultPersist) ──
      const isDetailsError = outputMessage?.details?.status === "error";
      const hasError = isError || isDetailsError;

      // Extract error message from details if available
      let errorMessage = "Tool execution error";
      if (isDetailsError && outputMessage?.details?.error) {
        errorMessage = String(outputMessage.details.error).slice(0, 500);
      }

      if (hasError) {
        toolSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
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

      // ── Duration ──
      let durationMs = spanEndTime - spanStartTime;
      if (typeof outputMessage?.details?.durationMs === "number") {
        durationMs = outputMessage.details.durationMs;
      }
      toolSpan.setAttribute("openclaw.tool.duration_ms", durationMs);
      histograms.aiOpDurationHistogram.record(durationMs / 1000.0, {
        "gen_ai.operation.name": "execute_tool",
        "error.type": hasError ? "tool_error" : "",
        "gen_ai.tool.name": toolName,
      });

      // End span with correct end time
      logger.debug?.(`[otel] Span ending: name=${spanName}, session=${sessionKey}, endTime=${spanEndTime}, durationMs=${durationMs}`);
      toolSpan.end(spanEndTime);
    } catch (spanError) {
      logger.debug?.(
        `[otel] Error creating tool span from message: msg=${msg}, error=${spanError}`,
      );
    } finally {
      // Clean up pending data
      pendingToolSpansMap.delete(toolCallId);
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
    telemetry: TelemetryRuntime,
  ): TokenUsage {
    const tokenUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      usedSkills: [],
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
          usedSkills = [],
        } = createLlmSpanFromMessage(
          msg,
          prevMsg,
          parentContext,
          sessionCtx,
          sessionKey,
          spanStartTime,
          spanEndTime,
          telemetry,
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
        // Collect used skills
        if (usedSkills.length > 0) {
          tokenUsage.usedSkills.push(...usedSkills);
        }
        // Extract toolCall arguments from assistant message as fallback input
        // for cases where before_tool_call event was missing
        if (Array.isArray(msg?.content)) {
          for (const item of msg.content) {
            if (item?.type === "toolCall" && item?.id) {
              const callId = item.id;
              const existing = pendingToolSpansMap.get(callId);
              if (!existing) {
                // No before_tool_call event — create entry with fallback data
                pendingToolSpansMap.set(callId, {
                  startTime: msg.timestamp || agentStartTime,
                  toolName: item.name || "unknown",
                  input: item.arguments || undefined,
                });
              }
            }
          }
        }
      } else if (msg?.role === "toolResult") {
        createToolSpanFromMessage(
          msg,
          parentContext,
          sessionKey,
          agentId,
          spanStartTime,
          spanEndTime,
          telemetry,
        );
      }
    }
    return tokenUsage;
  }

  function toString(content: any): string {
    if (typeof content === "string") {
      return content;
    }
    return JSON.stringify(content);
  }

  /**
   * 对 content 进行脱敏和裁剪处理
   * - 字符串：直接用 redactText 处理
   * - 数组：对 text 和 thinking 字段用 redactText 处理
   * - 其他：JSON 序列化后用 redactText 处理
   * 
   * 返回 ContentInfo 类型：
   * - totalChars: text 和 thinking 部分的字符总数
   * - totalParts: 内容块数量
   * - content: 脱敏加裁剪后的内容
   */
  function redactContent(content: any): ContentInfo {
    if (typeof content === "string") {
      return {
        totalChars: content.length,
        totalParts: 1,
        content: redactText(content),
      };
    }

    if (Array.isArray(content)) {
      let totalChars = 0;
      const redactedArray = content.map((item) => {
        if (item?.type === "text" && item?.text) {
          totalChars += String(item.text).length;
          return { type: "text", text: redactText(item.text) };
        } else if (item?.type === "thinking" && item?.thinking) {
          totalChars += String(item.thinking).length;
          return { type: "thinking", thinking: redactText(item.thinking) };
        }
        return item;
      });
      return {
        totalChars,
        totalParts: content.length,
        content: redactedArray,
      };
    }

    const str = JSON.stringify(content);
    return {
      totalChars: str.length,
      totalParts: 1,
      content: redactText(str),
    };
  }

  /**
   * 构建可以设置到span里的消息列表
   * - systemPrompt: 系统提示
   * - messages: 历史消息
   * - prompt: 当前用户输入
   * 返回 messageList 和 totalChars
   */
  function buildMessageListForSpan(
    messages: any[],
    systemPrompt?: string,
    prompt?: string
  ): { messageList: any[]; totalChars: number } {
    const messageList: any[] = [];
    let totalChars = 0;

    // 1. 添加 system prompt
    if (systemPrompt) {
      messageList.push({
        role: "system",
        content: redactText(systemPrompt)
      });
      totalChars += systemPrompt.length;
    }

    // 2. 添加历史消息
    for (const msg of messages) {
      if (msg?.role && msg?.content) {
        const contentInfo = redactContent(msg.content);
        totalChars += contentInfo.totalChars;

        const filteredMsg: any = {};
        if (msg.role) filteredMsg.role = msg.role;
        if (msg.content) filteredMsg.content = contentInfo.content;
        if (msg.stopReason) filteredMsg.stopReason = msg.stopReason;
        if (msg.toolCallId) filteredMsg.toolCallId = msg.toolCallId;
        if (msg.toolName) filteredMsg.toolName = msg.toolName;

        messageList.push(filteredMsg);
      }
    }

    // 3. 添加当前用户输入
    if (prompt) {
      messageList.push({
        role: "user",
        content: redactText(prompt)
      });
      totalChars += prompt.length;
    }

    return { messageList, totalChars };
  }
}
