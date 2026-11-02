export type Core = 'xray' | 'sing-box';
export type Page = 'home' | 'subscriptions' | 'cores' | 'nodes' | 'logs' | 'settings';
export type ConnectionMode = 'local' | 'system' | 'tun';
export type RouteMode = 'bypass-cn' | 'global' | 'direct';
export type JsonObject = Record<string, unknown>;

export interface ProxyNode {
  id: string;
  name: string;
  protocol: string;
  server: string;
  port: number;
  core: Core;
  corePreference: 'auto' | Core;
  outbound: JsonObject;
  sourceText: string;
  sourceId?: string;
  locallyEdited?: boolean;
  example?: boolean;
  importedAt: string;
}
export interface NativeProfile {
  id: string;
  name: string;
  core: Core;
  content: string;
  updatedAt: string;
}
export interface Subscription {
  id: string;
  name: string;
  url: string;
  updatedAt?: string;
}
export interface PageAppearance {
  image?: string;
  imageFile?: string;
  opacity: number;
  blur: number;
  focusMode?: 'auto' | 'manual';
  focus?: { x: number; y: number };
}
export interface Settings {
  appearanceVersion?: number;
  port: number;
  closeBehavior: 'ask' | 'tray' | 'exit';
  appearance: Partial<Record<Page, PageAppearance>>;
}
export interface AppData {
  version: 1;
  nodes: ProxyNode[];
  subscriptions: Subscription[];
  profiles: NativeProfile[];
  selectedId: string | null;
  selectedProfileId: string | null;
  mode: ConnectionMode;
  route: RouteMode;
  settings: Settings;
}
export interface CoreInfo {
  core: Core;
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}
export interface StorageInfo {
  directory: string;
  configFile: string;
  backgroundDirectory: string;
}
export interface RuntimeStatus {
  state: 'stopped' | 'running' | 'error';
  core?: Core;
  pid?: number;
  startedAt?: string;
  message?: string;
  localPorts?: { socks: number; http: number };
}
export interface CoreUpdate {
  core: Core;
  currentVersion: string | null;
  latestVersion: string | null;
  available: boolean;
  rollbackAvailable: boolean;
  error: string | null;
}
export interface TrafficStats {
  available: boolean;
  uploadTotal: number;
  downloadTotal: number;
  uploadSpeed: number;
  downloadSpeed: number;
}
export interface RuleStatus {
  ready: boolean;
  updatedAt?: number;
  source: string;
}
export interface LogEntry {
  id: string;
  time: string;
  level: 'info' | 'success' | 'error';
  message: string;
}
export interface ImportResult {
  nodes: ProxyNode[];
  profiles: NativeProfile[];
  errors: string[];
}

// All operating-system effects go through this boundary. Browser preview never simulates a connection.
export interface DesktopBridge {
  available: boolean;
  discoverCores(): Promise<CoreInfo[]>;
  checkCoreUpdates(force: boolean): Promise<CoreUpdate[]>;
  installCoreUpdate(core: Core, version: string, config?: string, managed?: boolean): Promise<CoreUpdate>;
  rollbackCore(core: Core): Promise<CoreUpdate>;
  validate(core: Core, config: string): Promise<string>;
  start(core: Core, config: string, mode: ConnectionMode, managed?: boolean): Promise<RuntimeStatus>;
  stop(): Promise<RuntimeStatus>;
  status(): Promise<RuntimeStatus>;
  traffic(): Promise<TrafficStats>;
  rulesStatus(): Promise<RuleStatus>;
  updateRules(force: boolean): Promise<RuleStatus>;
  currentConfig(): Promise<string | null>;
  fetchSubscription(url: string): Promise<string>;
  loadData(): Promise<string | null>;
  saveData(data: string): Promise<void>;
  storageInfo(): Promise<StorageInfo>;
  storeBackground(page: Page, data: string): Promise<string>;
  loadBackground(name: string): Promise<string | null>;
  resetBackgrounds(data: string, page?: Page): Promise<string>;
  exportData(data: string): Promise<string>;
  chooseStorageDirectory(): Promise<string | null>;
  setStorageDirectory(directory: string, data: string): Promise<StorageInfo>;
  openStorageFolder(folder: 'config' | 'backgrounds'): Promise<void>;
  setCloseBehavior(behavior: Settings['closeBehavior']): Promise<void>;
  close(action: 'tray' | 'exit'): Promise<void>;
}
