import { execFile, type ExecFileOptions } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export function execFileAsync(
  executable: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        ...options,
      },
      (error, stdout, stderr) => {
        const output = String(stdout ?? "").replaceAll("\0", "").trim();
        const errorOutput = String(stderr ?? "").replaceAll("\0", "").trim();
        if (error) {
          const wrapped = new Error(errorOutput || output || error.message);
          Object.assign(wrapped, { cause: error, stdout: output, stderr: errorOutput });
          reject(wrapped);
          return;
        }
        resolve({ stdout: output, stderr: errorOutput });
      },
    );
  });
}
