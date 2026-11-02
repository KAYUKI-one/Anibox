import type { Core, ImportResult, JsonObject, ProxyNode } from './types';

const makeId = () => crypto.randomUUID();
const asObject = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
  return value as JsonObject;
};

export function decodeBase64(text: string): string {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
  );
}

export function describeOutbound(outbound: JsonObject, core: Core) {
  const settings = outbound.settings as JsonObject | undefined;
  const servers = settings?.vnext ?? settings?.servers;
  const first = Array.isArray(servers) ? (servers[0] as JsonObject) : undefined;
  const server = String(outbound.server ?? first?.address ?? settings?.address ?? '自定义出站');
  const port = Number(outbound.server_port ?? first?.port ?? settings?.port ?? 0);
  const protocol = String(core === 'xray' ? outbound.protocol : outbound.type);
  if (!protocol || protocol === 'undefined') throw new Error('缺少出站协议字段');
  return { protocol, server, port };
}

function nodeFromOutbound(outbound: JsonObject, core: Core, name?: string, sourceText = ''): ProxyNode {
  const { protocol, server, port } = describeOutbound(outbound, core);
  return {
    id: makeId(),
    name: name || String(outbound.tag ?? server),
    protocol,
    server,
    port,
    core,
    corePreference: 'auto',
    outbound,
    sourceText,
    importedAt: new Date().toISOString(),
  };
}

function assertParams(url: URL, names: string[]) {
  const extra = [...url.searchParams.keys()].filter((key) => !names.includes(key));
  if (extra.length)
    throw new Error(`暂不支持参数 ${[...new Set(extra)].join('、')}，请改用原生 JSON 导入以保留配置`);
}

function tlsFor(url: URL, core: Core): JsonObject {
  const q = url.searchParams;
  const serverName = q.get('sni') || q.get('peer') || undefined;
  const insecure = q.get('insecure') === '1' || q.get('allowInsecure') === '1';
  const alpn = q.get('alpn')?.split(',').filter(Boolean);
  if (core === 'sing-box') return { enabled: true, server_name: serverName, insecure, alpn };
  return { serverName, allowInsecure: insecure, alpn, fingerprint: q.get('fp') || undefined };
}

function parseLink(input: string): ProxyNode {
  const scheme = input.slice(0, input.indexOf(':')).toLowerCase();
  if (scheme === 'ss') return parseShadowsocks(input);
  if (!['vless', 'trojan', 'hysteria2', 'hy2', 'tuic'].includes(scheme)) {
    throw new Error(`暂未实现 ${scheme || '此'} 分享链接解析，可导入原生 JSON`);
  }
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (['trojan', 'hy2', 'hysteria2', 'tuic'].includes(scheme) ? 443 : 0));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('服务器或端口无效');
  const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : host;
  const q = url.searchParams;
  let outbound: JsonObject;
  let core: Core;
  if (scheme === 'hy2' || scheme === 'hysteria2') {
    core = 'sing-box';
    assertParams(url, ['sni', 'peer', 'insecure', 'allowInsecure', 'alpn', 'obfs', 'obfs-password']);
    const password =
      decodeURIComponent(url.username) + (url.password ? `:${decodeURIComponent(url.password)}` : '');
    if (!password) throw new Error('缺少 Hysteria2 密码');
    const obfs = q.get('obfs');
    if (obfs && obfs !== 'salamander') throw new Error('仅支持 salamander 混淆，请使用原生 JSON');
    outbound = {
      type: 'hysteria2',
      server: host,
      server_port: port,
      password,
      tls: tlsFor(url, core),
      ...(obfs ? { obfs: { type: obfs, password: q.get('obfs-password') || '' } } : {}),
    };
  } else if (scheme === 'tuic') {
    core = 'sing-box';
    assertParams(url, ['sni', 'insecure', 'allowInsecure', 'alpn', 'congestion_control', 'udp_relay_mode']);
    if (!url.username || !url.password) throw new Error('TUIC 需要 UUID 和密码');
    outbound = {
      type: 'tuic',
      server: host,
      server_port: port,
      uuid: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      tls: tlsFor(url, core),
      congestion_control: q.get('congestion_control') || 'cubic',
      udp_relay_mode: q.get('udp_relay_mode') || 'native',
    };
  } else {
    core = 'xray';
    assertParams(url, [
      'type',
      'security',
      'encryption',
      'flow',
      'sni',
      'peer',
      'fp',
      'alpn',
      'pbk',
      'sid',
      'spx',
      'path',
      'host',
      'serviceName',
      'authority',
      'mode',
      'extra',
      'allowInsecure',
      'insecure',
    ]);
    const transport = q.get('type') || 'tcp';
    if (!['tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp'].includes(transport)) {
      throw new Error(`暂不支持 ${transport} 链接转换，请使用原生 JSON`);
    }
    const security = q.get('security') || (scheme === 'trojan' ? 'tls' : 'none');
    if (!['none', 'tls', 'reality'].includes(security)) throw new Error(`暂不支持 ${security} 安全层`);
    const streamSettings: JsonObject = { network: transport === 'tcp' ? 'raw' : transport, security };
    if (security === 'tls') streamSettings.tlsSettings = tlsFor(url, core);
    if (security === 'reality')
      streamSettings.realitySettings = {
        serverName: q.get('sni') || '',
        fingerprint: q.get('fp') || 'chrome',
        publicKey: q.get('pbk') || '',
        shortId: q.get('sid') || '',
        spiderX: q.get('spx') || '/',
      };
    if (['ws', 'httpupgrade'].includes(transport))
      streamSettings[`${transport}Settings`] = {
        path: q.get('path') || '/',
        ...(transport === 'ws'
          ? { headers: { Host: q.get('host') || host } }
          : { host: q.get('host') || host }),
      };
    if (transport === 'grpc')
      streamSettings.grpcSettings = {
        serviceName: q.get('serviceName') || '',
        authority: q.get('authority') || undefined,
        multiMode: q.get('mode') === 'multi',
      };
    if (transport === 'xhttp')
      streamSettings.xhttpSettings = {
        path: q.get('path') || '/',
        host: q.get('host') || undefined,
        mode: q.get('mode') || 'auto',
        ...(q.has('extra') ? { extra: asObject(JSON.parse(q.get('extra')!)) } : {}),
      };
    const credential = decodeURIComponent(url.username);
    if (!credential || url.password) throw new Error('节点身份或密码格式无效');
    const settings =
      scheme === 'vless'
        ? {
            vnext: [
              {
                address: host,
                port,
                users: [
                  { id: credential, encryption: q.get('encryption') || 'none', flow: q.get('flow') || '' },
                ],
              },
            ],
          }
        : { servers: [{ address: host, port, password: credential }] };
    outbound = { protocol: scheme, settings, streamSettings };
  }
  return nodeFromOutbound(outbound, core, name, input);
}

function parseShadowsocks(input: string): ProxyNode {
  let normalized = input;
  const payload = input.slice(5).split('#')[0];
  if (!payload.includes('@')) {
    const hash = input.includes('#') ? input.slice(input.indexOf('#')) : '';
    normalized = `ss://${decodeBase64(payload)}${hash}`;
  }
  const url = new URL(normalized);
  assertParams(url, []); // Plugins require explicit native configuration.
  let credentials = decodeURIComponent(url.username);
  if (url.password) credentials += `:${decodeURIComponent(url.password)}`;
  else credentials = decodeBase64(credentials);
  const separator = credentials.indexOf(':');
  if (separator < 1) throw new Error('Shadowsocks 身份格式无效');
  const method = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);
  const port = Number(url.port);
  if (!password || !url.hostname || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Shadowsocks 地址或密码无效');
  return nodeFromOutbound(
    {
      protocol: 'shadowsocks',
      settings: {
        servers: [
          {
            address: url.hostname.replace(/^\[|\]$/g, ''),
            port,
            method,
            password,
          },
        ],
      },
    },
    'xray',
    url.hash ? decodeURIComponent(url.hash.slice(1)) : url.hostname,
    input,
  );
}

export function parseImport(text: string, nativeCore: Core = 'xray'): ImportResult {
  const result: ImportResult = { nodes: [], profiles: [], errors: [] };
  let trimmed = text.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return { ...result, errors: ['请粘贴节点链接、订阅内容或原生 JSON'] };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        const obj = asObject(parsed);
        if (Array.isArray(obj.inbounds) || Array.isArray(obj.outbounds)) {
          const core: Core =
            'route' in obj ||
            (obj.outbounds as JsonObject[] | undefined)?.some((o) => typeof o.type === 'string')
              ? 'sing-box'
              : nativeCore;
          result.profiles.push({
            id: makeId(),
            name: `导入的 ${core} 配置`,
            core,
            content: trimmed,
            updatedAt: new Date().toISOString(),
          });
          return result;
        }
      }
      for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
        const obj = asObject(value);
        result.nodes.push(
          nodeFromOutbound(
            obj,
            typeof obj.protocol === 'string'
              ? 'xray'
              : typeof obj.type === 'string'
                ? 'sing-box'
                : nativeCore,
            undefined,
            JSON.stringify(obj),
          ),
        );
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : 'JSON 无效');
    }
    return result;
  }
  if (!trimmed.includes('://')) {
    try {
      trimmed = decodeBase64(trimmed).trim();
    } catch {
      return { ...result, errors: ['无法识别内容，请检查分享链接或 Base64 订阅'] };
    }
  }
  for (const [index, line] of trimmed.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    try {
      result.nodes.push(parseLink(line.trim()));
    } catch (error) {
      result.errors.push(`第 ${index + 1} 行：${error instanceof Error ? error.message : '解析失败'}`);
    }
  }
  return result;
}

export function coreForNode(node: ProxyNode): { core: Core; reason: string } {
  if (node.corePreference !== 'auto') {
    if (node.corePreference !== node.core)
      throw new Error('此出站是另一内核的原生格式，请先转换 JSON；不会自动丢弃字段转换。');
    return { core: node.core, reason: '使用节点指定的内核' };
  }
  return {
    core: node.core,
    reason: ['hysteria2', 'hy2', 'tuic'].includes(node.protocol)
      ? `${node.protocol.toUpperCase()} 默认使用 sing-box，TUN 入口随内核切换`
      : node.core === 'xray'
        ? 'Xray 优先 · 保留原生出站参数'
        : '使用 sing-box 原生出站配置',
  };
}

export function mergeSubscriptionNodes(
  current: ProxyNode[],
  incoming: ProxyNode[],
  sourceId: string,
): ProxyNode[] {
  const old = current.filter((node) => node.sourceId === sourceId);
  const matchKey = (node: ProxyNode) =>
    `${node.name}\u0000${node.protocol}\u0000${node.server}\u0000${node.port}`;
  const retained = current.filter((node) => node.sourceId !== sourceId || node.locallyEdited);
  const edited = new Set(old.filter((node) => node.locallyEdited).map(matchKey));
  const replaced = incoming
    .filter((node) => !edited.has(matchKey(node)))
    .map((node) => ({
      ...node,
      id:
        old.find((previous) => !previous.locallyEdited && matchKey(previous) === matchKey(node))?.id ??
        node.id,
      sourceId,
    }));
  return [...retained, ...replaced];
}
