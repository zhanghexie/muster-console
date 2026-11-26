import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyBookmarkChange, isBookmarkChange, isBookmarkTree, type BookmarkChange, type WorkspaceBookmarks, type WorkspaceBookmarksRead } from '../../shared/bookmarks';
import { DEFAULT_BOOKMARKS_VERSION, mergeDefaultBookmarks } from '../../shared/defaultBookmarks';
import { META_AGENT_DIR } from '../../shared/metaAgent';
import { errorMessage } from '../../shared/errors';
import { writeJsonAtomic } from '../atomicJson';
import { resolveRealPathInsideRoot, sourcePathKey } from '../workspacePaths';
import { legacyWorkspaceBookmarks, readWorkspaceFile, removeLegacyWorkspaceBookmarks } from './workspaceFile';

type BookmarkFile = WorkspaceBookmarks & { migratedLegacy?: string };
type LegacyFields = ReturnType<typeof legacyWorkspaceBookmarks>;
const digest = (fields: LegacyFields) => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const hasLegacy = (fields: LegacyFields) => Object.keys(fields).length > 0;
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function readFile(file: string): Promise<BookmarkFile | undefined> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(text) as BookmarkFile;
  if (value?.version !== 1 || !isVersion(value.bookmarkDefaultsVersion) || !isBookmarkTree(value.bookmarks) ||
      (value.migratedLegacy !== undefined && (typeof value.migratedLegacy !== 'string' || !/^[a-f0-9]{64}$/.test(value.migratedLegacy)))) {
    throw new Error('Invalid bookmarks.json');
  }
  return value;
}

function initializeDefaults(file: BookmarkFile): BookmarkFile {
  if (file.bookmarkDefaultsVersion >= DEFAULT_BOOKMARKS_VERSION) return file;
  const merged = mergeDefaultBookmarks(file.bookmarks);
  return merged.complete ? { ...file, bookmarks: merged.nodes, bookmarkDefaultsVersion: DEFAULT_BOOKMARKS_VERSION } : file;
}

function publicSnapshot(file: BookmarkFile): WorkspaceBookmarks {
  return { version: 1, bookmarks: file.bookmarks, bookmarkDefaultsVersion: file.bookmarkDefaultsVersion };
}

export class WorkspaceBookmarksStore {
  private readonly pending = new Map<string, Promise<unknown>>();

  private async run<T>(root: string, checkOwner: () => void, action: (file: string) => Promise<T>): Promise<T> {
    const key = sourcePathKey(root);
    const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      checkOwner();
      const file = await resolveRealPathInsideRoot(root, path.join(META_AGENT_DIR, 'bookmarks.json'));
      checkOwner();
      return action(file);
    });
    this.pending.set(key, next);
    try { return await next; }
    finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }

  private async publish(file: string, snapshot: BookmarkFile, checkOwner: () => void): Promise<void> {
    await writeJsonAtomic(file, snapshot, () => { checkOwner(); return true; });
  }

  read(root: string, checkOwner: () => void): Promise<WorkspaceBookmarksRead> {
    return this.run(root, checkOwner, async file => {
      const existing = await readFile(file);
      let snapshot: BookmarkFile;
      if (existing) {
        snapshot = initializeDefaults(existing);
      } else {
        await resolveRealPathInsideRoot(root, path.join(META_AGENT_DIR, 'workspace.json'));
        checkOwner();
        const fields = legacyWorkspaceBookmarks(readWorkspaceFile(root, { readonly: true }));
        const { bookmarks = [], bookmarkDefaultsVersion = 0 } = fields;
        if (!isBookmarkTree(bookmarks) || !isVersion(bookmarkDefaultsVersion)) throw new Error('Invalid legacy workspace bookmarks');
        snapshot = initializeDefaults({ version: 1, bookmarks, bookmarkDefaultsVersion,
          ...(hasLegacy(fields) ? { migratedLegacy: digest(fields) } : {}) });
      }
      if (snapshot !== existing) {
        await this.publish(file, snapshot, checkOwner);
        const confirmed = await readFile(file);
        if (JSON.stringify(confirmed) !== JSON.stringify(snapshot)) throw new Error('Could not verify bookmarks.json');
      }
      let cleanupError: string | undefined;
      const { migratedLegacy, ...completed } = snapshot;
      if (migratedLegacy) {
        try {
          await resolveRealPathInsideRoot(root, path.join(META_AGENT_DIR, 'workspace.json'));
          checkOwner();
          removeLegacyWorkspaceBookmarks(root, fields => {
            if (!hasLegacy(fields)) return false;
            if (digest(fields) !== migratedLegacy) throw new Error('Legacy workspace bookmarks changed during migration');
            return true;
          });
          await this.publish(file, completed, checkOwner);
        } catch (error) { cleanupError = errorMessage(error); }
      }
      return { snapshot: publicSnapshot(snapshot), ...(cleanupError ? { cleanupError } : {}) };
    });
  }

  change(root: string, checkOwner: () => void, change: BookmarkChange): Promise<WorkspaceBookmarks> {
    return this.run(root, checkOwner, async file => {
      if (!isBookmarkChange(change)) throw new Error('Invalid bookmark change');
      const current = await readFile(file);
      if (!current) throw new Error('Bookmarks file is missing');
      const result = applyBookmarkChange(current.bookmarks, change);
      if (result.error) throw new Error(`Bookmark change rejected: ${result.error}`);
      if (!isBookmarkTree(result.nodes)) throw new Error('Invalid bookmark tree');
      const next = { ...current, bookmarks: result.nodes };
      await this.publish(file, next, checkOwner);
      return publicSnapshot(next);
    });
  }
}
