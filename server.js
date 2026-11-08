const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.PORT || 6001);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
const SSH_KEY = process.env.SSH_KEY_PATH || '';
let scanInProgress = false;
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readDevices() {
  try { const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function saveDevices(devices) { fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2)); }
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
  if (!SSH_KEY) throw new Error('Configure SSH_KEY_PATH no servidor para habilitar desligamento remoto.');
  if (!device.sshHost || !/^[\w.@-]+$/.test(device.sshHost)) throw new Error('Destino SSH inválido ou não configurado para este dispositivo.');
  if (!['linux', 'windows'].includes(device.platform)) throw new Error('Selecione Windows ou Linux nas configurações do dispositivo.');
  const command = device.platform === 'linux'
    ? (action === 'restart' ? 'sudo -n shutdown -r now' : 'sudo -n shutdown -h now')
    : (action === 'restart' ? 'powershell.exe -NoProfile -NonInteractive -Command "Restart-Computer -Force"' : 'powershell.exe -NoProfile -NonInteractive -Command "Stop-Computer -Force"');
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-i', SSH_KEY, '-p', String(device.sshPort || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', device.sshHost, command], { timeout: 10000, windowsHide: true }, (error, _out, stderr) => {
      if (error) reject(new Error(stderr?.trim() || 'Falha no SSH. Verifique a chave e a configuração do host.'));
      else resolve();
    });
  });
}
function remoteInfo(device) {
  if (!SSH_KEY) throw new Error('Configure SSH_KEY_PATH no servidor para consultar o equipamento via SSH.');
  if (!device.sshHost || !/^[\w.@-]+$/.test(device.sshHost)) throw new Error('Configure o destino SSH deste equipamento primeiro.');
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
      'printf "memory=%s\\n" "$(free -h 2>/dev/null | awk \'/^Mem:/ {print $2 \" total, \" $3 \" used, \" $7 \" available\'}\')"',
      'printf "swap=%s\\n" "$(free -h 2>/dev/null | awk \'/^Swap:/ {print $2 \" total, \" $3 \" used\'}\')"',
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
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-i', SSH_KEY, '-p', String(device.sshPort || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', device.sshHost, command], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr?.trim() || 'Falha ao consultar informações por SSH.'));
      try {
        if (device.platform === 'windows') return resolve(JSON.parse(stdout.trim()));
        const values = Object.fromEntries(stdout.split(/\r?\n/).filter(Boolean).map(line => {
          const separator = line.indexOf('='); return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
        }));
        resolve(values);
      } catch { reject(new Error('O equipamento respondeu em um formato inesperado.')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      if (scanInProgress) return send(res, 409, { error: 'Já existe uma varredura em andamento.' });
      scanInProgress = true;
      try { return send(res, 200, await scanLan()); }
      finally { scanInProgress = false; }
    }
    if (req.method === 'GET' && url.pathname === '/api/config/export') {
      const config = { app: 'STATUS PC v2', schemaVersion: 1, exportedAt: new Date().toISOString(), devices: readDevices() };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="status-pc-config.json"', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(config, null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/api/config/import') {
      const body = await getBody(req, 2_000_000);
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
        if (!name || !validIp(ip) || (mac && !validMac(mac)) || !['windows', 'linux'].includes(platform)) return send(res, 400, { error: `Configuração ${i + 1}: nome, IPv4, MAC ou sistema operacional inválido.` });
        if (sshHost && !/^[\w.@-]{1,100}$/.test(sshHost)) return send(res, 400, { error: `Configuração ${i + 1}: destino SSH inválido.` });
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return send(res, 400, { error: `Configuração ${i + 1}: porta SSH inválida.` });
        normalized.push({ id: /^[\w-]{1,80}$/.test(String(item.id || '')) ? String(item.id) : crypto.randomUUID(), name, ip, mac: validMac(mac) ? mac.toUpperCase().replace(/-/g, ':') : '', platform, sshHost, sshPort, broadcast: validIp(item.broadcast) ? item.broadcast : '255.255.255.255' });
      }
      const current = readDevices(); const ids = new Set(current.map(device => device.id));
      let added = 0; let updated = 0;
      for (const item of normalized) {
        const index = current.findIndex(device => device.ip === item.ip);
        if (index >= 0) { current[index] = { ...item, id: current[index].id }; updated++; }
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
      const statuses = await Promise.all(devices.map(async device => ({ ...device, online: validIp(device.ip) ? await ping(device.ip) : false })));
      return send(res, 200, { devices: statuses, sshEnabled: Boolean(SSH_KEY), networkInterfaces: Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address) });
    }
    if (req.method === 'POST' && url.pathname === '/api/devices') {
      const body = await getBody(req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (!name || !validIp(body.ip) || (body.mac && !validMac(body.mac))) return send(res, 400, { error: 'Informe nome e IPv4 válidos; se preencher MAC, ele precisa ser válido.' });
      const devices = readDevices();
      const item = { id: crypto.randomUUID(), name, ip: body.ip, mac: validMac(body.mac) ? body.mac.toUpperCase().replace(/-/g, ':') : '', platform: ['windows', 'linux'].includes(body.platform) ? body.platform : 'windows', sshHost: String(body.sshHost || '').trim().slice(0, 100), sshPort: Number.isInteger(Number(body.sshPort)) && Number(body.sshPort) >= 1 && Number(body.sshPort) <= 65535 ? Number(body.sshPort) : 22, broadcast: validIp(body.broadcast) ? body.broadcast : '255.255.255.255' };
      devices.push(item); saveDevices(devices); return send(res, 201, item);
    }
    const match = url.pathname.match(/^\/api\/devices\/([\w-]+)(?:\/(wake|shutdown|restart|info))?$/);
    if (match) {
      const devices = readDevices(); const index = devices.findIndex(d => d.id === match[1]);
      if (index < 0) return send(res, 404, { error: 'Dispositivo não encontrado.' });
      if (req.method === 'DELETE' && !match[2]) { devices.splice(index, 1); saveDevices(devices); return send(res, 200, { ok: true }); }
      if (req.method === 'PATCH' && !match[2]) {
        const body = await getBody(req);
        const current = devices[index];
        const name = body.name === undefined ? current.name : String(body.name).trim().slice(0, 60);
        const ip = body.ip === undefined ? current.ip : String(body.ip).trim();
        const mac = body.mac === undefined ? current.mac : String(body.mac || '').trim();
        const platform = body.platform === undefined ? current.platform : body.platform;
        const sshHost = body.sshHost === undefined ? (current.sshHost || '') : String(body.sshHost || '').trim();
        const sshPort = Number(body.sshPort || current.sshPort || 22);
        const broadcast = body.broadcast === undefined ? current.broadcast : (validIp(body.broadcast) ? body.broadcast : '255.255.255.255');
        if (!name || !validIp(ip) || (mac && !validMac(mac))) return send(res, 400, { error: 'Informe nome e IPv4 válidos; se preencher MAC, ele precisa ser válido.' });
        if (!['windows', 'linux'].includes(platform)) return send(res, 400, { error: 'Selecione Windows ou Linux.' });
        if (sshHost && !/^[\w.@-]{1,100}$/.test(sshHost)) return send(res, 400, { error: 'Informe um destino válido no formato usuario@IP ou usuario@hostname.' });
        if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) return send(res, 400, { error: 'A porta SSH precisa estar entre 1 e 65535.' });
        devices[index] = { ...current, name, ip, mac: validMac(mac) ? mac.toUpperCase().replace(/-/g, ':') : '', platform, sshHost, sshPort, broadcast };
        saveDevices(devices);
        return send(res, 200, { ok: true, device: devices[index] });
      }
      if (req.method === 'POST' && match[2] === 'wake') { if (!validMac(devices[index].mac)) return send(res, 400, { error: 'Este dispositivo não tem endereço MAC cadastrado para Wake-on-LAN.' }); await wake(devices[index].mac, devices[index].broadcast); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && ['shutdown', 'restart'].includes(match[2])) { await remotePower(devices[index], match[2]); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && match[2] === 'info') { const info = await remoteInfo(devices[index]); return send(res, 200, { info, collectedAt: new Date().toISOString() }); }
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(ROOT, requested);
      if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Proibido', 'text/plain; charset=utf-8');
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
      return fs.readFile(file, (error, content) => error ? send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8') : send(res, 200, content, types[path.extname(file)] || 'application/octet-stream'));
    }
    send(res, 404, { error: 'Rota não encontrada.' });
  } catch (error) { send(res, 500, { error: error.message || 'Erro interno.' }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`STATUS PC v2 disponível em http://localhost:${PORT}`));
