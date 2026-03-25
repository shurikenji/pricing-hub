import { readFile } from "node:fs/promises";
import path from "node:path";

const jsonCache = new Map<string, unknown>();

function resolveSamplePath(fileName: string): string {
  const sampleRoot = process.env.SAMPLE_ROOT ?? "..";
  return path.resolve(process.cwd(), sampleRoot, fileName);
}

export async function loadRootJson<T>(fileName: string, parser: (payload: unknown) => T): Promise<T> {
  if (jsonCache.has(fileName)) {
    return parser(jsonCache.get(fileName));
  }

  const raw = await readFile(resolveSamplePath(fileName), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  jsonCache.set(fileName, parsed);
  return parser(parsed);
}
