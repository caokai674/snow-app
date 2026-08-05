import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const hostKeys = vi.hoisted(() => new Map<string, string>());

vi.mock("./sshHostKeys", () => ({
  getSshHostKey: (host: string, port: number) => {
    const fingerprint = hostKeys.get(`${host}:${port}`);
    return fingerprint
      ? { host, port, fingerprint, trustedAt: "2026-01-01T00:00:00.000Z" }
      : null;
  },
  saveSshHostKey: (params: {
    host: string;
    port: number;
    fingerprint: string;
  }) => {
    hostKeys.set(`${params.host}:${params.port}`, params.fingerprint);
    return { ...params, trustedAt: "2026-01-01T00:00:00.000Z" };
  },
}));

import {
  connectSsh,
  disconnectAllSsh,
  executeSshCommand,
  listSshDirectory,
  readSshFile,
  setSshClientFactoryForTesting,
  writeSshFile,
} from "./sshManager";

type ExecCallback = (
  error: Error | undefined,
  channel: FakeChannel
) => void;

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  closeCalls = 0;

  signal(signal: string): void {
    this.signals.push(signal);
  }

  close(): void {
    this.closeCalls += 1;
  }
}

class FakeReadStream extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  read(): void {
    // The production code starts flowing mode explicitly.
  }
}

class FakeSftp {
  readonly readStream = new FakeReadStream();
  readonly handle = Buffer.from("fake-handle");
  handleWriteCount = 0;
  onHandleWrite: (() => void) | undefined;
  readdirCallback:
    | ((error: Error | undefined, list: Array<unknown>) => void)
    | undefined;

  readdir(
    _path: string,
    callback: (error: Error | undefined, list: Array<unknown>) => void
  ): void {
    this.readdirCallback = callback;
  }

  createReadStream(): FakeReadStream {
    return this.readStream;
  }

  lstat(
    _path: string,
    callback: (error: Error | undefined, stats: unknown) => void
  ): void {
    const error = Object.assign(new Error("No such file"), { code: 2 });
    queueMicrotask(() => callback(error, undefined));
  }

  open(
    _path: string,
    _mode: string,
    attributesOrCallback:
      | { mode: number }
      | ((error: Error | undefined, handle: Buffer) => void),
    callback?: (error: Error | undefined, handle: Buffer) => void
  ): void {
    const done =
      typeof attributesOrCallback === "function" ? attributesOrCallback : callback;
    if (!done) {
      throw new Error("Missing SFTP open callback");
    }
    queueMicrotask(() => done(undefined, this.handle));
  }

  write(
    _handle: Buffer,
    _data: Buffer,
    _offset: number,
    _length: number,
    _position: number,
    callback: (error?: Error) => void
  ): void {
    this.handleWriteCount += 1;
    this.onHandleWrite?.();
    queueMicrotask(() => callback());
  }

  fchmod(
    _handle: Buffer,
    _mode: number,
    callback: (error?: Error) => void
  ): void {
    queueMicrotask(() => callback());
  }

  ext_openssh_fsync(
    _handle: Buffer,
    callback: (error?: Error) => void
  ): void {
    queueMicrotask(() => callback());
  }

  close(_handle: Buffer, callback: (error?: Error) => void): void {
    queueMicrotask(() => callback());
  }

  unlink(_path: string, callback: (error?: Error) => void): void {
    queueMicrotask(() => callback());
  }

  ext_openssh_rename(
    _oldPath: string,
    _newPath: string,
    callback: (error?: Error) => void
  ): void {
    queueMicrotask(() => callback());
  }

  rename(
    _oldPath: string,
    _newPath: string,
    callback: (error?: Error) => void
  ): void {
    queueMicrotask(() => callback());
  }

  end(): void {
    // No-op for the fake transport.
  }
}

class FakeClient extends EventEmitter {
  readonly sftpWrapper = new FakeSftp();
  fingerprint = "fingerprint-a";
  connectConfig: Record<string, unknown> | undefined;
  execCallback: ExecCallback | undefined;
  ended = false;

  connect(config: Record<string, unknown>): void {
    this.connectConfig = config;
    const verifier = config.hostVerifier as
      | ((fingerprint: string) => boolean)
      | undefined;
    const accepted = verifier?.(this.fingerprint) ?? true;
    queueMicrotask(() => {
      if (!accepted) {
        this.emit("error", new Error("Host denied"));
        return;
      }
      this.emit("ready");
    });
  }

  sftp(
    callback: (error: Error | undefined, sftp: FakeSftp) => void
  ): void {
    queueMicrotask(() => callback(undefined, this.sftpWrapper));
  }

  exec(_command: string, callback: ExecCallback): void {
    this.execCallback = callback;
  }

  end(): void {
    this.ended = true;
  }
}

const clients: FakeClient[] = [];
const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

const connectFake = async (): Promise<{ sessionId: string; client: FakeClient }> => {
  const sessionId = await connectSsh({
    host: "ssh.example.test",
    port: 22,
    username: "snow",
    authMethod: "password",
    password: "test",
  });
  const client = clients.at(-1);
  if (!client) {
    throw new Error("Expected a fake SSH client");
  }
  return { sessionId, client };
};

afterEach(() => {
  disconnectAllSsh();
  hostKeys.clear();
  clients.splice(0);
  setSshClientFactoryForTesting();
  if (originalSshAuthSock) {
    process.env.SSH_AUTH_SOCK = originalSshAuthSock;
  } else {
    delete process.env.SSH_AUTH_SOCK;
  }
});

describe("sshManager cancellation and host identity", () => {
  it("closes a channel that arrives after cancellation", async () => {
    setSshClientFactoryForTesting(() => {
      const client = new FakeClient();
      clients.push(client);
      return client as never;
    });
    const { sessionId, client } = await connectFake();
    const controller = new AbortController();
    const pending = executeSshCommand(sessionId, "sleep 30", {
      signal: controller.signal,
    });

    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "SSH_COMMAND_CANCELLED",
      sideEffect: "possible",
      remoteProcessTermination: "unconfirmed",
    });

    const delayedChannel = new FakeChannel();
    client.execCallback?.(undefined, delayedChannel);
    expect(delayedChannel.signals).toEqual(["KILL"]);
    expect(delayedChannel.closeCalls).toBe(1);
  });

  it("stops SFTP reads and directory callbacks after cancellation", async () => {
    setSshClientFactoryForTesting(() => {
      const client = new FakeClient();
      clients.push(client);
      return client as never;
    });
    const { sessionId, client } = await connectFake();

    const readAbort = new AbortController();
    const read = readSshFile(sessionId, "/large.log", {
      signal: readAbort.signal,
    });
    client.sftpWrapper.readStream.emit("data", Buffer.from("partial"));
    readAbort.abort();
    await expect(read).rejects.toMatchObject({
      code: "SSH_OPERATION_CANCELLED",
      operation: "sftp_read",
      sideEffect: "none",
    });
    expect(client.sftpWrapper.readStream.destroyed).toBe(true);

    const listAbort = new AbortController();
    const listing = listSshDirectory(sessionId, "/workspace", {
      signal: listAbort.signal,
    });
    listAbort.abort();
    client.sftpWrapper.readdirCallback?.(undefined, []);
    await expect(listing).rejects.toMatchObject({
      code: "SSH_OPERATION_CANCELLED",
      operation: "sftp_list",
    });
  });

  it("does not schedule another SFTP write chunk after cancellation", async () => {
    setSshClientFactoryForTesting(() => {
      const client = new FakeClient();
      clients.push(client);
      return client as never;
    });
    const { sessionId, client } = await connectFake();
    const controller = new AbortController();
    client.sftpWrapper.onHandleWrite = () => controller.abort();

    const write = writeSshFile(
      sessionId,
      "/workspace/large.txt",
      Buffer.alloc(256 * 1024),
      { signal: controller.signal }
    );

    await expect(write).rejects.toMatchObject({
      code: "SSH_OPERATION_CANCELLED",
      operation: "sftp_atomic_write",
      sideEffect: "none",
    });
    expect(client.sftpWrapper.handleWriteCount).toBe(1);
  });

  it("uses SSH_AUTH_SOCK and pins the first observed host fingerprint", async () => {
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    setSshClientFactoryForTesting(() => {
      const client = new FakeClient();
      clients.push(client);
      return client as never;
    });

    await connectSsh({
      host: "ssh.example.test",
      port: 2222,
      username: "snow",
      authMethod: "agent",
    });

    expect(clients[0].connectConfig?.agent).toBe("/tmp/ssh-agent.sock");
    expect(hostKeys.get("ssh.example.test:2222")).toBe("fingerprint-a");
  });

  it("blocks a changed host fingerprint unless replacement was confirmed", async () => {
    hostKeys.set("ssh.example.test:22", "fingerprint-old");
    setSshClientFactoryForTesting(() => {
      const client = new FakeClient();
      client.fingerprint = "fingerprint-new";
      clients.push(client);
      return client as never;
    });

    await expect(
      connectSsh({
        host: "ssh.example.test",
        port: 22,
        username: "snow",
        authMethod: "password",
        password: "test",
      })
    ).rejects.toMatchObject({ code: "SSH_HOST_KEY_CHANGED" });

    await connectSsh({
      host: "ssh.example.test",
      port: 22,
      username: "snow",
      authMethod: "password",
      password: "test",
      hostKeyPolicy: "replace",
    });
    expect(hostKeys.get("ssh.example.test:22")).toBe("fingerprint-new");
  });
});
