import { Reticulum } from '../src/Reticulum.js';
import { LXMRouter } from '../src/lxmf/LXMRouter.js';
import { LXMessage, DIRECT, DELIVERED, FAILED } from '../src/lxmf/LXMessage.js';
import { fromHex, toHex } from '../src/utils/bytes.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));

const targetHash = process.argv[2];
const sizeKb = parseInt(process.argv[3] || '100', 10);
const configDir = join(__dirname, '.lxmf_send_config');

const rns = new Reticulum({
  configDir,
  enableTransport: false,
  interfaces: [{
    name: 'RNS', type: 'TCPClientInterface', enabled: true,
    target_host: '127.0.0.1', target_port: 14242,
  }],
});
rns.configDir = configDir;
await rns.start();

const router = new LXMRouter(rns.transport);
router.registerDeliveryIdentity(rns.identity, { displayName: 'BigSend' });
router.announceAll();

await new Promise(r => setTimeout(r, 1500));
rns.transport.requestPath(fromHex(targetHash));
await new Promise(r => setTimeout(r, 500));

const content = 'Z'.repeat(sizeKb * 1024);
console.log(`Sending ${content.length} bytes...`);
const t0 = Date.now();

const msg = new LXMessage({
  destinationHash: fromHex(targetHash),
  title: `${sizeKb}KB test`,
  content,
  desiredMethod: DIRECT,
});
router.handleOutbound(msg);

const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  if (msg.state === DELIVERED) {
    console.log(`DELIVERED in ${Date.now() - t0}ms`);
    break;
  }
  if (msg.state === FAILED) {
    console.log(`FAILED in ${Date.now() - t0}ms`);
    break;
  }
  await new Promise(r => setTimeout(r, 200));
}
if (msg.state !== DELIVERED && msg.state !== FAILED) {
  console.log(`TIMEOUT — state=${msg.state}, attempts=${msg.deliveryAttempts}`);
}

router.stop();
await rns.stop();
setTimeout(() => process.exit(0), 500);
