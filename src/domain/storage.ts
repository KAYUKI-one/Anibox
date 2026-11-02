import type { AppData, Page } from './types';
import { clamp, DEFAULT_OPACITY, MIN_OPACITY } from './appearance';

export const STORAGE_KEY = 'anibox.workspace.v1';
export const emptyData = (): AppData => ({
  version: 1,
  nodes: [],
  subscriptions: [],
  profiles: [],
  selectedId: null,
  selectedProfileId: null,
  mode: 'local',
  route: 'bypass-cn',
  settings: { port: 10808, closeBehavior: 'ask', appearance: {}, appearanceVersion: 2 },
});

export function parseData(raw: string | null): AppData {
  if (!raw) return emptyData();
  const value = JSON.parse(raw) as AppData;
  if (
    value.version !== 1 ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.profiles) ||
    !Array.isArray(value.subscriptions)
  ) {
    throw new Error('保存的数据格式不受支持，请先备份数据。');
  }
  if (
    !value.settings ||
    !Number.isInteger(value.settings.port) ||
    value.settings.port < 1024 ||
    value.settings.port > 65534
  ) {
    throw new Error('保存的本地端口无效。');
  }
  const appearance = { ...value.settings.appearance };
  for (const page of Object.keys(appearance) as Page[]) {
    const item = appearance[page];
    if (!item) continue;
    const oldDefault = (value.settings.appearanceVersion ?? 0) < 2 && item.opacity === 78;
    appearance[page] = {
      ...item,
      opacity: clamp(
        oldDefault ? DEFAULT_OPACITY : Number.isFinite(item.opacity) ? item.opacity : DEFAULT_OPACITY,
        MIN_OPACITY,
        100,
      ),
      blur: clamp(Number.isFinite(item.blur) ? item.blur : 0, 0, 24),
    };
  }
  return {
    ...emptyData(),
    ...value,
    settings: { ...emptyData().settings, ...value.settings, appearance, appearanceVersion: 2 },
  };
}

export function appearanceFor(data: AppData, page: Page) {
  return data.settings.appearance[page] ?? { opacity: DEFAULT_OPACITY, blur: 0 };
}
