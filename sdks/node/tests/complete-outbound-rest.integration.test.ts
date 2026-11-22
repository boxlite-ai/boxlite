import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import {
  ApiKeyCredential,
  BoxliteRestOptions,
  JsBoxlite,
  outboundPolicyFailure,
} from "../lib/index.js";

test.each([
  { denyNet: undefined },
  { denyNet: [] },
  { denyNet: ["example.com"] },
])(
  "complete outbound policy preserves deny presence through native requests (%j)",
  async ({ denyNet }) => {
    const base = "/v1/org/boxes";
    const path = `${base}/complete-box/network/outbound/complete`;
    const snapshot = {
      revision: "r1",
      admission: denyNet === undefined ? "legacy" : "extended_ipv4",
      policy: { mode: "enabled", allow_net: [], deny_net: denyNet ?? [] },
    };
    const updated = { ...snapshot, revision: "r2" };
    const captured: Array<{
      method: string;
      path: string;
      auth?: string;
      ifMatch?: string;
      body?: unknown;
    }> = [];
    let refuseAfterAllocation = false;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      captured.push({
        method: req.method!,
        path: req.url!,
        auth: req.headers.authorization,
        ifMatch: req.headers["if-match"],
        body: text ? JSON.parse(text) : undefined,
      });
      res.setHeader("Content-Type", "application/json");
      switch (`${req.method} ${req.url}`) {
        case "GET /v1/config":
          res.end(
            JSON.stringify({
              capabilities: { complete_outbound_policy_enabled: true },
            }),
          );
          return;
        case `POST ${base}`:
          if (refuseAfterAllocation) {
            res.statusCode = 501;
            res.end(
              JSON.stringify({
                code: "unsupported",
                creation_effect: "allocated",
                box_id: "complete-box",
                message: "Runner refused policy",
              }),
            );
            return;
          }
          res.statusCode = 201;
          res.end(
            JSON.stringify({
              box_id: "complete-box",
              status: "running",
              image: "alpine",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
              cpus: 1,
              memory_mib: 512,
            }),
          );
          return;
        case `GET ${path}`:
          res.setHeader("ETag", '"r1"');
          res.end(JSON.stringify(snapshot));
          return;
        case `PUT ${path}`:
          res.setHeader("ETag", '"r2"');
          res.end(JSON.stringify(updated));
          return;
        case `GET ${path}/status`:
          res.end(
            JSON.stringify({
              persisted: updated,
              runtime_persisted: updated,
              observed: { snapshot: updated, application_state: "confirmed" },
              application_state: "uncertain",
            }),
          );
          return;
        default:
          res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        pathPrefix: "org",
        credential: new ApiKeyCredential("test-token"),
      }),
    );
    try {
      const options = { image: "alpine" };
      const policy = {
        mode: "enabled" as const,
        ...(denyNet === undefined ? {} : { denyNet }),
      };
      await expect(async () =>
        runtime.createWithOutboundPolicy(options, {
          ...policy,
          denyNet: null!,
        }),
      ).rejects.toThrow();
      await expect(async () =>
        runtime.createWithOutboundPolicy(options, {
          ...policy,
          proxy: null,
        } as typeof policy),
      ).rejects.toThrow();
      const hiddenProxy = Object.defineProperty({ ...policy }, "proxy", {
        value: null,
      });
      const symbolField = { ...policy, [Symbol("extra")]: null };
      for (const [input, error] of [
        [hiddenProxy, "unknown outbound policy field proxy"],
        [symbolField, "outbound policy keys must be strings"],
      ] as const) {
        await expect(async () =>
          runtime.createWithOutboundPolicy(options, input),
        ).rejects.toThrow(error);
      }
      expect(captured).toHaveLength(0);
      const box = await runtime.createWithOutboundPolicy(options, policy);
      await expect(async () =>
        box.network.replaceOutboundPolicy(hiddenProxy, "r1"),
      ).rejects.toThrow("unknown outbound policy field proxy");
      const result = await box.network.replaceOutboundPolicy(policy, "r1");
      expect(result.acknowledged.revision).toBe("r2");
      expect(result.status?.application_state).toBe("uncertain");
      expect(result.application_verified).toBe(false);
      expect(
        captured.map((request) => `${request.method} ${request.path}`),
      ).toEqual([
        "GET /v1/config",
        `POST ${base}`,
        `GET ${path}`,
        `GET ${path}`,
        `PUT ${path}`,
        `GET ${path}/status`,
      ]);
      const createBody = captured[1].body as { network: { outbound: object } };
      for (const body of [
        createBody.network.outbound,
        captured[4].body as object,
      ]) {
        expect(Object.hasOwn(body, "deny_net")).toBe(denyNet !== undefined);
        expect(Reflect.get(body, "deny_net")).toEqual(denyNet);
      }
      expect(captured.map((request) => request.auth)).toEqual(
        Array(6).fill("Bearer test-token"),
      );
      expect(captured[4].ifMatch).toBe('"r1"');
      refuseAfterAllocation = true;
      const failure = await runtime
        .createWithOutboundPolicy(options, policy)
        .catch(outboundPolicyFailure);
      expect(failure).toMatchObject({
        effect: "allocated",
        status: 501,
        box_id: "complete-box",
        code: "unsupported",
      });
      expect(
        captured.slice(6).map((request) => `${request.method} ${request.path}`),
      ).toEqual(["GET /v1/config", `POST ${base}`]);
    } finally {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
