const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const { Client: SshClient, utils: SshUtils } = require('ssh2');

const PORT = Number(process.env.PORT || 6001);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT precisa ser um número entre 1 e 65535.');
const ROOT = __dirname;
const PUBLIC_FILES = new Set([
  'index.html', 'app.js', 'validation.js', 'styles.css', 'ssh-modal.css', 'power-actions.css',
  'info-modal.css', 'save-config.css', 'scan.css', 'map.css', 'mobile-menu.css',
  'responsive.css', 'import.css'
]);
const DATA_DIR = process.env.STATUS_PC_DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
const SSH_KEY = process.env.SSH_KEY_PATH || '';
const SSH_KNOWN_HOSTS = process.env.SSH_KNOWN_HOSTS_PATH || path.join(os.homedir(), '.ssh', 'known_hosts');
const SSH_CREDENTIALS_KEY = process.env.SSH_CREDENTIALS_SECRET
  ? crypto.scryptSync(process.env.SSH_CREDENTIALS_SECRET, 'status-pc-ssh-password-v1', 32)
  : null;
let scanInProgress = false;
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readDevices() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  }
  catch { return []; }
}
function saveDevices(devices) { fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2)); }
function encryptSshCredential(value) {
  if (!SSH_CREDENTIALS_KEY) throw new Error('Configure SSH_CREDENTIALS_SECRET no servidor antes de salvar credenciais SSH.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SSH_CREDENTIALS_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}
function decryptSshCredential(value) {
  if (!value) return '';
  if (!SSH_CREDENTIALS_KEY) throw new Error('Configure o mesmo SSH_CREDENTIALS_SECRET usado para salvar as credenciais SSH.');
  const [version, ivHex, tagHex, dataHex] = String(value).split(':');
  if (version !== 'v1' || !ivHex || !tagHex || dataHex === undefined) throw new Error('A credencial SSH salva está em um formato inválido.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', SSH_CREDENTIALS_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch { throw new Error('Não foi possível descriptografar a credencial SSH; confira SSH_CREDENTIALS_SECRET.'); }
}
function publicDevice(device) {
  const { sshPasswordEncrypted, sshPrivateKeyEncrypted, sshPassword, password, ...safe } = device;
  return { ...safe, sshPasswordConfigured: Boolean(sshPasswordEncrypted), sshPrivateKeyConfigured: Boolean(sshPrivateKeyEncrypted) };
}
function hostPatternMatches(pattern, candidate) {
  if (pattern.startsWith('|1|')) {
    const [, version, saltHex, hashHex] = pattern.split('|');
    if (version !== '1') return false;
    const salt = Buffer.from(saltHex, 'base64');
    const expected = Buffer.from(hashHex, 'base64');
    const actual = crypto.createHmac('sha1', salt).update(candidate).digest();
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }
  const expression = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return expression.test(candidate);
}
function matchesKnownHost(field, host, port) {
  const candidates = port === 22 ? [host, `[${host}]:${port}`] : [`[${host}]:${port}`];
  let allowed = false;
  for (const pattern of field.split(',')) {
    const negative = pattern.startsWith('!');
    const value = negative ? pattern.slice(1) : pattern;
    const matches = candidates.some(candidate => hostPatternMatches(value, candidate));
    if (negative && matches) return false;
    if (matches) allowed = true;
  }
  return allowed;
}
function isKnownHostKey(host, port, key) {
  try {
    const keyData = Buffer.isBuffer(key) ? key.toString('base64') : '';
    const lines = fs.readFileSync(SSH_KNOWN_HOSTS, 'utf8').split(/\r?\n/);
    let trusted = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const fields = trimmed.split(/\s+/);
      const marker = fields[0].startsWith('@') ? fields.shift() : '';
      if (!matchesKnownHost(fields[0] || '', host, port) || fields[2] !== keyData) continue;
      if (marker === '@revoked') return false;
      if (marker !== '@cert-authority') trusted = true;
    }
    return trusted;
  } catch { return false; }
}
function sshTarget(device) {
  const target = String(device.sshHost || '');
  if (!validSshDestination(target)) throw new Error('Configure o destino SSH no formato usuario@IP ou usuario@hostname.');
  const separator = target.lastIndexOf('@');
  return { username: target.slice(0, separator), host: target.slice(separator + 1) };
}
function runSshCommand(device, command, timeoutMs = 15000, temporaryCredentials = {}) {
  const { username, host } = sshTarget(device);
  const port = Number(device.sshPort || 22);
  const keyPath = device.sshKeyPath || SSH_KEY;
  const password = Object.hasOwn(temporaryCredentials, 'password') ? temporaryCredentials.password : decryptSshCredential(device.sshPasswordEncrypted);
  const privateKeyText = Object.hasOwn(temporaryCredentials, 'privateKey') ? temporaryCredentials.privateKey : decryptSshCredential(device.sshPrivateKeyEncrypted);
  let privateKey = privateKeyText ? Buffer.from(privateKeyText) : undefined;
  if (!privateKey && keyPath) {
    try { privateKey = fs.readFileSync(keyPath); }
    catch { throw new Error('Não foi possível ler a chave privada no caminho informado pelo dispositivo.'); }
  }
  if (!password && !privateKey) throw new Error('Informe uma senha SSH ou o caminho da chave privada deste dispositivo.');
  const connection = new SshClient();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let exitCode;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.end();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Tempo limite da conexão SSH excedido.')), timeoutMs + 5000);
    connection.on('ready', () => connection.exec(command, (error, stream) => {
      if (error) return finish(new Error(`Falha ao executar o comando SSH: ${error.message}`));
      stream.on('data', chunk => {
        stdout += chunk.toString();
        if (stdout.length > 1_000_000) finish(new Error('A resposta SSH excedeu o limite de 1 MB.'));
      });
      stream.stderr.on('data', chunk => {
        stderr += chunk.toString();
        if (stderr.length > 1_000_000) finish(new Error('A resposta de erro SSH excedeu o limite de 1 MB.'));
      });
      stream.on('exit', code => { exitCode = code; });
      stream.on('close', () => {
        if (exitCode !== undefined && exitCode !== 0) return finish(new Error(stderr.trim() || `Comando SSH retornou código ${exitCode}.`));
        finish(null, stdout);
      });
    }));
    connection.on('error', error => finish(new Error(`Falha na conexão SSH: ${error.message}`)));
    connection.on('close', () => { if (!settled) finish(new Error('A conexão SSH foi encerrada antes da resposta.')); });
    try {
      connection.connect({
        host,
        port,
        username,
        ...(password ? { password, passphrase: password } : {}),
        ...(privateKey ? { privateKey } : {}),
        readyTimeout: timeoutMs,
        hostVerifier: key => isKnownHostKey(host, port, key)
      });
    } catch (error) { finish(new Error(`Falha ao iniciar a conexão SSH: ${error.message}`)); }
  });
}
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function getBody(req, maxBytes = 100_000) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', chunk => { raw += chunk; if (Buffer.byteLength(raw) > maxBytes) reject(new Error('Payload muito grande')); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON inválido')); } });
  });
}
function validIp(ip) { return typeof ip === 'string' && /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(ip); }
function validMac(mac) { return typeof mac === 'string' && /^(?:[\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(mac); }
function validSshDestination(value) { return /^[\w.-]{1,64}@[\w.-]{1,255}$/.test(value); }
function ping(ip) {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    execFile(windows ? 'ping.exe' : 'ping', windows ? ['-n', '1', '-w', '1200', ip] : ['-c', '1', '-W', '2', ip], { timeout: 3000, windowsHide: true }, err => resolve(!err));
  });
}
function ipv4Number(ip) { return ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0); }
function ipv4Text(value) { return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.'); }
function discoverRanges() {
  const ranges = [];
  for (const iface of Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal && validIp(item.address) && validIp(item.netmask))) {
    const address = ipv4Number(iface.address); const mask = ipv4Number(iface.netmask);
    const network = (address & mask) >>> 0; const broadcast = (network | (~mask >>> 0)) >>> 0;
    const count = broadcast - network - 1;
    if (count < 1) continue;
    ranges.push({ address: iface.address, broadcast: ipv4Text(broadcast), network, first: network + 1, last: broadcast - 1, count });
  }
  return ranges;
}
function scanPing(ip) {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    execFile(windows ? 'ping.exe' : 'ping', windows ? ['-n', '1', '-w', '800', ip] : ['-c', '1', '-W', '1', ip], { timeout: 1800, windowsHide: true }, error => resolve(!error));
  });
}
function readArpTable() {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    execFile(windows ? 'arp.exe' : 'ip', windows ? ['-a'] : ['neigh', 'show'], { timeout: 3000, windowsHide: true }, (_error, stdout) => {
      const found = new Map();
      for (const line of stdout.split(/\r?\n/)) {
        const match = windows
          ? line.match(/\b((?:\d{1,3}\.){3}\d{1,3})\s+((?:[\da-f]{2}[:-]){5}[\da-f]{2})\b/i)
          : line.match(/\b((?:\d{1,3}\.){3}\d{1,3})\s+dev\s+([^ ]+).*?lladdr\s+(([\da-f]{2}:){5}[\da-f]{2})/i);
        if (match && validIp(match[1])) found.set(match[1], { mac: match[windows ? 2 : 3].toUpperCase().replace(/-/g, ':'), interface: windows ? '' : match[2] });
      }
      resolve(found);
    });
  });
}
async function scanLan() {
  const ranges = discoverRanges();
  if (!ranges.length) throw new Error('Não encontrei uma interface IPv4 local para varrer.');
  const targets = []; const maxTargets = 8192;
  let truncated = false;
  for (const range of ranges) {
    for (let n = range.first; n <= range.last; n++) {
      if (ipv4Text(n) === range.address) continue;
      if (targets.length >= maxTargets) { truncated = true; break; }
      targets.push({ ip: ipv4Text(n), broadcast: range.broadcast });
    }
    if (truncated) break;
  }
  const responding = new Set(); let cursor = 0;
  const workers = Array.from({ length: Math.min(128, targets.length) }, async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      if (await scanPing(item.ip)) responding.add(item.ip);
    }
  });
  await Promise.all(workers);
  const arp = await readArpTable();
  const targetMap = new Map(targets.map(item => [item.ip, item]));
  const foundIps = new Set(responding);
  for (const [ip, entry] of arp) if (targetMap.has(ip) && entry.mac) foundIps.add(ip);
  const devices = Array.from(foundIps).sort((a, b) => ipv4Number(a) - ipv4Number(b)).map(ip => ({
    ip, mac: arp.get(ip)?.mac || '', interface: arp.get(ip)?.interface || '', broadcast: targetMap.get(ip)?.broadcast || '', online: responding.has(ip),
    source: responding.has(ip) ? (arp.has(ip) ? 'ping+arp' : 'ping') : 'arp'
  }));
  return { devices, scanned: targets.length, truncated, subnets: ranges.map(range => ({ address: range.address, broadcast: range.broadcast, hosts: range.count })) };
}
function wake(mac, broadcast = '255.255.255.255') {
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  if (bytes.length !== 6) throw new Error('Endereço MAC inválido');
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) bytes.copy(packet, 6 + i * 6);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', error => { socket.close(); reject(error); });
    socket.bind(() => { socket.setBroadcast(true); socket.send(packet, 9, broadcast, error => { socket.close(); error ? reject(error) : resolve(); }); });
  });
}
function remotePower(device, action = 'shutdown') {
  if (!validSshDestination(device.sshHost)) throw new Error('Destino SSH inválido ou não configurado para este dispositivo.');
  if (!['linux', 'windows'].includes(device.platform)) throw new Error('Selecione Windows ou Linux nas configurações do dispositivo.');
  const command = device.platform === 'linux'
    ? (action === 'restart' ? 'sudo -n shutdown -r now' : 'sudo -n shutdown -h now')
    : (action === 'restart' ? 'powershell.exe -NoProfile -NonInteractive -Command "Restart-Computer -Force"' : 'powershell.exe -NoProfile -NonInteractive -Command "Stop-Computer -Force"');
  return runSshCommand(device, command, 10000);
}
function remoteInfo(device) {
  if (!validSshDestination(device.sshHost)) throw new Error('Configure o destino SSH deste equipamento no formato usuario@host.');
  if (!['linux', 'windows'].includes(device.platform)) throw new Error('Sistema operacional inválido.');
  let command;
  if (device.platform === 'linux') {
    const script = [
      'printf "hostname=%s\\n" "$(hostname 2>/dev/null)"',
      'printf "os=%s\\n" "$(sed -n \'s/^PRETTY_NAME=//p\' /etc/os-release 2>/dev/null | tr -d \'\\"\')"',
      'printf "kernel=%s\\n" "$(uname -srmo 2>/dev/null)"',
      'printf "uptime=%s\\n" "$(uptime -p 2>/dev/null || uptime 2>/dev/null)"',
      'printf "cpu=%s\\n" "$(lscpu 2>/dev/null | awk -F: \'/Model name/ {gsub(/^[ \\t]+/, \"\", $2); print $2; exit}\')"',
      'printf "cores=%s\\n" "$(nproc 2>/dev/null)"',
      'printf "memory=%s total, %s used, %s available\\n" $(free -h 2>/dev/null | awk \'/^Mem:/ {print $2, $3, $7}\')',
      'printf "swap=%s total, %s used\\n" $(free -h 2>/dev/null | awk \'/^Swap:/ {print $2, $3}\')',
      'printf "disks=%s\\n" "$(df -hP 2>/dev/null | awk \'NR>1 {printf \"%s: %s used of %s (%s free); \", $6, $3, $2, $4}\')"',
      'printf "network=%s\\n" "$(ip -o -4 addr show 2>/dev/null | awk \'{printf \"%s %s; \", $2, $4}\')"',
      'printf "macs=%s\\n" "$(ip -o link show 2>/dev/null | awk \'/link\\/ether/ {for(i=1;i<=NF;i++) if ($i==\"link/ether\") printf \"%s %s; \", $2, $(i+1)}\')"',
      'printf "manufacturer=%s\\n" "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"',
      'printf "model=%s\\n" "$(cat /sys/class/dmi/id/product_name 2>/dev/null)"',
      'printf "serial=%s\\n" "$(cat /sys/class/dmi/id/product_serial 2>/dev/null)"',
      'printf "bios=%s\\n" "$(cat /sys/class/dmi/id/bios_version 2>/dev/null)"',
      'printf "load=%s\\n" "$(cat /proc/loadavg 2>/dev/null)"',
      'printf "processes=%s\\n" "$(ps -e --no-headers 2>/dev/null | wc -l | tr -d \' \')"',
      'printf "gpu=%s\\n" "$(lspci 2>/dev/null | grep -Ei \'VGA|3D controller|Display controller\' | sed \'s/^[^ ]* //\' | tr \'\\n\' \';\')"'
    ].join('; ');
    command = `echo ${Buffer.from(script).toString('base64')} | base64 -d | sh`;
  } else {
    const script = `$os=Get-CimInstance Win32_OperatingSystem; $cs=Get-CimInstance Win32_ComputerSystem; $cpu=Get-CimInstance Win32_Processor; $bios=Get-CimInstance Win32_BIOS; $disks=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,@{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}}; $net=Get-NetIPConfiguration | Where-Object {$_.IPv4Address} | ForEach-Object {[pscustomobject]@{Interface=$_.InterfaceAlias;IPv4=($_.IPv4Address.IPAddress -join ', ');Gateway=($_.IPv4DefaultGateway.NextHop -join ', ')}}; $macs=Get-NetAdapter | Where-Object {$_.MacAddress} | ForEach-Object {[pscustomobject]@{Interface=$_.Name;MAC=$_.MacAddress;Status=$_.Status}}; [ordered]@{hostname=$env:COMPUTERNAME;os=$os.Caption;version=$os.Version;build=$os.BuildNumber;architecture=$os.OSArchitecture;lastBoot=$os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss');manufacturer=$cs.Manufacturer;model=$cs.Model;domain=$cs.Domain;cpu=(($cpu.Name | ForEach-Object {$_.Trim()}) -join '; ');cores=($cpu | Measure-Object -Property NumberOfCores -Sum).Sum;logicalProcessors=($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum;memoryGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1);memoryAvailableGB=[math]::Round($os.FreePhysicalMemory/1MB,1);disks=@($disks);network=@($net);macs=@($macs);bios=$bios.SMBIOSBIOSVersion;serial=$bios.SerialNumber;gpu=@(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name)} | ConvertTo-Json -Compress -Depth 5`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    command = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
  }
  return runSshCommand(device, command, 20000).then(stdout => {
    if (device.platform === 'windows') {
      try { return JSON.parse(stdout.trim()); }
      catch { throw new Error('O equipamento respondeu em um formato inesperado.'); }
    }
    return Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const separator = line.indexOf('='); return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      if (scanInProgress) return send(res, 409, { error: 'Já existe uma varredura em andamento.' });
      scanInProgress = true;
      try { return send(res, 200, await scanLan()); }
      finally { scanInProgress = false; }
    }
    if (req.method === 'GET' && url.pathname === '/api/config/export') {
      const config = { app: 'STATUS PC v2', schemaVersion: 1, exportedAt: new Date().toISOString(), devices: readDevices().map(publicDevice) };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="status-pc-config.json"', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(config, null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/api/config/import') {
      const body = await getBody(req, 2_000_000);
      if (!body || typeof body !== 'object') return send(res, 400, { error: 'Arquivo JSON inválido.' });
      const imported = Array.isArray(body) ? body : body.devices;
      if (!Array.isArray(imported) || imported.length > 4096) return send(res, 400, { error: 'Arquivo inválido: esperado um JSON com até 4.096 dispositivos.' });
      const normalized = [];
      for (let i = 0; i < imported.length; i++) {
        const item = imported[i];
        if (!item || typeof item !== 'object') return send(res, 400, { error: `Configuração ${i + 1} inválida.` });
        const name = String(item.name || '').trim().slice(0, 60);
        const ip = String(item.ip || '').trim();
        const mac = String(item.mac || '').trim();
        const platform = item.platform;
        const sshHost = String(item.sshHost || '').trim().slice(0, 100);
        const sshPort = Number(item.sshPort || 22);
        const sshKeyPath = String(item.sshKeyPath || '').trim();
        const sshPublicKey = String(item.sshPublicKey || '').trim();
        if (!name || !validIp(ip) || (mac && !validMac(mac)) || !['windows', 'linux'].includes(platform)) return send(res, 400, { error: `Configuração ${i + 1}: nome, IPv4, MAC ou sistema operacional inválido.` });
        if (sshHost && !validSshDestination(sshHost)) return send(res, 400, { error: `Configuração ${i + 1}: use o destino SSH no formato usuario@host.` });
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return send(res, 400, { error: `Configuração ${i + 1}: porta SSH inválida.` });
        if (sshKeyPath.length > 500) return send(res, 400, { error: `Configuração ${i + 1}: caminho da chave SSH muito longo.` });
        if (sshPublicKey.length > 2048) return send(res, 400, { error: `Configuração ${i + 1}: chave pública muito longa.` });
        normalized.push({ id: /^[\w-]{1,80}$/.test(String(item.id || '')) ? String(item.id) : crypto.randomUUID(), name, ip, mac: validMac(mac) ? mac.toUpperCase().replace(/-/g, ':') : '', platform, sshHost, sshPort, sshKeyPath, sshPublicKey, broadcast: validIp(item.broadcast) ? item.broadcast : '255.255.255.255' });
      }
      const current = readDevices(); const ids = new Set(current.map(device => device.id));
      let added = 0; let updated = 0;
      for (const item of normalized) {
        const index = current.findIndex(device => device.ip === item.ip);
        if (index >= 0) { current[index] = { ...item, id: current[index].id, sshPasswordEncrypted: current[index].sshPasswordEncrypted, sshPrivateKeyEncrypted: current[index].sshPrivateKeyEncrypted }; updated++; }
        else {
          if (ids.has(item.id)) item.id = crypto.randomUUID();
          ids.add(item.id); current.push(item); added++;
        }
      }
      saveDevices(current);
      return send(res, 200, { ok: true, added, updated, total: current.length });
    }
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      const devices = readDevices();
      const statuses = await mapWithConcurrency(devices, 64, async device => ({ ...publicDevice(device), online: validIp(device.ip) ? await ping(device.ip) : false }));
      return send(res, 200, { devices: statuses, sshEnabled: Boolean(SSH_KEY), networkInterfaces: Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address) });
    }
    if (req.method === 'POST' && url.pathname === '/api/ssh/test') {
      const body = await getBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Envie as configurações SSH para testar a conexão.' });
      const existing = body.id ? readDevices().find(device => device.id === body.id) : null;
      if (body.id && !existing) return send(res, 404, { error: 'Dispositivo não encontrado.' });
      const sshHost = String(body.sshHost || existing?.sshHost || '').trim();
      const sshPort = body.sshPort === undefined || body.sshPort === '' ? Number(existing?.sshPort || 22) : Number(body.sshPort);
      const sshKeyPath = String(body.sshKeyPath || existing?.sshKeyPath || '').trim();
      const sshPassword = body.sshPassword === undefined ? undefined : body.sshPassword;
      const sshPrivateKey = body.sshPrivateKey === undefined ? undefined : body.sshPrivateKey;
      if (!validSshDestination(sshHost)) return send(res, 400, { error: 'Informe o destino no formato usuario@IP ou usuario@hostname.' });
      if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return send(res, 400, { error: 'A porta SSH precisa estar entre 1 e 65535.' });
      if (sshKeyPath.length > 500 || (sshPassword !== undefined && (typeof sshPassword !== 'string' || sshPassword.length > 1024))) return send(res, 400, { error: 'Confira o caminho da chave e a senha informados.' });
      if (sshPrivateKey !== undefined && (typeof sshPrivateKey !== 'string' || sshPrivateKey.length > 20000)) return send(res, 400, { error: 'A chave privada precisa ter até 20.000 caracteres.' });
      const device = { ...existing, sshHost, sshPort, sshKeyPath };
      const temporaryCredentials = {
        ...(sshPassword ? { password: sshPassword } : {}),
        ...(sshPrivateKey ? { privateKey: sshPrivateKey } : {})
      };
      if (!sshPassword && !device.sshPasswordEncrypted && !sshPrivateKey && !device.sshPrivateKeyEncrypted && !sshKeyPath && !SSH_KEY) return send(res, 400, { error: 'Informe uma senha SSH, cole uma chave privada ou indique o caminho da chave.' });
      const output = await runSshCommand(device, 'echo STATUS_PC_SSH_OK', 10000, temporaryCredentials);
      if (!output.includes('STATUS_PC_SSH_OK')) return send(res, 502, { error: 'A conexão foi aberta, mas o equipamento não confirmou o comando de teste.' });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/ssh/generate-key') {
      const pair = SshUtils.generateKeyPairSync('ed25519', { comment: 'status-pc' });
      return send(res, 200, { privateKey: pair.private, publicKey: pair.public });
    }
    if (req.method === 'POST' && url.pathname === '/api/devices') {
      const body = await getBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Envie uma configuração de dispositivo válida.' });
      const name = String(body.name || '').trim().slice(0, 60);
      const ip = String(body.ip || '').trim();
      const mac = String(body.mac || '').trim();
      const platform = body.platform;
      const sshHost = String(body.sshHost || '').trim();
      const sshPort = body.sshPort === undefined || body.sshPort === '' ? 22 : Number(body.sshPort);
      const sshKeyPath = String(body.sshKeyPath || '').trim();
      const sshPublicKey = String(body.sshPublicKey || '').trim();
      const sshPassword = body.sshPassword === undefined ? '' : body.sshPassword;
      const sshPrivateKey = body.sshPrivateKey === undefined ? '' : body.sshPrivateKey;
      const broadcast = String(body.broadcast || '').trim();
      if (!name || !validIp(ip) || (mac && !validMac(mac))) return send(res, 400, { error: 'Informe nome e IPv4 válidos; se preencher MAC, ele precisa ser válido.' });
      if (!['windows', 'linux'].includes(platform)) return send(res, 400, { error: 'Selecione Windows ou Linux.' });
      if (sshHost && !validSshDestination(sshHost)) return send(res, 400, { error: 'Informe um destino SSH válido no formato usuario@IP ou usuario@hostname.' });
      if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return send(res, 400, { error: 'A porta SSH precisa estar entre 1 e 65535.' });
      if (sshKeyPath.length > 500) return send(res, 400, { error: 'O caminho da chave SSH pode ter no máximo 500 caracteres.' });
      if (sshPublicKey.length > 2048) return send(res, 400, { error: 'A chave pública SSH pode ter no máximo 2.048 caracteres.' });
      if (typeof sshPassword !== 'string' || sshPassword.length > 1024) return send(res, 400, { error: 'A senha SSH precisa ser um texto com até 1.024 caracteres.' });
      if (typeof sshPrivateKey !== 'string' || sshPrivateKey.length > 20000) return send(res, 400, { error: 'A chave privada precisa ter até 20.000 caracteres.' });
      if ((sshPassword || sshPrivateKey) && !SSH_CREDENTIALS_KEY) return send(res, 503, { error: 'Configure SSH_CREDENTIALS_SECRET no servidor antes de salvar credenciais SSH.' });
      if (broadcast && !validIp(broadcast)) return send(res, 400, { error: 'Informe um endereço de broadcast IPv4 válido.' });
      const devices = readDevices();
      if (devices.some(device => device.ip === ip)) return send(res, 409, { error: 'Já existe um dispositivo cadastrado com este endereço IP.' });
      const item = { id: crypto.randomUUID(), name, ip, mac: validMac(mac) ? mac.toUpperCase().replace(/-/g, ':') : '', platform, sshHost, sshPort, sshKeyPath, sshPublicKey, broadcast: broadcast || '255.255.255.255' };
      if (sshPassword) item.sshPasswordEncrypted = encryptSshCredential(sshPassword);
      if (sshPrivateKey) item.sshPrivateKeyEncrypted = encryptSshCredential(sshPrivateKey);
      devices.push(item); saveDevices(devices); return send(res, 201, publicDevice(item));
    }
    const match = url.pathname.match(/^\/api\/devices\/([\w-]+)(?:\/(wake|shutdown|restart|info))?$/);
    if (match) {
      const devices = readDevices(); const index = devices.findIndex(d => d.id === match[1]);
      if (index < 0) return send(res, 404, { error: 'Dispositivo não encontrado.' });
      if (req.method === 'DELETE' && !match[2]) { devices.splice(index, 1); saveDevices(devices); return send(res, 200, { ok: true }); }
      if (req.method === 'PATCH' && !match[2]) {
        const body = await getBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Envie alterações válidas para o dispositivo.' });
        const current = devices[index];
        const name = body.name === undefined ? current.name : String(body.name).trim().slice(0, 60);
        const ip = body.ip === undefined ? current.ip : String(body.ip).trim();
        const mac = body.mac === undefined ? current.mac : String(body.mac || '').trim();
        const platform = body.platform === undefined ? current.platform : body.platform;
        const sshHost = body.sshHost === undefined ? (current.sshHost || '') : String(body.sshHost || '').trim();
        const sshPort = body.sshPort === undefined || body.sshPort === '' ? Number(current.sshPort || 22) : Number(body.sshPort);
        const sshKeyPath = body.sshKeyPath === undefined ? (current.sshKeyPath || '') : String(body.sshKeyPath || '').trim();
        const sshPublicKey = body.sshPublicKey === undefined ? (current.sshPublicKey || '') : String(body.sshPublicKey || '').trim();
        const sshPassword = body.sshPassword === undefined ? '' : body.sshPassword;
        const sshPrivateKey = body.sshPrivateKey === undefined ? '' : body.sshPrivateKey;
        const broadcast = body.broadcast === undefined || body.broadcast === '' ? (validIp(current.broadcast) ? current.broadcast : '255.255.255.255') : String(body.broadcast).trim();
        if (!name || !validIp(ip) || (mac && !validMac(mac))) return send(res, 400, { error: 'Informe nome e IPv4 válidos; se preencher MAC, ele precisa ser válido.' });
        if (!['windows', 'linux'].includes(platform)) return send(res, 400, { error: 'Selecione Windows ou Linux.' });
        if (sshHost && !validSshDestination(sshHost)) return send(res, 400, { error: 'Informe um destino válido no formato usuario@IP ou usuario@hostname.' });
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return send(res, 400, { error: 'A porta SSH precisa estar entre 1 e 65535.' });
        if (sshKeyPath.length > 500) return send(res, 400, { error: 'O caminho da chave SSH pode ter no máximo 500 caracteres.' });
        if (sshPublicKey.length > 2048) return send(res, 400, { error: 'A chave pública SSH pode ter no máximo 2.048 caracteres.' });
        if (typeof sshPassword !== 'string' || sshPassword.length > 1024) return send(res, 400, { error: 'A senha SSH precisa ser um texto com até 1.024 caracteres.' });
        if (typeof sshPrivateKey !== 'string' || sshPrivateKey.length > 20000) return send(res, 400, { error: 'A chave privada precisa ter até 20.000 caracteres.' });
        if ((sshPassword || sshPrivateKey) && !SSH_CREDENTIALS_KEY) return send(res, 503, { error: 'Configure SSH_CREDENTIALS_SECRET no servidor antes de salvar credenciais SSH.' });
        if (body.clearSshPassword && sshPassword) return send(res, 400, { error: 'Não é possível salvar e remover a senha na mesma operação.' });
        if (body.clearSshPrivateKey && sshPrivateKey) return send(res, 400, { error: 'Não é possível salvar e remover a chave na mesma operação.' });
        if (!validIp(broadcast)) return send(res, 400, { error: 'Informe um endereço de broadcast IPv4 válido.' });
        if (devices.some((device, deviceIndex) => deviceIndex !== index && device.ip === ip)) return send(res, 409, { error: 'Já existe outro dispositivo cadastrado com este endereço IP.' });
        const updated = { ...current, name, ip, mac: validMac(mac) ? mac.toUpperCase().replace(/-/g, ':') : '', platform, sshHost, sshPort, sshKeyPath, sshPublicKey, broadcast };
        if (body.clearSshPassword === true) delete updated.sshPasswordEncrypted;
        else if (sshPassword) updated.sshPasswordEncrypted = encryptSshCredential(sshPassword);
        if (body.clearSshPrivateKey === true) {
          delete updated.sshPrivateKeyEncrypted;
          updated.sshPublicKey = '';
        }
        else if (sshPrivateKey) updated.sshPrivateKeyEncrypted = encryptSshCredential(sshPrivateKey);
        devices[index] = updated;
        saveDevices(devices);
        return send(res, 200, { ok: true, device: publicDevice(devices[index]) });
      }
      if (req.method === 'POST' && match[2] === 'wake') { if (!validMac(devices[index].mac)) return send(res, 400, { error: 'Este dispositivo não tem endereço MAC cadastrado para Wake-on-LAN.' }); await wake(devices[index].mac, devices[index].broadcast); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && ['shutdown', 'restart'].includes(match[2])) { await remotePower(devices[index], match[2]); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && match[2] === 'info') { const info = await remoteInfo(devices[index]); return send(res, 200, { info, collectedAt: new Date().toISOString() }); }
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      if (!PUBLIC_FILES.has(requested)) return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
      const file = path.join(ROOT, requested);
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
      return fs.readFile(file, (error, content) => error ? send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8') : send(res, 200, content, types[path.extname(file)] || 'application/octet-stream'));
    }
    send(res, 404, { error: 'Rota não encontrada.' });
  } catch (error) { send(res, 500, { error: error.message || 'Erro interno.' }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`STATUS PC v2 disponível em http://localhost:${PORT}`));
