/**
 * Session context management — shared data structures for trace context.
 * This module provides a centralized location for session tracking state
 * that needs to be shared between diagnostics and hooks modules.
 */

import type { Span, Context } from "@opentelemetry/api";
import type { SecurityEvent } from "./security.js";

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
// export interface PendingLlmSpan {
//   span: Span;
//   startTime: number;
// }

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