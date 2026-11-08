(function exposeValidation(root) {
  function validationMessage(field) {
    const value = field.value.trim();
    if (!value) return field.required ? 'Este campo é obrigatório.' : '';
    if (field.id === 'ip' || field.id === 'broadcast') {
      const valid = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(value);
      return valid ? '' : 'Informe um endereço IPv4 válido.';
    }
    if (field.id === 'mac' && !/^(?:[\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(value)) return 'Informe um MAC no formato AA:BB:CC:DD:EE:FF.';
    if (['sshHost', 'ssh-destination'].includes(field.id) && !/^[\w.-]{1,64}@[\w.-]{1,255}$/.test(value)) return 'Use o formato usuario@IP ou usuario@hostname.';
    if (['sshPortDevice', 'ssh-port'].includes(field.id) && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535)) return 'A porta deve estar entre 1 e 65535.';
    if (field.id === 'sshKeyPathDevice' && value.length > 500) return 'O caminho da chave pode ter no máximo 500 caracteres.';
    if (field.id === 'sshPublicKeyDevice' && value.length > 2048) return 'A chave pública pode ter no máximo 2.048 caracteres.';
    if (field.id === 'sshPasswordDevice' && field.value.length > 1024) return 'A senha pode ter no máximo 1.024 caracteres.';
    if (field.id === 'sshPrivateKeyDevice' && field.value.length > 20000) return 'A chave privada pode ter no máximo 20.000 caracteres.';
    return '';
  }

  const api = { validationMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatusPcValidation = api;
})(globalThis);
