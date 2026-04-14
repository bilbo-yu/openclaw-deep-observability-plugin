/**
 * Session context management — shared data structures for trace context.
 * This module provides a centralized location for session tracking state
 * that needs to be shared between diagnostics and hooks modules.
 */

import type { Span, Context } from "@opentelemetry/api";

/** Pending tool span data collected by hooks, consumed by createToolSpanFromMessage */
export interface PendingToolSpan {
  startTime: number;
  endTime?: number;
  toolName: string;
  input?: any;
  output?: any;
  isSynthetic?: boolean;
}

export interface ToolCallInfo {
  name: string;
  arguments?: any;
}

export interface ContentInfo {
  totalChars: number;
  totalParts: number;
  content: any;
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
  startTime: number;
  messageInput?: string;
  messageOutput?: string[];
  skills?: string[];
  // toolCalls: Map<string, ToolCallInfo>;
  // pendingLlmSpans: Map<string, PendingLlmSpan>;
  startMessagesLength?: number;
  /** For subagent sessions: references the parent session key */
  parentSessionKey?: string;
  /** For parent sessions: tracks active child subagent session keys */
  childSessionKeys?: Set<string>;
}

/** Map of sessionKey → active trace context. Cleaned up on message.processed or agent_end. */
export const sessionContextMap = new Map<string, SessionTraceContext>();

/** Global map of toolCallId → pending tool span data, populated by before_tool_call / tool_result_persist hooks. */
export const pendingToolSpansMap = new Map<string, PendingToolSpan>();

/** Pending user message input from message_received events, keyed by messageId.
 *  Consumed by llm_input handler which matches via ctx.runId === messageId. */
export const pendingMessageInputs = new Map<string, { content: string; timestamp: number }>();
