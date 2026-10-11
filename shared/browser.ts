export type BrowserAttentionKind = "auth" | "challenge" | "network" | "http" | "certificate" | "crash";
export interface BrowserTab { id: string; url: string; title: string; loading: boolean; owner: "user" | "agent"; attention?: string; attentionKind?: BrowserAttentionKind; canGoBack?: boolean; canGoForward?: boolean }
export interface Bookmark { id: string; title: string; url: string }
export interface BrowserHistory { url: string; title: string; at: number }
export interface BrowserState { tabs: BrowserTab[]; active: string | null; bookmarks: Bookmark[]; history: BrowserHistory[]; retentionDays: number; mode: "desktop" | "headless" }
export const emptyBrowser = (): BrowserState => ({ tabs: [], active: null, bookmarks: [], history: [], retentionDays: 30, mode: "headless" });
