// `npm test`: start one throwaway Postgres for the whole run (unless TEST_DATABASE_URL is
// set), run the test files against it, then remove it. Each test file still creates its own
// databases (test/pg.ts), so files and tests stay isolated from each other.
//
//   node test/run.ts <node --test arguments...>
import { spawn } from "node:child_process";
import { startCluster } from "./pg.ts";

const cluster = process.env.TEST_DATABASE_URL ? null : await startCluster();
const env = { ...process.env, ...(cluster ? { TEST_DATABASE_URL: cluster.url } : {}) };
const child = spawn(process.execPath, process.argv.slice(2), { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
const code = await new Promise<number>((resolve) => child.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0))));
cluster?.stop();
process.exit(code);
