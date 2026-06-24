import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcClient, type RpcSpawnTarget } from "../src/gateway-rpc.js";

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget(): RpcSpawnTarget {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("PiRpcClient steering and approval commands", () => {
  it("steer sends a steering message and resolves after the ack", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      // The fake Pi acks steer with success. No throw means success.
      await client.steer("actually, wait");
    } finally {
      await client.stop();
    }
  });

  it("followUp sends a follow-up message and resolves after the ack", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      await client.followUp("and then do this");
    } finally {
      await client.stop();
    }
  });

  it("emits a queue_update event after a prompt", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("Hello");
      expect(events.some((e) => e.type === "queue_update")).toBe(true);
    } finally {
      await client.stop();
    }
  });

  it("emits an extension_ui_request event when the message contains 'approve'", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const events = await client.promptAndWait("please approve this action");
      const uiRequest = events.find((e) => e.type === "extension_ui_request");
      expect(uiRequest).toBeDefined();
      expect(typeof uiRequest?.id).toBe("string");
      expect(uiRequest?.method).toBe("confirm");
    } finally {
      await client.stop();
    }
  });

  it("respondToUiRequest writes a response to stdin without hanging", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      // Start a prompt that triggers an approval request.
      const uiRequestPromise = new Promise<string>((resolve) => {
        client.onEvent((event) => {
          if (event.type === "extension_ui_request" && typeof event.id === "string") {
            resolve(event.id as string);
          }
        });
      });
      void client.prompt("please approve this").catch(() => {});
      const requestId = await uiRequestPromise;

      // Respond with confirmed: true. This must not hang (no ack is expected).
      await client.respondToUiRequest(requestId, { confirmed: true });
    } finally {
      await client.stop();
    }
  });

  it("respondToUiRequest can cancel an approval", async () => {
    const client = new PiRpcClient(fakePiTarget());
    try {
      await client.start();
      const uiRequestPromise = new Promise<string>((resolve) => {
        client.onEvent((event) => {
          if (event.type === "extension_ui_request" && typeof event.id === "string") {
            resolve(event.id as string);
          }
        });
      });
      void client.prompt("please approve this").catch(() => {});
      const requestId = await uiRequestPromise;

      await client.respondToUiRequest(requestId, { cancelled: true });
    } finally {
      await client.stop();
    }
  });
});
