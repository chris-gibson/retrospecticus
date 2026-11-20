import { readSync } from "node:fs";

/**
 * Reads one line from a file descriptor with blocking reads. The prompts use
 * this instead of readline because readline watches stdin for readiness, and
 * on macOS kqueue refuses to watch a terminal opened as /dev/tty (EINVAL),
 * which is how the install script hands over the terminal.
 */
export function readLineSync(fd = 0): string | null {
  const bytes: number[] = [];
  const one = Buffer.alloc(1);
  for (;;) {
    let n: number;
    try {
      n = readSync(fd, one, 0, 1, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EINTR") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        continue;
      }
      throw err;
    }
    // End of input before any byte (Ctrl-D on an empty line) is not an answer; a blank line is.
    if (n === 0 && bytes.length === 0) return null;
    if (n === 0 || one[0] === 0x0a) break;
    bytes.push(one[0]!);
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r$/, "");
}
