const list = document.querySelector('#device-list');
const toast = new bootstrap.Toast(document.querySelector('#toast'), { delay: 3200 });
let devices = [];
let sshEnabled = false;
let sshDevice = null;
let sshAction = 'shutdown';
let scanDevices = [];
let localAddresses = [];
let selectedMapIp = '';
let editingDeviceId = null;
let importConfig = null;

function notify(message) { document.querySelector('#toast-message').textContent = message; toast.show(); }
async function api(url, options) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Não foi possível concluir a operação.');
  return body;
}
function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function render() {
  const query = document.querySelector('#search').value.trim().toLowerCase();
  const visible = devices.filter(d => `${d.name} ${d.ip} ${d.mac}`.toLowerCase().includes(query));
  document.querySelector('#total-count').textContent = devices.length;
  document.querySelector('#online-count').textContent = devices.filter(d => d.online).length;
  document.querySelector('#offline-count').textContent = devices.filter(d => !d.online).length;
  document.querySelector('#device-subtitle').textContent = `${devices.length} equipamento${devices.length === 1 ? '' : 's'} cadastrado${devices.length === 1 ? '' : 's'} · atualização automática a cada 15 s`;
  if (!visible.length) {
    list.innerHTML = query ? '<div class="empty-state"><i class="bi bi-search"></i><strong>Nenhum resultado</strong><p>Tente outro nome, IP ou MAC.</p></div>' : '<div class="empty-state"><i class="bi bi-pc-display"></i><strong>Sua rede começa aqui</strong><p>Adicione o primeiro computador para acompanhar seu status.</p></div>';
    return;
  }
  list.innerHTML = visible.map(d => `<article class="device-card"><div class="device-top"><div class="device-ident"><div class="device-icon"><i class="bi ${d.platform === 'linux' ? 'bi-ubuntu' : 'bi-windows'}"></i></div><div class="min-w-0"><div class="device-name">${escapeHtml(d.name)}</div><div class="device-os">${d.platform === 'linux' ? 'Linux' : 'Windows'} · ${escapeHtml(d.ip)}</div></div></div><span class="status ${d.online ? 'online' : 'offline'}"><span class="status-dot"></span>${d.online ? 'ONLINE' : 'OFFLINE'}</span></div><div class="device-meta"><div class="meta-item"><span>ENDEREÇO IP</span><strong>${escapeHtml(d.ip)}</strong></div><div class="meta-item"><span>ENDEREÇO MAC</span><strong>${escapeHtml(d.mac || 'Não localizado')}</strong></div></div><div class="device-actions"><button class="action-btn wake" data-action="wake" data-id="${d.id}" title="Enviar pacote Wake-on-LAN" ${d.mac ? '' : 'disabled'}><i class="bi bi-power"></i> Ligar (WoL)</button><button class="action-btn shutdown" data-action="shutdown" data-id="${d.id}" title="Configurar SSH e desligar"><i class="bi bi-moon"></i> Desligar (SSH)</button><button class="action-btn restart" data-action="restart" data-id="${d.id}" title="Configurar SSH e reiniciar"><i class="bi bi-arrow-clockwise"></i> Reiniciar</button><button class="action-btn info" data-action="info" data-id="${d.id}" title="Consultar informações do equipamento"><i class="bi bi-info-circle"></i> Info</button><button class="action-btn edit" data-action="edit" data-id="${d.id}" title="Editar configurações"><i class="bi bi-pencil-square"></i> Editar</button><button class="action-btn" data-action="refresh" data-id="${d.id}"><i class="bi bi-arrow-repeat"></i> Status</button><button class="delete-btn" data-action="delete" data-id="${d.id}" title="Remover" aria-label="Remover ${escapeHtml(d.name)}"><i class="bi bi-trash3"></i></button></div></article>`).join('');
}
async function refresh(showError = false) {
  try { const result = await api('/api/devices'); devices = result.devices; sshEnabled = result.sshEnabled; localAddresses = result.networkInterfaces || []; document.querySelector('#last-update').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; document.querySelector('#refresh').classList.remove('is-error'); render(); renderNetworkMap(); }
  catch (error) { if (showError) notify(error.message); else list.innerHTML = `<div class="empty-state error-state"><i class="bi bi-exclamation-circle"></i><strong>Servidor local indisponível</strong><p>${escapeHtml(error.message)} Inicie o app com <code>npm start</code>.</p></div>`; }
}
document.querySelector('#refresh').addEventListener('click', () => refresh(true));
document.querySelector('#search').addEventListener('input', render);
function prepareDeviceModal(device = null) {
  const form = document.querySelector('#device-form'); form.reset();
  document.querySelector('#form-error').textContent = '';
  editingDeviceId = device?.id || null;
  document.querySelector('#device-modal-title').textContent = device ? 'Editar dispositivo' : 'Adicionar dispositivo';
  document.querySelector('#device-submit').innerHTML = device ? '<i class="bi bi-check2"></i> <span>Salvar alterações</span>' : '<i class="bi bi-plus-lg"></i> <span>Adicionar</span>';
  if (device) {
    document.querySelector('#name').value = device.name;
    document.querySelector('#ip').value = device.ip;
    document.querySelector('#mac').value = device.mac || '';
    document.querySelector('#platform').value = device.platform;
    document.querySelector('#broadcast').value = device.broadcast || '';
    document.querySelector('#sshHost').value = device.sshHost || '';
    document.querySelector('#sshPortDevice').value = device.sshPort || 22;
  }
}
document.querySelector('.add-button').addEventListener('click', () => prepareDeviceModal());
document.querySelector('#scan-network').addEventListener('click', async event => {
  const button = event.currentTarget; const results = document.querySelector('#scan-results'); const summary = document.querySelector('#scan-summary');
  button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Scan...';
  results.innerHTML = '<div class="info-loading"><span class="spinner-border spinner-border-sm"></span> Varrendo os endereços da rede local. Isso pode levar alguns segundos...</div>';
  summary.textContent = 'Buscando computadores e dispositivos ativos...';
  bootstrap.Modal.getOrCreateInstance(document.querySelector('#scan-modal')).show();
  try {
    const scan = await api('/api/scan', { method: 'POST' }); scanDevices = scan.devices; renderNetworkMap();
    const registered = new Set(devices.map(device => device.ip));
    summary.textContent = `${scan.devices.length} dispositivo(s) encontrados; ${scan.scanned} endereços consultados em ${scan.subnets.length} sub-rede(s)${scan.truncated ? ' (varredura limitada a 8.192 endereços)' : ''}.`;
    if (!scan.devices.length) { results.innerHTML = '<div class="empty-state"><i class="bi bi-radar"></i><strong>Nenhum dispositivo encontrado</strong><p>Os dispositivos podem bloquear ping e não estar na tabela ARP.</p></div>'; return; }
    results.innerHTML = scan.devices.map((found, index) => `<div class="scan-device"><div class="scan-device-icon"><i class="bi bi-pc-display"></i></div><div class="scan-device-main"><strong>${escapeHtml(`Dispositivo ${found.ip}`)}</strong><span>${escapeHtml(found.ip)} · MAC ${escapeHtml(found.mac || 'não identificado')}</span></div><span class="scan-source">${found.source === 'ping+arp' ? 'PING + ARP' : found.source.toUpperCase()}</span><button class="btn btn-scan-add" data-scan-index="${index}" ${registered.has(found.ip) ? 'disabled' : ''}>${registered.has(found.ip) ? 'Cadastrado' : 'Adicionar'}</button></div>`).join('');
  } catch (error) { summary.textContent = 'A varredura não foi concluída.'; results.innerHTML = `<div class="info-error"><i class="bi bi-exclamation-circle"></i><strong>Erro na varredura</strong><p>${escapeHtml(error.message)}</p></div>`; }
  finally { button.disabled = false; button.innerHTML = '<i class="bi bi-radar"></i> Scan'; }
});
document.querySelector('#scan-results').addEventListener('click', event => {
  const button = event.target.closest('[data-scan-index]'); if (!button) return;
  const found = scanDevices[Number(button.dataset.scanIndex)]; if (!found) return;
  const scanModal = document.querySelector('#scan-modal');
  scanModal.addEventListener('hidden.bs.modal', () => {
    prepareDeviceModal();
    document.querySelector('#name').value = `PC-${found.ip.split('.').at(-1)}`;
    document.querySelector('#ip').value = found.ip;
    document.querySelector('#mac').value = found.mac;
    document.querySelector('#platform').value = '';
    document.querySelector('#broadcast').value = found.broadcast;
    document.querySelector('#form-error').textContent = '';
    bootstrap.Modal.getOrCreateInstance(document.querySelector('#device-modal')).show();
  }, { once: true });
  bootstrap.Modal.getInstance(scanModal).hide();
});
document.querySelector('#save-config').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/config/export');
    if (!response.ok) throw new Error('Não foi possível salvar as configurações.');
    const file = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = `status-pc-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
    notify('Arquivo JSON das configurações baixado.');
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
const configFile = document.querySelector('#config-file');
document.querySelector('#upload-config').addEventListener('click', () => { configFile.value = ''; configFile.click(); });
configFile.addEventListener('change', async () => {
  const file = configFile.files?.[0]; if (!file) return;
  const errorBox = document.querySelector('#import-error'); errorBox.textContent = '';
  if (!file.name.toLowerCase().endsWith('.json') || file.size > 1_500_000) { notify('Selecione um arquivo .json de até 1,5 MB.'); return; }
  try {
    const parsed = JSON.parse(await file.text());
    const importedDevices = Array.isArray(parsed) ? parsed : parsed.devices;
    if (!Array.isArray(importedDevices) || importedDevices.length > 4096) throw new Error('JSON inválido: não encontrei a lista de dispositivos ou ela excede 4.096 itens.');
    importConfig = { devices: importedDevices };
    document.querySelector('#import-filename').textContent = file.name;
    document.querySelector('#import-count').textContent = `${importedDevices.length} dispositivo(s) no arquivo`;
    bootstrap.Modal.getOrCreateInstance(document.querySelector('#import-modal')).show();
  } catch (error) { notify(error.message.startsWith('JSON') ? error.message : 'O arquivo não contém um JSON válido.'); }
});
document.querySelector('#import-submit').addEventListener('click', async event => {
  if (!importConfig) return;
  const button = event.currentTarget; const errorBox = document.querySelector('#import-error');
  button.disabled = true; errorBox.textContent = '';
  try {
    const result = await api('/api/config/import', { method: 'POST', body: JSON.stringify(importConfig) });
    importConfig = null; bootstrap.Modal.getInstance(document.querySelector('#import-modal')).hide(); await refresh();
    notify(`Importação concluída: ${result.added} adicionado(s), ${result.updated} atualizado(s).`);
  } catch (error) { errorBox.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#device-form').addEventListener('submit', async event => {
  event.preventDefault(); const errorBox = document.querySelector('#form-error'); errorBox.textContent = '';
  const device = { name: document.querySelector('#name').value, ip: document.querySelector('#ip').value.trim(), mac: document.querySelector('#mac').value.trim(), platform: document.querySelector('#platform').value, broadcast: document.querySelector('#broadcast').value.trim(), sshHost: document.querySelector('#sshHost').value.trim(), sshPort: Number(document.querySelector('#sshPortDevice').value || 22) };
  try {
    if (editingDeviceId) await api(`/api/devices/${editingDeviceId}`, { method: 'PATCH', body: JSON.stringify(device) });
    else await api('/api/devices', { method: 'POST', body: JSON.stringify(device) });
    const wasEditing = Boolean(editingDeviceId); editingDeviceId = null; prepareDeviceModal(); bootstrap.Modal.getInstance(document.querySelector('#device-modal')).hide(); await refresh(); notify(wasEditing ? 'Configurações atualizadas.' : 'Dispositivo adicionado.');
  }
  catch (error) { errorBox.textContent = error.message; }
});
function openSshModal(device, action = 'shutdown') {
  sshDevice = device;
  sshAction = action;
  document.querySelector('#ssh-device-label').textContent = `Computador: ${device.name}`;
  document.querySelector('#ssh-destination').value = device.sshHost || `usuario@${device.ip}`;
  document.querySelector('#ssh-port').value = device.sshPort || 22;
  document.querySelector('#ssh-platform').textContent = device.platform === 'linux' ? 'Linux' : 'Windows';
  document.querySelector('#ssh-error').textContent = '';
  const notice = document.querySelector('#ssh-key-notice');
  notice.classList.toggle('warning', !sshEnabled);
  notice.querySelector('span').textContent = sshEnabled ? 'Chave SSH configurada no servidor.' : 'SSH_KEY_PATH ainda não está configurada no servidor. Você pode salvar o destino, mas precisa configurar a chave antes de desligar.';
  const actionLabel = action === 'restart' ? 'reiniciar' : 'desligar';
  document.querySelector('#ssh-submit').innerHTML = device.online ? `<i class="bi ${action === 'restart' ? 'bi-arrow-clockwise' : 'bi-power'}"></i> Salvar e ${actionLabel}` : '<i class="bi bi-check2"></i> Salvar configuração';
  bootstrap.Modal.getOrCreateInstance(document.querySelector('#ssh-modal')).show();
}
document.querySelector('#ssh-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!sshDevice) return;
  const submit = document.querySelector('#ssh-submit');
  const errorBox = document.querySelector('#ssh-error');
  errorBox.textContent = ''; submit.disabled = true;
  const actionLabel = sshAction === 'restart' ? 'reiniciar' : 'desligar';
  try {
    const settings = { sshHost: document.querySelector('#ssh-destination').value.trim(), sshPort: Number(document.querySelector('#ssh-port').value) };
    await api(`/api/devices/${sshDevice.id}`, { method: 'PATCH', body: JSON.stringify(settings) });
    if (sshDevice.online) await api(`/api/devices/${sshDevice.id}/${sshAction}`, { method: 'POST' });
    bootstrap.Modal.getInstance(document.querySelector('#ssh-modal')).hide();
    notify(sshDevice.online ? `Comando para ${actionLabel} ${sshDevice.name} enviado.` : `Configuração SSH salva para ${sshDevice.name}.`);
    await refresh();
  } catch (error) { errorBox.textContent = error.message; }
  finally { submit.disabled = false; }
});
const infoLabels = { registeredName: 'Nome no painel', ip: 'Endereço IP cadastrado', mac: 'MAC cadastrado', platform: 'Sistema cadastrado', hostname: 'Hostname', os: 'Sistema operacional', version: 'Versão', build: 'Build', architecture: 'Arquitetura', kernel: 'Kernel', uptime: 'Tempo ligado', lastBoot: 'Última inicialização', cpu: 'Processador', cores: 'Núcleos físicos', logicalProcessors: 'Processadores lógicos', memoryGB: 'Memória RAM total (GB)', memoryAvailableGB: 'Memória RAM disponível (GB)', memory: 'Memória RAM', swap: 'Memória Swap', disks: 'Discos e partições', network: 'Interfaces e IPv4', macs: 'Interfaces e endereços MAC', manufacturer: 'Fabricante', model: 'Modelo', domain: 'Domínio ou grupo', bios: 'BIOS/UEFI', serial: 'Número de série', gpu: 'Placa(s) de vídeo', load: 'Carga do sistema', processes: 'Processos em execução', collectedAt: 'Consultado em' };
function formatInfo(value) {
  if (value === null || value === undefined || value === '') return 'Não informado';
  if (Array.isArray(value)) return value.length ? value.map(item => typeof item === 'object' ? Object.entries(item).map(([k, v]) => `${k}: ${formatInfo(v)}`).join(' · ') : String(item)).join('\n') : 'Nenhum';
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${formatInfo(v)}`).join(' · ');
  return String(value);
}
function getMapEntries() {
  const registeredIps = new Set(devices.map(device => device.ip));
  const entries = devices.map(device => ({ ip: device.ip, name: device.name, mac: device.mac, platform: device.platform, online: device.online, registered: true, device }));
  for (const found of scanDevices) if (!registeredIps.has(found.ip)) entries.push({ ...found, name: `Dispositivo ${found.ip}`, platform: 'desconhecido', registered: false });
  return entries;
}
function renderNetworkMap() {
  const graph = document.querySelector('#network-graph'); if (!graph) return;
  const entries = getMapEntries();
  document.querySelector('#map-count').textContent = `${entries.length} dispositivo${entries.length === 1 ? '' : 's'} · ${devices.length} cadastrado${devices.length === 1 ? '' : 's'}${scanDevices.length ? ` · ${scanDevices.length} do último scan` : ''}`;
  if (!entries.length) {
    graph.style.width = '100%'; graph.style.height = '400px';
    graph.innerHTML = '<div class="map-empty"><i class="bi bi-diagram-3"></i><strong>Nenhum equipamento para mapear</strong><span>Cadastre dispositivos ou faça um Scan da rede.</span><button class="btn btn-scan" data-action="map-empty-scan"><i class="bi bi-radar"></i> Fazer Scan</button></div>';
    document.querySelector('#map-details').innerHTML = '<div class="map-placeholder"><i class="bi bi-pc-display"></i><strong>Mapa vazio</strong><span>Os dispositivos aparecerão aqui após o cadastro ou Scan.</span></div>';
    return;
  }
  const slots = 12; const ringCount = Math.ceil(entries.length / slots);
  const radiusFor = ring => { const count = Math.min(slots, entries.length - ring * slots); return Math.max(235, count * 195 / (2 * Math.PI)) + ring * 205; };
  const maxRadius = Math.max(...Array.from({ length: ringCount }, (_, ring) => radiusFor(ring)));
  const width = Math.max(1000, Math.ceil((maxRadius + 190) * 2)); const height = Math.max(690, Math.ceil((maxRadius + 145) * 2));
  const cx = width / 2, cy = height / 2;
  graph.style.width = `${width}px`; graph.style.height = `${height}px`;
  const nodePositions = entries.map((entry, index) => {
    const ring = Math.floor(index / slots); const start = ring * slots; const count = Math.min(slots, entries.length - start); const slot = index - start;
    const angle = (2 * Math.PI * slot / count) - Math.PI / 2; const radius = radiusFor(ring);
    return { entry, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius, index };
  });
  const lines = nodePositions.map(({ x, y, entry }) => `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="map-edge ${entry.online ? 'edge-online' : ''}"/>`).join('');
  const nodes = nodePositions.map(({ entry, x, y, index }) => {
    const status = entry.registered ? (entry.online ? 'Online' : 'Offline') : (entry.online ? 'Ping' : 'ARP');
    const stateClass = entry.registered ? (entry.online ? 'online' : 'offline') : 'found';
    const icon = entry.platform === 'linux' ? 'bi-ubuntu' : entry.platform === 'windows' ? 'bi-windows' : 'bi-pc-display';
    return `<button class="map-node ${stateClass} ${selectedMapIp === entry.ip ? 'selected' : ''}" data-map-index="${index}" style="left:${x - 91}px;top:${y - 48}px" aria-label="Selecionar ${escapeHtml(entry.name)}"><span class="map-node-top"><i class="bi ${icon}"></i><b>${escapeHtml(status)}</b></span><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.ip)}</small></button>`;
  }).join('');
  graph.innerHTML = `<svg class="map-edges" viewBox="0 0 ${width} ${height}" aria-hidden="true">${lines}<circle cx="${cx}" cy="${cy}" r="8" class="hub-dot"/></svg><div class="map-hub" style="left:${cx - 89}px;top:${cy - 46}px"><i class="bi bi-router"></i><strong>REDE LOCAL</strong><small>${escapeHtml(localAddresses.join(' · ') || 'Servidor STATUS PC')}</small></div>${nodes}`;
  if (!entries.some(entry => entry.ip === selectedMapIp)) selectedMapIp = entries[0].ip;
  showMapDetails(entries.find(entry => entry.ip === selectedMapIp));
}
function showMapDetails(entry) {
  if (!entry) return;
  const state = entry.registered ? (entry.online ? 'ONLINE' : 'OFFLINE') : (entry.online ? 'RESPONDE AO PING' : 'VISTO NA TABELA ARP');
  const icon = entry.platform === 'linux' ? 'bi-ubuntu' : entry.platform === 'windows' ? 'bi-windows' : 'bi-pc-display';
  document.querySelector('#map-details').innerHTML = `<div class="map-detail-card"><div class="map-detail-head"><div class="device-icon"><i class="bi ${icon}"></i></div><span class="status ${entry.online ? 'online' : 'offline'}"><span class="status-dot"></span>${state}</span></div><div class="eyebrow">${entry.registered ? 'DISPOSITIVO CADASTRADO' : 'DESCOBERTO NO SCAN'}</div><h3>${escapeHtml(entry.name)}</h3><div class="map-detail-row"><span>Endereço IP</span><strong>${escapeHtml(entry.ip)}</strong></div><div class="map-detail-row"><span>Endereço MAC</span><strong>${escapeHtml(entry.mac || 'Não identificado')}</strong></div><div class="map-detail-row"><span>Sistema</span><strong>${escapeHtml(entry.platform === 'linux' ? 'Linux' : entry.platform === 'windows' ? 'Windows' : 'Não identificado')}</strong></div>${entry.registered ? `<div class="map-detail-row"><span>Destino SSH</span><strong>${escapeHtml(entry.device.sshHost || 'Não configurado')}</strong></div><button class="btn btn-primary map-info-button" data-map-info="${entry.device.id}"><i class="bi bi-info-circle"></i> Informações completas</button>` : '<p class="map-discovery-note">Cadastre o equipamento para configurar SSH e consultar detalhes.</p>'}</div>`;
}
document.querySelector('#network-graph').addEventListener('click', event => {
  const node = event.target.closest('[data-map-index]');
  if (node) { const entry = getMapEntries()[Number(node.dataset.mapIndex)]; if (entry) { selectedMapIp = entry.ip; renderNetworkMap(); } return; }
  if (event.target.closest('[data-action="map-empty-scan"]')) document.querySelector('#scan-network').click();
});
document.querySelector('#map-details').addEventListener('click', event => {
  const button = event.target.closest('[data-map-info]');
  if (button) { const device = devices.find(item => item.id === button.dataset.mapInfo); if (device) showInfo(device); }
});
document.querySelector('#map-scan').addEventListener('click', () => document.querySelector('#scan-network').click());
document.querySelector('#map-refresh').addEventListener('click', async () => { await refresh(true); renderNetworkMap(); });
document.querySelectorAll('.nav-link[data-view]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  document.querySelectorAll('.nav-link[data-view]').forEach(item => item.classList.toggle('active', item === link));
  document.querySelector('#dashboard-view').hidden = link.dataset.view !== 'dashboard-view';
  document.querySelector('#network-map-page').hidden = link.dataset.view !== 'network-map-page';
  if (link.dataset.view === 'network-map-page') renderNetworkMap();
  if (link.dataset.scroll) document.querySelector(`#${link.dataset.scroll}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  link.closest('.mobile-menu')?.removeAttribute('open');
}));
async function showInfo(device) {
  const modal = bootstrap.Modal.getOrCreateInstance(document.querySelector('#info-modal'));
  document.querySelector('#info-device-label').textContent = `${device.name} · ${device.ip}`;
  const content = document.querySelector('#info-content');
  content.innerHTML = '<div class="info-loading"><span class="spinner-border spinner-border-sm"></span> Consultando o equipamento por SSH...</div>';
  modal.show();
  try {
    const result = await api(`/api/devices/${device.id}/info`, { method: 'POST' });
    const details = { registeredName: device.name, ip: device.ip, mac: device.mac, platform: device.platform === 'linux' ? 'Linux' : 'Windows', ...result.info, collectedAt: new Date(result.collectedAt).toLocaleString('pt-BR') };
    content.innerHTML = Object.entries(details).map(([key, value]) => `<div class="info-item"><span>${escapeHtml(infoLabels[key] || key)}</span><strong>${escapeHtml(formatInfo(value))}</strong></div>`).join('');
  } catch (error) {
    content.innerHTML = `<div class="info-error"><i class="bi bi-exclamation-circle"></i><strong>Não foi possível consultar o equipamento</strong><p>${escapeHtml(error.message)}</p><small>Confirme se está online, se o destino SSH está configurado, se a chave do servidor está autorizada e se o host consta em known_hosts.</small></div>`;
  }
}
list.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset; const device = devices.find(d => d.id === id); if (!device) return;
  if (action === 'edit') { prepareDeviceModal(device); bootstrap.Modal.getOrCreateInstance(document.querySelector('#device-modal')).show(); return; }
  if (action === 'info') { showInfo(device); return; }
  if (action === 'shutdown' || action === 'restart') { openSshModal(device, action); return; }
  if (action === 'delete' && !confirm(`Remover ${device.name} do painel?`)) return;
  button.disabled = true;
  try {
    if (action === 'delete') { await api(`/api/devices/${id}`, { method: 'DELETE' }); notify('Dispositivo removido.'); }
    else if (action === 'refresh') { await refresh(true); return; }
    else { await api(`/api/devices/${id}/${action}`, { method: 'POST' }); notify(action === 'wake' ? `Pacote Wake-on-LAN enviado para ${device.name}.` : `Comando de desligamento enviado para ${device.name}.`); }
    await refresh();
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
refresh(); setInterval(() => refresh(), 15000);
