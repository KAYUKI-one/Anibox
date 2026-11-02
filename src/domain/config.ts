import type { AppData, Core, JsonObject, ProxyNode } from './types';
import { coreForNode } from './import';

export function validateObject(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('配置顶层必须是 JSON 对象');
  return value as JsonObject;
}

// Templates are intentionally small. Native profiles never pass through this generator.
export function buildConfig(node: ProxyNode, data: AppData): { core: Core; config: string } {
  if (node.example) throw new Error('示例节点仅用于预览界面，请导入自己的节点后连接。');
  const { core } = coreForNode(node);
  const port = data.settings.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('本地端口应在 1024–65534 之间');
  const outbound: JsonObject = { ...structuredClone(node.outbound), tag: 'proxy' };
  let config: JsonObject;
  if (core === 'xray') {
    const stream = (outbound.streamSettings ?? {}) as JsonObject;
    outbound.streamSettings = {
      ...stream,
      sockopt: { domainStrategy: 'UseIP', ...((stream.sockopt ?? {}) as JsonObject) },
    };
    const rules: JsonObject[] = [];
    if (data.route !== 'global') rules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' });
    if (data.route === 'bypass-cn')
      rules.push(
        { type: 'field', domain: ['geosite:private', 'geosite:cn'], outboundTag: 'direct' },
        { type: 'field', ip: ['geoip:cn'], outboundTag: 'direct' },
      );
    rules.push({
      type: 'field',
      network: 'tcp,udp',
      outboundTag: data.route === 'direct' ? 'direct' : 'proxy',
    });
    config = {
      log: { loglevel: 'warning' },
      dns: {
        tag: 'dns-internal',
        servers: [
          {
            address: '223.5.5.5',
            domains: [`full:${node.server}`, ...(data.route === 'bypass-cn' ? ['geosite:cn'] : [])],
            skipFallback: true,
          },
          'https://1.1.1.1/dns-query',
        ],
      },
      inbounds: [
        ...(data.mode === 'tun'
          ? [
              {
                tag: 'tun-in',
                protocol: 'tun',
                sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true },
                settings: {
                  name: 'Anibox',
                  desc: 'Anibox',
                  mtu: 1500,
                  gateway: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
                  dns: ['1.1.1.1'],
                  autoSystemRoutingTable: ['0.0.0.0/0', '::/0'],
                  autoOutboundsInterface: 'auto',
                },
              },
            ]
          : []),
        {
          tag: 'socks-in',
          listen: '127.0.0.1',
          port,
          protocol: 'socks',
          settings: { auth: 'noauth', udp: true },
        },
        { tag: 'http-in', listen: '127.0.0.1', port: port + 1, protocol: 'http', settings: {} },
      ],
      outbounds: [
        outbound,
        { protocol: 'freedom', tag: 'direct' },
        { protocol: 'blackhole', tag: 'block' },
        ...(data.mode === 'tun' ? [{ protocol: 'dns', tag: 'dns-out' }] : []),
      ],
      routing: {
        domainStrategy: 'IPIfNonMatch',
        rules: [
          { type: 'field', inboundTag: ['dns-internal'], ip: ['223.5.5.5'], outboundTag: 'direct' },
          ...(data.mode === 'tun'
            ? [{ type: 'field', inboundTag: ['tun-in'], port: '53', outboundTag: 'dns-out' }]
            : []),
          ...rules,
        ],
      },
    };
  } else {
    config = {
      log: { level: 'warn', timestamp: true },
      dns: {
        servers: [
          { type: 'udp', tag: 'direct-dns', server: '223.5.5.5', server_port: 53 },
          {
            type: 'https',
            tag: 'proxy-dns',
            server: '1.1.1.1',
            path: '/dns-query',
            detour: 'proxy',
            tls: { enabled: true, server_name: 'cloudflare-dns.com' },
          },
        ],
        rules: [
          { domain: [node.server], action: 'route', server: 'direct-dns' },
          ...(data.route === 'bypass-cn'
            ? [{ rule_set: ['geosite-cn'], action: 'route', server: 'direct-dns' }]
            : []),
        ],
        final: data.route === 'direct' ? 'direct-dns' : 'proxy-dns',
      },
      inbounds: [
        ...(data.mode === 'tun'
          ? [
              {
                type: 'tun',
                tag: 'tun-in',
                interface_name: 'Anibox',
                address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
                mtu: 1500,
                auto_route: true,
                strict_route: true,
                dns_mode: 'hijack',
              },
            ]
          : []),
        { type: 'socks', tag: 'socks-in', listen: '127.0.0.1', listen_port: port },
        { type: 'http', tag: 'http-in', listen: '127.0.0.1', listen_port: port + 1 },
      ],
      outbounds: [outbound, { type: 'direct', tag: 'direct' }],
      route: {
        default_domain_resolver: 'direct-dns',
        rules: [
          ...(data.mode === 'tun' ? [{ inbound: ['tun-in'], action: 'sniff' }] : []),
          ...(data.mode === 'tun' ? [{ inbound: ['tun-in'], port: 53, action: 'hijack-dns' }] : []),
          { ip_is_private: true, action: 'route', outbound: 'direct' },
          ...(data.route === 'bypass-cn'
            ? [{ rule_set: ['geosite-cn', 'geoip-cn'], action: 'route', outbound: 'direct' }]
            : []),
        ],
        ...(data.route === 'bypass-cn'
          ? {
              rule_set: [
                { type: 'local', tag: 'geosite-cn', format: 'binary', path: 'rules/geosite-cn.srs' },
                { type: 'local', tag: 'geoip-cn', format: 'binary', path: 'rules/geoip-cn.srs' },
              ],
            }
          : {}),
        final: data.route === 'direct' ? 'direct' : 'proxy',
        auto_detect_interface: true,
      },
    };
  }
  return { core, config: JSON.stringify(config, null, 2) };
}

export function activeConfig(data: AppData): { core: Core; config: string; name: string } {
  if (data.selectedProfileId) {
    const profile = data.profiles.find((item) => item.id === data.selectedProfileId);
    if (!profile) throw new Error('所选原生配置不存在');
    validateObject(profile.content);
    return { core: profile.core, config: profile.content, name: profile.name };
  }
  const node = data.nodes.find((item) => item.id === data.selectedId);
  if (!node) throw new Error('请先导入并选择一个节点');
  return { ...buildConfig(node, data), name: node.name };
}

export const nativeStarter = (core: Core) =>
  JSON.stringify(
    core === 'xray'
      ? {
          log: { loglevel: 'warning' },
          inbounds: [
            { tag: 'socks-in', listen: '127.0.0.1', port: 10808, protocol: 'socks', settings: { udp: true } },
          ],
          outbounds: [{ tag: 'direct', protocol: 'freedom' }],
        }
      : {
          log: { level: 'warn' },
          inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 10808 }],
          outbounds: [{ type: 'direct', tag: 'direct' }],
        },
    null,
    2,
  );
