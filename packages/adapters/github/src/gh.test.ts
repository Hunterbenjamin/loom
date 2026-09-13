import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { runGh, utf8Prefix } from "./gh.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("bounds captured diff output while draining responses beyond the normal 16 MiB limit", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  const pending = runGh(["api"], undefined, { stdoutLimit: 9 });
  child.stdout.write(Buffer.from("prefix éé"));
  child.stdout.write(Buffer.alloc(20 * 1024 * 1024, "x"));
  child.emit("close", 0);
  expect(await pending).toEqual({
    stdout: "prefix é",
    stderr: "",
    exitCode: 0,
    truncated: true,
  });
  expect(child.kill).not.toHaveBeenCalled();
});

it.each([1, 2, 3])(
  "does not cut a four-byte code point at byte %s",
  (limit) => {
    expect(utf8Prefix(Buffer.from("😀x"), limit)).toBe("");
    expect(utf8Prefix(Buffer.from("😀x"), 4)).toBe("😀");
  },
);
