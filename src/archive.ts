import {access, mkdir, rename} from "node:fs/promises";
import path from "node:path";

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function archiveDestination(dataDirectory: string, date = new Date()): string {
  const absolute = path.resolve(dataDirectory);
  return path.join(path.dirname(absolute), "backups", `${path.basename(absolute)}-${timestamp(date)}`);
}

export async function archiveDataDirectory(dataDirectory: string, date = new Date()): Promise<string | undefined> {
  const source = path.resolve(dataDirectory);
  try {
    await access(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const destination = archiveDestination(source, date);
  await mkdir(path.dirname(destination), {recursive: true});
  await rename(source, destination);
  return destination;
}
