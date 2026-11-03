import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { activeConfig, buildConfig } from './config';
import { coreForNode, decodeBase64, mergeSubscriptionNodes, parseImport } from './import';
import { emptyData, parseData } from './storage';

const vless =
  'vless://11111111-1111-4111-8111-111111111111@127.0.0.1:443?security=tls&type=ws&path=%2Fsocket&sni=example.com#My%20node';
const hy2 = 'hysteria2://test-password@127.0.0.1:443?sni=example.com#HY2';

describe('node imports and core policy', () => {
  it('preserves VLESS TLS and transport settings and selects Xray', () => {
    const result = parseImport(vless);
    expect(result.errors).toEqual([]);
    expect(result.nodes[0].name).toBe('My node');
    expect(result.nodes[0].outbound.streamSettings).toMatchObject({
      network: 'ws',
      security: 'tls',
      wsSettings: { path: '/socket' },
    });
    expect(coreForNode(result.nodes[0]).core).toBe('xray');
  });
  it('selects sing-box for Hysteria2, including its future TUN entry', () => {
    const node = parseImport(hy2).nodes[0];
    expect(coreForNode(node)).toMatchObject({ core: 'sing-box' });
    expect(node.outbound).toMatchObject({
      type: 'hysteria2',
      password: 'test-password',
      tls: { server_name: 'example.com' },
    });
  });
  it('keeps valid lines and reports unsupported parameters instead of dropping them', () => {
    const result = parseImport(`${vless}\n${vless}&unsupported=secret`);
    expect(result.nodes).toHaveLength(2); // The suffix is a fragment here, not a query parameter.
    const unsupported = parseImport(vless.replace('#My%20node', '&unsupported=secret#name'));
    expect(unsupported.nodes).toEqual([]);
    expect(unsupported.errors[0]).toContain('unsupported');
    expect(unsupported.errors[0]).not.toContain('secret');
  });
  it('decodes UTF-8 URL-safe base64 subscriptions', () => {
    const encoded = Buffer.from(`${vless}\n${hy2}`).toString('base64url');
    expect(decodeBase64(encoded)).toContain('hysteria2://');
    expect(parseImport(encoded).nodes).toHaveLength(2);
  });
  it('preserves unknown fields on native outbound import', () => {
    const result = parseImport(
      '{"type":"future-protocol","server":"example.com","server_port":443,"future_field":{"enabled":true}}',
    );
    expect(result.nodes[0].core).toBe('sing-box');
    expect(result.nodes[0].outbound.future_field).toEqual({ enabled: true });
  });
  it('keeps full native profile text byte-for-byte', () => {
    const original = '{\n  "outbounds": [{ "protocol": "freedom", "unrecognized": 42 }]\n}';
    const profile = parseImport(original).profiles[0];
    const data = { ...emptyData(), profiles: [profile], selectedProfileId: profile.id };
    expect(activeConfig(data).config).toBe(original);
  });
  it('does not pretend a cross-core override can convert native JSON', () => {
    const node = parseImport(vless).nodes[0];
    expect(() => coreForNode({ ...node, corePreference: 'sing-box' })).toThrow('原生格式');
  });
  it('parses modern SIP002 and legacy Shadowsocks without losing colons in passwords', () => {
    const user = Buffer.from('aes-128-gcm:password:with:colons').toString('base64url');
    const node = parseImport(`ss://${user}@127.0.0.1:8388#SS`).nodes[0];
    expect(node.outbound.settings).toEqual({
      servers: [
        { address: '127.0.0.1', port: 8388, method: 'aes-128-gcm', password: 'password:with:colons' },
      ],
    });
    const legacy = Buffer.from('aes-128-gcm:password@127.0.0.1:8388').toString('base64');
    expect(parseImport(`ss://${legacy}#Legacy`).nodes[0].name).toBe('Legacy');
  });
});

describe('configuration generation and subscription ownership', () => {
  it('keeps node credentials untouched while adding runtime tags and loopback inbounds', () => {
    const node = parseImport(vless).nodes[0];
    const original = JSON.stringify(node.outbound);
    const result = JSON.parse(buildConfig(node, emptyData()).config);
    expect(result.inbounds.every((inbound: { listen: string }) => inbound.listen === '127.0.0.1')).toBe(true);
    expect(result.routing.rules.at(-1).outboundTag).toBe('proxy');
    expect(JSON.stringify(node.outbound)).toBe(original);
  });
  it('uses the selected core for TUN and provides matching DNS and mainland rules', () => {
    const xray = buildConfig(parseImport(vless).nodes[0], { ...emptyData(), mode: 'tun' });
    const sing = buildConfig(parseImport(hy2).nodes[0], { ...emptyData(), mode: 'tun' });
    expect(xray.core).toBe('xray');
    expect(
      JSON.parse(xray.config).inbounds.some((inbound: { protocol: string }) => inbound.protocol === 'tun'),
    ).toBe(true);
    const config = JSON.parse(sing.config);
    expect(sing.core).toBe('sing-box');
    expect(config.inbounds.some((inbound: { type: string }) => inbound.type === 'tun')).toBe(true);
    expect(config.route.rule_set.map((rule: { tag: string }) => rule.tag)).toEqual([
      'geosite-cn',
      'geoip-cn',
    ]);
    expect(config.dns.final).toBe('proxy-dns');
    expect(config.route.default_domain_resolver).toEqual({ server: 'direct-dns', strategy: 'prefer_ipv4' });
  });
  it('never maps missing selection to an unrelated default connection', () => {
    expect(() => activeConfig(emptyData())).toThrow('选择');
    expect(() => activeConfig({ ...emptyData(), selectedProfileId: 'missing' })).toThrow('不存在');
  });
  it('preserves local edits and stable IDs during subscription refresh', () => {
    const old = { ...parseImport(vless).nodes[0], sourceId: 'sub', locallyEdited: true };
    const incoming = { ...parseImport(vless).nodes[0], outbound: { changed: true } };
    expect(mergeSubscriptionNodes([old], [incoming], 'sub')).toEqual([old]);
    const unedited = { ...old, locallyEdited: false };
    const merged = mergeSubscriptionNodes([unedited], [incoming], 'sub');
    expect(merged[0].id).toBe(unedited.id);
    expect(merged[0].outbound).toEqual({ changed: true });
  });
  it('rejects broken backups instead of silently replacing user data', () => {
    expect(() => parseData('{"version":2}')).toThrow('不受支持');
    expect(() => parseData(JSON.stringify({ ...emptyData(), settings: { port: 65535 } }))).toThrow('端口');
  });
});
