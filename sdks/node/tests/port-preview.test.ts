import { describe, expect, test } from "vitest";
import type {
  JsBox,
  PortPreviewUrl,
  SignedPortPreviewUrl,
} from "../lib/index.js";

describe("port preview SDK contract", () => {
  test("JsBox exposes port preview methods", async () => {
    const preview: PortPreviewUrl = {
      boxId: "box123",
      url: "https://3000-box123.proxy.example.test/",
      token: "tok",
    };
    const signed: SignedPortPreviewUrl = {
      boxId: "box123",
      port: 3000,
      url: "https://3000-signed.proxy.example.test/",
      token: "signed",
    };

    const box: Pick<
      JsBox,
      "portPreviewUrl" | "signedPortPreviewUrl" | "expireSignedPortPreviewUrl"
    > = {
      portPreviewUrl: async () => preview,
      signedPortPreviewUrl: async () => signed,
      expireSignedPortPreviewUrl: async () => undefined,
    };

    await expect(box.portPreviewUrl(3000)).resolves.toEqual(preview);
    await expect(box.signedPortPreviewUrl(3000, 60)).resolves.toEqual(signed);
    await expect(
      box.expireSignedPortPreviewUrl(3000, "signed"),
    ).resolves.toBeUndefined();
  });
});
