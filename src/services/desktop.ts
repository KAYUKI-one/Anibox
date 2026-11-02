import { invoke, isTauri } from '@tauri-apps/api/core';
import type { DesktopBridge } from '../domain/types';

const nativeOnly = () =>
  Promise.reject(
    new Error('此操作需要 Windows 桌面版。浏览器预览支持导入、编辑和保存，不会启动代理或修改系统网络。'),
  );

export const desktop: DesktopBridge = isTauri()
  ? {
      available: true,
      discoverCores: () => invoke('discover_cores'),
      checkCoreUpdates: (force) => invoke('check_core_updates', { force }),
      installCoreUpdate: (core, version, config, managed) =>
        invoke('install_core_update', { core, version, config: config ?? null, managed: managed ?? false }),
      rollbackCore: (core) => invoke('rollback_core', { core }),
      validate: (core, config) => invoke('validate_config', { core, config }),
      start: (core, config, mode, managed = false) => invoke('start_core', { core, config, mode, managed }),
      stop: () => invoke('stop_core'),
      status: () => invoke('runtime_status'),
      traffic: () => invoke('traffic_stats'),
      rulesStatus: () => invoke('rules_status'),
      updateRules: (force) => invoke('update_rules', { force }),
      currentConfig: () => invoke('current_config'),
      fetchSubscription: (url) => invoke('fetch_subscription', { url }),
      loadData: () => invoke('load_data'),
      saveData: (data) => invoke('save_data', { data }),
      setCloseBehavior: (behavior) => invoke('set_close_behavior', { behavior }),
      close: (action) => invoke('close_app', { action }),
    }
  : {
      available: false,
      discoverCores: async () => [],
      checkCoreUpdates: nativeOnly,
      installCoreUpdate: nativeOnly,
      rollbackCore: nativeOnly,
      validate: nativeOnly,
      start: nativeOnly,
      stop: nativeOnly,
      status: async () => ({ state: 'stopped' }),
      traffic: async () => ({
        available: false,
        uploadTotal: 0,
        downloadTotal: 0,
        uploadSpeed: 0,
        downloadSpeed: 0,
      }),
      rulesStatus: async () => ({ ready: false, source: '2dust/sing-box-rules' }),
      updateRules: nativeOnly,
      currentConfig: async () => null,
      fetchSubscription: nativeOnly,
      loadData: async () => null,
      saveData: async () => {},
      setCloseBehavior: async () => {},
      close: nativeOnly,
    };
