export type HomeWallpaper = 'default' | 'none' | 'custom';
export interface HomeAppearance {
  wallpaper: HomeWallpaper;
  wallpaperId?: string;
  transparency: number;
  blur: number;
}

const KEY = 'muster.browser.home.appearance.v1';
const DATABASE = 'muster.browser.home.wallpaper.v1';
const STORE = 'wallpapers';
export const HOME_APPEARANCE_CHANGED = 'muster:browser-home-appearance-changed';
export const MAX_HOME_WALLPAPER_SIZE = 20 * 1024 * 1024;
export const DEFAULT_HOME_APPEARANCE: HomeAppearance = { wallpaper: 'default', transparency: 25, blur: 0 };
export const MAX_HOME_MATERIAL_BLUR = 40;

// 滑杆前段更细；存储和显示的仍是实际透明度，而不是滑杆位置。
export function homeTransparencyFromSlider(position: number): number {
  const value = Math.max(0, Math.min(100, position));
  return Math.round(value * value) / 100;
}
export function homeTransparencyToSlider(transparency: number): number {
  return Math.round(Math.sqrt(Math.max(0, Math.min(100, transparency)) * 100));
}

export function readHomeAppearance(): HomeAppearance {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<HomeAppearance> | null;
    if (!value) return { ...DEFAULT_HOME_APPEARANCE };
    const transparency = typeof value.transparency === 'number' && Number.isFinite(value.transparency)
      ? Math.max(0, Math.min(100, Math.round(value.transparency * 100) / 100)) : DEFAULT_HOME_APPEARANCE.transparency;
    const blur = typeof value.blur === 'number' && Number.isFinite(value.blur)
      ? Math.max(0, Math.min(MAX_HOME_MATERIAL_BLUR, Math.round(value.blur))) : 0;
    if (value.wallpaper === 'custom' && typeof value.wallpaperId === 'string' && value.wallpaperId) {
      return { wallpaper: 'custom', wallpaperId: value.wallpaperId, transparency, blur };
    }
    return { wallpaper: value.wallpaper === 'none' ? 'none' : 'default', transparency, blur };
  } catch { return { ...DEFAULT_HOME_APPEARANCE }; }
}

export function writeHomeAppearance(value: HomeAppearance): void {
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(HOME_APPEARANCE_CHANGED));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open(DATABASE, 1);
    let settled = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => { settled = true; reject(request.error ?? new Error('IndexedDB open failed')); };
    request.onblocked = () => { settled = true; reject(new Error('IndexedDB open blocked')); };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true;
      resolve(request.result);
    };
  });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction(STORE, mode); }
    catch (error) { db.close(); reject(error); return; }
    let result: T;
    try {
      const request = operation(transaction.objectStore(STORE));
      request.onsuccess = () => { result = request.result; };
    } catch (error) { transaction.abort(); db.close(); reject(error); return; }
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('IndexedDB transaction aborted')); };
    transaction.onerror = () => { /* onabort reports the transaction failure */ };
  });
}

export async function saveHomeWallpaper(id: string, file: Blob): Promise<void> {
  await transact('readwrite', store => store.put(file, id));
}
export async function readHomeWallpaper(id: string): Promise<Blob> {
  const result: unknown = await transact('readonly', store => store.get(id));
  if (!(result instanceof Blob)) throw new Error('Wallpaper not found');
  return result;
}
export async function deleteHomeWallpaper(id: string): Promise<void> {
  await transact('readwrite', store => store.delete(id));
}

export function validateHomeWallpaper(file: File): Promise<void> {
  const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'];
  if (!types.includes(file.type)) return Promise.reject(new Error('type'));
  if (file.size > MAX_HOME_WALLPAPER_SIZE) return Promise.reject(new Error('size'));
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    image.src = url;
  });
}
