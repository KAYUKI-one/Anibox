// Dedicated benchmark subnet only. No system proxy or default route is changed.
import { execFileSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createSocket } from 'node:dgram';
import { mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import path from 'node:path';
import assert from 'node:assert/strict';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function checkTunTraffic(invoke) {
  const root = path.resolve('.local', `tun-traffic-${process.pid}`);
  const exe = path.resolve('.local/qa/Anibox/cores/sing-box/sing-box.exe');
  const nic = JSON.parse(
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1; $a=Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex | Where-Object {$_.AddressState -eq 'Preferred'} | Select-Object -First 1; @{ip=$a.IPAddress;name=$r.InterfaceAlias;otherTun=!!(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object {$_.InterfaceAlias -match 'tun|wireguard|^Anibox-'})} | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  assert(nic.ip, 'An IPv4 interface is required for the isolated QUIC fixture');
  const dnsProbePort = nic.otherTun ? 1053 : 53;
  await mkdir(root, { recursive: true });
  const cert = execFileSync(exe, ['generate', 'tls-keypair', 'anibox.test'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  await writeFile(
    path.join(root, 'cert.pem'),
    cert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0],
  );
  await writeFile(
    path.join(root, 'key.pem'),
    cert.match(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]+?-----END [^-]*PRIVATE KEY-----/)[0],
  );
  let dnsQueries = 0;
  const dnsReply = (query) => {
    let end = 12,
      name = [];
    while (query[end]) {
      const size = query[end++];
      name.push(query.subarray(end, end + size).toString());
      end += size;
    }
    end++;
    const type = query.readUInt16BE(end);
    end += 4;
    const proxy = name.join('.') === 'anibox.test';
    const data =
      type === 1
        ? Buffer.from((proxy ? nic.ip : '198.18.234.10').split('.').map(Number))
        : type === 28
          ? Buffer.from('20010db8ffff00000000000000000009', 'hex')
          : null;
    const header = Buffer.alloc(12);
    query.copy(header, 0, 0, 2);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(data ? 1 : 0, 6);
    let answer = Buffer.alloc(0);
    if (data) {
      answer = Buffer.alloc(12);
      answer.writeUInt16BE(0xc00c, 0);
      answer.writeUInt16BE(type, 2);
      answer.writeUInt16BE(1, 4);
      answer.writeUInt32BE(60, 6);
      answer.writeUInt16BE(data.length, 10);
      answer = Buffer.concat([answer, data]);
    }
    dnsQueries++;
    return Buffer.concat([header, query.subarray(12, end), answer]);
  };
  const tls = {
    cert: await readFile(path.join(root, 'cert.pem')),
    key: await readFile(path.join(root, 'key.pem')),
  };
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const query =
          req.method === 'GET'
            ? Buffer.from(new URL(req.url, 'https://anibox.test').searchParams.get('dns'), 'base64url')
            : Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/dns-message' });
        res.end(dnsReply(query));
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  };
  const directDns = createHttpsServer(tls, handler);
  await new Promise((resolve) => directDns.listen(0, nic.ip, resolve));
  const dnsPort = directDns.address().port;
  const proxyDns = createHttpsServer(tls, handler);
  await new Promise((resolve) => proxyDns.listen(dnsPort, '127.0.0.1', resolve));
  const payload = 'ANIBOX_TUN_QUIC_OK'.repeat(65536);
  const http = createServer((_req, res) => res.end(payload));
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const udp = createSocket('udp4');
  udp.on('message', (data, peer) => udp.send(data, peer.port, peer.address));
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const probe = createSocket('udp4');
  await new Promise((resolve) => probe.bind(0, nic.ip, resolve));
  const quicPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const secret = randomBytes(24).toString('hex');
  const subnet = '198.18.234.0/24',
    destination = '198.18.234.10';
  const serverConfig = {
    log: { level: 'debug', output: path.join(root, 'server.log') },
    inbounds: [
      {
        type: 'hysteria2',
        tag: 'test-quic',
        listen: nic.ip,
        listen_port: quicPort,
        users: [{ password: secret }],
        tls: {
          enabled: true,
          certificate_path: path.join(root, 'cert.pem'),
          key_path: path.join(root, 'key.pem'),
        },
      },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      rules: [{ ip_cidr: [subnet], action: 'route-options', override_address: '127.0.0.1' }],
      final: 'direct',
    },
  };
  await writeFile(path.join(root, 'server.json'), JSON.stringify(serverConfig));
  const server = spawn(exe, ['run', '-c', path.join(root, 'server.json')], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const stopped = new Promise((resolve) => server.once('close', resolve));
  try {
    await pause(500);
    const bundle = await build({
      stdin: {
        contents:
          'export {parseImport} from "./src/domain/import.ts"; export {buildConfig} from "./src/domain/config.ts"; export {emptyData} from "./src/domain/storage.ts";',
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
    });
    const { parseImport, buildConfig, emptyData } = await import(
      'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
    );
    const node = parseImport(`hysteria2://${secret}@${nic.ip}:${quicPort}?sni=anibox.test`).nodes[0];
    node.outbound.tls.certificate_path = path.join(root, 'cert.pem');
    node.server = 'anibox.test';
    node.outbound.server = 'anibox.test';
    for (const mode of ['local', 'tun']) {
      const config = JSON.parse(buildConfig(node, { ...emptyData(), route: 'global', mode }).config);
      config.dns.servers = [
        {
          type: 'https',
          tag: 'direct-dns',
          server: nic.ip,
          server_port: dnsPort,
          path: '/dns-query',
          tls: { enabled: true, server_name: 'anibox.test', certificate_path: path.join(root, 'cert.pem') },
        },
        {
          type: 'https',
          tag: 'proxy-dns',
          server: '198.18.234.53',
          server_port: dnsPort,
          path: '/dns-query',
          detour: 'proxy',
          tls: { enabled: true, server_name: 'anibox.test', certificate_path: path.join(root, 'cert.pem') },
        },
      ];
      config.log = { level: 'debug', output: path.join(root, `client-${mode}.log`) };
      config.route.rules.splice(mode === 'tun' ? 2 : 0, 0, {
        ip_cidr: [subnet],
        action: 'route',
        outbound: 'proxy',
      });
      if (mode === 'tun' && dnsProbePort !== 53)
        config.route.rules.splice(1, 0, { inbound: ['tun-in'], port: dnsProbePort, action: 'hijack-dns' });
      if (mode === 'tun')
        Object.assign(config.inbounds[0], {
          address: ['172.31.247.1/30'],
          route_address: [subnet],
          dns_mode: 'disabled',
        });
      try {
        console.log(`Checking real ${mode} Hysteria2 traffic with an isolated DNS/server fixture.`);
        const status = await invoke('start_core', {
          core: 'sing-box',
          config: JSON.stringify(config),
          mode,
          managed: true,
        });
        const body = await new Promise((resolve, reject) => {
          const req = request(
            {
              hostname: mode === 'local' ? '127.0.0.1' : destination,
              port: mode === 'local' ? status.localPorts.http : http.address().port,
              path: mode === 'local' ? `http://${destination}:${http.address().port}/` : '/',
              headers: { Host: destination },
            },
            (response) => {
              let body = '';
              response.on('data', (chunk) => (body += chunk));
              response.on('end', () => resolve(body));
            },
          );
          req.setTimeout(8000, () => req.destroy(new Error(`${mode} TCP through Hysteria2 timed out`)));
          req.on('error', reject);
          req.end();
        });
        assert.equal(body.length, payload.length);
        assert(body === payload, 'Large HTTP response must arrive intact through QUIC');
        if (mode === 'tun') {
          const client = createSocket('udp4');
          try {
            const result = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('TUN UDP through Hysteria2 timed out')), 5000);
              client.once('message', (data) => {
                clearTimeout(timer);
                resolve(data.toString());
              });
              client.once('error', (error) => {
                clearTimeout(timer);
                reject(error);
              });
              client.send('ANIBOX_TUN_UDP_OK', udp.address().port, destination);
            });
            assert.equal(result, 'ANIBOX_TUN_UDP_OK');
          } finally {
            client.close();
          }
        }
        if (mode === 'tun') {
          if (dnsProbePort !== 53)
            console.log(
              'DNS probe uses isolated port 1053 because another strict-routing TUN is active; its firewall is left unchanged.',
            );
          const dnsClient = createSocket('udp4');
          try {
            const labels = 'lookup.anibox.test'
              .split('.')
              .flatMap((name) => [Buffer.from([name.length]), Buffer.from(name)]);
            const header = Buffer.alloc(12);
            header.writeUInt16BE(0x414e, 0);
            header.writeUInt16BE(0x0100, 2);
            header.writeUInt16BE(1, 4);
            const query = Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
            const exchange = (packet) =>
              new Promise((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new Error('TUN DNS hijack → DoH → QUIC timed out')),
                  5000,
                );
                dnsClient.once('message', (packet) => {
                  clearTimeout(timer);
                  resolve(packet);
                });
                dnsClient.once('error', (error) => {
                  clearTimeout(timer);
                  reject(error);
                });
                dnsClient.send(packet, dnsProbePort, '198.18.234.53');
              });
            const response = await exchange(query);
            assert.equal(response.readUInt16BE(0), 0x414e);
            assert.equal(response.readUInt16BE(6), 1);
            assert(response.includes(Buffer.from([198, 18, 234, 10])));
            // The fixture deliberately advertises an unreachable AAAA record.
            // prefer_ipv4 still returns it; an IPv4-only TUN must suppress it.
            const ipv6Query = Buffer.from(query);
            ipv6Query.writeUInt16BE(28, ipv6Query.length - 4);
            const ipv6Response = await exchange(ipv6Query);
            assert.equal(ipv6Response.readUInt16BE(2) & 15, 0, 'AAAA must return NOERROR');
            assert.equal(ipv6Response.readUInt16BE(6), 0, 'IPv4-only TUN must not advertise unusable IPv6');
          } finally {
            dnsClient.close();
          }
        }
        assert(dnsQueries > 0, 'Proxy hostname must be resolved through bootstrap DoH');
        console.log(
          `PASS real ${mode}: hostname bootstrap → Hysteria2 QUIC → large HTTP${mode === 'tun' ? ', UDP and hijacked DNS/DoH' : ''}`,
        );
      } catch (error) {
        for (const name of [`client-${mode}.log`, 'server.log']) {
          const log = await readFile(path.join(root, name), 'utf8').catch(() => '');
          console.error(name + '\n' + log.slice(-6000));
        }
        throw error;
      } finally {
        console.log(`Stopping isolated ${mode} traffic fixture.`);
        await invoke('stop_core');
      }
    }
  } finally {
    server.kill();
    await stopped;
    http.close();
    udp.close();
    directDns.close();
    proxyDns.close();
    for (const name of [
      'cert.pem',
      'key.pem',
      'server.json',
      'server.log',
      'client-local.log',
      'client-tun.log',
    ])
      await unlink(path.join(root, name)).catch(() => {});
    await rmdir(root).catch(() => {});
  }
}
