// Self-signed dev certificate for https://<host>:5173.
//
// The dev server already binds every interface (host: true), so the only thing
// missing to test motion/VR features on a phone is TLS -- browsers only expose
// DeviceOrientation over a secure context. This generates certs/dev.{key,crt}
// with a SAN covering localhost, 127.0.0.1 and every non-internal IPv4 of this
// machine, so the phone can reach it by LAN address. The certificate is
// self-signed: the browser will warn once and the user clicks through.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'certs');
const keyPath = join(dir, 'dev.key');
const crtPath = join(dir, 'dev.crt');

if (existsSync(keyPath) && existsSync(crtPath)) {
  console.log('dev-cert: using existing certs/dev.crt');
} else {
  mkdirSync(dir, { recursive: true });
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  const conf = `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=infinity-edge-web dev\n[v3]\nsubjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`;
  const confPath = join(dir, 'dev.cnf');
  writeFileSync(confPath, conf);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
    '-keyout', keyPath, '-out', crtPath, '-config', confPath], { stdio: 'inherit' });
  console.log(`dev-cert: wrote certs/dev.crt (SAN: ${san})`);
  if (ips.length) console.log(`dev-cert: open https://${ips[0]}:5173 on the phone`);
}
