#!/usr/bin/env node

const { createHash, createPrivateKey, createPublicKey, sign } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const artifact = valueFor("--artifact");
const version = valueFor("--version");
const keyId = valueFor("--key-id");
const output = valueFor("--output");
const publicKeyOutput = valueFor("--public-key-output");
const privateKey = process.env.SNOW_AGENT_RELEASE_SIGNING_KEY;

if (!artifact || !version || !keyId || !output || !privateKey) {
  throw new Error(
    "Usage: SNOW_AGENT_RELEASE_SIGNING_KEY=<pem> node scripts/sign-snow-agent-release.cjs --artifact <path> --version <version> --key-id <id> --output <path> [--public-key-output <path>]"
  );
}

const artifactBytes = readFileSync(resolve(artifact));
const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
const capabilities = {
  transactionalQueue: true,
  processGroups: true,
  resourceLimits: true,
  outputFrames: true,
  fileCas: true,
  interactiveAttach: false,
};
const payload = JSON.stringify({
  protocolVersion: 1,
  version,
  artifactSha256,
  capabilities,
});
const signingKey = createPrivateKey(privateKey);
const signature = sign(null, Buffer.from(payload, "utf8"), signingKey).toString(
  "base64"
);
const manifest = {
  protocolVersion: 1,
  version,
  artifactSha256,
  release: { keyId, payload, signature },
  capabilities,
};

writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (publicKeyOutput) {
  writeFileSync(
    resolve(publicKeyOutput),
    createPublicKey(signingKey).export({ type: "spki", format: "pem" }),
    "utf8"
  );
}
