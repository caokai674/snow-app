import { beforeEach, describe, expect, it, vi } from "vitest";

const ssh = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  execute: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  readWithVersion: vi.fn(),
  write: vi.fn(),
}));

const remoteJobs = vi.hoisted(() => ({
  cancel: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
}));

const cancelled = (operation: string, sideEffect: "none" | "possible") => ({
  sshOperation: true,
  code: "SSH_OPERATION_CANCELLED",
  operation,
  sideEffect,
  message: "cancelled",
});

vi.mock("./sshManager", () => ({
  connectSsh: ssh.connect,
  disconnectSsh: ssh.disconnect,
  executeSshCommand: ssh.execute,
  listSshDirectory: ssh.list,
  parseSshUrl: (value: string) => ({
    host: "example.test",
    port: 22,
    username: "snow",
    remotePath: value.replace(/^ssh:\/\/[^/]+/, "") || "/",
  }),
  readSshFile: ssh.read,
  readSshFileWithVersion: ssh.readWithVersion,
  writeSshFile: ssh.write,
  isSshOperationError: (error: unknown) =>
    typeof error === "object" && error !== null && "sshOperation" in error,
  toSshOperationErrorResult: (error: ReturnType<typeof cancelled>) => ({
    code: error.code,
    operation: error.operation,
    sideEffect: error.sideEffect,
    message: error.message,
  }),
}));

vi.mock("./sshCredentials", () => ({
  getSshCredential: () => null,
  getDecryptedSecret: () => null,
}));

vi.mock("./remoteJobs", () => ({
  cancelRemoteJob: remoteJobs.cancel,
  getRemoteJob: remoteJobs.get,
  listRemoteJobs: remoteJobs.list,
  startRemoteJob: remoteJobs.start,
}));

import { dispatchRemoteWorkspaceCommand } from "./remoteWorkspaceCommand";

beforeEach(() => {
  vi.clearAllMocks();
  ssh.connect.mockResolvedValue("session-1");
  ssh.execute.mockResolvedValue("");
});

describe("dispatchRemoteWorkspaceCommand cancellation propagation", () => {
  it("passes one signal into connect, Exec and SFTP write, then returns structured uncertainty", async () => {
    const controller = new AbortController();
    ssh.write.mockRejectedValue(cancelled("sftp_write", "possible"));

    const response = await dispatchRemoteWorkspaceCommand(
      {
        operation: "filesystem-create",
        argsJson: JSON.stringify({
          filePath: "ssh://snow@example.test/workspace/new.txt",
          workspaceRoot: "ssh://snow@example.test/workspace",
          content: "new content",
          overwrite: true,
        }),
      },
      { signal: controller.signal }
    );

    expect(ssh.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "example.test" }),
      { signal: controller.signal }
    );
    expect(ssh.execute).toHaveBeenCalledWith(
      "session-1",
      expect.any(String),
      { signal: controller.signal }
    );
    expect(ssh.write).toHaveBeenCalledWith(
      "session-1",
      "/workspace/new.txt",
      "new content",
      {
        signal: controller.signal,
        workspaceRoot: "/workspace",
        expectedVersion: { exists: false },
      }
    );
    expect(JSON.parse(response)).toEqual({
      success: false,
      error: {
        code: "SSH_OPERATION_CANCELLED",
        operation: "sftp_write",
        sideEffect: "possible",
        message: "cancelled",
      },
    });
    expect(ssh.disconnect).toHaveBeenCalledWith("session-1");
  });

  it("does not fall back from a cancelled directory read into file contents", async () => {
    const controller = new AbortController();
    ssh.list.mockRejectedValue(cancelled("sftp_list", "none"));

    const response = await dispatchRemoteWorkspaceCommand(
      {
        operation: "filesystem-read",
        argsJson: JSON.stringify({
          filePath: "ssh://snow@example.test/workspace",
        }),
      },
      { signal: controller.signal }
    );

    expect(ssh.list).toHaveBeenCalledWith("session-1", "/workspace", {
      signal: controller.signal,
    });
    expect(ssh.read).not.toHaveBeenCalled();
    expect(JSON.parse(response)).toMatchObject({
      success: false,
      error: { operation: "sftp_list", sideEffect: "none" },
    });
  });

  it("passes cancellation into Durable Job launch before the backend can start", async () => {
    const controller = new AbortController();
    remoteJobs.start.mockRejectedValue(cancelled("remote_job_start", "none"));
    controller.abort();

    const response = await dispatchRemoteWorkspaceCommand(
      {
        operation: "bash-terminal-execute",
        argsJson: JSON.stringify({
          workingDirectory: "ssh://snow@example.test/workspace",
          command: "npm test",
          durable: true,
        }),
      },
      { signal: controller.signal }
    );

    expect(remoteJobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ command: "npm test" }),
      {
        signal: controller.signal,
        cancellationPolicy: "cancel_remote",
      }
    );
    expect(controller.signal.aborted).toBe(true);
    expect(JSON.parse(response)).toMatchObject({
      success: false,
      error: { operation: "remote_job_start", sideEffect: "none" },
    });
  });

  it("uses the loaded version as an atomic edit precondition and returns its guarantee", async () => {
    const version = {
      exists: true,
      sha256: "a".repeat(64),
      size: 12,
      mtime: 1,
    };
    ssh.readWithVersion.mockResolvedValue({
      content: Buffer.from("before value"),
      version,
    });
    ssh.write.mockResolvedValue({
      guarantee: "atomic_best_effort",
      sideEffect: "committed",
      bytes: 11,
      version: { ...version, sha256: "b".repeat(64), size: 11 },
      durability: { fsynced: true, posixRename: true },
    });

    const response = await dispatchRemoteWorkspaceCommand({
      operation: "filesystem-replace_edit",
      argsJson: JSON.stringify({
        filePath: "ssh://snow@example.test/workspace/document.txt",
        workspaceRoot: "ssh://snow@example.test/workspace",
        searchContent: "before",
        replaceContent: "after",
      }),
    });

    expect(ssh.write).toHaveBeenCalledWith(
      "session-1",
      "/workspace/document.txt",
      "after value",
      {
        signal: undefined,
        workspaceRoot: "/workspace",
        expectedVersion: version,
      }
    );
    expect(JSON.parse(response)).toMatchObject({
      success: true,
      saveGuarantee: "atomic_best_effort",
      sideEffect: "committed",
    });
  });
});
