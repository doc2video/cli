import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

/** Must match DOCUMENT_TYPES / PHOTO_TYPES in the app's src/lib/services/documents.ts. */
const DOCUMENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv",
  ".json": "application/json",
};

const PHOTO_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** Formats people commonly have that the pipeline can't read yet, with a hint. */
const CONVERT_HINTS: Record<string, string> = {
  ".doc": "save as .docx first",
  ".ppt": "save as .pptx first",
  ".key": "export Keynote as .pptx or PDF first",
  ".pages": "export Pages as .docx or PDF first",
};

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** The script generator looks at up to this many photos. */
export const MAX_PHOTOS = 50;

const IGNORED_DIRS = new Set(["node_modules", "__pycache__", "venv", ".venv"]);

export interface LocalFile {
  path: string;
  name: string;
  size: number;
  kind: "document" | "photo";
  contentType: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/**
 * Expand files and folders into uploadable files. Folders are walked
 * recursively (skipping hidden files/folders) and files are sorted naturally
 * (IMG_2 before IMG_10) so photo order is stable.
 */
export function collectFiles(paths: string[]): { files: LocalFile[]; skipped: SkippedFile[] } {
  const files: LocalFile[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();

  function addFile(path: string, size: number) {
    if (seen.has(path)) return;
    seen.add(path);
    const ext = extname(path).toLowerCase();
    const name = basename(path);
    if (size > MAX_FILE_BYTES) {
      skipped.push({ path, reason: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` });
    } else if (size === 0) {
      skipped.push({ path, reason: "empty file" });
    } else if (DOCUMENT_TYPES[ext]) {
      files.push({ path, name, size, kind: "document", contentType: DOCUMENT_TYPES[ext] });
    } else if (PHOTO_TYPES[ext]) {
      files.push({ path, name, size, kind: "photo", contentType: PHOTO_TYPES[ext] });
    } else {
      skipped.push({ path, reason: CONVERT_HINTS[ext] ?? `unsupported type${ext ? ` (${ext})` : ""}` });
    }
  }

  function walk(dir: string) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => naturalCompare(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        addFile(full, statSync(full).size);
      }
    }
  }

  for (const input of paths) {
    const full = resolve(input);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      skipped.push({ path: full, reason: "not found" });
      continue;
    }
    if (stat.isDirectory()) walk(full);
    else addFile(full, stat.size);
  }

  return { files, skipped };
}

export function describeFiles(files: LocalFile[]): string {
  const docs = files.filter((f) => f.kind === "document").length;
  const photos = files.length - docs;
  const parts = [];
  if (docs) parts.push(`${docs} document${docs === 1 ? "" : "s"}`);
  if (photos) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
  return parts.join(" and ") || "no files";
}
