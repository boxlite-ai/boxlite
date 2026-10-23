import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions, type Boxlite } from "../lib/index.js";

const BOX = {
  box_id: "box1",
  name: null,
  status: "running",
  created_at: "2026-07-14T00:00:00Z",
  updated_at: "2026-07-14T00:00:00Z",
  pid: null,
  image: "alpine:3.20",
  cpus: 1,
  memory_mib: 256,
};

/** One final, unmasked server frame; every payload here fits the 7-bit length. */
function frame(opcode: number, payload: string): Buffer {
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
}

/**
 * Completes the upgrade by hand and plays one session: "hi" on stdout, then
 * exit code 7. The client hangs up on the exit frame.
 */
function playSession(req: IncomingMessage, socket: Socket, headers: string[]) {
  const accept = createHash("sha1")
    .update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      ...headers,
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(frame(0x2, "\x01hi"));
  socket.write(frame(0x1, '{"type":"exit","exit_code":7}'));
}

describe("box attach on a REST runtime", () => {
  let server: Server;
  let sockets: Socket[];
  let requests: string[];
  let runtime: Boxlite;

  beforeEach(async () => {
    requests = [];
    sockets = [];
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/v1/boxes/box1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(BOX));
        return;
      }
      res.writeHead(404).end();
    });
    server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      requests.push(`${req.method} ${req.url}`);
      sockets.push(socket);
      socket.on("error", () => {});
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/boxes/box1/attach") {
        playSession(req, socket, ["X-Boxlite-Execution-Id: init-1"]);
      } else if (path === "/v1/boxes/box1/executions/exec-1/attach") {
        playSession(req, socket, []);
      } else {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
    );
  });

  afterEach(async () => {
    runtime.close();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function box1() {
    const box = await runtime.get("box1");
    if (box === null) throw new Error("runtime.get returned no box1");
    return box;
  }

  test("box attach joins the main session and streams its init", async () => {
    const execution = await (await box1()).attach();

    expect(await execution.id()).toBe("init-1");
    const stdout = await execution.stdout();
    expect(await stdout.next()).toBe("hi");
    expect((await execution.wait()).exitCode).toBe(7);
    expect(requests).toContain("GET /v1/boxes/box1/attach");
  });

  test("box attach rejoins an exec by id, read-only", async () => {
    const execution = await (await box1()).attach("exec-1", false);

    expect(await execution.id()).toBe("exec-1");
    expect((await execution.wait()).exitCode).toBe(7);
    expect(requests).toContain(
      "GET /v1/boxes/box1/executions/exec-1/attach?stdin=0",
    );
  });
});
