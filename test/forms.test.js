const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { validationMessage } = require('../validation');

let serverProcess;
let baseUrl;
let tempDataDir;

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error('Servidor de teste encerrou antes de iniciar.');
    try {
      const response = await fetch(`${baseUrl}/api/devices`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Tempo limite ao iniciar servidor de teste.');
}

before(async () => {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pc-tests-'));
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), STATUS_PC_DATA_DIR: tempDataDir, SSH_CREDENTIALS_SECRET: 'test-only-secret' },
    stdio: 'ignore'
  });
  await waitForServer();
});

after(() => {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  if (tempDataDir) fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('validação de tela aceita os campos opcionais vazios e rejeita IPv4 inválido', () => {
  assert.equal(validationMessage({ id: 'sshHost', value: '', required: false }), '');
  assert.equal(validationMessage({ id: 'ip', value: '192.168.1.25', required: true }), '');
  assert.match(validationMessage({ id: 'ip', value: '300.168.1.25', required: true }), /IPv4/);
});

test('validação de tela confere MAC, destino e porta SSH', () => {
  assert.equal(validationMessage({ id: 'mac', value: 'aa:bb:cc:dd:ee:ff', required: false }), '');
  assert.match(validationMessage({ id: 'mac', value: 'invalido', required: false }), /MAC/);
  assert.equal(validationMessage({ id: 'ssh-destination', value: 'admin@pc.local', required: true }), '');
  assert.match(validationMessage({ id: 'ssh-destination', value: 'pc.local', required: true }), /usuario@/);
  assert.match(validationMessage({ id: 'ssh-port', value: '70000', required: true }), /1 e 65535/);
});

test('validação de tela impõe os limites de tamanho das credenciais SSH', () => {
  assert.match(validationMessage({ id: 'sshPrivateKeyDevice', value: 'k'.repeat(20001), required: false }), /20.000/);
  assert.match(validationMessage({ id: 'sshPasswordDevice', value: 's'.repeat(1025), required: false }), /1.024/);
  assert.match(validationMessage({ id: 'sshKeyPathDevice', value: 'p'.repeat(501), required: false }), /500/);
});

test('telas publicam os formulários e ações principais para o navegador', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const id of ['device-form', 'device-submit', 'ssh-form', 'ssh-submit', 'test-ssh', 'generate-ssh-key', 'import-submit']) {
    assert.match(html, new RegExp(`id="${id}"`), `controle ausente: ${id}`);
  }
  assert.match(html, /src="\/validation\.js"><\/script><script src="\/app\.js"/);
  const asset = await fetch(`${baseUrl}/validation.js`);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /StatusPcValidation/);
});

test('cadastro rejeita nome, IPv4 e sistema operacional inválidos', async () => {
  for (const payload of [
    { name: '', ip: '192.168.1.10', platform: 'linux' },
    { name: 'PC', ip: '999.1.1.1', platform: 'linux' },
    { name: 'PC', ip: '192.168.1.10', platform: 'macos' }
  ]) {
    const result = await request('/api/devices', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(result.status, 400);
  }
});

test('cadastro e edição mantêm os campos principais e a configuração SSH', async () => {
  const created = await request('/api/devices', {
    method: 'POST',
    body: JSON.stringify({ name: 'PC de teste', ip: '192.168.77.10', mac: 'aa:bb:cc:dd:ee:ff', platform: 'linux', sshHost: 'admin@192.168.77.10', sshPort: 22 })
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const invalid = await request(`/api/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ sshPort: 70000 }) });
  assert.equal(invalid.status, 400);

  const updated = await request(`/api/devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'PC editado', sshHost: 'operador@pc-teste.local', sshPort: 2222, broadcast: '192.168.77.255' })
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.device.name, 'PC editado');
  assert.equal(updated.body.device.sshPort, 2222);
  assert.equal(updated.body.device.sshHost, 'operador@pc-teste.local');

  const list = await request('/api/devices');
  assert.equal(list.body.devices.find(device => device.id === id).name, 'PC editado');
});

test('cadastro rejeita MAC, destino SSH e broadcast inválidos', async () => {
  for (const changes of [
    { mac: 'not-a-mac' },
    { sshHost: 'destino-sem-usuario' },
    { broadcast: '300.1.1.1' }
  ]) {
    const result = await request('/api/devices', {
      method: 'POST',
      body: JSON.stringify({ name: 'PC inválido', ip: '192.168.77.20', platform: 'windows', ...changes })
    });
    assert.equal(result.status, 400);
  }
});

test('teste de conexão SSH valida destino, porta e credenciais antes de conectar', async () => {
  const missingCredentials = await request('/api/ssh/test', {
    method: 'POST', body: JSON.stringify({ sshHost: 'admin@localhost', sshPort: 22 })
  });
  assert.equal(missingCredentials.status, 400);

  const badPort = await request('/api/ssh/test', {
    method: 'POST', body: JSON.stringify({ sshHost: 'admin@localhost', sshPort: 0, sshPassword: 'x' })
  });
  assert.equal(badPort.status, 400);

  const badHost = await request('/api/ssh/test', {
    method: 'POST', body: JSON.stringify({ sshHost: 'localhost', sshPort: 22, sshPassword: 'x' })
  });
  assert.equal(badHost.status, 400);
});

test('geração de chave SSH retorna par Ed25519', async () => {
  const result = await request('/api/ssh/generate-key', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.match(result.body.privateKey, /BEGIN OPENSSH PRIVATE KEY/);
  assert.match(result.body.publicKey, /^ssh-ed25519 /);
});

test('importação rejeita registros inválidos e aceita configuração válida', async () => {
  const invalid = await request('/api/config/import', {
    method: 'POST', body: JSON.stringify({ devices: [{ name: 'Inválido', ip: '10.0.0.300', platform: 'linux' }] })
  });
  assert.equal(invalid.status, 400);

  const valid = await request('/api/config/import', {
    method: 'POST', body: JSON.stringify({ devices: [{ id: 'import-form-test', name: 'Importado', ip: '10.0.0.30', platform: 'windows' }] })
  });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.added, 1);
  assert.equal(valid.body.total, 2);
});
