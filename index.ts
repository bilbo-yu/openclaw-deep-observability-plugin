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
 *         "otel-deep-observability": {
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
import { initOpenLLMetry } from "./src/openllmetry.js";
import { registerHooks } from "./src/hooks.js";
import { registerDiagnosticsListener, hasDiagnosticsSupport } from "./src/diagnostics.js";

const otelObservabilityPlugin = {
  id: "otel-deep-observability",
  name: "OpenTelemetry Deep Observability",
  description:
    "Deep traces, cost tracking, and metrics for OpenClaw via OpenTelemetry",

  configSchema: {
    parse(value: unknown): OtelObservabilityConfig {
      return parseConfig(value);
    },
  },

  register(api: any) {
    const config = parseConfig(api.pluginConfig);
    const logger = api.logger;

    let telemetry: TelemetryRuntime | null = null;
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
      id: "otel-deep-observability",

      start: async () => {
        logger.info("[otel] Starting OpenTelemetry deep observability...");

        // 1. Initialize our OTel providers FIRST (traces + metrics)
        //    This registers our TracerProvider as global, so all spans
        //    (including GenAI wraps) export through our pipeline.
        telemetry = initTelemetry(config, logger);

        // 2. Wrap LLM SDKs AFTER provider is registered
        //    The wraps use trace.getTracer() which goes through our provider.
        if (config.traces) {
          await initOpenLLMetry(config, logger);
        }

        // 3. Register hooks for tool results and command events
        registerHooks(api, telemetry, config);

        // 4. Subscribe to OpenClaw diagnostic events (model.usage, etc.)
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
          };
        },
      },
      { optional: true }
    );
  },
};

export default otelObservabilityPlugin;
