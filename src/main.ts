import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { errMsg, log } from "./log.ts";
import { createCloudfriend } from "./cloudfriend.ts";

export async function main(): Promise<void> {
  const config = loadConfig();
  const cloudfriend = await createCloudfriend(config);

  if (cloudfriend.role === "worker") log.info("CLOUDFRIEND_ROLE=worker: running the worker; HTTP serves only /healthz");
  if (cloudfriend.role === "web") log.info("CLOUDFRIEND_ROLE=web: serving HTTP and intake; events are processed by workers (CLOUDFRIEND_ROLE=worker or all)");
  if (cloudfriend.bootSecret) {
    const bar = "=".repeat(72);
    console.log(
      [
        bar,
        "First boot: created an ingest secret named 'default'. It is shown only once:",
        "",
        `  ${cloudfriend.bootSecret}`,
        "",
        `Send events:  curl -X POST http://localhost:${config.port}/in/<source> \\`,
        `                -H 'Authorization: Bearer <secret>' -d '{"message":"hello"}'`,
        bar,
      ].join("\n"),
    );
  }
  if (!config.adminKey) log.warn("CLOUDFRIEND_ADMIN_KEY is not set; the admin API (/secrets, /flags, /events) is disabled");
  if (!cloudfriend.decider) {
    log.warn(
      cloudfriend.triage?.classifier
        ? `decider '${config.decider}' is not configured (JEV_API_KEY or OPENROUTER_API_KEY missing?); the classifier decides alone`
        : `decider '${config.decider}' is not configured (JEV_API_KEY or OPENROUTER_API_KEY missing?); events are stored but not triaged`,
    );
  }
  if (!cloudfriend.actions.size && cloudfriend.role !== "worker") log.info("no actions configured from environment variables; flags go to each workspace's destinations (SLACK_WEBHOOK_URL or WEBHOOK_URL add one to the default workspace)");

  cloudfriend.start();
  const server = serve({ fetch: cloudfriend.app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info("cloudfriend listening", {
      role: cloudfriend.role,
      port: info.port,
      data: config.dataDir,
      decider: cloudfriend.decider?.name ?? "none",
      classifier: cloudfriend.triage?.classifier ? "on" : "off",
      actions: [...cloudfriend.actions.keys()].join(",") || "none",
      batch: `${config.batchSize} events or ${config.batchWaitMs}ms`,
    });
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    // Stop accepting requests; requests already waiting on a commit still get their reply.
    server.close();
    void (async () => {
      let code = 0;
      try {
        await cloudfriend.close(4_000);
        log.info("stopped");
      } catch (err) {
        log.error("shutdown failed", { error: errMsg(err) });
        code = 1;
      }
      // stdout/stderr are asynchronous when piped (as in Docker); flush before exiting.
      await Promise.all([process.stdout, process.stderr].map((s) => new Promise((r) => s.write("", r))));
      process.exit(code);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("failed to start", { error: errMsg(err) });
    process.exit(1);
  });
}
