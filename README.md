# STATUS PC v2

Painel web responsivo para acompanhar computadores na rede local e enviar comandos Wake-on-LAN.

## Iniciar

Requer Node.js 18 ou mais recente. Na pasta do projeto, execute:

```sh
npm start
```

Abra `http://localhost:3000`. Para acessar de outro aparelho na mesma rede, abra `http://IP-DO-SERVIDOR:3000`. O servidor mostra os endereços IPv4 disponíveis no painel ao consultar a API.

Os dispositivos cadastrados ficam em `data/devices.json`.

## Recursos

- Status online/offline com verificação ICMP, atualizado a cada 15 segundos.
- Ligar via Wake-on-LAN (WoL), por pacote UDP broadcast para a porta 9. SSH não consegue iniciar um computador que está desligado.
- Cadastro e remoção de dispositivos Windows e Linux.
- Interface responsiva em tema escuro com Bootstrap e Bootstrap Icons via CDN.
- Desligamento e reinício remotos de Windows e Linux via SSH com autenticação por chave.
- Modal de informações do equipamento com inventário consultado via SSH (sistema, CPU, memória, discos, rede e dados de hardware disponíveis).
- Botão para exportar as configurações dos dispositivos em um arquivo JSON.
- Varredura das sub-redes IPv4 locais com ping concorrente e leitura da tabela ARP.
- Mapa lógico da rede com grafo dos dispositivos cadastrados e encontrados no último Scan.

## Desligamento por SSH

Configure `SSH_KEY_PATH` no ambiente do processo que executa o servidor. A chave pública correspondente deve estar autorizada no computador remoto. No Linux, o usuário remoto precisa executar `sudo -n shutdown -h now` e `sudo -n shutdown -r now` sem senha. No Windows, habilite o OpenSSH Server e permita que o usuário remoto execute `Stop-Computer` e `Restart-Computer`. No cadastro, preencha o destino no formato `usuario@IP` ou `usuario@nome-do-host`.

O cliente SSH deve estar instalado no computador que executa o STATUS PC. A primeira conexão precisa ter o host incluído em `known_hosts`, porque a validação de identidade do SSH permanece habilitada.

O status depende de ICMP estar permitido pelo firewall do dispositivo. Wake-on-LAN requer suporte e configuração na BIOS/UEFI, sistema operacional e placa de rede; em geral, funciona melhor na mesma sub-rede.

## Segurança e uso

Use somente em uma rede confiável. A API não inclui autenticação de usuários; mantenha a porta acessível apenas na LAN e não publique o serviço diretamente na internet. O botão Scan consulta até 8.192 endereços IPv4 por operação, conforme as máscaras das interfaces locais. A detecção depende de ping ou tabela ARP; firewalls e isolamento de clientes Wi-Fi podem ocultar dispositivos.
