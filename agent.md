# AGENT — STATUS PC v2

## Projeto

- Aplicação Node.js com servidor HTTP próprio e frontend HTML/CSS/JavaScript sem framework. Não é Next.js e não tem etapa de build frontend.
- `server.js` disponibiliza a API e os arquivos permitidos; `index.html` contém as telas, `app.js` controla a interface e `validation.js` contém a validação reutilizável dos formulários.
- A porta HTTP padrão é `6001`. SSH usa a porta configurada por dispositivo (normalmente `22`); Wake-on-LAN envia pacotes UDP na porta `9`.
- O alvo de produção é Linux. `compose.yaml` usa rede do host para descoberta LAN, ARP e Wake-on-LAN. Em desenvolvimento no Windows com Docker Desktop, pode ser necessário publicar `6001:6001` em vez de usar o modo host.

## Desenvolvimento, testes e deploy

- Dependências: Node.js 18+ e `npm ci`.
- Execução: `npm start`; modo de desenvolvimento: `npm run dev`.
- Testes automatizados: `npm test` (`node:test`). Eles iniciam um servidor isolado usando uma pasta temporária configurada em `STATUS_PC_DATA_DIR`; nunca apontar esse diretório de teste para `data/` real.
- Não existe `npm run build`. A imagem de produção é construída e publicada com Docker Compose.
- Antes do deploy, preserve `data/` e `.env`. Não use `docker compose down -v`; o diretório de dados contém dispositivos e credenciais criptografadas.
- `.env` deve manter um valor persistente para `SSH_CREDENTIALS_SECRET`. Trocá-lo impede de descriptografar senhas e chaves privadas já salvas.
- `SSH_KNOWN_HOSTS_PATH` aponta para o arquivo de hosts confiáveis. Manter a validação da identidade SSH habilitada.
- O container roda como usuário `node`; garanta permissão de escrita em `/app/data`. No deploy Linux, prepare também `/app/data/ssh/known_hosts` conforme o volume configurado.

## SSH, energia e informações remotas

- Use a biblioteca multiplataforma `ssh2` para conexão, execução remota e geração Ed25519. Não dependa de comandos SSH do sistema operacional do servidor da aplicação.
- A aplicação inicia comandos conforme o sistema cadastrado no dispositivo:
  - Linux: desligar/reiniciar via `sudo -n shutdown`; o usuário SSH precisa de regras `sudo` sem senha para esses comandos.
  - Windows: OpenSSH Server habilitado e permissões remotas adequadas para `Stop-Computer` e `Restart-Computer` via PowerShell.
- O formulário permite senha, chave privada colada/gerada ou caminho de chave existente no servidor. Ao gerar um par, preencher chave privada e chave pública; instalar a pública em `authorized_keys` no dispositivo remoto. Nunca mostrar senha ou chave privada ao usuário via API.
- Senhas e chaves privadas inline persistidas são criptografadas com `SSH_CREDENTIALS_SECRET`. A API deve expor apenas indicadores de credenciais configuradas.
- Caminhos de chave são resolvidos no servidor/container, não no computador que abre a interface. No Docker, usar caminhos como `/app/data/ssh/id_ed25519`.
- A identidade do host remoto deve corresponder a uma entrada em `known_hosts`, incluindo porta não padrão. Não desabilitar a verificação para contornar erro de conexão.
- Status de ping é apenas indicativo; não usar `device.online` para impedir ações SSH, pois ICMP pode estar bloqueado. A ação deve deixar a conexão SSH confirmar acessibilidade.
- Ligar é Wake-on-LAN, requer MAC correto, suporte/configuração de firmware e uma rede que permita o pacote mágico; isso não é inicialização via SSH.
- Informações de hardware são coletadas por comandos específicos de Linux ou Windows via SSH. Verificar requisitos de permissão e ferramentas disponíveis em cada sistema.

## Formulários e frontend

- `validation.js` deve ser carregado antes de `app.js` e permanecer na allowlist de arquivos estáticos de `server.js`.
- Manter validação de tela e validação da API coerentes para IPv4, MAC, destino/porta SSH, broadcast e limites de tamanho de credenciais.
- Campos de conexão SSH permanecem opcionais no cadastro, mas precisam ser válidos quando preenchidos.
- O formulário de dispositivo deve manter o botão para gerar par de chaves pública/privada e exibir o estado/erro ao usuário.
- Inputs inválidos devem receber `setCustomValidity`, feedback visual e atributos acessíveis; limpar erros de validação ao reiniciar o formulário.
- Escapar conteúdo fornecido pelo usuário antes de interpolá-lo em `innerHTML`.

## Dados, API e segurança

- `data/devices.json` é dado do usuário: manter compatibilidade e preservar durante qualquer alteração ou deploy.
- Validar cadastro, edição e importação consistentemente; rejeitar IP duplicado, endereços inválidos e portas SSH fora de `1..65535`.
- Não servir arquivos fora da allowlist em `server.js`.
- A API não tem autenticação de usuário. Manter a aplicação restrita à LAN e não expô-la diretamente à internet.
- Não registrar segredos, não commitar `.env`, `data/ssh/` ou credenciais.
- Atualizar `README.md` quando mudarem porta, variáveis, requisitos SSH ou implantação.

## Verificação

- JavaScript alterado: `node --check server.js`, `node --check app.js` e `node --check validation.js`.
- Rodar `npm test` quando o usuário solicitar testes/verificação ou quando a tarefa pedir validação automatizada.
- Para Compose, validar mudanças com `docker compose config --quiet`.
- Nunca executar comandos reais de desligamento/reinicialização contra dispositivos durante testes de rotina.