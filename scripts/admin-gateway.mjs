import fs from 'node:fs';
import path from 'node:path';
import { createAdminGateway } from '../src/admin-gateway.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config' || !path.isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/admin-gateway.mjs --config ABSOLUTE_PRIVATE_CONFIG.json');
}
const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
if (config.requiredRole !== undefined && config.requiredRole !== 'admin') throw new Error('The full Agent console requires the admin role');
const { port = 3211, ...options } = config;
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid gateway port');
const gateway = createAdminGateway({ ...options, requiredRole: 'admin' });
await gateway.listen(port);
console.log('Administrator gateway ready on its configured loopback port');
let closing = false;
const close = async () => { if (closing) return; closing = true; await gateway.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
