import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(__dirname, "../../../../.env");
const EXAMPLE_PATH = resolve(__dirname, "../../../../.env.example");

/** Sets each key in the repo-root .env (the file both Hardhat and the frontend read), replacing
 * an existing line or appending one; every other line is left untouched. Returns the keys whose
 * previous non-empty value was replaced, so the caller can print them — they're addresses, not
 * secrets, and the console output is the only record of them once overwritten. */
export function writeEnv(values: Record<string, string>): { path: string; replaced: Record<string, string> } {
  if (!existsSync(ENV_PATH)) copyFileSync(EXAMPLE_PATH, ENV_PATH);
  let text = readFileSync(ENV_PATH, "utf8");
  const replaced: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key}=(.*)$`, "m");
    const match = text.match(line);
    if (match) {
      const old = match[1].trim();
      if (old && old !== value) replaced[key] = old;
      text = text.replace(line, `${key}=${value}`);
    } else {
      text = `${text.replace(/\n?$/, "\n")}${key}=${value}\n`;
    }
  }
  writeFileSync(ENV_PATH, text);
  return { path: ENV_PATH, replaced };
}
