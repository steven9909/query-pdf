/** Zustand store for the open document and all viewer UI state. */
import { create } from "zustand";
import type { PDFDocumentProxy } from "../lib/pdf";
import type { SearchHit } from "../lib/search";

export type FitMode = "width" | "page" | "custom";
export type SidebarMode = "thumbnails" | "outline" | "none";

/** A request to scroll the viewer to a page; the nonce makes repeated requests distinct. */
export interface NavRequest {
  pageIndex: number;
  nonce: number;
}

export interface ViewerState {
  doc: PDFDocumentProxy | null;
  fileName: string | null;
  filePath: string | null;
  numPages: number;
  currentPage: number;
  zoom: number;
  fitMode: FitMode;
  rotation: number;
  sidebarMode: SidebarMode;
  lastSidebarMode: Exclude<SidebarMode, "none">;
  searchQuery: string;
  searchHits: SearchHit[];
  activeHit: number;
  hitNonce: number;
  loading: boolean;
  error: string | null;
  navRequest: NavRequest | null;
  setDocument(doc: PDFDocumentProxy, info: { fileName: string; filePath: string | null }): void;
  clearDocument(): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setCurrentPage(pageIndex: number): void;
  goToPage(pageIndex: number): void;
  setZoom(zoom: number): void;
  setFittedZoom(zoom: number): void;
  zoomIn(): void;
  zoomOut(): void;
  setFitMode(mode: FitMode): void;
  rotate(delta: number): void;
  setSidebarMode(mode: SidebarMode): void;
  toggleSidebar(): void;
  setSearchQuery(query: string): void;
  setSearchHits(hits: SearchHit[]): void;
  nextHit(): void;
  prevHit(): void;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];

const LAST_PAGE_KEY = "query.lastPage";
const LAST_PAGE_LIMIT = 200;

/** Clamps a zoom factor to the supported range. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Reads the remembered-page map from localStorage. */
function readLastPages(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_PAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Returns the last viewed page index remembered for a file key, if any. */
export function recallLastPage(key: string): number | null {
  const v = readLastPages()[key];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Remembers the last viewed page index for a file key, keeping the map bounded. */
export function rememberLastPage(key: string, pageIndex: number): void {
  try {
    const map = readLastPages();
    delete map[key];
    map[key] = pageIndex;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - LAST_PAGE_LIMIT))) delete map[k];
    localStorage.setItem(LAST_PAGE_KEY, JSON.stringify(map));
  } catch {
    return;
  }
}

/** Returns the key used to remember a document's page. */
function fileKey(s: Pick<ViewerState, "filePath" | "fileName">): string | null {
  return s.filePath ?? s.fileName;
}

let navNonce = 0;

export const useViewer = create<ViewerState>()((set, get) => ({
  doc: null,
  fileName: null,
  filePath: null,
  numPages: 0,
  currentPage: 0,
  zoom: 1,
  fitMode: "width",
  rotation: 0,
  sidebarMode: "thumbnails",
  lastSidebarMode: "thumbnails",
  searchQuery: "",
  searchHits: [],
  activeHit: -1,
  hitNonce: 0,
  loading: false,
  error: null,
  navRequest: null,

  setDocument(doc, info) {
    const key = info.filePath ?? info.fileName;
    const remembered = recallLastPage(key);
    const page = remembered !== null && remembered < doc.numPages ? remembered : 0;
    set({
      doc,
      fileName: info.fileName,
      filePath: info.filePath,
      numPages: doc.numPages,
      currentPage: page,
      rotation: 0,
      searchHits: [],
      activeHit: -1,
      loading: false,
      error: null,
      navRequest: { pageIndex: page, nonce: ++navNonce },
    });
  },

  clearDocument() {
    set({ doc: null, fileName: null, filePath: null, numPages: 0, currentPage: 0, searchHits: [], activeHit: -1, navRequest: null });
  },

  setLoading(loading) {
    set({ loading });
  },

  setError(error) {
    set({ error, loading: false });
  },

  setCurrentPage(pageIndex) {
    const s = get();
    if (pageIndex === s.currentPage) return;
    set({ currentPage: pageIndex });
    const key = fileKey(s);
    if (key) rememberLastPage(key, pageIndex);
  },

  goToPage(pageIndex) {
    const s = get();
    if (s.numPages === 0) return;
    const p = Math.min(s.numPages - 1, Math.max(0, Math.round(pageIndex)));
    set({ navRequest: { pageIndex: p, nonce: ++navNonce } });
    get().setCurrentPage(p);
  },

  setZoom(zoom) {
    set({ zoom: clampZoom(zoom), fitMode: "custom" });
  },

  setFittedZoom(zoom) {
    set({ zoom: clampZoom(zoom) });
  },

  zoomIn() {
    const z = get().zoom;
    const next = ZOOM_STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM;
    get().setZoom(next);
  },

  zoomOut() {
    const z = get().zoom;
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
    get().setZoom(prev);
  },

  setFitMode(mode) {
    set({ fitMode: mode });
  },

  rotate(delta) {
    set({ rotation: (((get().rotation + delta) % 360) + 360) % 360 });
  },

  setSidebarMode(mode) {
    set(mode === "none" ? { sidebarMode: mode } : { sidebarMode: mode, lastSidebarMode: mode });
  },

  toggleSidebar() {
    const s = get();
    set({ sidebarMode: s.sidebarMode === "none" ? s.lastSidebarMode : "none" });
  },

  setSearchQuery(query) {
    set({ searchQuery: query });
  },

  setSearchHits(hits) {
    const page = get().currentPage;
    const first = hits.findIndex((h) => h.pageIndex >= page);
    set({ searchHits: hits, activeHit: hits.length ? Math.max(0, first) : -1, hitNonce: get().hitNonce + 1 });
  },

  nextHit() {
    const s = get();
    if (!s.searchHits.length) return;
    set({ activeHit: (s.activeHit + 1) % s.searchHits.length, hitNonce: s.hitNonce + 1 });
  },

  prevHit() {
    const s = get();
    if (!s.searchHits.length) return;
    set({ activeHit: (s.activeHit - 1 + s.searchHits.length) % s.searchHits.length, hitNonce: s.hitNonce + 1 });
  },
}));
