import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JsBoxlite } from "../lib/index.js";
import { SimpleBox } from "../lib/simplebox.js";
import { testRegistries } from "./test-registries.js";

const binary = process.env.BOXLITE_TEST_OPENCODE_BINARY;

function assertRustParity(
  result: Record<string, unknown>,
  event: { kind: string; turnId?: string },
  turnId: string,
) {
  const path = process.env.BOXLITE_AGENT_RUST_BASELINE;
  if (!path) return;
  const baseline = JSON.parse(readFileSync(path, "utf8")) as {
    result: Record<string, unknown>;
    event: { kind: string; turn_id: string | null };
    turn_id: string;
  };
  expect(baseline.result.turn_id).toBe(baseline.turn_id);
  expect(baseline.event.turn_id).toBe(baseline.turn_id);
  expect(result.turnId).toBe(turnId);
  expect(event.turnId).toBe(turnId);
  expect(event.kind).toBe(baseline.event.kind);
  const actual = structuredClone(result);
  const expected = baseline.result;
  delete actual.turnId;
  delete expected.turn_id;
  for (const key of ["outcome", "text", "data", "usage", "error"]) {
    if (!(key in actual)) actual[key] = null;
  }
  for (const record of [actual, expected]) {
    for (const entry of (record.usage ?? []) as Record<string, unknown>[]) {
      expect(entry.message_id).toEqual(expect.any(String));
      expect(entry.message_id).not.toBe("");
      delete entry.message_id;
    }
  }
  expect(actual).toEqual(expected);
}

describe.skipIf(!binary)(
  "Node agent with OpenCode",
  { timeout: 240_000 },
  () => {
    test("creates, opens events, sends and waits", async () => {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            stream?: boolean;
            messages: Array<{
              role: string;
              content: string | Array<{ text?: string }>;
            }>;
          };
          if (!body.stream) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: "c",
                object: "chat.completion",
                model: "fake-model",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "title" },
                    finish_reason: "stop",
                  },
                ],
              }),
            );
            return;
          }
          const value =
            [...body.messages]
              .reverse()
              .find((message) => message.role === "user")?.content ?? "";
          const prompt =
            typeof value === "string"
              ? value
              : value.map((part) => part.text ?? "").join("");
          const chunk = (delta: object, finish: string | null) => ({
            id: "c",
            object: "chat.completion.chunk",
            model: "fake-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
          });
          response.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "close",
          });
          response.end(
            `data: ${JSON.stringify(chunk({ role: "assistant", content: `pong: ${prompt}` }, null))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "0.0.0.0", resolve),
      );
      const port = (server.address() as AddressInfo).port;
      const homeDir = mkdtempSync("/tmp/boxlite-node-agent-");
      const runtime = new JsBoxlite({
        homeDir,
        imageRegistries: testRegistries(),
      });
      const box = new SimpleBox({ image: "debian:bookworm-slim", runtime });
      try {
        await box.exec("true");
        await box.copyIn(binary!, "/usr/local/bin/opencode");
        await box.exec(
          "sh",
          "-c",
          "chmod 755 /usr/local/bin/opencode && mkdir -p /root/.config/opencode",
        );
        const config = {
          provider: {
            fake: {
              npm: "@ai-sdk/openai-compatible",
              name: "Fake",
              options: {
                baseURL: `http://host.boxlite.internal:${port}/v1`,
                apiKey: "fake",
              },
              models: { "fake-model": { name: "Fake" } },
            },
          },
          small_model: "fake/fake-model",
        };
        const configPath = join(homeDir, "opencode.json");
        writeFileSync(configPath, JSON.stringify(config));
        await box.copyIn(configPath, "/root/.config/opencode/opencode.json");
        const agent = await box.agents.create("opencode", {
          config: { model: "fake/fake-model" },
        });
        expect(agent.config.model).toBe("fake/fake-model");
        expect(agent.capabilities.operations).toContain("agent.capabilities");
        expect(() => agent.state).toThrow("unsupported");
        await expect(
          agent.send("invalid", { mode: "invalid" as "queue" }),
        ).rejects.toThrow("unknown send mode");
        const events = agent.events();
        await events.opened();
        const turn = await agent.send("hello");
        const result = await turn.wait({ timeoutSeconds: 120 });
        expect(result).toMatchObject({
          status: "completed",
          text: "pong: hello",
          turnId: turn.state.id,
          outcome: "answer",
          artifacts: [],
        });
        expect(result).not.toHaveProperty("data");
        expect(result).not.toHaveProperty("error");
        expect(result.usage).toEqual([
          {
            message_id: expect.any(String),
            cost: 0,
            tokens: {
              cache: { read: 0, write: 0 },
              input: 0,
              output: 0,
              reasoning: 0,
            },
          },
        ]);
        for (const timeoutSeconds of [-1, Infinity, NaN]) {
          await expect(turn.wait({ timeoutSeconds })).rejects.toThrow();
        }
        await expect(turn.steer("unsupported")).rejects.toThrow("unsupported");
        await expect(turn.interrupt()).rejects.toThrow("unsupported");
        await expect(agent.requests()).rejects.toThrow("unsupported");
        await expect(
          agent.respond("request", { type: "answer", text: "yes" }),
        ).rejects.toThrow("unsupported");
        await expect(
          agent.respond("request", { type: "invalid" } as never),
        ).rejects.toThrow();
        await expect(agent.close()).rejects.toThrow("unsupported");
        const enqueued = (await events.next()).value;
        expect(enqueued?.kind).toBe("session.inbox.enqueued");
        expect(enqueued?.turnId).toBe(turn.state.id);
        assertRustParity(
          result as unknown as Record<string, unknown>,
          enqueued!,
          turn.state.id,
        );
        const reattached = await box.agents.get(enqueued!.agentId);
        const finished = await reattached.getTurn(enqueued!.turnId!);
        expect(finished.state.status).toBe("completed");
        await events.return();
        const idle = agent.events();
        await idle.opened();
        const pending = idle.next();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await Promise.race([
          idle.return(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("stream close timed out")), 5000),
          ),
        ]);
        await expect(pending).resolves.toMatchObject({ done: true });
        await expect(
          agent.send("unsupported", { data: { x: 1 } }),
        ).rejects.toThrow("unsupported");
        const unsupported = turn.events();
        await expect(unsupported.opened()).rejects.toThrow("unsupported");
        await unsupported.return();
      } finally {
        await box.stop();
        await runtime.shutdown();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  },
);
