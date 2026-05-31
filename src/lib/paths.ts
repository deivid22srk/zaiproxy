import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function projectPath(path: string): string {
  return resolve(process.cwd(), path);
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function ensureParentDir(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
