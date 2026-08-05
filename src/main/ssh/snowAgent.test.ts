import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseSnowAgentHandshake,
  verifySnowAgentHandshake,
  type SnowAgentCapabilities,
} from "./snowAgent";

const capabilities: SnowAgentCapabilities = {
  transactionalQueue: true,
  processGroups: true,
  resourceLimits: true,
  outputFrames: true,
  fileCas: true,
  interactiveAttach: true,
};

const artifactSha256 = "9c2ef76816de91f1d86574f96d119f648b14ded5d4aa23fab5731c89d71224d7";

const signedHandshake = (): {
  handshake: ReturnType<typeof parseSnowAgentHandshake>;
  publicKey: string;
} => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = JSON.stringify({
    protocolVersion: 1,
    version: "1.2.3",
    artifactSha256,
    capabilities,
  });
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString(
    "base64"
  );
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    handshake: parseSnowAgentHandshake({
      protocolVersion: 1,
      version: "1.2.3",
      artifactSha256,
      release: { keyId: "test", payload, signature },
      capabilities,
    }),
  };
};

describe("snow-agent protocol negotiation", () => {
  it("accepts a matching Ed25519 signed capability declaration", () => {
    const { handshake, publicKey } = signedHandshake();
    expect(() => verifySnowAgentHandshake(handshake, publicKey)).not.toThrow();
  });

  it("rejects a handshake whose displayed version differs from its signed declaration", () => {
    const { handshake, publicKey } = signedHandshake();
    const tampered = { ...handshake, version: "9.9.9" };
    expect(() => verifySnowAgentHandshake(tampered, publicKey)).toThrow(
      "does not match"
    );
  });

  it("rejects a release that omits transactional file CAS", () => {
    expect(() =>
      parseSnowAgentHandshake({
        protocolVersion: 1,
        version: "1.2.3",
        artifactSha256,
        release: { keyId: "test", payload: "{}", signature: "AA==" },
        capabilities: { ...capabilities, fileCas: false },
      })
    ).toThrow("missing required durable-job capabilities");
  });
});
