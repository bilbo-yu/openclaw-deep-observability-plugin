/**
 * Core OpenTelemetry setup — initializes tracing (with OpenLLMetry),
 * metrics, and resource configuration.
 *
 * OpenLLMetry auto-instruments Anthropic/OpenAI SDK calls and produces
 * standard OTel spans following the GenAI semantic conventions.
 */

import {
  trace,
  metrics,
  context,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type {
  Span,
  Tracer,
  Meter,
  Counter,
  Histogram,
  UpDownCounter,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";

import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";

import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc";

import type { OtelObservabilityConfig } from "./config.js";

// ═══════════════════════════════════════════════════════════════
// openclaw/plugin-sdk 动态加载
// ═══════════════════════════════════════════════════════════════
type LogTransportRecord = Record<string, unknown>;
type LogTransport = (logObj: LogTransportRecord) => void;
type RegisterLogTransport = (transport: LogTransport) => () => void;

let registerLogTransport: RegisterLogTransport | null = null;
let sdkLoadAttempted = false;

async function loadSdk(): Promise<void> {
  if (sdkLoadAttempted) return;
  sdkLoadAttempted = true;
  try {
    // Dynamic import to avoid build issues if SDK not available
    // @ts-ignore - openclaw/plugin-sdk types not available at build time
    const sdk = (await import("openclaw/plugin-sdk")) as any;
    registerLogTransport = sdk.registerLogTransport;
  } catch {
    // SDK not available — log transport will not be registered
  }
}

// ═══════════════════════════════════════════════════════════════
// 日志级别映射: tslog -> OpenTelemetry SeverityNumber
// ═══════════════════════════════════════════════════════════════
const logSeverityMap: Record<string, SeverityNumber> = {
  SILLY: 1,    // TRACE
  TRACE: 1,    // TRACE
  DEBUG: 5,    // DEBUG
  INFO: 9,     // INFO
  WARN: 13,    // WARN
  ERROR: 17,   // ERROR
  FATAL: 21,   // FATAL
};

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════
const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const _GEN_AI_CLIENT_OPERATION_DURATION_BUCKETS = [
  0.0,
  1.0,
  2.0,
  4.0,
  6.0,
  8.0,
  10.0,
  15.0,
  20.0,
  25.0,
  50.0,
  75.0,
  100.0,
  250.0,
  500.0,
  750.0,
  1000.0,
  2500.0,
  5000.0,
];
// ── Types ───────────────────────────────────────────────────────────

export interface TelemetryRuntime {
  tracer: Tracer;
  meter: Meter;
  counters: OtelCounters;
  histograms: OtelHistograms;
  gauges: OtelGauges;
  shutdown: () => Promise<void>;
}

export interface OtelCounters {
  /** Total LLM requests */
  llmRequests: Counter;
  /** Total LLM errors */
  llmErrors: Counter;
  /** Total tokens (prompt + completion) */
  tokensTotal: Counter;
  /** Prompt tokens */
  tokensPrompt: Counter;
  /** Completion tokens */
  tokensCompletion: Counter;
  /** Tool invocations */
  toolCalls: Counter;
  /** Tool errors */
  toolErrors: Counter;
  /** Session resets */
  sessionResets: Counter;
  /** Messages received */
  messagesReceived: Counter;
  /** Messages sent */
  // messagesSent: Counter;
  /** Security events detected */
  securityEvents: Counter;
  /** Sensitive file access attempts */
  sensitiveFileAccess: Counter;
  /** Prompt injection attempts */
  promptInjection: Counter;
  /** Dangerous command executions */
  dangerousCommand: Counter;
}

export interface OtelHistograms {
  /** LLM token usage distribution */
  tokenHistogram: Histogram;
  /** LLM request duration distribution in seconds */
  llmDurationHistogram: Histogram;
  /** Agent request processing duration distribution in seconds */
  messageDurationHistogram: Histogram;
  /** LLM request duration in ms */
  // llmDuration: Histogram;
  /** Tool execution duration in ms */
  toolDuration: Histogram;
  /** Agent turn duration in ms */
  agentTurnDuration: Histogram;
}

export interface OtelGauges {
  /** Currently active sessions */
  activeSessions: UpDownCounter;
}

// ── Init ────────────────────────────────────────────────────────────

export function initTelemetry(
  config: OtelObservabilityConfig,
  logger: any,
): TelemetryRuntime {
  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
    "openclaw.plugin": "otel-observability",
    "agent.type": "openclaw",
    ...config.resourceAttributes,
  };

  const resource = resourceFromAttributes(resourceAttrs);

  // Resolve endpoint suffixes for HTTP protocol
  const traceEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/traces`
      : config.endpoint;
  const metricsEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/metrics`
      : config.endpoint;
  const logsEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/logs`
      : config.endpoint;

  // ── Tracing ─────────────────────────────────────────────────────

  let tracerProvider: NodeTracerProvider | undefined;

  if (config.traces) {
    const traceExporter =
      config.protocol === "grpc"
        ? new OTLPTraceExporterGRPC({
            url: traceEndpoint,
            headers: config.headers,
          })
        : new OTLPTraceExporterHTTP({
            url: traceEndpoint,
            headers: config.headers,
          });

    // SDK v2: pass spanProcessors in constructor (addSpanProcessor was removed)
    tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    // Note: Not registering as global - only used within this plugin
    // tracerProvider.register();

    logger.info(
      `[otel] Trace exporter → ${traceEndpoint} (${config.protocol})`,
    );
  }

  // ── Metrics ─────────────────────────────────────────────────────

  let meterProvider: MeterProvider | undefined;

  if (config.metrics) {
    const metricExporter =
      config.protocol === "grpc"
        ? new OTLPMetricExporterGRPC({
            url: metricsEndpoint,
            headers: config.headers,
          })
        : new OTLPMetricExporterHTTP({
            url: metricsEndpoint,
            headers: config.headers,
          });

    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: config.metricsIntervalMs,
        }),
      ],
    });
    // Note: Not registering as global - only used within this plugin
    // metrics.setGlobalMeterProvider(meterProvider);

    logger.info(
      `[otel] Metrics exporter → ${metricsEndpoint} (${config.protocol}, interval=${config.metricsIntervalMs}ms)`,
    );
  }

  // ── Logs ───────────────────────────────────────────────────────

  let loggerProvider: LoggerProvider | undefined;
  let unsubscribeLogTransport: (() => void) | undefined;

  if (config.logs) {
    const logExporter =
      config.protocol === "grpc"
        ? new OTLPLogExporterGRPC({
            url: logsEndpoint,
            headers: config.headers,
          })
        : new OTLPLogExporterHTTP({
            url: logsEndpoint,
            headers: config.headers,
          });

    loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(logExporter)],
    });

    // Register as global logger provider
    logs.setGlobalLoggerProvider(loggerProvider);

    logger.info(
      `[otel] Log exporter → ${logsEndpoint} (${config.protocol})`,
    );

    // ═══════════════════════════════════════════════════════════════
    // Log Transport: 通过 openclaw/plugin-sdk 将日志重定向到 OpenTelemetry
    // ═══════════════════════════════════════════════════════════════
    const otelLogger = logs.getLogger("openclaw-observability");

    // 创建 log transport 处理函数
    const logTransportHandler = (logObj: LogTransportRecord) => {
      try {
        const meta = logObj._meta as
          | {
              logLevelName?: string;
              date?: Date;
              name?: string;
              parentNames?: string[];
              path?: {
                filePath?: string;
                fileLine?: string;
                fileColumn?: string;
                filePathWithLine?: string;
                method?: string;
              };
            }
          | undefined;

        const logLevelName = meta?.logLevelName ?? "INFO";
        const severityNumber = logSeverityMap[logLevelName] ?? (9 as SeverityNumber);

        // 提取数字索引的参数并按索引排序
        const numericArgs = Object.entries(logObj)
          .filter(([key]) => /^\d+$/.test(key))
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([, value]) => value);

        // 尝试解析第一个参数作为 JSON bindings
        let bindings: Record<string, unknown> | undefined;
        if (typeof numericArgs[0] === "string" && numericArgs[0].trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(numericArgs[0]);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              bindings = parsed as Record<string, unknown>;
              numericArgs.shift();
            }
          } catch {
            // ignore malformed json bindings
          }
        }

        // 提取消息
        let message = "";
        if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
          message = String(numericArgs.pop());
        } else if (numericArgs.length === 1) {
          message = safeStringify(numericArgs[0]);
          numericArgs.length = 0;
        }
        if (!message) {
          message = "log";
        }

        // 构建属性
        const attributes: Record<string, string | number | boolean> = {
          "openclaw.log.level": logLevelName,
        };

        if (meta?.name) {
          attributes["openclaw.logger"] = meta.name;
        }
        if (meta?.parentNames?.length) {
          attributes["openclaw.logger.parents"] = meta.parentNames.join(".");
        }
        if (bindings) {
          for (const [key, value] of Object.entries(bindings)) {
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
            ) {
              attributes[`openclaw.${key}`] = value;
            } else if (value != null) {
              attributes[`openclaw.${key}`] = safeStringify(value);
            }
          }
        }
        if (numericArgs.length > 0) {
          attributes["openclaw.log.args"] = safeStringify(numericArgs);
        }
        if (meta?.path?.filePath) {
          attributes["code.filepath"] = meta.path.filePath;
        }
        if (meta?.path?.fileLine) {
          attributes["code.lineno"] = Number(meta.path.fileLine);
        }
        if (meta?.path?.method) {
          attributes["code.function"] = meta.path.method;
        }
        if (meta?.path?.filePathWithLine) {
          attributes["openclaw.code.location"] = meta.path.filePathWithLine;
        }

        // 发送到 OTLP
        otelLogger.emit({
          body: message,
          severityText: logLevelName,
          severityNumber,
          attributes,
          timestamp: meta?.date ?? new Date(),
        });
      } catch (err) {
        // 避免日志 transport 错误影响主流程
      }
    };

    // 尝试加载 SDK 并注册 log transport
    loadSdk().then(() => {
      if (registerLogTransport) {
        unsubscribeLogTransport = registerLogTransport(logTransportHandler);
        logger.info("[otel] Log transport registered for OTLP export via openclaw/plugin-sdk");
      } else {
        logger.warn?.("[otel] Log transport not registered: openclaw/plugin-sdk not available");
      }
    });
  }

  // ── Instruments ─────────────────────────────────────────────────

  // Get tracer/meter from local providers (not global) to isolate this plugin's telemetry
  const tracer = tracerProvider
    ? tracerProvider.getTracer("openclaw-observability", "0.1.0")
    : trace.getTracer("openclaw-observability", "0.1.0"); // no-op fallback

  const meter = meterProvider
    ? meterProvider.getMeter("openclaw-observability", "0.1.0")
    : metrics.getMeter("openclaw-observability", "0.1.0"); // no-op fallback

  const counters: OtelCounters = {
    llmRequests: meter.createCounter("openclaw.llm.requests", {
      description: "Total LLM API requests",
      unit: "requests",
    }),
    llmErrors: meter.createCounter("openclaw.llm.errors", {
      description: "Total LLM API errors",
      unit: "errors",
    }),
    tokensTotal: meter.createCounter("openclaw.llm.tokens.total", {
      description: "Total tokens consumed (prompt + completion)",
      unit: "tokens",
    }),
    tokensPrompt: meter.createCounter("openclaw.llm.tokens.prompt", {
      description: "Prompt tokens consumed",
      unit: "tokens",
    }),
    tokensCompletion: meter.createCounter("openclaw.llm.tokens.completion", {
      description: "Completion tokens consumed",
      unit: "tokens",
    }),
    toolCalls: meter.createCounter("openclaw.tool.calls", {
      description: "Total tool invocations",
      unit: "calls",
    }),
    toolErrors: meter.createCounter("openclaw.tool.errors", {
      description: "Total tool errors",
      unit: "errors",
    }),
    sessionResets: meter.createCounter("openclaw.session.resets", {
      description: "Total session resets",
      unit: "resets",
    }),
    messagesReceived: meter.createCounter("openclaw.messages.received", {
      description: "Total inbound messages",
      unit: "messages",
    }),
    // messagesSent: meter.createCounter("openclaw.messages.sent", {
    //   description: "Total outbound messages",
    //   unit: "messages",
    // }),
    // Security detection counters
    securityEvents: meter.createCounter("openclaw.security.events", {
      description: "Total security events detected",
      unit: "events",
    }),
    sensitiveFileAccess: meter.createCounter(
      "openclaw.security.sensitive_file_access",
      {
        description: "Sensitive file access attempts",
        unit: "events",
      },
    ),
    promptInjection: meter.createCounter("openclaw.security.prompt_injection", {
      description: "Prompt injection attempts detected",
      unit: "events",
    }),
    dangerousCommand: meter.createCounter(
      "openclaw.security.dangerous_command",
      {
        description: "Dangerous command executions detected",
        unit: "events",
      },
    ),
  };

  const histograms: OtelHistograms = {
    tokenHistogram: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "token",
      description: "Measures number of input and output tokens used",
    }),
    llmDurationHistogram: meter.createHistogram(
      "gen_ai.client.operation.duration",
      {
        unit: "s",
        description: "GenAI operation duration",
        advice: {
          // 定义自定义桶边界：针对秒级延迟进行优化
          explicitBucketBoundaries: _GEN_AI_CLIENT_OPERATION_DURATION_BUCKETS,
        },
      },
    ),
    messageDurationHistogram: meter.createHistogram(
      "gen_ai.agent.request.duration",
      {
        unit: "s",
        description: "Agent request processing duration",
        advice: {
          // 定义自定义桶边界：针对秒级延迟进行优化
          explicitBucketBoundaries: _GEN_AI_CLIENT_OPERATION_DURATION_BUCKETS,
        },
      },
    ),
    // llmDuration: meter.createHistogram("openclaw.llm.duration", {
    //   description: "LLM request duration",
    //   unit: "ms",
    // }),
    toolDuration: meter.createHistogram("openclaw.tool.duration", {
      description: "Tool execution duration",
      unit: "ms",
    }),
    agentTurnDuration: meter.createHistogram("openclaw.agent.turn_duration", {
      description: "Full agent turn duration (LLM + tools)",
      unit: "ms",
    }),
  };

  const gauges: OtelGauges = {
    activeSessions: meter.createUpDownCounter("openclaw.sessions.active", {
      description: "Currently active sessions",
      unit: "sessions",
    }),
  };

  // ── Periodic Metric Heartbeat ─────────────────────────────────
  // OTel counters only emit data points when .add() is called.
  // To maintain continuous timeseries (important for Dynatrace),
  // we periodically emit zero-value data points on all counters.
  // This ensures metrics always have data, even during idle periods.

  const metricHeartbeatInterval = setInterval(() => {
    try {
      const idleAttrs = { "openclaw.idle": true };

      // Core counters — emit 0 to keep timeseries alive
      counters.llmRequests.add(0, idleAttrs);
      counters.llmErrors.add(0, idleAttrs);
      counters.tokensTotal.add(0, idleAttrs);
      counters.tokensPrompt.add(0, idleAttrs);
      counters.tokensCompletion.add(0, idleAttrs);
      counters.toolCalls.add(0, idleAttrs);
      counters.toolErrors.add(0, idleAttrs);
      counters.messagesReceived.add(0, idleAttrs);
      // counters.messagesSent.add(0, idleAttrs);
      counters.sessionResets.add(0, idleAttrs);

      // Security counters
      counters.securityEvents.add(0, idleAttrs);
      counters.sensitiveFileAccess.add(0, idleAttrs);
      counters.promptInjection.add(0, idleAttrs);
      counters.dangerousCommand.add(0, idleAttrs);
    } catch {
      // Never let metric heartbeat errors affect the gateway
    }
  }, config.metricsIntervalMs || 30_000); // Match the export interval

  // ── Shutdown ────────────────────────────────────────────────────

  const shutdown = async () => {
    logger.info("[otel] Shutting down telemetry...");
    clearInterval(metricHeartbeatInterval);
    
    // 取消日志传输器注册
    if (unsubscribeLogTransport) {
      unsubscribeLogTransport();
    }
    
    try {
      if (tracerProvider) await tracerProvider.shutdown();
      if (meterProvider) await meterProvider.shutdown();
      if (loggerProvider) await loggerProvider.shutdown();
    } catch (err) {
      logger.error(
        `[otel] Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return { tracer, meter, counters, histograms, gauges, shutdown };
}
