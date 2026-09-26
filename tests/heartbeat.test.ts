import { describe, test, expect, beforeEach, afterEach, setSystemTime } from "bun:test";
import { HeartbeatRunner } from "../src/heartbeat";
import { createTempDir, cleanupTempDir } from "./helpers/temp-dir";
import { writeFileSync } from "fs";
import { join } from "path";

let tmpDir: string;

beforeEach(() => {
  tmpDir = createTempDir();
});

afterEach(() => {
  setSystemTime();
  cleanupTempDir(tmpDir);
});

function makeRunner(opts: {
  runAgentResult?: string;
  runAgentError?: Error;
  activeHours?: { start: string; end: string };
  healthcheckUrl?: string;
}) {
  const sendCalls: Array<{ text: string; attachments: string[] }> = [];
  const runAgentCalls: string[] = [];

  const runner = new HeartbeatRunner({
    intervalMs: 60000,
    workspaceDir: tmpDir,
    runAgent: async (msg: string) => {
      runAgentCalls.push(msg);
      if (opts.runAgentError) throw opts.runAgentError;
      return { text: opts.runAgentResult ?? "HEARTBEAT_OK", attachments: [] };
    },
    sendToChannel: async (text: string, attachments: string[]) => {
      sendCalls.push({ text, attachments });
    },
    activeHours: opts.activeHours,
    healthcheckUrl: opts.healthcheckUrl,
  });

  return { runner, sendCalls, runAgentCalls };
}

describe("periodic heartbeat", () => {
  test("skips when outside active hours", async () => {
    setSystemTime(new Date("2025-01-15T03:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check stuff\nDo things");
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(0);
  });

  test("skips when HEARTBEAT.md does not exist", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(0);
  });

  test("skips when HEARTBEAT.md contains only headings", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "# Heartbeat\n## Section\n");
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(0);
  });

  test("runs agent when content exists and within active hours", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "# Checks\nCheck the weather");
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(1);
  });

  test("suppresses HEARTBEAT_OK response from channel", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, sendCalls } = makeRunner({
      runAgentResult: "HEARTBEAT_OK",
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(sendCalls.length).toBe(0);
  });

  test("sends non-OK response to channel", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, sendCalls } = makeRunner({
      runAgentResult: "Something needs attention!",
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].text).toBe("Something needs attention!");
  });

  test("deduplicates identical messages within 24 hours", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, sendCalls } = makeRunner({
      runAgentResult: "Alert: disk full",
      activeHours: { start: "08:00", end: "23:00" },
    });
    await runner.runOnce();
    expect(sendCalls.length).toBe(1);

    setSystemTime(new Date("2025-01-15T13:00:00"));
    await runner.runOnce();

    expect(sendCalls.length).toBe(1);
  });

  test("re-sends duplicate message after 24 hours", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, sendCalls } = makeRunner({
      runAgentResult: "Alert: disk full",
      activeHours: { start: "08:00", end: "23:00" },
    });
    await runner.runOnce();
    expect(sendCalls.length).toBe(1);

    setSystemTime(new Date("2025-01-16T13:00:00"));
    await runner.runOnce();

    expect(sendCalls.length).toBe(2);
  });

  test("handles agent errors without crashing", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, sendCalls } = makeRunner({
      runAgentError: new Error("LLM is down"),
      activeHours: { start: "08:00", end: "23:00" },
    });

    await runner.runOnce();

    expect(sendCalls.length).toBe(0);
  });

  test("runs during late night when active hours wrap midnight", async () => {
    setSystemTime(new Date("2025-01-15T23:30:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "22:00", end: "06:00" },
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(1);
  });

  test("skips during daytime when active hours wrap midnight", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "22:00", end: "06:00" },
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(0);
  });

  test("runs at any hour when no active hours are configured", async () => {
    setSystemTime(new Date("2025-01-15T03:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things\nDo stuff");
    const { runner, runAgentCalls } = makeRunner({});

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(1);
  });
});

describe("healthcheck ping (dead man's switch)", () => {
  const realFetch = globalThis.fetch;
  let pingCalls: string[] = [];
  let pingMode: "ok" | "http500" | "network-error" = "ok";

  beforeEach(() => {
    pingCalls = [];
    pingMode = "ok";
    globalThis.fetch = (async (url: unknown) => {
      pingCalls.push(String(url));
      if (pingMode === "network-error") throw new Error("connection refused");
      return new Response("ping", { status: pingMode === "ok" ? 200 : 500 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("pings the URL on every tick, even outside active hours", async () => {
    setSystemTime(new Date("2025-01-15T03:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check stuff");
    const { runner, runAgentCalls } = makeRunner({
      activeHours: { start: "08:00", end: "23:00" },
      healthcheckUrl: "https://hc-ping.com/abcd-1234",
    });

    await runner.runOnce();

    // Agent skipped (inactive hours), but the liveness ping still went out
    expect(runAgentCalls.length).toBe(0);
    expect(pingCalls).toEqual(["https://hc-ping.com/abcd-1234"]);
  });

  test("pings even when HEARTBEAT.md is empty", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    const { runner } = makeRunner({
      healthcheckUrl: "https://hc-ping.com/abcd-1234",
    });

    await runner.runOnce();

    expect(pingCalls.length).toBe(1);
  });

  test("ping network failure does not break the heartbeat run", async () => {
    pingMode = "network-error";
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things");
    const { runner, runAgentCalls } = makeRunner({
      healthcheckUrl: "https://hc-ping.com/abcd-1234",
    });

    await runner.runOnce();

    expect(pingCalls.length).toBe(1);
    expect(runAgentCalls.length).toBe(1);
  });

  test("ping HTTP 500 does not break the heartbeat run", async () => {
    pingMode = "http500";
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things");
    const { runner, runAgentCalls } = makeRunner({
      healthcheckUrl: "https://hc-ping.com/abcd-1234",
    });

    await runner.runOnce();

    expect(runAgentCalls.length).toBe(1);
  });

  test("does not call fetch when no URL is configured", async () => {
    setSystemTime(new Date("2025-01-15T12:00:00"));
    writeFileSync(join(tmpDir, "HEARTBEAT.md"), "Check things");
    const { runner, runAgentCalls } = makeRunner({});

    await runner.runOnce();

    expect(pingCalls.length).toBe(0);
    expect(runAgentCalls.length).toBe(1);
  });
});
