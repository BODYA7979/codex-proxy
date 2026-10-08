import { access, link, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Share only the official credential file, not the user's config. A copied
 * refresh token could be rotated in a temporary home and lost on cleanup.
 * Codex's file credential store saves through OpenOptions (following the link).
 */
export async function linkCallerCredentials(sourceHome: string, targetHome: string): Promise<void> {
  const source = resolve(sourceHome, "auth.json");
  try { await access(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const target = join(targetHome, "auth.json");
  try { await symlink(source, target, "file"); }
  catch (error) {
    // Windows can deny file symlinks without Developer Mode. A hard link still
    // follows the current file-store in-place save, and retains token rotation.
    if (process.platform !== "win32") throw error;
    await link(source, target);
  }
}
