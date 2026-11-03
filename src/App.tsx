import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardPaste,
  Code2,
  Copy,
  Cpu,
  Download,
  Ellipsis,
  FileCode2,
  FileInput,
  FileJson,
  FolderOpen,
  Globe2,
  Home,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Maximize2,
  Minus,
  Monitor,
  Network,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type {
  AppData,
  Core,
  CoreInfo,
  CoreUpdate,
  LogEntry,
  NativeProfile,
  Page,
  ProxyNode,
  RuntimeStatus,
  TrafficStats,
  RuleStatus,
  RulePreparation,
  ConnectionMode,
  StorageInfo,
} from './domain/types';
import { appearanceFor, parseData, STORAGE_KEY } from './domain/storage';
import { coreForNode, describeOutbound, mergeSubscriptionNodes, parseImport } from './domain/import';
import { activeConfig, nativeStarter, validateObject } from './domain/config';
import { desktop } from './services/desktop';
import { downloadText, readBackground } from './services/files';
import { useBackground } from './services/useBackground';
import PageBackground, { AppearancePreview } from './components/PageBackground';
import { DEFAULT_OPACITY, MIN_OPACITY } from './domain/appearance';

const JsonEditor = lazy(() => import('./components/JsonEditor'));
const pageLabels: Record<Page, string> = {
  home: '主界面',
  subscriptions: '订阅管理',
  cores: '内核配置',
  nodes: '节点配置',
  logs: '运行日志',
  settings: '偏好设置',
};
const navigation: { page: Page; label: string; icon: LucideIcon }[] = [
  { page: 'home', label: '主界面', icon: Home },
  { page: 'subscriptions', label: '订阅', icon: Layers3 },
  { page: 'nodes', label: '节点', icon: Network },
  { page: 'cores', label: '内核', icon: Code2 },
  { page: 'logs', label: '日志', icon: Activity },
];
const formatBytes = (value: number) => {
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = value > 0 ? Math.min(3, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return (value / 1024 ** index).toFixed(index ? 1 : 0) + ' ' + units[index];
};
const coreLabel = (core: Core) => (core === 'xray' ? 'Xray' : 'sing-box');
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
let persistenceQueue = Promise.resolve();

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none">
        <path d="M10 33 23 9l15 27-14-7-14 4Z" fill="currentColor" />
        <path d="m23 9 1 20 14 7" stroke="#17232E" strokeWidth="2.3" />
        <path d="m8 39 14-8" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
      </svg>
    </div>
  );
}
function IconButton({
  icon: Icon,
  label,
  onClick,
  className = '',
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={17} strokeWidth={1.7} />
    </button>
  );
}
function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab') return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input,select,textarea,[tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handle);
    (panel.current?.querySelector<HTMLElement>('textarea,input') ?? panel.current)?.focus();
    return () => {
      document.removeEventListener('keydown', handle);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="关闭弹窗" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>('home');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | Core>('all');
  const [logSource, setLogSource] = useState('app');
  const [coreLog, setCoreLog] = useState('');
  const [toast, setToast] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [preview, setPreview] = useState<{ core: Core; config: string } | null>(null);
  const [ruleRequest, setRuleRequest] = useState<{
    core: Core;
    config: string;
    name: string;
    mode: ConnectionMode;
    managed: boolean;
    missing: RulePreparation['missing'];
  } | null>(null);
  const [closeOpen, setCloseOpen] = useState(false);
  const [cores, setCores] = useState<CoreInfo[]>([]);
  const [coreUpdates, setCoreUpdates] = useState<CoreUpdate[]>([]);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [updateNotice, setUpdateNotice] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingCore, setUpdatingCore] = useState<Core | null>(null);
  const [updateProgress, setUpdateProgress] = useState('');
  const checkInFlight = useRef(false);
  const coreChangeInFlight = useRef(false);
  const notifiedUpdates = useRef('');
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'stopped' });
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [editorCore, setEditorCore] = useState<Core>('xray');
  const [editorProfileId, setEditorProfileId] = useState<string | null>(null);
  const [draft, setDraft] = useState(nativeStarter('xray'));
  const [savedDraft, setSavedDraft] = useState(draft);
  const [profileName, setProfileName] = useState('我的 Xray 配置');
  const [savedProfileName, setSavedProfileName] = useState('我的 Xray 配置');
  const [editedNodeId, setEditedNodeId] = useState<string | null>(null);
  const [nodeDraft, setNodeDraft] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [nodeSavedDraft, setNodeSavedDraft] = useState('');
  const backgroundInput = useRef<HTMLInputElement>(null);
  const backgroundTarget = useRef<Page>('home');
  const [appearancePage, setAppearancePage] = useState<Page>('home');
  const [traffic, setTraffic] = useState<TrafficStats>({
    available: false,
    uploadTotal: 0,
    downloadTotal: 0,
    uploadSpeed: 0,
    downloadSpeed: 0,
  });
  const [rules, setRules] = useState<RuleStatus>({ ready: false, source: '2dust/sing-box-rules' });
  const [updatingRules, setUpdatingRules] = useState(false);
  const closeHandler = useRef<() => void>(() => {});
  const closeEditorState = useRef(false);

  const notify = useCallback((message: string, level: LogEntry['level'] = 'info') => {
    setToast(message);
    void desktop.appendLog(`${new Date().toISOString()} [${level}] ${message}`).catch(() => {});
  }, []);
  useEffect(() => {
    if (page !== 'logs') return;
    setCoreLog('');
    let disposed = false,
      polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const log = await (logSource === 'core' ? desktop.runtimeLogs() : desktop.appLogs());
        if (!disposed) setCoreLog(log);
      } catch (error) {
        if (!disposed) setCoreLog(`日志读取失败：${messageOf(error)}`);
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [page, logSource]);

  useEffect(() => {
    if (desktop.available)
      desktop
        .storageInfo()
        .then(setStorage)
        .catch(() => {});
  }, []);
  const backgroundImage = useBackground(data?.settings.appearance[page], storage?.directory);
  useEffect(() => {
    if (!desktop.available) return;
    let disposed = false;
    const window = getCurrentWindow();
    const refresh = () =>
      window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    void refresh();
    const unlisten = window.onResized(refresh);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const raw = desktop.available ? await desktop.loadData() : localStorage.getItem(STORAGE_KEY);
        if (!disposed) setData(parseData(raw));
      } catch (error) {
        if (!disposed) setLoadError(messageOf(error));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!data) return;
    const raw = JSON.stringify(data);
    persistenceQueue = persistenceQueue
      .catch(() => {})
      .then(async () => {
        if (desktop.available) await desktop.saveData(raw);
        else localStorage.setItem(STORAGE_KEY, raw);
      })
      .catch((error) => notify(`保存失败：${messageOf(error)}`, 'error'));
  }, [data, notify]);

  const resetBackground = async (target?: Page) => {
    if (!data || storageBusy) return;
    if (!desktop.available) {
      const appearance = { ...data.settings.appearance };
      for (const key of Object.keys(pageLabels) as Page[]) {
        if (!target || key === target) appearance[key] = { opacity: DEFAULT_OPACITY, blur: 0 };
      }
      setData({ ...data, settings: { ...data.settings, appearance } });
      return;
    }
    setStorageBusy(true);
    try {
      await persistenceQueue;
      const raw = await desktop.resetBackgrounds(JSON.stringify(data), target);
      setData(parseData(raw));
      notify('已恢复默认背景', 'success');
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setStorageBusy(false);
    }
  };
  const changeStorage = async () => {
    if (!data || storageBusy) return;
    setStorageBusy(true);
    try {
      const directory = await desktop.chooseStorageDirectory();
      if (!directory) return;
      await persistenceQueue;
      setStorage(await desktop.setStorageDirectory(directory, JSON.stringify(data)));
      setData(parseData(await desktop.loadData()));
      notify('存储目录已更改', 'success');
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setStorageBusy(false);
    }
  };

  useEffect(() => {
    if (!data) return;
    desktop.setCloseBehavior(data.settings.closeBehavior).catch((error) => notify(messageOf(error), 'error'));
  }, [data?.settings.closeBehavior, !!data, notify]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const refreshRules = useCallback(
    async (force: boolean) => {
      setUpdatingRules(true);
      try {
        setRules(await desktop.updateRules(force));
        if (force) notify('规则已更新', 'success');
      } catch (error) {
        if (force) notify(messageOf(error), 'error');
      } finally {
        setUpdatingRules(false);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!desktop.available) return;
    desktop
      .rulesStatus()
      .then(setRules)
      .catch(() => {});
    // Let the first frame and cached rules load before any background network work.
    const startup = setTimeout(() => void refreshRules(false), 30000);
    const timer = setInterval(() => void refreshRules(false), 3600000);
    return () => {
      clearTimeout(startup);
      clearInterval(timer);
    };
  }, [refreshRules]);
  const showConfig = async () => {
    if (!data) return;
    try {
      const current = activeConfig(data);
      const actual = running ? await desktop.currentConfig() : null;
      setPreview({ ...current, config: actual ?? current.config });
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };
  const discover = useCallback(async () => {
    try {
      setCores(await desktop.discoverCores());
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  }, [notify]);
  useEffect(() => {
    void discover();
  }, [discover]);
  const checkUpdates = useCallback(
    async (force: boolean) => {
      if (!desktop.available || checkInFlight.current || coreChangeInFlight.current) return;
      checkInFlight.current = true;
      setCheckingUpdates(true);
      try {
        const updates = await desktop.checkCoreUpdates(force);
        setCoreUpdates(updates);
        if (force) setUpdatesOpen(true);
        else {
          const signature = updates
            .filter((item) => item.available)
            .map((item) => `${item.core}:${item.latestVersion}`)
            .join('|');
          if (signature && signature !== notifiedUpdates.current) {
            notifiedUpdates.current = signature;
            setUpdateNotice(true);
          }
        }
      } catch (error) {
        if (force) notify(messageOf(error), 'error');
      } finally {
        checkInFlight.current = false;
        setCheckingUpdates(false);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (!desktop.available) return;
    const startup = setTimeout(() => void checkUpdates(false), 45000);
    const timer = setInterval(() => void checkUpdates(false), 6 * 3600000);
    const progress = listen<{ core: Core; phase: string; downloaded: number; total: number }>(
      'core-update-progress',
      ({ payload }) => {
        setUpdateProgress(
          payload.phase === '下载中' && payload.total > 0
            ? `下载中 ${Math.min(100, Math.floor((payload.downloaded / payload.total) * 100))}%`
            : payload.phase,
        );
      },
    );
    return () => {
      clearTimeout(startup);
      clearInterval(timer);
      void progress.then((unlisten) => unlisten());
    };
  }, [checkUpdates]);
  useEffect(() => {
    if (!desktop.available) return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (polling || disposed) return;
      polling = true;
      try {
        const value = await desktop.status();
        if (!disposed) {
          setRuntime(value);
          const traffic = await desktop.traffic();
          if (!disposed) setTraffic(traffic);
        }
      } catch {
        /* The next poll retries; never fabricate a running state. */
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1000);
    const event = listen('close-requested', () => closeHandler.current());
    const quit = listen('exit-requested', () => {
      const editors = closeEditorState.current;
      if (editors && !window.confirm('配置有尚未保存的修改，放弃修改并退出？')) return;
      void persistenceQueue
        .then(() => desktop.close('exit'))
        .catch((error) => notify(messageOf(error), 'error'));
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      void event.then((unlisten) => unlisten());
      void quit.then((unlisten) => unlisten());
    };
  }, []);

  const mutate = (change: (current: AppData) => AppData) =>
    setData((current) => (current ? change(current) : current));
  const selected = data?.nodes.find((node) => node.id === data.selectedId);
  const selectedProfile = data?.profiles.find((profile) => profile.id === data.selectedProfileId);
  const running = runtime.state === 'running';
  const dirty = draft !== savedDraft || profileName !== savedProfileName;
  const nodeDirty =
    nodeDraft !== nodeSavedDraft ||
    (data?.nodes.find((node) => node.id === editedNodeId)?.name ?? '') !== nodeName;
  useEffect(() => {
    if (
      updateNotice &&
      data &&
      !dirty &&
      !nodeDirty &&
      !importOpen &&
      !subscriptionOpen &&
      !preview &&
      !closeOpen
    ) {
      setUpdatesOpen(true);
      setUpdateNotice(false);
    }
  }, [updateNotice, data, dirty, nodeDirty, importOpen, subscriptionOpen, preview, closeOpen]);
  const changeCore = async (item: CoreUpdate, rollback = false) => {
    if (updatingCore || busy || !data || checkInFlight.current || coreChangeInFlight.current) return;
    coreChangeInFlight.current = true;
    setUpdatingCore(item.core);
    setUpdateProgress(rollback ? '回退中' : '准备中');
    try {
      let config: string | undefined;
      let managed = false;
      try {
        const active = activeConfig(data);
        if (active.core === item.core) {
          config = active.config;
          managed = !data.selectedProfileId;
        }
      } catch {
        /* No selected configuration; the core's default check is sufficient. */
      }
      const next = rollback
        ? await desktop.rollbackCore(item.core)
        : await desktop.installCoreUpdate(item.core, item.latestVersion!, config, managed);
      setCoreUpdates((current) => current.map((value) => (value.core === next.core ? next : value)));
      await discover();
      notify(running ? '内核已更换，重新连接后生效' : rollback ? '内核已回退' : '内核已更新', 'success');
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      coreChangeInFlight.current = false;
      setUpdatingCore(null);
      setUpdateProgress('');
    }
  };
  const guarded = (action: () => void) => {
    if (
      ((page === 'cores' && dirty) || (page === 'nodes' && nodeDirty)) &&
      !window.confirm('有尚未保存的修改。放弃这些修改并继续？')
    )
      return;
    if (page === 'cores' && dirty) {
      setDraft(savedDraft);
      setProfileName(savedProfileName);
    }
    if (page === 'nodes' && nodeDirty) {
      setNodeDraft(nodeSavedDraft);
      setNodeName(data?.nodes.find((node) => node.id === editedNodeId)?.name ?? '');
    }
    action();
  };

  const requestClose = () => {
    if (!data) return;
    const unsaved = (page === 'cores' && dirty) || (page === 'nodes' && nodeDirty);
    if (unsaved && !window.confirm('配置有尚未保存的修改，仍然关闭窗口？')) return;
    if (data.settings.closeBehavior === 'ask' || !desktop.available) setCloseOpen(true);
    else desktop.close(data.settings.closeBehavior).catch((error) => notify(messageOf(error), 'error'));
  };
  closeHandler.current = requestClose;
  closeEditorState.current = (page === 'cores' && dirty) || (page === 'nodes' && nodeDirty);

  const startPrepared = async (
    request: { core: Core; config: string; name: string; mode: ConnectionMode; managed: boolean },
    download: boolean,
  ) => {
    const prepared = await desktop.prepareRules(request.core, request.config, download);
    if (prepared.missing.length) {
      setRuleRequest({ ...request, missing: prepared.missing });
      return;
    }
    const status = await desktop.start(request.core, prepared.config, request.mode, request.managed);
    setRuleRequest(null);
    setRuntime(status);
    if (status.message) notify(status.message);
    notify(`${coreLabel(request.core)} 已启动 · ${request.name}`, 'success');
  };

  const connect = async () => {
    if (!data || busy) return;
    setBusy(true);
    try {
      if (running) {
        setRuntime(await desktop.stop());
        notify('代理已停止', 'success');
      } else {
        const target = activeConfig(data);
        await startPrepared({ ...target, mode: data.mode, managed: !data.selectedProfileId }, false);
      }
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const importContent = (text: string, core: Core) => {
    const result = parseImport(text, core);
    if (!result.nodes.length && !result.profiles.length) return result;
    mutate((current) => ({
      ...current,
      nodes: [...current.nodes, ...result.nodes],
      profiles: [...current.profiles, ...result.profiles],
      selectedId: current.selectedId ?? result.nodes[0]?.id ?? null,
      selectedProfileId: running
        ? current.selectedProfileId
        : (result.profiles[0]?.id ?? current.selectedProfileId),
    }));
    notify(`已导入 ${result.nodes.length} 个节点、${result.profiles.length} 份原生配置`, 'success');
    return result;
  };

  const refreshSubscription = async (id: string) => {
    const sub = data?.subscriptions.find((item) => item.id === id);
    if (!sub || refreshing) return;
    setRefreshing(id);
    try {
      const content = await desktop.fetchSubscription(sub.url);
      const result = parseImport(content);
      if (result.errors.length || !result.nodes.length)
        throw new Error(`订阅未替换：${result.errors[0] || '没有可用节点'}。可下载内容后通过导入窗口检查。`);
      mutate((current) => {
        const nodes = mergeSubscriptionNodes(current.nodes, result.nodes, id);
        return {
          ...current,
          nodes,
          selectedId: nodes.some((node) => node.id === current.selectedId)
            ? current.selectedId
            : (nodes[0]?.id ?? null),
          subscriptions: current.subscriptions.map((item) =>
            item.id === id ? { ...item, updatedAt: new Date().toISOString() } : item,
          ),
        };
      });
      notify(`订阅已更新，共 ${result.nodes.length} 个节点；保留本地修改`, 'success');
    } catch (error) {
      notify(messageOf(error), 'error');
    } finally {
      setRefreshing(null);
    }
  };

  const openProfile = (profile: NativeProfile) =>
    guarded(() => {
      setEditorCore(profile.core);
      setEditorProfileId(profile.id);
      setDraft(profile.content);
      setSavedDraft(profile.content);
      setProfileName(profile.name);
      setSavedProfileName(profile.name);
    });
  const newProfile = (core: Core) =>
    guarded(() => {
      setEditorCore(core);
      setEditorProfileId(null);
      setDraft(nativeStarter(core));
      setSavedDraft(nativeStarter(core));
      setProfileName(`我的 ${coreLabel(core)} 配置`);
      setSavedProfileName(`我的 ${coreLabel(core)} 配置`);
    });
  const saveProfile = () => {
    try {
      validateObject(draft);
      if (!profileName.trim()) throw new Error('请为配置命名');
      const profile: NativeProfile = {
        id: editorProfileId ?? crypto.randomUUID(),
        name: profileName.trim(),
        core: editorCore,
        content: draft,
        updatedAt: new Date().toISOString(),
      };
      mutate((current) => ({
        ...current,
        profiles: [...current.profiles.filter((item) => item.id !== profile.id), profile],
      }));
      setEditorProfileId(profile.id);
      setSavedDraft(draft);
      setProfileName(profile.name);
      setSavedProfileName(profile.name);
      notify('原生配置已保存，原文与未知字段均保留', 'success');
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };
  const openNode = (node: ProxyNode) =>
    guarded(() => {
      setEditedNodeId(node.id);
      const text = JSON.stringify(node.outbound, null, 2);
      setNodeDraft(text);
      setNodeSavedDraft(text);
      setNodeName(node.name);
    });
  const saveNode = () => {
    try {
      const outbound = validateObject(nodeDraft);
      const node = data?.nodes.find((item) => item.id === editedNodeId);
      if (!node) throw new Error('请选择节点');
      if (!nodeName.trim()) throw new Error('节点名称不能为空');
      const protocol = outbound[node.core === 'xray' ? 'protocol' : 'type'];
      if (typeof protocol !== 'string' || !protocol) throw new Error('缺少原生协议字段');
      mutate((current) => ({
        ...current,
        nodes: current.nodes.map((item) =>
          item.id === node.id
            ? {
                ...item,
                name: nodeName.trim(),
                ...describeOutbound(outbound, node.core),
                outbound,
                locallyEdited: true,
              }
            : item,
        ),
      }));
      setNodeName(nodeName.trim());
      setNodeSavedDraft(nodeDraft);
      notify('节点出站已保存，不会被订阅更新覆盖', 'success');
    } catch (error) {
      notify(messageOf(error), 'error');
    }
  };

  if (loadError)
    return (
      <div className="fatal">
        <Brand />
        <h1>无法读取配置</h1>
        <p>{loadError}</p>
        <p>请检查配置文件或存储目录。</p>
        <button className="button primary" onClick={() => location.reload()}>
          重新读取
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="fatal">
        <Brand />
        <LoaderCircle className="spin" />
        <p>正在打开 Anibox…</p>
      </div>
    );

  const appearance = appearanceFor(data, page);
  const visibleNodes = data.nodes.filter(
    (node) =>
      (filter === 'all' || node.core === filter) &&
      `${node.name} ${node.protocol} ${node.server}`.toLowerCase().includes(search.toLowerCase()),
  );
  let selectedReason = '导入节点后自动选择合适的内核';
  try {
    if (selected) selectedReason = coreForNode(selected).reason;
  } catch (error) {
    selectedReason = messageOf(error);
  }
  const settingsAppearance = appearanceFor(data, appearancePage);
  const updateAppearance = (changes: Partial<typeof appearance>, target: Page = page) =>
    mutate((current) => ({
      ...current,
      settings: {
        ...current.settings,
        appearance: {
          ...current.settings.appearance,
          [target]: { ...appearanceFor(current, target), ...changes },
        },
      },
    }));

  return (
    <div
      className={`app-shell ${desktop.available ? 'desktop' : 'browser-preview'} ${maximized ? 'maximized' : ''}`}
    >
      <aside className="sidebar">
        <button
          className="brand-button"
          onClick={() => guarded(() => setPage('home'))}
          aria-label="Anibox 主界面"
        >
          <Brand />
        </button>
        <nav aria-label="主导航">
          {navigation.map(({ page: key, label, icon: Icon }) => (
            <button
              key={key}
              className={`nav-item ${page === key ? 'active' : ''}`}
              aria-current={page === key ? 'page' : undefined}
              onClick={() => guarded(() => setPage(key))}
            >
              <Icon size={21} strokeWidth={1.6} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <button
          className={`nav-item settings-nav ${page === 'settings' ? 'active' : ''}`}
          onClick={() => guarded(() => setPage('settings'))}
        >
          <Settings2 size={21} />
          <span>设置</span>
        </button>
      </aside>
      <main className="main-panel" style={{ '--surface-opacity': appearance.opacity / 100 } as CSSProperties}>
        <PageBackground
          image={backgroundImage}
          blur={appearance.blur}
          focus={appearance.focus}
          focusMode={appearance.focusMode}
        />
        <header className="titlebar" data-tauri-drag-region>
          <h1>{pageLabels[page]}</h1>
          <div className="titlebar-actions">
            {!desktop.available && <span className="preview-label">预览</span>}
            <IconButton
              icon={ImagePlus}
              label="页面背景"
              onClick={() => {
                backgroundTarget.current = page;
                backgroundInput.current?.click();
              }}
            />
            <IconButton
              icon={Minus}
              label="最小化窗口"
              onClick={() => {
                if (desktop.available) void getCurrentWindow().minimize();
              }}
            />
            <IconButton
              icon={Maximize2}
              label="最大化窗口"
              onClick={() => {
                if (desktop.available) void getCurrentWindow().toggleMaximize();
              }}
            />
            <IconButton icon={X} label="关闭窗口" className="window-close" onClick={requestClose} />
          </div>
        </header>
        <div className={`page-content ${page === 'settings' ? 'settings-page' : ''}`} data-page={page}>
          {page === 'home' && (
            <>
              <div className="status-strip glass">
                <span className={`state-badge ${running ? 'online' : ''}`} title={runtime.message}>
                  <span />
                  {running ? '运行中' : runtime.state === 'error' ? '已退出' : '已停止'}
                </span>
                <span className="current-core" title={selectedReason}>
                  <Cpu size={15} />
                  {selectedProfile
                    ? coreLabel(selectedProfile.core)
                    : selected
                      ? coreLabel(selected.core)
                      : '自动'}
                </span>
                <div
                  className="traffic-readout"
                  title={
                    traffic.available
                      ? `本次上传 ${formatBytes(traffic.uploadTotal)} / 下载 ${formatBytes(traffic.downloadTotal)}`
                      : '当前配置未提供统计'
                  }
                >
                  <span>
                    <ArrowUp size={14} />
                    {traffic.available ? formatBytes(traffic.uploadSpeed) + '/s' : '—'}
                  </span>
                  <span>
                    <ArrowDown size={14} />
                    {traffic.available ? formatBytes(traffic.downloadSpeed) + '/s' : '—'}
                  </span>
                </div>
                <IconButton icon={FileCode2} label="查看运行配置" onClick={() => void showConfig()} />
              </div>
              <div className="home-grid">
                <section className="glass proxy-panel">
                  <div className="section-heading">
                    <div className="section-title">
                      <h2>节点</h2>
                      <span className="count">{data.nodes.length}</span>
                    </div>
                    <button className="button primary" onClick={() => setImportOpen(true)}>
                      <Plus size={15} />
                      导入节点
                    </button>
                  </div>
                  <div className="list-toolbar">
                    <div className="segmented" aria-label="节点内核筛选">
                      {(['all', 'xray', 'sing-box'] as const).map((key) => (
                        <button
                          key={key}
                          className={filter === key ? 'selected' : ''}
                          onClick={() => setFilter(key)}
                        >
                          {key === 'all' ? '全部' : coreLabel(key)}
                        </button>
                      ))}
                    </div>
                    <div className="search-field">
                      <Search size={14} />
                      <input
                        aria-label="搜索节点"
                        placeholder="搜索"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                      {search && <IconButton icon={X} label="清除搜索" onClick={() => setSearch('')} />}
                    </div>
                  </div>
                  <div className="node-list">
                    {!visibleNodes.length ? (
                      <div className="empty-state">
                        {data.nodes.length ? (
                          <span>无匹配节点</span>
                        ) : (
                          <button className="button outlined" onClick={() => setImportOpen(true)}>
                            <Plus size={16} />
                            导入配置
                          </button>
                        )}
                      </div>
                    ) : (
                      visibleNodes.map((node) => (
                        <div
                          className={`proxy-row ${data.selectedId === node.id && !selectedProfile ? 'selected' : ''}`}
                          key={node.id}
                        >
                          <button
                            className="proxy-select"
                            aria-label={`选择 ${node.name}`}
                            disabled={running || busy}
                            onClick={() =>
                              mutate((current) => ({
                                ...current,
                                selectedId: node.id,
                                selectedProfileId: null,
                              }))
                            }
                          >
                            <span className={`node-avatar ${node.core === 'sing-box' ? 'purple' : ''}`}>
                              <Globe2 size={19} />
                            </span>
                            <span className="node-description">
                              <strong>{node.name}</strong>
                              <span>
                                {node.protocol.toUpperCase()} · {node.server}:{node.port}
                              </span>
                            </span>
                            <span className="core-chip">{coreLabel(node.core)}</span>
                            <span className="node-indicator">
                              {data.selectedId === node.id && !selectedProfile && <Check size={12} />}
                            </span>
                          </button>
                          <IconButton
                            icon={Ellipsis}
                            label={`编辑 ${node.name}`}
                            onClick={() =>
                              guarded(() => {
                                setPage('nodes');
                                setEditedNodeId(node.id);
                                const text = JSON.stringify(node.outbound, null, 2);
                                setNodeDraft(text);
                                setNodeSavedDraft(text);
                                setNodeName(node.name);
                              })
                            }
                          />
                        </div>
                      ))
                    )}
                  </div>
                </section>
                <aside className="glass connection-panel">
                  <label className="field-label" htmlFor="connection-mode">
                    连接方式
                  </label>
                  <div className="select-wrap">
                    <select
                      id="connection-mode"
                      value={data.mode}
                      disabled={running}
                      onChange={(event) =>
                        mutate((current) => ({ ...current, mode: event.target.value as AppData['mode'] }))
                      }
                    >
                      <option value="local">仅开放本地端口</option>
                      <option value="system">系统代理</option>
                      <option value="tun">TUN</option>
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <label className="field-label" htmlFor="route-mode">
                    分流
                  </label>
                  <div className="select-wrap">
                    <select
                      id="route-mode"
                      value={selectedProfile ? 'native' : data.route}
                      disabled={running || !!selectedProfile}
                      onChange={(event) =>
                        mutate((current) => ({ ...current, route: event.target.value as AppData['route'] }))
                      }
                    >
                      {selectedProfile && <option value="native">原生配置</option>}
                      <option value="bypass-cn">绕过中国大陆</option>
                      <option value="global">全局代理</option>
                      <option value="direct">全局直连</option>
                    </select>
                    <ChevronDown size={14} />
                  </div>
                  <div className="connection-details">
                    {selectedProfile ? (
                      <>
                        <span>原生配置</span>
                        <strong title={selectedProfile.name}>{selectedProfile.name}</strong>
                        <button
                          className="text-button"
                          disabled={running}
                          onClick={() => mutate((current) => ({ ...current, selectedProfileId: null }))}
                        >
                          切换到节点
                        </button>
                      </>
                    ) : (
                      <>
                        <div>
                          <span>SOCKS</span>
                          <code>
                            127.0.0.1:
                            {running ? (runtime.localPorts?.socks ?? data.settings.port) : data.settings.port}
                          </code>
                        </div>
                        <div>
                          <span>HTTP</span>
                          <code>
                            127.0.0.1:
                            {running
                              ? (runtime.localPorts?.http ?? data.settings.port + 1)
                              : data.settings.port + 1}
                          </code>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="connect-area">
                    <span className="selected-name" title={selectedProfile?.name ?? selected?.name}>
                      {selectedProfile?.name ?? selected?.name ?? '未选择节点'}
                    </span>
                    <button
                      className={`connect-button ${running ? 'is-connected' : ''}`}
                      disabled={busy || (!selected && !selectedProfile)}
                      onClick={() => void connect()}
                    >
                      {busy ? <LoaderCircle size={18} className="spin" /> : <Power size={18} />}
                      <span>{busy ? '处理中' : running ? '断开' : '连接'}</span>
                    </button>
                  </div>
                </aside>
              </div>
            </>
          )}
          {page === 'subscriptions' && (
            <section className="glass content-panel">
              <div className="section-heading">
                <h2>订阅</h2>
                <button className="button primary" onClick={() => setSubscriptionOpen(true)}>
                  <Plus size={15} />
                  添加订阅
                </button>
              </div>
              <div className="subscription-list scroll-region">
                {!data.subscriptions.length ? (
                  <div className="empty-state">
                    <span>无订阅</span>
                  </div>
                ) : (
                  data.subscriptions.map((sub) => (
                    <div className="subscription-row" key={sub.id}>
                      <Layers3 size={20} />
                      <div className="subscription-description">
                        <strong>{sub.name}</strong>
                        <span>
                          {new URL(sub.url).hostname} ·{' '}
                          {data.nodes.filter((node) => node.sourceId === sub.id).length} 个节点
                        </span>
                        {sub.updatedAt && <small>{new Date(sub.updatedAt).toLocaleString('zh-CN')}</small>}
                      </div>
                      <IconButton
                        icon={RefreshCw}
                        label={`更新订阅 ${sub.name}`}
                        disabled={!!refreshing}
                        onClick={() => void refreshSubscription(sub.id)}
                      />
                      <IconButton
                        icon={Trash2}
                        label={`删除订阅 ${sub.name}`}
                        onClick={() => {
                          if (window.confirm('删除订阅？已导入节点保留。'))
                            mutate((current) => ({
                              ...current,
                              subscriptions: current.subscriptions.filter((item) => item.id !== sub.id),
                              nodes: current.nodes.map((node) =>
                                node.sourceId === sub.id ? { ...node, sourceId: undefined } : node,
                              ),
                            }));
                        }}
                      />
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
          {page === 'cores' && (
            <div className="editor-layout">
              <section className="glass editor-panel">
                <div className="editor-toolbar">
                  <div className="core-tabs">
                    {(['xray', 'sing-box'] as Core[]).map((core) => (
                      <button
                        key={core}
                        className={editorCore === core ? 'active' : ''}
                        onClick={() => newProfile(core)}
                      >
                        {coreLabel(core)}
                      </button>
                    ))}
                  </div>
                  <span className="editor-state">
                    {dirty ? '未保存' : editorProfileId ? '已保存' : '新配置'}
                  </span>
                </div>
                <div className="filename-row">
                  <FileJson size={15} />
                  <input
                    aria-label="配置名称"
                    value={profileName}
                    onChange={(event) => setProfileName(event.target.value)}
                  />
                </div>
                <div className="code-container">
                  <Suspense fallback={<div className="editor-loading">加载中</div>}>
                    <JsonEditor value={draft} onChange={setDraft} />
                  </Suspense>
                </div>
              </section>
              <aside className="editor-sidebar">
                <section className="glass editor-tools">
                  <button className="button primary full" onClick={saveProfile}>
                    <Check size={15} />
                    保存配置
                  </button>
                  <button
                    className="button outlined full"
                    onClick={async () => {
                      try {
                        validateObject(draft);
                        notify(await desktop.validate(editorCore, draft), 'success');
                      } catch (error) {
                        notify(messageOf(error), 'error');
                      }
                    }}
                  >
                    <ShieldCheck size={15} />
                    校验配置
                  </button>
                  <button
                    className="tool-row"
                    onClick={() => {
                      try {
                        setDraft(JSON.stringify(validateObject(draft), null, 2));
                      } catch (error) {
                        notify(messageOf(error), 'error');
                      }
                    }}
                  >
                    <Code2 size={15} />
                    格式化
                  </button>
                  <button className="tool-row" onClick={() => setImportOpen(true)}>
                    <FileInput size={15} />
                    导入配置
                  </button>
                  <button
                    className="tool-row"
                    onClick={() => downloadText(`${editorCore}-config.json`, draft)}
                  >
                    <Download size={15} />
                    导出配置
                  </button>
                  <button
                    className="tool-row"
                    disabled={running}
                    onClick={() => {
                      if (!editorProfileId || dirty) {
                        notify('请先保存配置');
                        return;
                      }
                      mutate((current) => ({ ...current, selectedProfileId: editorProfileId }));
                      notify('已设为运行配置', 'success');
                    }}
                  >
                    <Radio size={15} />
                    设为运行配置
                  </button>
                </section>
                <section className="glass saved-profiles">
                  <div className="section-heading">
                    <h2>配置</h2>
                    <IconButton icon={Plus} label="新建原生配置" onClick={() => newProfile(editorCore)} />
                  </div>
                  <div className="scroll-region">
                    {data.profiles
                      .filter((item) => item.core === editorCore)
                      .map((profile) => (
                        <div className="saved-profile-row" key={profile.id}>
                          <button
                            className={`profile-link ${profile.id === editorProfileId ? 'active' : ''}`}
                            onClick={() => openProfile(profile)}
                          >
                            <FileCode2 size={14} />
                            <span>{profile.name}</span>
                          </button>
                          <IconButton
                            icon={Trash2}
                            label={`删除配置 ${profile.name}`}
                            disabled={running && profile.id === data.selectedProfileId}
                            onClick={() => {
                              if (!window.confirm('删除配置？')) return;
                              guarded(() => {
                                mutate((current) => ({
                                  ...current,
                                  profiles: current.profiles.filter((item) => item.id !== profile.id),
                                  selectedProfileId:
                                    current.selectedProfileId === profile.id
                                      ? null
                                      : current.selectedProfileId,
                                }));
                                if (editorProfileId === profile.id) {
                                  setEditorProfileId(null);
                                  setDraft(nativeStarter(editorCore));
                                  setSavedDraft(nativeStarter(editorCore));
                                }
                              });
                            }}
                          />
                        </div>
                      ))}
                  </div>
                </section>
                <section className="glass core-discovery">
                  <div className="section-heading">
                    <h2>内核</h2>
                    <IconButton
                      icon={RefreshCw}
                      label="检查内核更新"
                      disabled={!desktop.available || checkingUpdates || !!updatingCore}
                      onClick={() => void checkUpdates(true)}
                    />
                  </div>
                  {(['xray', 'sing-box'] as Core[]).map((core) => {
                    const info = cores.find((item) => item.core === core);
                    return (
                      <div className="core-status" key={core} title={info?.path ?? info?.error}>
                        <span className={`availability ${info?.available ? 'yes' : ''}`} />
                        <strong>{coreLabel(core)}</strong>
                        <span>{info?.version?.split('\n')[0].match(/\d+\.\d+\.\d+/)?.[0] ?? '—'}</span>
                      </div>
                    );
                  })}
                </section>
              </aside>
            </div>
          )}
          {page === 'nodes' && (
            <div className="editor-layout">
              <section className="glass editor-panel">
                {!editedNodeId || !data.nodes.some((node) => node.id === editedNodeId) ? (
                  <div className="empty-state">
                    <span>选择节点</span>
                  </div>
                ) : (
                  <>
                    <div className="editor-toolbar">
                      <input
                        className="node-name-input"
                        aria-label="节点名称"
                        value={nodeName}
                        onChange={(event) => setNodeName(event.target.value)}
                      />
                      <span className="editor-state">{nodeDirty ? '未保存' : '出站 JSON'}</span>
                    </div>
                    <div className="code-container">
                      <Suspense fallback={<div className="editor-loading">加载中</div>}>
                        <JsonEditor value={nodeDraft} onChange={setNodeDraft} />
                      </Suspense>
                    </div>
                  </>
                )}
              </section>
              <aside className="editor-sidebar">
                <section className="glass editor-tools">
                  <button className="button primary full" disabled={!editedNodeId} onClick={saveNode}>
                    <Check size={15} />
                    保存出站
                  </button>
                  <button className="tool-row" onClick={() => setImportOpen(true)}>
                    <Plus size={15} />
                    导入节点
                  </button>
                  <button
                    className="tool-row"
                    disabled={!editedNodeId}
                    onClick={() => downloadText('outbound.json', nodeDraft)}
                  >
                    <Download size={15} />
                    导出出站
                  </button>
                  {editedNodeId && (
                    <>
                      <label className="field-label" htmlFor="core-preference">
                        内核
                      </label>
                      <div className="select-wrap">
                        <select
                          id="core-preference"
                          value={
                            data.nodes.find((item) => item.id === editedNodeId)?.corePreference ?? 'auto'
                          }
                          onChange={(event) => {
                            const preference = event.target.value as ProxyNode['corePreference'];
                            mutate((current) => ({
                              ...current,
                              nodes: current.nodes.map((item) =>
                                item.id === editedNodeId
                                  ? { ...item, corePreference: preference, locallyEdited: true }
                                  : item,
                              ),
                            }));
                          }}
                        >
                          <option value="auto">自动</option>
                          <option value="xray">Xray</option>
                          <option value="sing-box">sing-box</option>
                        </select>
                        <ChevronDown size={14} />
                      </div>
                      <button
                        className="tool-row danger-text"
                        disabled={running}
                        onClick={() => {
                          if (!window.confirm('删除节点？')) return;
                          mutate((current) => ({
                            ...current,
                            nodes: current.nodes.filter((item) => item.id !== editedNodeId),
                            selectedId: current.selectedId === editedNodeId ? null : current.selectedId,
                          }));
                          setEditedNodeId(null);
                          setNodeDraft('');
                          setNodeSavedDraft('');
                          setNodeName('');
                        }}
                      >
                        <Trash2 size={15} />
                        删除节点
                      </button>
                    </>
                  )}
                </section>
                <section className="glass saved-profiles">
                  <div className="section-heading">
                    <h2>节点</h2>
                    <span className="count">{data.nodes.length}</span>
                  </div>
                  <div className="scroll-region">
                    {data.nodes.map((node) => (
                      <button
                        className={`profile-link ${editedNodeId === node.id ? 'active' : ''}`}
                        key={node.id}
                        onClick={() => openNode(node)}
                      >
                        <span>{node.name}</span>
                        <small>{coreLabel(node.core)}</small>
                      </button>
                    ))}
                  </div>
                </section>
              </aside>
            </div>
          )}
          {page === 'logs' && (
            <section className="glass content-panel">
              <div className="section-heading">
                <h2>日志</h2>
                <div className="log-actions">
                  <select
                    aria-label="日志来源"
                    value={logSource}
                    onChange={(event) => setLogSource(event.target.value)}
                  >
                    <option value="app">应用</option>
                    <option value="core">内核</option>
                  </select>
                  <IconButton
                    icon={Trash2}
                    label="清空日志"
                    onClick={() => {
                      void desktop
                        .clearLogs(logSource as 'app' | 'core')
                        .then(() => setCoreLog(''))
                        .catch((error) => notify(messageOf(error), 'error'));
                    }}
                  />
                </div>
              </div>
              <div className="event-list scroll-region">
                <pre className="core-log" aria-label={logSource === 'core' ? '内核日志' : '应用日志'}>
                  {coreLog || (logSource === 'core' ? '无内核输出' : '无日志')}
                </pre>
              </div>
            </section>
          )}
          {page === 'settings' && (
            <div className="settings-grid" inert={storageBusy}>
              <section className="glass settings-card">
                <h2>外观</h2>
                <label className="field-label" htmlFor="appearance-page">
                  页面
                </label>
                <div className="select-wrap">
                  <select
                    id="appearance-page"
                    value={appearancePage}
                    onChange={(event) => setAppearancePage(event.target.value as Page)}
                  >
                    {Object.entries(pageLabels).map(([key, label]) => (
                      <option value={key} key={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} />
                </div>
                <div className="button-pair">
                  <button
                    className="button outlined"
                    onClick={() => {
                      backgroundTarget.current = appearancePage;
                      backgroundInput.current?.click();
                    }}
                  >
                    <ImagePlus size={15} />
                    导入背景
                  </button>
                  <button
                    className="button quiet"
                    disabled={storageBusy}
                    onClick={() => void resetBackground(appearancePage)}
                  >
                    恢复默认
                  </button>
                </div>
                <label className="slider-label">
                  卡片不透明度<span>{settingsAppearance.opacity}%</span>
                  <input
                    aria-label="卡片不透明度"
                    type="range"
                    min={MIN_OPACITY}
                    max="100"
                    value={settingsAppearance.opacity}
                    onChange={(event) =>
                      updateAppearance({ opacity: Number(event.target.value) }, appearancePage)
                    }
                  />
                </label>
                <AppearancePreview appearance={settingsAppearance} directory={storage?.directory} />
                {(settingsAppearance.image || settingsAppearance.imageFile) && (
                  <>
                    <label className="field-label" htmlFor="background-focus-mode">
                      背景对焦
                    </label>
                    <div className="select-wrap">
                      <select
                        id="background-focus-mode"
                        value={settingsAppearance.focusMode ?? 'auto'}
                        onChange={(event) =>
                          updateAppearance(
                            { focusMode: event.target.value as 'auto' | 'manual' },
                            appearancePage,
                          )
                        }
                      >
                        <option value="auto">自动</option>
                        <option value="manual">手动</option>
                      </select>
                      <ChevronDown size={14} />
                    </div>
                    {settingsAppearance.focusMode === 'manual' &&
                      (['x', 'y'] as const).map((axis) => (
                        <label className="slider-label" key={axis}>
                          {axis === 'x' ? '水平焦点' : '垂直焦点'}
                          <span>{Math.round((settingsAppearance.focus?.[axis] ?? 0.5) * 100)}%</span>
                          <input
                            type="range"
                            aria-label={axis === 'x' ? '水平焦点' : '垂直焦点'}
                            min="0"
                            max="100"
                            value={Math.round((settingsAppearance.focus?.[axis] ?? 0.5) * 100)}
                            onChange={(event) =>
                              updateAppearance(
                                {
                                  focus: {
                                    x: settingsAppearance.focus?.x ?? 0.5,
                                    y: settingsAppearance.focus?.y ?? 0.5,
                                    [axis]: Number(event.target.value) / 100,
                                  },
                                },
                                appearancePage,
                              )
                            }
                          />
                        </label>
                      ))}
                  </>
                )}
                <label className="slider-label">
                  背景模糊<span>{settingsAppearance.blur}px</span>
                  <input
                    aria-label="背景模糊"
                    type="range"
                    min="0"
                    max="24"
                    value={settingsAppearance.blur}
                    onChange={(event) =>
                      updateAppearance({ blur: Number(event.target.value) }, appearancePage)
                    }
                  />
                </label>
              </section>
              <section className="glass settings-card storage-card">
                <h2>文件目录</h2>
                <label className="field-label" htmlFor="config-file-path">
                  配置文件
                </label>
                <input
                  id="config-file-path"
                  className="text-input storage-path"
                  readOnly
                  value={storage?.configFile ?? '仅桌面版可用'}
                  title={storage?.configFile}
                />
                <button
                  className="button outlined"
                  disabled={!desktop.available || storageBusy}
                  onClick={() =>
                    void desktop
                      .openStorageFolder('config')
                      .catch((error) => notify(messageOf(error), 'error'))
                  }
                >
                  <FolderOpen size={15} />
                  打开配置文件夹
                </button>
                <label className="field-label" htmlFor="background-directory-path">
                  背景文件夹
                </label>
                <input
                  id="background-directory-path"
                  className="text-input storage-path"
                  readOnly
                  value={storage?.backgroundDirectory ?? '仅桌面版可用'}
                  title={storage?.backgroundDirectory}
                />
                <div className="button-pair">
                  <button
                    className="button outlined"
                    disabled={!desktop.available || storageBusy}
                    onClick={() =>
                      void desktop
                        .openStorageFolder('backgrounds')
                        .catch((error) => notify(messageOf(error), 'error'))
                    }
                  >
                    <FolderOpen size={15} />
                    打开背景文件夹
                  </button>
                  <button
                    className="button quiet"
                    onClick={() =>
                      void desktop
                        .openStorageFolder('logs')
                        .catch((error) => notify(messageOf(error), 'error'))
                    }
                  >
                    <FolderOpen size={15} />
                    打开日志文件夹
                  </button>
                  <button
                    className="button quiet"
                    onClick={() =>
                      void desktop
                        .openStorageFolder('rules')
                        .catch((error) => notify(messageOf(error), 'error'))
                    }
                  >
                    <FolderOpen size={15} />
                    打开规则集文件夹
                  </button>
                  <button
                    className="button quiet"
                    disabled={storageBusy}
                    onClick={() => void resetBackground()}
                  >
                    恢复全部默认
                  </button>
                </div>
                <button
                  className="button primary"
                  disabled={!desktop.available || storageBusy}
                  title="复制配置与背景至新目录，原文件保留"
                  onClick={() => void changeStorage()}
                >
                  {storageBusy ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}
                  {storageBusy ? '处理中' : '更改存储目录'}
                </button>
              </section>
              <section className="glass settings-card">
                <h2>窗口与端口</h2>
                <label className="field-label" htmlFor="close-behavior">
                  关闭窗口时
                </label>
                <div className="select-wrap">
                  <select
                    id="close-behavior"
                    value={data.settings.closeBehavior}
                    onChange={(event) =>
                      mutate((current) => ({
                        ...current,
                        settings: {
                          ...current.settings,
                          closeBehavior: event.target.value as AppData['settings']['closeBehavior'],
                        },
                      }))
                    }
                  >
                    <option value="ask">每次询问</option>
                    <option value="tray">最小化到托盘</option>
                    <option value="exit">退出程序</option>
                  </select>
                  <ChevronDown size={14} />
                </div>
                <label className="field-label" htmlFor="local-port">
                  SOCKS 端口
                </label>
                <input
                  className="text-input"
                  id="local-port"
                  type="number"
                  min="1024"
                  max="65534"
                  defaultValue={data.settings.port}
                  disabled={running}
                  onBlur={(event) => {
                    const port = Number(event.target.value);
                    if (!Number.isInteger(port) || port < 1024 || port > 65534) {
                      event.target.value = String(data.settings.port);
                      notify('端口范围为 1024–65534', 'error');
                      return;
                    }
                    mutate((current) => ({ ...current, settings: { ...current.settings, port } }));
                  }}
                />
              </section>
              <section className="glass settings-card">
                <div className="section-heading">
                  <h2>sing-box 规则</h2>
                  <button
                    className="button outlined"
                    disabled={!desktop.available || updatingRules}
                    onClick={() => void refreshRules(true)}
                  >
                    <RefreshCw size={14} className={updatingRules ? 'spin' : ''} />
                    {updatingRules ? '更新中' : '更新规则'}
                  </button>
                </div>
                <div className="settings-detail">
                  <span>来源</span>
                  <span>2dust / Loyalsoldier</span>
                </div>
                <div className="settings-detail">
                  <span>自动更新</span>
                  <span>运行时 · 每 24 小时</span>
                </div>
                <div className="settings-detail">
                  <span>状态</span>
                  <span>{rules.ready ? '可用' : '未就绪'}</span>
                </div>
                {rules.updatedAt && (
                  <div className="settings-detail">
                    <span>更新于</span>
                    <span>{new Date(rules.updatedAt).toLocaleString('zh-CN')}</span>
                  </div>
                )}
              </section>
              <section className="glass settings-card">
                <h2>备份</h2>
                <div className="button-pair">
                  <button
                    className="button outlined"
                    disabled={storageBusy}
                    onClick={async () => {
                      try {
                        const raw = desktop.available
                          ? await desktop.exportData(JSON.stringify(data))
                          : JSON.stringify(data, null, 2);
                        downloadText('anibox-backup.json', raw);
                      } catch (error) {
                        notify(messageOf(error), 'error');
                      }
                    }}
                  >
                    <Download size={15} />
                    导出备份
                  </button>
                  <label className="button quiet backup-import">
                    <Upload size={15} />
                    恢复备份
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (!file) return;
                        try {
                          if (running) throw new Error('请先断开连接');
                          const next = parseData(await file.text());
                          if (window.confirm('用备份替换当前数据？')) {
                            if (desktop.available) {
                              await persistenceQueue;
                              await desktop.saveData(JSON.stringify(next));
                              setData(parseData(await desktop.loadData()));
                            } else setData(next);
                            notify('备份已恢复', 'success');
                          }
                        } catch (error) {
                          notify(messageOf(error), 'error');
                        }
                      }}
                    />
                  </label>
                </div>
              </section>
            </div>
          )}
        </div>
        <input
          ref={backgroundInput}
          className="hidden-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (storageBusy) return;
            try {
              const target = backgroundTarget.current;
              const image = await readBackground(file);
              if (desktop.available)
                updateAppearance(
                  {
                    image: undefined,
                    imageFile: await desktop.storeBackground(target, image),
                    focusMode: 'auto',
                    focus: undefined,
                  },
                  target,
                );
              else
                updateAppearance(
                  { image, imageFile: undefined, focusMode: 'auto', focus: undefined },
                  target,
                );
              notify('背景已更新', 'success');
            } catch (error) {
              notify(messageOf(error), 'error');
            }
          }}
        />
      </main>

      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button onClick={() => setToast('')} aria-label="关闭提示">
            <X size={15} />
          </button>
        </div>
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImport={importContent} />}
      {updatesOpen && (
        <Modal
          title="内核更新"
          onClose={() => {
            if (!updatingCore) setUpdatesOpen(false);
          }}
        >
          <div className="core-update-list">
            {coreUpdates.map((item) => (
              <div className="core-update-item" key={item.core}>
                <div className="core-update-title">
                  <strong>{coreLabel(item.core)}</strong>
                  <span>
                    {item.currentVersion ?? '未安装'}
                    {item.available && ` → ${item.latestVersion}`}
                  </span>
                </div>
                <div className="core-update-actions">
                  {item.rollbackAvailable && (
                    <button
                      className="button quiet"
                      disabled={!!updatingCore || busy || checkingUpdates}
                      onClick={() => void changeCore(item, true)}
                    >
                      回退
                    </button>
                  )}
                  <button
                    className="button primary"
                    disabled={!item.available || !!updatingCore || busy || checkingUpdates}
                    onClick={() => void changeCore(item)}
                  >
                    {updatingCore === item.core ? (
                      <>
                        <LoaderCircle className="spin" size={14} />
                        {updateProgress}
                      </>
                    ) : item.available ? (
                      '更新'
                    ) : item.error ? (
                      '检查失败'
                    ) : (
                      '已是最新'
                    )}
                  </button>
                </div>
                {item.error && <p className="core-update-error">{item.error}</p>}
              </div>
            ))}
          </div>
          <div className="modal-footer">
            <button
              className="button quiet"
              disabled={!!updatingCore || checkingUpdates}
              onClick={() => void checkUpdates(true)}
            >
              <RefreshCw size={14} className={checkingUpdates ? 'spin' : ''} />
              检查更新
            </button>
            <button
              className="button outlined"
              disabled={!!updatingCore}
              onClick={() => setUpdatesOpen(false)}
            >
              关闭
            </button>
          </div>
        </Modal>
      )}
      {subscriptionOpen && (
        <SubscriptionDialog
          onClose={() => setSubscriptionOpen(false)}
          onSave={(name, url) => {
            mutate((current) => ({
              ...current,
              subscriptions: [...current.subscriptions, { id: crypto.randomUUID(), name, url }],
            }));
            setSubscriptionOpen(false);
            notify('订阅已保存。点击更新以获取节点。', 'success');
          }}
        />
      )}
      {preview && (
        <Modal title="配置预览" description={coreLabel(preview.core)} onClose={() => setPreview(null)} wide>
          <div className="preview-editor">
            <Suspense fallback={<div className="editor-loading">正在加载…</div>}>
              <JsonEditor value={preview.config} readOnly />
            </Suspense>
          </div>
          <div className="modal-footer">
            <button
              className="button quiet"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(preview.config);
                  notify('已复制配置，内容包含凭据，请妥善保管');
                } catch {
                  notify('无法访问剪贴板，请使用导出');
                }
              }}
            >
              <Copy size={15} />
              复制
            </button>
            <button
              className="button primary"
              onClick={() => downloadText('runtime-config.json', preview.config)}
            >
              <Download size={15} />
              导出 JSON
            </button>
          </div>
        </Modal>
      )}
      {ruleRequest && (
        <Modal
          title="缺少规则集"
          onClose={() => {
            if (!busy) setRuleRequest(null);
          }}
        >
          <p>从 2dust/sing-box-rules 下载至程序的 rules 文件夹。</p>
          <div className="rule-download-list">
            {ruleRequest.missing.map((rule) => (
              <div key={rule.tag}>
                <span>{rule.tag}</span>
                <span>{rule.source ? rule.filename : '未找到公共来源，请指定 URL 或本地文件'}</span>
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="button quiet" disabled={busy} onClick={() => setRuleRequest(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy || ruleRequest.missing.some((rule) => !rule.source)}
              onClick={async () => {
                setBusy(true);
                try {
                  await startPrepared(ruleRequest, true);
                } catch (error) {
                  notify(messageOf(error), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '处理中…' : '下载并连接'}
            </button>
          </div>
        </Modal>
      )}
      {closeOpen && (
        <CloseDialog
          onClose={() => setCloseOpen(false)}
          onConfirm={async (action, remember) => {
            try {
              await persistenceQueue;
              if (remember) {
                const next = { ...data, settings: { ...data.settings, closeBehavior: action } };
                setData(next);
                if (desktop.available) await desktop.saveData(JSON.stringify(next));
              }
              await persistenceQueue;
              await desktop.close(action);
              setCloseOpen(false);
            } catch (error) {
              notify(messageOf(error), 'error');
            }
          }}
        />
      )}
    </div>
  );
}

function ImportDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (text: string, core: Core) => ReturnType<typeof parseImport>;
}) {
  const [text, setText] = useState('');
  const [core, setCore] = useState<Core>('xray');
  const [errors, setErrors] = useState<string[]>([]);
  const [imported, setImported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Modal title="导入配置" onClose={onClose}>
      <div className="import-tabs">
        <span>
          <ClipboardPaste size={16} />
          粘贴内容
        </span>
        <button className="text-button" onClick={() => inputRef.current?.click()}>
          <FileInput size={15} />
          从文件导入
        </button>
      </div>
      <textarea
        className="import-textarea"
        aria-label="导入内容"
        autoFocus
        placeholder={'vless://…\nhysteria2://…\n\n也可以直接粘贴原生 JSON 配置'}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setImported(false);
          setErrors([]);
        }}
      />
      <input
        className="hidden-input"
        type="file"
        ref={inputRef}
        accept=".json,.txt,.conf,.yaml,.yml"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          if (file.size > 5 * 1024 * 1024) {
            setErrors(['文件不能超过 5 MB']);
            return;
          }
          setText(await file.text());
          setImported(false);
        }}
      />
      <div className="import-options">
        <span>无法自动识别的原生配置使用</span>
        <select
          aria-label="原生配置内核"
          value={core}
          onChange={(event) => setCore(event.target.value as Core)}
        >
          <option value="xray">Xray</option>
          <option value="sing-box">sing-box</option>
        </select>
      </div>
      {errors.length > 0 && (
        <div className="inline-error" role="alert">
          {errors.map((error, index) => (
            <p key={index}>{error}</p>
          ))}
          {imported && <p>有效条目已导入；修正错误后请只导入失败的条目。</p>}
        </div>
      )}
      <div className="modal-footer">
        <button className="button quiet" onClick={onClose}>
          {imported ? '完成' : '取消'}
        </button>
        <button
          className="button primary"
          disabled={!text.trim() || imported}
          onClick={() => {
            const result = onImport(text, core);
            setErrors(result.errors);
            if (result.nodes.length || result.profiles.length) {
              setImported(true);
              if (!result.errors.length) onClose();
            }
          }}
        >
          <Plus size={16} />
          导入
        </button>
      </div>
    </Modal>
  );
}

function SubscriptionDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, url: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title="添加订阅" onClose={onClose}>
      <label className="field-label" htmlFor="subscription-name">
        订阅名称
      </label>
      <input
        className="text-input"
        id="subscription-name"
        autoFocus
        placeholder="例如：日常连接"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="field-label" htmlFor="subscription-url">
        订阅地址
      </label>
      <input
        className="text-input"
        id="subscription-url"
        type="url"
        placeholder="https://…"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-footer">
        <button className="button quiet" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          onClick={() => {
            try {
              const parsed = new URL(url.trim());
              if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
                throw new Error();
              onSave(name.trim() || parsed.hostname, parsed.href);
            } catch {
              setError('请输入有效的 HTTP / HTTPS 订阅地址');
            }
          }}
        >
          <Plus size={15} />
          保存订阅
        </button>
      </div>
    </Modal>
  );
}

function CloseDialog({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (action: 'tray' | 'exit', remember: boolean) => Promise<void>;
}) {
  const [remember, setRemember] = useState(false);
  const [pending, setPending] = useState(false);
  const choose = async (action: 'tray' | 'exit') => {
    setPending(true);
    try {
      await onConfirm(action, remember);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title="关闭窗口"

      onClose={onClose}
    >
      <div className="close-choices">
        <button disabled={pending} onClick={() => void choose('tray')}>
          <Monitor size={24} />
          <strong>最小化到托盘</strong>
        </button>
        <button disabled={pending} onClick={() => void choose('exit')}>
          <Power size={24} />
          <strong>退出程序</strong>
        </button>
      </div>
      <label className="checkbox-label">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        以后不再询问
      </label>
    </Modal>
  );
}
