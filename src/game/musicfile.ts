// User-selected soundtrack persistence: a File/Blob in IndexedDB plus an
// object URL that the WebAudio decoder reads into an AudioBuffer. Browser-only
// at runtime, but importing this module in Node (tests) must not touch
// File/IndexedDB APIs.

/** Extensions offered by both picker paths; `audio/*` covers other formats. */
export const MUSIC_EXTENSIONS = ['.mp3', '.ogg', '.m4a', '.wav'];
export const MUSIC_ACCEPT: Record<string, string[]> = { 'audio/*': [...MUSIC_EXTENSIONS] };
export const MUSIC_FILE_TYPES = [{ description: 'Audio', accept: MUSIC_ACCEPT }];

const DB_NAME = 'ie-audio';
const STORE_NAME = 'music';
const RECORD_KEY = 'custom';
const MAX_NAME = 120;

/**
 * Keep only a readable basename: browsers already pass File.name without a
 * path, but callers (and the hidden input on old browsers) can be less tidy.
 */
export function sanitizeMusicName(raw: string): string {
  const base = String(raw).split(/[\\/]/).pop() ?? '';
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME);
  return clean || 'Custom soundtrack';
}

/** True for any audio MIME type, or for the extensions the picker offers. */
export function isAcceptedMusicFile(file: { name: string; type?: string }): boolean {
  const type = (file.type ?? '').trim().toLowerCase();
  if (type.startsWith('audio/')) return true;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return false;
  return MUSIC_EXTENSIONS.includes(file.name.slice(dot).toLowerCase());
}

interface MusicRecord {
  key: string;
  name: string;
  data: Blob;
}

// Falls back to this when IndexedDB is unavailable (private mode, policy) so
// a freshly picked track still plays until the page is reloaded.
let memoryRecord: MusicRecord | null = null;

function canUseIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function isMusicRecord(value: unknown): value is MusicRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Partial<MusicRecord>;
  return typeof rec.key === 'string' &&
    typeof rec.name === 'string' &&
    typeof Blob !== 'undefined' &&
    rec.data instanceof Blob &&
    rec.data.size > 0;
}

async function readRecord(): Promise<MusicRecord | null> {
  if (!canUseIndexedDb()) return memoryRecord;
  try {
    const db = await openDb();
    try {
      const rec = await new Promise<MusicRecord | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        req.onsuccess = () => resolve(isMusicRecord(req.result) ? req.result : null);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB read aborted'));
      });
      if (rec) memoryRecord = rec;
      return rec ?? memoryRecord;
    } finally {
      db.close();
    }
  } catch {
    return memoryRecord;
  }
}

async function writeRecord(rec: MusicRecord): Promise<void> {
  memoryRecord = rec;
  if (!canUseIndexedDb()) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    // The in-memory copy keeps playback working for this session.
  }
}

async function deleteRecord(): Promise<void> {
  memoryRecord = null;
  if (!canUseIndexedDb()) return;
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB delete aborted'));
      });
    } finally {
      db.close();
    }
  } catch {
    // Nothing to recover: clearing is best effort, like the picker itself.
  }
}

interface OpenFilePickerOptions {
  types: { description?: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption?: boolean;
  multiple?: boolean;
}

interface FileHandleLike {
  getFile(): Promise<File>;
}

type ShowOpenFilePicker = (options?: OpenFilePickerOptions) => Promise<FileHandleLike[]>;

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    (err as { name?: string }).name === 'AbortError';
}

/** Hidden <input> fallback for browsers without showOpenFilePicker. */
function pickWithInput(): Promise<File | null> {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.hidden = true;

    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      if (focusTimer !== null) clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
      resolve(file);
    };
    const onChange = (): void => finish(input.files?.[0] ?? null);
    const onCancel = (): void => finish(null);
    const onFocus = (): void => {
      // Safari/Firefox may not fire `cancel`; give `change` a moment first.
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!input.files || input.files.length === 0) finish(null);
      }, 400);
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    try {
      input.click();
    } catch {
      finish(null);
    }
  });
}

async function pickFile(): Promise<File | null> {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as { showOpenFilePicker?: ShowOpenFilePicker }).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const handles = await picker.call(window, { types: MUSIC_FILE_TYPES, multiple: false });
      const handle = handles[0];
      return handle ? await handle.getFile() : null;
    } catch (err) {
      // Cancelling is normal; other failures (policy, no activation) fall
      // through to the <input> path instead of breaking the menu.
      if (isAbortError(err)) return null;
    }
  }
  return pickWithInput();
}

/**
 * Ask for an audio file, persist it, and return its sanitized display name.
 * Cancelling (or any picker/storage failure) resolves to null, never throws.
 */
export async function pickMusicFile(): Promise<{ name: string } | null> {
  try {
    const file = await pickFile();
    if (!file || !isAcceptedMusicFile(file)) return null;
    const name = sanitizeMusicName(file.name);
    await writeRecord({ key: RECORD_KEY, name, data: file });
    return { name };
  } catch {
    return null;
  }
}

/** Read the saved track and mint a fresh object URL (caller owns revoking it). */
export async function loadStoredMusic(): Promise<{ name: string; url: string } | null> {
  const rec = await readRecord();
  if (!rec) return null;
  try {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
    return { name: sanitizeMusicName(rec.name), url: URL.createObjectURL(rec.data) };
  } catch {
    return null;
  }
}

/** Remove the saved track; playback is handled by the audio manager. */
export async function clearStoredMusic(): Promise<void> {
  await deleteRecord();
}
