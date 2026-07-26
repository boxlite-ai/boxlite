import { createServer, type IncomingMessage, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions } from "../lib/index.js";
import type { JsBox } from "../lib/native-contracts.js";

// These drive the real napi binding against a local stub of the hosted REST
// API, so the certificate JSON fixture, the request the SDK sends, the
// generated key pair and the redaction guarantees are exercised end to end.
//
// The fixture is the shared cross-SDK shape from `openapi/box.openapi.yaml`
// (`SshCertificateCredential`) — the same one the Python suite uses.

const BOX_ID = "box-1";
const CERTIFICATES_PATH = `/v1/boxes/${BOX_ID}/ssh-access/certificates`;

const CERTIFICATE_FIXTURE = {
  id: "sshcred-1",
  box_id: BOX_ID,
  certificate: "ssh-ed25519-cert-v01@openssh.com AAAACERT",
  public_key: "ssh-ed25519 AAAAPUB",
  fingerprint: "SHA256:kEyF1nGeRpRiNt",
  serial: "42",
  ca_key_id: "ca-2026-07",
  valid_after: "2026-07-25T12:00:00Z",
  expires_at: "2026-07-25T12:05:00Z",
  revoked_at: null,
  host: "22-d-abc.direct.example.com",
  port: 22,
  ssh_command:
    "ssh -i id -o CertificateFile=id-cert.pub root@22-d-abc.direct.example.com",
  proxy_command: "proxytunnel -p gateway.example.com:443",
  known_hosts: "[22-d-abc.direct.example.com]:22 ssh-ed25519 AAAAHOST",
  created_at: "2026-07-25T12:00:00Z",
  updated_at: "2026-07-25T12:00:00Z",
};

const BOX_FIXTURE = {
  box_id: BOX_ID,
  name: "demo",
  status: "running",
  created_at: "2026-07-25T11:59:00Z",
  updated_at: "2026-07-25T11:59:30Z",
  pid: null,
  image: "alpine:latest",
  cpus: 1,
  memory_mib: 512,
  labels: {},
};

interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** Minimal stand-in for the hosted REST API's certificate endpoints. */
class StubHostedApi {
  readonly requests: RecordedRequest[] = [];
  /** Mutable so a test can vary one field of the shared fixture. */
  certificate: Record<string, unknown> = { ...CERTIFICATE_FIXTURE };
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  get url(): string {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub server is not listening on a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  onlyRequest(method: string, pathPrefix: string): RecordedRequest {
    const matches = this.requests.filter(
      (r) => r.method === method && r.path.startsWith(pathPrefix),
    );
    expect(matches, `${method} ${pathPrefix}`).toHaveLength(1);
    return matches[0]!;
  }

  private async handle(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const path = req.url ?? "";
    this.requests.push({
      method: req.method ?? "",
      path,
      body: raw ? JSON.parse(raw) : null,
    });

    const respond = (status: number, payload: unknown) => {
      if (payload === undefined) {
        res.writeHead(status);
        res.end();
        return;
      }
      const encoded = JSON.stringify(payload);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(encoded),
      });
      res.end(encoded);
    };

    if (req.method === "GET" && path === `/v1/boxes/${BOX_ID}`) {
      respond(200, BOX_FIXTURE);
    } else if (req.method === "GET" && path.startsWith(CERTIFICATES_PATH)) {
      respond(200, { certificates: [this.certificate] });
    } else if (req.method === "POST" && path.startsWith(CERTIFICATES_PATH)) {
      respond(201, this.certificate);
    } else if (req.method === "DELETE") {
      respond(204, undefined);
    } else {
      respond(404, { error: { message: "not found" } });
    }
  }
}

describe("box.sshCertificates", () => {
  let api: StubHostedApi;
  let runtime: ReturnType<typeof JsBoxlite.rest>;

  beforeEach(async () => {
    api = new StubHostedApi();
    await api.start();
    runtime = JsBoxlite.rest(new BoxliteRestOptions({ url: api.url }));
  });

  afterEach(async () => {
    runtime.close();
    await api.stop();
  });

  const hostedBox = async (): Promise<JsBox> => {
    const box = await runtime.get(BOX_ID);
    expect(box).not.toBeNull();
    return box!;
  };

  test("create parses the shared fixture", async () => {
    const box = await hostedBox();

    const credential = await box.sshCertificates.create(
      "ssh-ed25519 AAAAPUB",
      15,
    );

    expect(credential).toEqual({
      id: "sshcred-1",
      boxId: BOX_ID,
      certificate: "ssh-ed25519-cert-v01@openssh.com AAAACERT",
      publicKey: "ssh-ed25519 AAAAPUB",
      fingerprint: "SHA256:kEyF1nGeRpRiNt",
      serial: "42",
      caKeyId: "ca-2026-07",
      validAfter: "2026-07-25T12:00:00Z",
      expiresAt: "2026-07-25T12:05:00Z",
      host: "22-d-abc.direct.example.com",
      port: 22,
      sshCommand:
        "ssh -i id -o CertificateFile=id-cert.pub root@22-d-abc.direct.example.com",
      proxyCommand: "proxytunnel -p gateway.example.com:443",
      knownHosts: "[22-d-abc.direct.example.com]:22 ssh-ed25519 AAAAHOST",
      createdAt: "2026-07-25T12:00:00Z",
      updatedAt: "2026-07-25T12:00:00Z",
    });

    // napi maps the core `Option::None` to an absent property, not null.
    expect(credential.revokedAt).toBeUndefined();

    const request = api.onlyRequest("POST", CERTIFICATES_PATH);
    expect(request.body).toEqual({ public_key: "ssh-ed25519 AAAAPUB" });
    expect(request.path).toContain("expiresInMinutes=15");
  });

  test("create without a ttl leaves the policy default", async () => {
    const box = await hostedBox();

    await box.sshCertificates.create("ssh-ed25519 AAAAPUB");

    expect(api.onlyRequest("POST", CERTIFICATES_PATH).path).not.toContain(
      "expiresInMinutes",
    );
  });

  // The wire encodes serial as a string so uint64 values stay exact; a JS
  // number cannot hold this one.
  test("serial above 2^53 survives exactly", async () => {
    const huge = "18446744073709551615"; // u64::MAX
    api.certificate = { ...CERTIFICATE_FIXTURE, serial: huge };
    const box = await hostedBox();

    const credential = await box.sshCertificates.create("ssh-ed25519 AAAAPUB");

    expect(credential.serial).toBe(huge);
    // Had the binding surfaced a JS number, this is what would have come back.
    expect(String(Number(huge))).not.toBe(huge);
  });

  test("a revoked credential carries its revocation timestamp", async () => {
    api.certificate = {
      ...CERTIFICATE_FIXTURE,
      revoked_at: "2026-07-25T12:03:00Z",
    };
    const box = await hostedBox();

    const credential = await box.sshCertificates.create("ssh-ed25519 AAAAPUB");

    expect(credential.revokedAt).toBe("2026-07-25T12:03:00Z");
  });

  test("list returns public metadata", async () => {
    const box = await hostedBox();

    const credentials = await box.sshCertificates.list();

    expect(credentials.map((c) => c.id)).toEqual(["sshcred-1"]);
    expect(credentials[0]!.fingerprint).toBe("SHA256:kEyF1nGeRpRiNt");
  });

  test("revoke targets the credential id", async () => {
    const box = await hostedBox();

    await box.sshCertificates.revoke("sshcred-1");

    expect(api.onlyRequest("DELETE", CERTIFICATES_PATH).path).toBe(
      `${CERTIFICATES_PATH}/sshcred-1`,
    );
  });

  test("issue sends only a locally generated public key", async () => {
    const box = await hostedBox();

    const bundle = await box.sshCertificates.issue();

    const body = api.onlyRequest("POST", CERTIFICATES_PATH).body!;
    expect(Object.keys(body)).toEqual(["public_key"]);
    expect(body.public_key as string).toMatch(/^ssh-ed25519 /);
    expect(bundle.exposePrivateKey()).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----/,
    );
    expect(bundle.credential.id).toBe("sshcred-1");
  });

  test("each issue generates a distinct key", async () => {
    const box = await hostedBox();

    const first = await box.sshCertificates.issue();
    const second = await box.sshCertificates.issue();

    expect(first.exposePrivateKey()).not.toBe(second.exposePrivateKey());
  });

  test("no default representation leaks the private key", async () => {
    const box = await hostedBox();

    const bundle = await box.sshCertificates.issue();
    const secret = bundle.exposePrivateKey();
    // The key body without the PEM banner — the part that must never leak.
    const secretBody = secret.split("\n")[1]!;

    const renderings = [
      JSON.stringify(bundle),
      String(bundle),
      `${bundle}`,
      inspect(bundle),
      inspect(bundle, { depth: null }),
      JSON.stringify(bundle.credential),
    ];
    for (const rendered of renderings) {
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain(secretBody);
      expect(rendered).not.toContain("PRIVATE KEY");
    }

    // Redaction is targeted: the public half stays serializable.
    const serialized = JSON.parse(JSON.stringify(bundle));
    expect(serialized.privateKey).toBe("[REDACTED]");
    expect(serialized.credential.id).toBe("sshcred-1");
  });

  // Matches the Python suite's guard: OpenSSH is not a build dependency of
  // this SDK, and `execFileSync` would fail the run with ENOENT without it.
  const hasSshKeygen = (() => {
    try {
      execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ENOENT";
    }
  })();

  test.skipIf(!hasSshKeygen)(
    "ssh-keygen derives the submitted public key from the generated key",
    async () => {
      const box = await hostedBox();

      const bundle = await box.sshCertificates.issue();
      const submitted = api.onlyRequest("POST", CERTIFICATES_PATH).body!
        .public_key as string;

      const workdir = mkdtempSync(join(tmpdir(), "boxlite-ssh-cert-"));
      try {
        const keyPath = join(workdir, "id_ed25519");
        writeFileSync(keyPath, bundle.exposePrivateKey(), { mode: 0o600 });
        const derived = execFileSync("ssh-keygen", ["-y", "-f", keyPath], {
          encoding: "utf8",
        }).trim();

        // `ssh-keygen -y` prints "<type> <base64>"; the SDK may append a comment.
        expect(derived.split(" ").slice(0, 2)).toEqual(
          submitted.split(" ").slice(0, 2),
        );
        expect(derived).toMatch(/^ssh-ed25519 /);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    },
  );
});
