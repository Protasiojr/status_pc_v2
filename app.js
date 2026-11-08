const list = document.querySelector('#device-list');
const toast = new bootstrap.Toast(document.querySelector('#toast'), { delay: 3200 });
let devices = [];
let sshEnabled = false;
let sshDevice = null;
let sshAction = 'shutdown';

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
  list.innerHTML = visible.map(d => `<article class="device-card"><div class="device-top"><div class="device-ident"><div class="device-icon"><i class="bi ${d.platform === 'linux' ? 'bi-ubuntu' : 'bi-windows'}"></i></div><div class="min-w-0"><div class="device-name">${escapeHtml(d.name)}</div><div class="device-os">${d.platform === 'linux' ? 'Linux' : 'Windows'} · ${escapeHtml(d.ip)}</div></div></div><span class="status ${d.online ? 'online' : 'offline'}"><span class="status-dot"></span>${d.online ? 'ONLINE' : 'OFFLINE'}</span></div><div class="device-meta"><div class="meta-item"><span>ENDEREÇO IP</span><strong>${escapeHtml(d.ip)}</strong></div><div class="meta-item"><span>ENDEREÇO MAC</span><strong>${escapeHtml(d.mac)}</strong></div></div><div class="device-actions"><button class="action-btn wake" data-action="wake" data-id="${d.id}" title="Enviar pacote Wake-on-LAN"><i class="bi bi-power"></i> Ligar (WoL)</button><button class="action-btn shutdown" data-action="shutdown" data-id="${d.id}" title="Configurar SSH e desligar"><i class="bi bi-moon"></i> Desligar (SSH)</button><button class="action-btn restart" data-action="restart" data-id="${d.id}" title="Configurar SSH e reiniciar"><i class="bi bi-arrow-clockwise"></i> Reiniciar</button><button class="action-btn info" data-action="info" data-id="${d.id}" title="Consultar informações do equipamento"><i class="bi bi-info-circle"></i> Info</button><button class="action-btn" data-action="refresh" data-id="${d.id}"><i class="bi bi-arrow-repeat"></i> Status</button><button class="delete-btn" data-action="delete" data-id="${d.id}" title="Remover" aria-label="Remover ${escapeHtml(d.name)}"><i class="bi bi-trash3"></i></button></div></article>`).join('');
}
async function refresh(showError = false) {
  try { const result = await api('/api/devices'); devices = result.devices; sshEnabled = result.sshEnabled; document.querySelector('#last-update').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; document.querySelector('#refresh').classList.remove('is-error'); render(); }
  catch (error) { if (showError) notify(error.message); else list.innerHTML = `<div class="empty-state error-state"><i class="bi bi-exclamation-circle"></i><strong>Servidor local indisponível</strong><p>${escapeHtml(error.message)} Inicie o app com <code>npm start</code>.</p></div>`; }
}
document.querySelector('#refresh').addEventListener('click', () => refresh(true));
document.querySelector('#search').addEventListener('input', render);
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
document.querySelector('#device-form').addEventListener('submit', async event => {
  event.preventDefault(); const errorBox = document.querySelector('#form-error'); errorBox.textContent = '';
  const device = { name: document.querySelector('#name').value, ip: document.querySelector('#ip').value.trim(), mac: document.querySelector('#mac').value.trim(), platform: document.querySelector('#platform').value, broadcast: document.querySelector('#broadcast').value.trim(), sshHost: document.querySelector('#sshHost').value.trim() };
  try { await api('/api/devices', { method: 'POST', body: JSON.stringify(device) }); event.target.reset(); bootstrap.Modal.getInstance(document.querySelector('#device-modal')).hide(); await refresh(); notify('Dispositivo adicionado.'); }
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
