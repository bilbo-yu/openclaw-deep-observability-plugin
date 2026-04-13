/**
 * OpenClaw OTel Deep Observability Plugin
 *
 * Provides deep OpenTelemetry observability for OpenClaw:
 *   - Connected distributed traces (request → agent turn → llm/tools)
 *   - Cost tracking via OpenClaw diagnostic events integration
 *   - Token usage (input, output, cache read/write) as spans + metrics
 *   - Tool execution spans with result metadata
 *   - Metrics: token usage, cost, latency histograms, tool calls
 *   - OTLP export to any OpenTelemetry-compatible backend (Dynatrace, Grafana, etc.)
 *
 * Usage in openclaw config:
 *   {
 *     "plugins": {
 *       "entries": {
 *         "openclaw-deep-observability-plugin": {
 *           "enabled": true,
 *           "config": {
 *             "endpoint": "http://localhost:4318",
 *             "protocol": "http",
 *             "serviceName": "openclaw-gateway",
 *             "traces": true,
 *             "metrics": true,
 *             "logs": true,
 *             "captureContent": true
 *           }
 *         }
 *       }
 *     }
 *   }
 */

import { parseConfig, type OtelObservabilityConfig } from "./src/config.js";
import { initTelemetry, type TelemetryRuntime } from "./src/telemetry.js";
import { registerHooks, startAutoCleanupStaleSessions, stopAutoCleanupStaleSessions } from "./src/hooks.js";
import { registerDiagnosticsListener, hasDiagnosticsSupport } from "./src/diagnostics.js";

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

let telemetry: TelemetryRuntime | null = null;

export default definePluginEntry({
  id: "openclaw-deep-observability-plugin",
  name: "OpenTelemetry Deep Observability",
  description:
    "Deep traces, cost tracking, and metrics for OpenClaw via OpenTelemetry",

  configSchema: {
    parse(value: unknown): OtelObservabilityConfig {
      return parseConfig(value);
    },
  },

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const logger = api.logger;
    
    let unsubscribeDiagnostics: (() => void) | null = null;

    // ── RPC: status endpoint ────────────────────────────────────────

    api.registerGatewayMethod(
      "otel-deep-observability.status",
      ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        respond(true, {
          initialized: telemetry !== null,
          config: {
            endpoint: config.endpoint,
            protocol: config.protocol,
            serviceName: config.serviceName,
            traces: config.traces,
            metrics: config.metrics,
            logs: config.logs,
            captureContent: config.captureContent,
          },
        });
      }
    );

    // ── CLI command ─────────────────────────────────────────────────

    api.registerCli(
      ({ program }: { program: any }) => {
        program
          .command("otel")
          .description("OpenTelemetry observability status")
          .action(async () => {
            console.log("🔭 OpenTelemetry Observability Plugin");
            console.log("─".repeat(40));
            console.log(`  Endpoint:        ${config.endpoint}`);
            console.log(`  Protocol:        ${config.protocol}`);
            console.log(`  Service:         ${config.serviceName}`);
            console.log(`  Traces:          ${config.traces ? "✅" : "❌"}`);
            console.log(`  Metrics:         ${config.metrics ? "✅" : "❌"}`);
            console.log(`  Logs:            ${config.logs ? "✅" : "❌"}`);
            console.log(`  Capture content: ${config.captureContent ? "✅" : "❌"}`);
            console.log(`  Initialized:     ${telemetry ? "✅" : "❌"}`);
            console.log(`  Cost tracking:   ${hasDiagnosticsSupport() ? "✅ (via diagnostics API)" : "❌"}`);

          });
      },
      { commands: ["otel"] }
    );

    

    // ── Background service ──────────────────────────────────────────

    api.registerService({
      id: "openclaw-deep-observability-plugin",

      start: async () => {
        logger.info(`[otel] Starting OpenTelemetry deep observability plugin... config = ${JSON.stringify(config)}`);

        // 1. Initialize telemetry at service start time
        telemetry = initTelemetry(config, logger);

        // 2. Start stale session cleanup
        startAutoCleanupStaleSessions(logger);

        // 3. Subscribe to OpenClaw diagnostic events (model.usage, etc.)
        //    This gives us cost data and accurate token counts
        unsubscribeDiagnostics = await registerDiagnosticsListener(telemetry, config, logger);
        if (hasDiagnosticsSupport()) {
          logger.info("[otel] ✅ Integrated with OpenClaw diagnostics (cost tracking enabled)");
        }

        logger.info("[otel] ✅ Observability pipeline active");
        logger.info(
          `[otel]   Traces=${config.traces} Metrics=${config.metrics} Logs=${config.logs}`
        );
        logger.info(`[otel]   Endpoint=${config.endpoint} (${config.protocol})`);
      },

      stop: async () => {
        stopAutoCleanupStaleSessions();
        if (unsubscribeDiagnostics) {
          unsubscribeDiagnostics();
          unsubscribeDiagnostics = null;
        }
        if (telemetry) {
          await telemetry.shutdown();
          telemetry = null;
          logger.info("[otel] Telemetry shut down");
        }
      },
    });

    // ── Agent tool: otel_status ─────────────────────────────────────
    // Lets the agent check observability status in conversation

    api.registerTool(
      {
        name: "otel_status",
        label: "OTel Status",
        description:
          "Check the OpenTelemetry deep observability plugin status and configuration.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const status = {
            initialized: telemetry !== null,
            endpoint: config.endpoint,
            protocol: config.protocol,
            serviceName: config.serviceName,
            traces: config.traces,
            metrics: config.metrics,
            logs: config.logs,
            captureContent: config.captureContent,
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(status, null, 2),
              },
            ],
            details: undefined,
          };
        },
      },
      { optional: true }
    );

    // ── Register hooks (telemetry obtained lazily via getter) ──────
    registerHooks(api, () => telemetry, config);
    logger.info("[otel] Hooks registered, telemetry will initialize at service start");
  },
});


