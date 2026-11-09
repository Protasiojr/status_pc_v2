# STATUS PC v2

Painel web responsivo para acompanhar computadores na rede local e enviar comandos Wake-on-LAN.

## Iniciar

Requer Node.js 18 ou mais recente. Na pasta do projeto, execute:

```sh
npm start
```

O STATUS PC utiliza a porta **6001** por padrão. Abra `http://localhost:6001`. Para acessar de outro aparelho na mesma rede, abra `http://IP-DO-SERVIDOR:6001`. O servidor mostra os endereços IPv4 disponíveis no painel ao consultar a API. A porta pode ser alterada pela variável de ambiente `PORT`.

Os dispositivos cadastrados ficam em `data/devices.json`.

## Deploy em servidor Linux

O Compose usa a rede do host Linux para que Scan, ARP e Wake-on-LAN vejam as interfaces reais da LAN. A aplicação fica disponível na porta 6001 do servidor.

```sh
mkdir -p data/ssh
sudo chown -R 1000:1000 data
chmod 700 data/ssh
```

Crie `.env` com um segredo persistente para proteger credenciais salvas e inicie o serviço:

```sh
printf 'SSH_CREDENTIALS_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d --build
```

Preserve `.env` entre reinicializações e backups; sem o mesmo segredo, as senhas e chaves privadas salvas não podem ser descriptografadas. Os dispositivos e arquivos SSH ficam em `data/`, montada no contêiner e pertencente ao usuário UID 1000 (`node`).

### Inventário Windows pelo Microsoft Intune

O botão **Info** consulta o Microsoft Graph para dispositivos Windows quando as três variáveis abaixo estão configuradas. O aplicativo Entra ID precisa de permissão de aplicação `DeviceManagementManagedDevices.Read.All` no Microsoft Graph, com consentimento de administrador. O dispositivo do Intune deve ter o mesmo nome do card cadastrado no STATUS PC. Sem essas variáveis, o botão continua consultando o computador por SSH.

```env
INTUNE_TENANT_ID=ID-do-tenant
INTUNE_CLIENT_ID=ID-da-aplicacao
INTUNE_CLIENT_SECRET=segredo-da-aplicacao
```

Mantenha `INTUNE_CLIENT_SECRET` apenas no `.env` do servidor e proteja esse arquivo (permissão `600`). A consulta retorna dados de inventário disponíveis no Intune, como versão do Windows, fabricante, modelo, serial, estado de conformidade, usuário principal, sincronização e armazenamento. O inventário do Intune depende da última sincronização do dispositivo e não substitui uma consulta em tempo real.

No cadastro, gere o par Ed25519 que o STATUS PC usará como cliente SSH. O formulário oferece um script Bash para autorizar a chave em Linux ou PowerShell para Windows. No Windows, execute o script elevado: ele instala o OpenSSH Server se necessário, gera as chaves de identidade do host, inicia o serviço sshd, libera a porta 22, instala a chave pública da aplicação em administrators_authorized_keys e aplica as ACLs do OpenSSH. Compare a impressão digital exibida com a chave apresentada ao Linux antes de confiar no host. Também pode usar uma chave existente: coloque-a em data/ssh/ e informe /app/data/ssh/nome-da-chave no formulário. Coloque os hosts confiáveis em data/ssh/known_hosts; a validação da identidade SSH permanece habilitada. A senha também pode ser usada como passphrase de uma chave criptografada.

O servidor STATUS PC pode rodar diretamente em Node no Linux ou Windows. O Compose executa o app em um contêiner Linux; os caminhos de chave no formulário devem ser caminhos visíveis dentro dele, como `/app/data/ssh/id_ed25519`.

## Recursos

- Status online/offline com verificação ICMP, atualizado a cada 15 segundos.
- Ligar via Wake-on-LAN (WoL), por pacote UDP broadcast para a porta 9. SSH não consegue iniciar um computador que está desligado.
- Cadastro e remoção de dispositivos Windows e Linux.
- Edição de nome, IP, MAC, sistema operacional, broadcast e destino/porta SSH dos dispositivos.
- Interface responsiva em tema escuro com Bootstrap e Bootstrap Icons via CDN.
- Desligamento e reinício remotos de Windows e Linux via SSH com autenticação por senha ou chave privada.
- Modal de informações do equipamento com inventário consultado via SSH (sistema, CPU, memória, discos, rede e dados de hardware disponíveis).
- Botão para exportar as configurações dos dispositivos em um arquivo JSON.
- Importação de configurações a partir de um arquivo JSON, mesclando por endereço IP.
- Varredura das sub-redes IPv4 locais com ping concorrente e leitura da tabela ARP.
- Mapa lógico da rede com grafo dos dispositivos cadastrados e encontrados no último Scan.

## Desligamento por SSH

No cadastro do dispositivo, informe o destino `usuario@IP` ou `usuario@nome-do-host`, a senha da conta, uma chave privada colada/gerada ou o caminho de uma chave no servidor. Ao gerar um par Ed25519, instale a chave pública exibida em `authorized_keys` no Linux ou na configuração `authorized_keys` do OpenSSH Server no Windows. A senha também serve como passphrase para uma chave criptografada. Senhas e chaves privadas salvas são criptografadas com `SSH_CREDENTIALS_SECRET`, que deve permanecer igual entre reinicializações. Deixe os campos de senha e chave privada vazios na edição para manter as credenciais já salvas.

A chave pública correspondente deve estar autorizada no computador remoto. O servidor valida a identidade remota usando `known_hosts`; no Docker, monte esse arquivo e configure `SSH_KNOWN_HOSTS_PATH`. No Linux, o usuário remoto precisa executar `sudo -n shutdown -h now` e `sudo -n shutdown -r now` sem senha. No Windows, habilite o OpenSSH Server e permita que o usuário remoto execute `Stop-Computer` e `Restart-Computer`. `SSH_KEY_PATH` continua disponível como caminho de chave global opcional.

O status depende de ICMP estar permitido pelo firewall do dispositivo. Wake-on-LAN requer suporte e configuração na BIOS/UEFI, sistema operacional e placa de rede; em geral, funciona melhor na mesma sub-rede.

## Segurança e uso

Use somente em uma rede confiável. A API não inclui autenticação de usuários; mantenha a porta acessível apenas na LAN e não publique o serviço diretamente na internet. O botão Scan consulta até 8.192 endereços IPv4 por operação, conforme as máscaras das interfaces locais. A detecção depende de ping ou tabela ARP; firewalls e isolamento de clientes Wi-Fi podem ocultar dispositivos.
