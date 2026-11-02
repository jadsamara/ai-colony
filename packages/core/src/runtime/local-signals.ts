import { execFile } from "node:child_process";
import { createConnection } from "node:net";

export const API_PROCESS = /apps\/api\/(?:src\/server\.ts|dist\/server\.js)/;
export const WORKER_PROCESS = /workflows\/(?:src\/cli\.ts|dist\/cli\.js)/;
export const DISPATCHER_PROCESS = /messaging\/(?:src\/publisher-cli\.ts|dist\/publisher-cli\.js)/;
export const TRAINING_PROCESS = /services\/training\/.*trainer|mlx_lm/;

export function processSeen(lines: readonly string[] | null, pattern: RegExp): boolean | null {
  if (lines === null) {
    return null;
  }
  return lines.some((line) => pattern.test(line));
}

export function commandLines(timeoutMs = 2_000): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-ax", "-o", "command="], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout.split("\n"));
    });
  });
}

export function tcpReachable(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
