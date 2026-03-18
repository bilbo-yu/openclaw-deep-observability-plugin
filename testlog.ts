import { Logger, ILogObj, ISettingsParam } from "tslog";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";

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
// OTLP LogExporter 配置
// ═══════════════════════════════════════════════════════════════
const logExporter = new OTLPLogExporterHTTP({
  url: "http://192.168.10.30:4318/v1/logs",
});

const resourceAttrs: Record<string, string> = {
  "service.name": "test-logs",
  "service.version": "0.1.0",
  "openclaw.plugin": "otel-observability",
  "agent.type": "openclaw",
};

const resource = resourceFromAttributes(resourceAttrs);
const loggerProvider = new LoggerProvider({
  resource,
  processors: [new BatchLogRecordProcessor(logExporter)],
});

// Register as global logger provider
logs.setGlobalLoggerProvider(loggerProvider);

const otelLogger = logs.getLogger("test-logs");

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

// ═══════════════════════════════════════════════════════════════
// 创建 tslog Logger
// ═══════════════════════════════════════════════════════════════
const tslogConfig: ISettingsParam<ILogObj> = {
  name: "test-logs",
  type: "pretty",
  hideLogPositionForProduction: false,
  prettyLogTemplate: "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}\t{{logLevelName}}\t{{name}}\t",
  prettyErrorTemplate: "\n{{errorName}} {{errorMessage}}\n{{errorStack}}",
  prettyLogStyles: {
    logLevelName: {
      SILLY: ["white", "bold"],
      TRACE: ["white", "bold"],
      DEBUG: ["blue", "bold"],
      INFO: ["green", "bold"],
      WARN: ["yellow", "bold"],
      ERROR: ["red", "bold"],
      FATAL: ["red", "bold"],
    },
  },
};

const logger = new Logger<ILogObj>(tslogConfig);

// ═══════════════════════════════════════════════════════════════
// OTLP Transport: 将 tslog 日志重定向到 OpenTelemetry
// ═══════════════════════════════════════════════════════════════
logger.attachTransport((logObj: ILogObj) => {
  try {
    const meta = (logObj as Record<string, unknown>)._meta as
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
    console.error(`tslog-otlp: log transport failed: ${err}`);
  }
});

// ═══════════════════════════════════════════════════════════════
// 测试日志发送
// ═══════════════════════════════════════════════════════════════
try {
  // 发送不同级别的测试日志
  logger.silly("This is a SILLY message");
  logger.trace("This is a TRACE message");
  logger.debug("This is a DEBUG message");
  logger.info("This is an INFO message");
  logger.warn("This is a WARN message");
  logger.error("This is an ERROR message");
  logger.fatal("This is a FATAL message");

  // 带有 JSON bindings 的日志
  logger.info({ userId: "12345", action: "login" }, "User logged in");
  logger.info({ requestId: "req-001", duration: 150 }, "Request completed");

  // 带有多个参数的日志
  logger.info("Processing item", { itemId: "item-001" }, { count: 5 });

  // 循环发送测试日志
  for (let i = 0; i < 10; i++) {
    logger.info(`test log message: ${i}`);
  }

  // 等待日志导出后退出
  setTimeout(async () => {
    try {
      await loggerProvider.shutdown();
      console.log('Logs sent successfully and resources cleaned up');
    } catch (err) {
      console.error('Error during shutdown:', err);
    }
  }, 2000); // 等待 2 秒让日志处理完成

} catch (error) {
  console.error('Error emitting logs:', error);
}

export { logger, loggerProvider };