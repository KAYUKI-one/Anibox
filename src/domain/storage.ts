import type { AppData, Page } from './types';

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
  settings: { port: 10808, closeBehavior: 'ask', appearance: {} },
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
  return { ...emptyData(), ...value, settings: { ...emptyData().settings, ...value.settings } };
}

export function appearanceFor(data: AppData, page: Page) {
  return data.settings.appearance[page] ?? { opacity: 78, blur: 0 };
}
