import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDirectoryCommit } from "./directoryCommit";

const cleanupPaths: string[] = [];

const temporaryDirectory = (parent: string, prefix: string): string => {
  const path = mkdtempSync(join(parent, prefix));
  cleanupPaths.push(path);
  return path;
};

const writeSkill = (directory: string, content: string): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), content, "utf8");
};

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("prepareDirectoryCommit", () => {
  it("copies a /dev/shm source into a target-local staging directory", () => {
    const sourceRoot = process.platform === "linux"
      ? temporaryDirectory("/dev/shm", "snow-directory-commit-")
      : temporaryDirectory(tmpdir(), "snow-directory-commit-");
    const targetRoot = temporaryDirectory(process.cwd(), ".snow-directory-commit-");
    const source = join(sourceRoot, "source-skill");
    const target = join(targetRoot, "installed-skill");
    writeSkill(source, "new skill");

    if (process.platform === "linux") {
      expect(statSync(sourceRoot).dev).not.toBe(statSync(targetRoot).dev);
    }

    const transaction = prepareDirectoryCommit(source, target);
    transaction.commit();
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("new skill");
    transaction.cleanup();
    expect(existsSync(transaction.stagingRoot)).toBe(false);
  });

  it("restores a replaced target when the caller rolls back", () => {
    const root = temporaryDirectory(tmpdir(), "snow-directory-commit-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeSkill(source, "new skill");
    writeSkill(target, "old skill");

    const transaction = prepareDirectoryCommit(source, target);
    transaction.commit();
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("new skill");
    transaction.rollback();
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("old skill");
    transaction.cleanup();
    expect(existsSync(transaction.stagingRoot)).toBe(false);
  });

  it("rejects a target that appears after selected-import staging", () => {
    const root = temporaryDirectory(tmpdir(), "snow-directory-commit-");
    const source = join(root, "source");
    const target = join(root, "target");
    writeSkill(source, "new skill");
    const transaction = prepareDirectoryCommit(source, target);
    writeSkill(target, "competing skill");

    expect(() => transaction.commit({ replaceExisting: false })).toThrow(
      `Target directory appeared during commit: ${target}`
    );
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("competing skill");
    transaction.cleanup();
  });
});
