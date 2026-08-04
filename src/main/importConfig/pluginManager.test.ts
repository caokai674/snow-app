import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeBridge } from "../native/types";
import type { PluginMarketplaceInput, PluginMarketplaceRecord, PluginRecord } from "../../shared/plugins";
import type { PluginImportDefinition } from "./pluginManager";
import {
  addPluginMarketplace,
  commitPluginImports,
  discoverPluginImports,
  installPluginFromMarketplace,
  previewPluginMarketplaceInstall,
  refreshManagedPlugins,
  removePluginMarketplace,
} from "./pluginManager";

const cleanupPaths: string[] = [];
const initialHome = process.env.HOME;
const initialCodexHome = process.env.CODEX_HOME;

const temporaryDirectory = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(path);
  return path;
};

const writeSkill = (directory: string, content: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), content, "utf8");
};

const writeMarketplacePlugin = (root: string): void => {
  const pluginRoot = join(root, "example-plugin");
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(join(root, "marketplace.json"), JSON.stringify({
    name: "example-marketplace",
    plugins: [{ name: "example-plugin", source: "./example-plugin" }],
  }), "utf8");
  writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "Example Plugin",
    version: "1.0.0",
  }), "utf8");
  writeFileSync(join(pluginRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      local: {
        command: "node",
        args: ["--eval", "console.log('mcp')"],
        env: { MCP_TEST_MODE: "preview" },
      },
      remote: {
        url: "https://mcp.example.test/api",
        headers: { "X-Plugin-Source": "example" },
      },
    },
  }), "utf8");
};

const marketplaceInstallNative = (): {
  native: NativeBridge;
  transactions: Array<{ mcpServers: Array<{ name: string; command: string; enabled: boolean }> }>;
} => {
  const native = marketplaceNative();
  const transactions: Array<{ mcpServers: Array<{ name: string; command: string; enabled: boolean }> }> = [];
  (native as unknown as { commitImportTransaction: (input: { mcpServers: Array<{ name: string; command: string; enabled: boolean }> }) => Promise<void> })
    .commitImportTransaction = async (input) => {
      transactions.push(input);
    };
  return { native, transactions };
};

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  if (initialHome === undefined) delete process.env.HOME;
  else process.env.HOME = initialHome;
  if (initialCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = initialCodexHome;
});

const marketplaceNative = (marketplaces: PluginMarketplaceRecord[] = []): NativeBridge => ({
  listPluginMarketplaces: async () => marketplaces,
  listPlugins: async () => [],
  upsertPluginMarketplace: async (input: PluginMarketplaceInput) => {
    const existingIndex = marketplaces.findIndex((item) => item.marketplaceId === input.marketplaceId);
    const previous = existingIndex === -1 ? undefined : marketplaces[existingIndex];
    const record: PluginMarketplaceRecord = {
      ...input,
      addedAt: previous?.addedAt ?? "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    if (existingIndex === -1) marketplaces.push(record);
    else marketplaces[existingIndex] = record;
  },
  deletePluginMarketplace: async (marketplaceId: string) => {
    const index = marketplaces.findIndex((item) => item.marketplaceId === marketplaceId);
    if (index !== -1) marketplaces.splice(index, 1);
  },
} as unknown as NativeBridge);

describe("commitPluginImports", () => {
  it("rolls back an overwritten Plugin Skill when the native import transaction fails", async () => {
    const root = temporaryDirectory("snow-plugin-import-");
    const source = join(root, "source");
    const target = join(root, "managed", "skill");
    writeSkill(source, "new skill");
    writeSkill(target, "old skill");
    const definition: PluginImportDefinition = {
      candidate: {
        type: "plugin",
        provider: "codex",
        scope: "global",
        originPath: source,
        logicalId: "plugin-test",
        contentHash: "plugin-hash",
      },
      input: {
        pluginId: "plugin:test",
        name: "Plugin test",
        version: "1.0.0",
        provider: "codex",
        sourcePath: source,
        manifestPath: join(source, "plugin.json"),
        scope: "global",
        state: "enabled",
        capabilities: [],
        contentHash: "plugin-hash",
        components: [{
          componentId: "skill:test",
          componentType: "skill",
          logicalId: "test",
          targetId: "test",
          targetPath: target,
          originPath: source,
          contentHash: "skill-hash",
          status: "supported",
          sortOrder: 0,
        }],
      },
      runtime: [{
        component: {
          componentId: "skill:test",
          componentType: "skill",
          logicalId: "test",
          targetId: "test",
          targetPath: target,
          originPath: source,
          contentHash: "skill-hash",
          status: "supported",
          sortOrder: 0,
        },
        skillSourceDir: source,
      }],
    };
    const native = {
      listMcpServerConfigs: async () => [],
      listSystemPrompts: async () => [],
      setSkillEnabled: async () => {},
      commitImportTransaction: async () => {
        throw new Error("resource tracking unavailable");
      },
    } as unknown as NativeBridge;

    await expect(commitPluginImports(native, [definition])).rejects.toThrow(
      "Plugin import was rolled back: resource tracking unavailable"
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old skill");
  });
});

describe("Plugin marketplace cache safety", () => {
  it("rejects Marketplace and Plugin names that normalize to path traversal segments", async () => {
    const root = temporaryDirectory("snow-marketplace-manifest-");
    const manifestPath = join(root, "marketplace.json");
    const native = marketplaceNative();

    writeFileSync(manifestPath, JSON.stringify({ name: ".", plugins: [] }), "utf8");
    await expect(addPluginMarketplace(native, root)).rejects.toThrow("Marketplace name must not resolve");

    writeFileSync(manifestPath, JSON.stringify({ name: "valid-marketplace", plugins: [{ name: ".\\", source: "./plugin" }] }), "utf8");
    await expect(addPluginMarketplace(native, root)).rejects.toThrow("Plugin name must not resolve");
  });

  it("isolates remote caches by source and removes only its strict descendant", async () => {
    const home = temporaryDirectory("snow-marketplace-home-");
    process.env.HOME = home;
    const native = marketplaceNative();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => new Response(JSON.stringify({
      name: input.toString().endsWith("one.json") ? "one-marketplace" : "two-marketplace",
      plugins: [],
    }));
    try {
      await addPluginMarketplace(native, "https://marketplace.example/one.json");
      await addPluginMarketplace(native, "https://marketplace.example/two.json");
      await addPluginMarketplace(native, "https://marketplace.example/one.json");
      const marketplaces = await native.listPluginMarketplaces();
      const marketplace = marketplaces.find((item) => item.sourcePath.endsWith("one.json"))!;
      const firstCachePath = marketplace.cachePath as string;
      const secondCachePath = marketplaces.find((item) => item.sourcePath.endsWith("two.json"))!.cachePath as string;

      expect(basename(firstCachePath)).not.toBe("one-marketplace");
      expect(secondCachePath).not.toBe(firstCachePath);
      expect(marketplace.marketplaceId).not.toContain("one-marketplace");
      expect(existsSync(firstCachePath)).toBe(true);
      expect(existsSync(secondCachePath)).toBe(true);

      await removePluginMarketplace(native, marketplace.marketplaceId);
      expect(existsSync(firstCachePath)).toBe(false);
      expect(existsSync(secondCachePath)).toBe(true);
      expect(existsSync(join(home, ".snow", "plugin-marketplaces"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requires removing a same-named Marketplace before a different source can replace it", async () => {
    const home = temporaryDirectory("snow-marketplace-home-");
    process.env.HOME = home;
    const native = marketplaceNative();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "shared-marketplace", plugins: [] }));
    try {
      await addPluginMarketplace(native, "https://marketplace.example/one.json");
      const [original] = await native.listPluginMarketplaces();

      await expect(addPluginMarketplace(native, "https://marketplace.example/two.json")).rejects.toThrow(
        "Remove that marketplace and confirm its removal"
      );

      expect(await native.listPluginMarketplaces()).toEqual([original]);
      expect(existsSync(original.cachePath as string)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("derives the same Marketplace ID from equivalent normalized source URLs", async () => {
    const native = marketplaceNative();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ name: "canonical-marketplace", plugins: [] }));
    try {
      await addPluginMarketplace(native, "https://marketplace.example/marketplace.json#fragment");
      const [first] = await native.listPluginMarketplaces();
      await addPluginMarketplace(native, "https://marketplace.example/marketplace.json");
      const [second] = await native.listPluginMarketplaces();

      expect(await native.listPluginMarketplaces()).toHaveLength(1);
      expect(second.marketplaceId).toBe(first.marketplaceId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an oversized declared response before reading its body", async () => {
    const native = marketplaceNative();
    const originalFetch = globalThis.fetch;
    let bodyRead = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true;
        controller.enqueue(new Uint8Array([123]));
        controller.close();
      },
    }, { highWaterMark: 0 });
    globalThis.fetch = async () => new Response(body, {
      headers: { "content-length": String(2 * 1024 * 1024 + 1) },
    });
    try {
      await expect(addPluginMarketplace(native, "https://marketplace.example/oversized.json")).rejects.toThrow(
        "Marketplace manifest exceeds the 2 MB limit"
      );
      expect(bodyRead).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces the byte limit while streaming a response without Content-Length", async () => {
    const native = marketplaceNative();
    const originalFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array([123]));
        controller.close();
      },
    });
    globalThis.fetch = async () => new Response(body);
    try {
      await expect(addPluginMarketplace(native, "https://marketplace.example/streamed.json")).rejects.toThrow(
        "Marketplace manifest exceeds the 2 MB limit"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("never deletes the Marketplace cache root", async () => {
    const home = temporaryDirectory("snow-marketplace-home-");
    process.env.HOME = home;
    const cacheRoot = join(home, ".snow", "plugin-marketplaces");
    mkdirSync(cacheRoot, { recursive: true });
    const marker = join(cacheRoot, "keep");
    writeFileSync(marker, "keep", "utf8");
    const native = marketplaceNative([{
      marketplaceId: "marketplace:malformed",
      name: "malformed",
      displayName: "Malformed",
      description: "",
      sourceType: "url",
      sourcePath: "https://marketplace.example/marketplace.json",
      cachePath: cacheRoot,
      manifestPath: join(cacheRoot, "marketplace.json"),
      contentHash: "hash",
      addedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]);

    await removePluginMarketplace(native, "marketplace:malformed");

    expect(existsSync(marker)).toBe(true);
    expect(await native.listPluginMarketplaces()).toEqual([]);
  });
});

describe("Marketplace MCP authorization", () => {
  it("shows the executable declaration and installs every MCP disabled by default", async () => {
    const root = temporaryDirectory("snow-marketplace-plugin-");
    const home = temporaryDirectory("snow-marketplace-home-");
    process.env.HOME = home;
    writeMarketplacePlugin(root);
    const { native, transactions } = marketplaceInstallNative();
    await addPluginMarketplace(native, root);
    const [marketplace] = await native.listPluginMarketplaces();

    const preview = await previewPluginMarketplaceInstall(native, marketplace.marketplaceId, "example-plugin");

    expect(preview.marketplaceSource).toBe(root);
    expect(preview.pluginSource).toBe(join(root, "example-plugin"));
    expect(preview.mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Example Plugin/local",
        command: "node",
        args: ["--eval", "console.log('mcp')"],
        env: { MCP_TEST_MODE: "preview" },
        url: "",
      }),
      expect.objectContaining({
        name: "Example Plugin/remote",
        command: "",
        url: "https://mcp.example.test/api",
        headers: { "X-Plugin-Source": "example" },
      }),
    ]));

    await installPluginFromMarketplace(native, marketplace.marketplaceId, "example-plugin", []);

    expect(transactions).toHaveLength(1);
    expect(transactions[0].mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Example Plugin/local", command: "node", enabled: false }),
      expect.objectContaining({ name: "Example Plugin/remote", command: "", enabled: false }),
    ]));
  });

  it("enables only MCP components whose reviewed declaration was explicitly approved", async () => {
    const root = temporaryDirectory("snow-marketplace-plugin-");
    const home = temporaryDirectory("snow-marketplace-home-");
    process.env.HOME = home;
    writeMarketplacePlugin(root);
    const { native, transactions } = marketplaceInstallNative();
    await addPluginMarketplace(native, root);
    const [marketplace] = await native.listPluginMarketplaces();
    const preview = await previewPluginMarketplaceInstall(native, marketplace.marketplaceId, "example-plugin");
    const local = preview.mcpServers.find((item) => item.command === "node");
    expect(local).toBeDefined();

    await installPluginFromMarketplace(native, marketplace.marketplaceId, "example-plugin", [{
      componentId: local!.componentId,
      approvalHash: local!.approvalHash,
    }]);

    expect(transactions[0].mcpServers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Example Plugin/local", enabled: true }),
      expect.objectContaining({ name: "Example Plugin/remote", enabled: false }),
    ]));
  });

  it("rejects a reviewed approval when the Marketplace changes the MCP command", async () => {
    const root = temporaryDirectory("snow-marketplace-plugin-");
    const home = temporaryDirectory("snow-marketplace-home-");
    process.env.HOME = home;
    writeMarketplacePlugin(root);
    const { native, transactions } = marketplaceInstallNative();
    await addPluginMarketplace(native, root);
    const [marketplace] = await native.listPluginMarketplaces();
    const preview = await previewPluginMarketplaceInstall(native, marketplace.marketplaceId, "example-plugin");
    const local = preview.mcpServers.find((item) => item.command === "node");
    writeFileSync(join(root, "example-plugin", ".mcp.json"), JSON.stringify({
      mcpServers: {
        local: { command: "sh", args: ["-c", "unexpected command"] },
      },
    }), "utf8");

    await expect(installPluginFromMarketplace(native, marketplace.marketplaceId, "example-plugin", [{
      componentId: local!.componentId,
      approvalHash: local!.approvalHash,
    }])).rejects.toThrow("Marketplace MCP declaration changed");
    expect(transactions).toHaveLength(0);
  });
});

describe("Plugin source recovery", () => {
  it("restores the persisted enabled or disabled intent when the source hash recovers", async () => {
    const home = temporaryDirectory("snow-plugin-home-");
    const codexHome = temporaryDirectory("snow-plugin-codex-");
    process.env.HOME = home;
    process.env.CODEX_HOME = codexHome;
    const pluginRoot = join(codexHome, "plugins", "recovery-plugin");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "Recovery Plugin",
      version: "1.0.0",
    }), "utf8");

    const discoveryNative = {
      listWorkspaceDirectories: async () => [],
    } as unknown as NativeBridge;
    const [definition] = await discoverPluginImports(discoveryNative);
    expect(definition).toBeDefined();
    const plugin: PluginRecord = {
      ...definition!.input,
      state: "update-available",
      desiredState: "disabled",
      importedAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
      components: definition!.input.components,
    };
    const stateChanges: string[] = [];
    const native = {
      listWorkspaceDirectories: async () => [],
      listPlugins: async () => [plugin],
      setPluginState: async (_pluginId: string, state: PluginRecord["state"]) => {
        plugin.state = state;
        stateChanges.push(state);
      },
    } as unknown as NativeBridge;

    await refreshManagedPlugins(native);
    plugin.state = "broken";
    plugin.desiredState = "enabled";
    await refreshManagedPlugins(native);

    expect(stateChanges).toEqual(["disabled", "enabled"]);
  });
});
