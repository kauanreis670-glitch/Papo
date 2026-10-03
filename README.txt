============================================================
 PAPO
 Aplicativo de mensagens em tempo real (estilo WhatsApp)
 Node.js + Express + Socket.IO
 Feito e programado por: Kauan_hexa
============================================================

O QUE É ISSO?
------------------------------------------------------------
Um chat em tempo real de verdade, entre pessoas diferentes,
passando por um SERVIDOR NODE.JS REAL.

- Não usa localStorage como "banco de dados" de mensagens.
- Não existe nenhuma resposta automática.
- Não é possível conversar "com você mesmo".
- Toda mensagem só existe porque alguém clicou em Enviar
  ou terminou uma gravação de áudio.
- O histórico fica salvo em disco (pasta data/), sobrevive
  a F5, fechar o navegador e reiniciar o servidor.


NOVIDADES DESTA VERSÃO
------------------------------------------------------------
0) NÚMERO QUE NUNCA MUDA (CHAVE DE RECUPERAÇÃO)
   - ANTES: o número ficava salvo só no localStorage do navegador.
     Se você limpasse o cache/dados do navegador, trocasse de
     navegador ou de computador, o app criava um número NOVO do
     zero e você perdia todos os contatos e conversas do número
     antigo (mesmo ele continuando salvo no servidor).
   - AGORA: na primeira vez que você abre o app num navegador novo
     (ou depois de limpar os dados), ele NÃO cria um número
     sozinho. Aparece uma tela perguntando:
       "➕ Criar um número novo"  ou  "🔑 Já tenho um número — Entrar"
   - Ao criar um número novo, o app mostra a CHAVE DE RECUPERAÇÃO
     (algo como "A1B2-C3D4-E5F6-0912") em uma tela de aviso. ANOTE
     ESSA CHAVE em um lugar seguro (bloco de notas, papel, etc.).
     O servidor guarda só uma versão criptografada dela, nunca o
     valor original — se você perder a chave, ninguém (nem o
     servidor) consegue mostrar ela de novo.
   - Sempre que precisar (outro navegador, outro PC, depois de
     limpar o cache), escolha "Já tenho um número — Entrar",
     digite o número e a chave, e TODOS os seus contatos,
     conversas e grupos voltam exatamente como estavam.
   - Você pode ver/gerar sua chave a qualquer momento em
     "✏️ Perfil" -> "🔑 Ver / gerar minha chave". Se sua conta foi
     criada numa versão antiga (sem essa função), o botão gera uma
     chave nova na hora.
   - Enquanto você não limpar o navegador, tudo continua 100%
     automático como antes (não precisa digitar nada).

1) PERFIL EDITÁVEL
   - Clique em "✏️ Perfil" (ou no seu avatar) no topo da barra
     lateral para trocar seu NOME e sua FOTO.
   - O NÚMERO nunca pode ser alterado — ele continua sendo
     gerado e controlado pelo servidor.

2) SOLICITAÇÃO DE CONVERSA (Aceitar / Recusar)
   - Quando você manda a PRIMEIRA mensagem para alguém, ela
     chega para a outra pessoa como uma SOLICITAÇÃO, com
     botões "Aceitar" e "Recusar" (aparecem na lista de
     conversas e também dentro da própria conversa).
   - Aceitar -> a conversa vira normal para os dois lados.
   - Recusar -> quem recusou BLOQUEIA quem mandou a mensagem.
     A partir daí, se a pessoa bloqueada tentar mandar
     mensagem de novo, ela recebe o aviso:
     "Você foi bloqueado por este usuário e não pode mais
     enviar mensagens."

3) CONVITE DE GRUPO (Aceitar / Recusar)
   - Ao ser adicionado a um grupo, você entra como convidado
     PENDENTE e vê um convite com "Aceitar" / "Recusar".
   - Aceitar -> você passa a fazer parte do grupo de verdade
     e passa a receber as mensagens.
   - Recusar -> você sai do grupo e BLOQUEIA quem criou o
     grupo (mesmo comportamento do bloqueio de conversa
     privada: essa pessoa não consegue mais te chamar nem
     te adicionar em novos grupos).

4) ENVIO DE ARQUIVOS DE QUALQUER FORMATO
   - Botão "📎" ao lado do campo de texto: envia imagem, vídeo,
     PDF, documento, zip, etc (até 1GB por arquivo).
   - Imagem e vídeo aparecem direto na conversa; qualquer outro
     formato vira um cartão com nome do arquivo e link para
     baixar.

5) APAGAR MENSAGEM (para todos)
   - Passe o mouse (ou toque, no celular) na sua própria
     mensagem enviada e clique no ícone "🗑️" ao lado do horário.
   - Só quem enviou pode apagar, e ela é apagada PARA TODOS os
     participantes da conversa (ou do grupo), assim como o
     WhatsApp de verdade. No lugar do conteúdo, aparece
     "🚫 Mensagem apagada".
   - Se a mensagem tinha um arquivo/áudio anexado, o arquivo
     também é removido do servidor.

6) NOTIFICAÇÃO DE VERDADE (funciona com o site FECHADO)
   - Na primeira vez que o site abre, o navegador pede
     permissão para mostrar notificações — permita.
   - Agora o app usa NOTIFICAÇÃO PUSH de verdade (Service
     Worker + Web Push): a notificação chega no celular ou no
     PC MESMO COM O SITE/NAVEGADOR FECHADO, não precisa deixar
     nenhuma aba aberta em segundo plano.
   - Tocar na notificação abre o app já direto na conversa
     de quem mandou a mensagem.
   - Enquanto o app está aberto e a pessoa está online, as
     mensagens continuam chegando em tempo real (Socket.IO)
     normalmente, com toast e notificação de tela também.

   IMPORTANTE - REQUISITO DE HTTPS PARA A NOTIFICAÇÃO PUSH:
   -----------------------------------------------------
   Notificação push (a que funciona com o site fechado) só
   funciona em conexões seguras (HTTPS) OU em
   "http://localhost:3000" no mesmo computador que roda o
   servidor. Isso é uma regra de segurança dos navegadores,
   não é algo que dá pra contornar no código.

   - No PC que roda o servidor, acessando por
     "http://localhost:3000" -> a notificação push funciona
     normalmente, sem precisar de nada extra.
   - No celular (ou outro PC) acessando pelo IP da rede local
     (ex: "http://192.168.0.10:3000") -> o navegador BLOQUEIA
     o Service Worker/Push nesse endereço por não ser HTTPS.
     Você ainda recebe mensagens em tempo real normalmente
     enquanto o app estiver aberto, mas a notificação "com o
     app fechado" não vai funcionar até você usar HTTPS.

   Para ter push funcionando também no celular, use um túnel
   HTTPS gratuito apontando para a porta 3000, por exemplo:

     npx localtunnel --port 3000

   ou

     ngrok http 3000

   Isso gera um link "https://alguma-coisa.loca.lt" (ou do
   ngrok) que pode ser aberto no celular; a partir desse link
   HTTPS, a notificação push funciona no celular mesmo com o
   navegador fechado. O mesmo vale se, no futuro, você hospedar
   o projeto em um serviço com HTTPS de verdade (Render,
   Railway, etc.) — assim todo mundo acessa por HTTPS direto,
   sem precisar de túnel.

7) EDITAR NOME E FOTO DO GRUPO
   - Dentro de uma conversa de grupo, clique no ícone "✏️" no
     canto do cabeçalho (ou na própria foto do grupo) para
     trocar o NOME e/ou a FOTO do grupo.
   - Qualquer membro que já faz parte do grupo (convite aceito)
     pode editar.
   - A alteração aparece na hora para todos os membros que
     estiverem com o app aberto (nome e foto atualizam sozinhos
     na lista de conversas e no cabeçalho, sem precisar dar F5).


ESTRUTURA DE ARQUIVOS
------------------------------------------------------------
WHATSAPP-REAL/
│
├── package.json          -> dependências do projeto
├── server.js              -> servidor Express + Socket.IO
├── README.txt             -> este arquivo
│
├── data/
│   ├── users.json              -> números registrados + nome/foto de perfil
│   ├── messages.json           -> histórico de conversas privadas/grupos
│   ├── groups.json             -> grupos criados (membros com status
│   │                              'pending' ou 'accepted')
│   ├── relationships.json      -> status das conversas privadas
│   │                              ('pending' / 'accepted' / 'blocked')
│   ├── blocks.json             -> quem bloqueou quem
│   ├── vapid.json              -> chaves da notificação push (geradas
│   │                              automaticamente na 1ª vez que o
│   │                              servidor roda; NÃO apague depois de
│   │                              já ter gente inscrita, ou as
│   │                              inscrições antigas param de funcionar)
│   ├── push-subscriptions.json -> inscrições de push por número
│   │                              (um número pode ter vários
│   │                              dispositivos inscritos)
│   └── audio/                   -> arquivos de áudio enviados
│
└── public/
    ├── index.html          -> interface (HTML + CSS + JS puro)
    ├── sw.js               -> Service Worker (mostra a notificação
    │                          push e abre a conversa ao tocar nela)
    ├── manifest.json       -> permite "instalar" o app na tela inicial
    └── icon-192.png / icon-512.png / badge-96.png -> ícones do app
        e da notificação


============================================================
 PASSO A PASSO PARA INSTALAR (WINDOWS)
============================================================

1) INSTALAR O NODE.JS
------------------------------------------------------------
- Acesse: https://nodejs.org
- Baixe a versão "LTS" (recomendada) para Windows.
- Instale normalmente (Next, Next, Finish).
- Para confirmar que instalou, abra o "Prompt de Comando"
  (cmd) e digite:

    node -v
    npm -v

  Deve aparecer um número de versão em cada comando.
  É necessário Node.js 16 ou superior.


2) COPIAR O PROJETO
------------------------------------------------------------
- Copie toda a pasta "WHATSAPP-REAL" para o seu computador,
  por exemplo em:

    C:\Users\SEU_USUARIO\Desktop\WHATSAPP-REAL


3) INSTALAR AS DEPENDÊNCIAS
------------------------------------------------------------
- Abra o Prompt de Comando (cmd) ou PowerShell.
- Navegue até a pasta do projeto, exemplo:

    cd C:\Users\SEU_USUARIO\Desktop\WHATSAPP-REAL

- Execute:

    npm install

  Isso vai baixar o Express e o Socket.IO (só precisa fazer
  isso uma vez).


4) EXECUTAR O SERVIDOR
------------------------------------------------------------
- Ainda dentro da pasta do projeto, execute:

    npm start

- Você verá uma mensagem assim:

    ==================================================
     WHATSAPP-REAL rodando!
     Acesse localmente em: http://localhost:3000
    ==================================================

- Deixe essa janela do terminal ABERTA. É o servidor rodando.


5) ABRIR NO NAVEGADOR (no mesmo computador)
------------------------------------------------------------
- Abra o navegador (Chrome, Edge, Firefox) e acesse:

    http://localhost:3000

- O sistema vai gerar automaticamente um número no formato:

    9XXXX-XXXX

- Esse número aparece no topo da barra lateral e é reconhecido
  pelo servidor (não é inventado pelo navegador).


============================================================
 COMO TESTAR COM DUAS PESSOAS DE VERDADE
============================================================

OPÇÃO A - Mesma rede Wi-Fi/local (dois computadores/celulares)
------------------------------------------------------------
1) No computador que está rodando "npm start" (Computador A),
   descubra o IP local (IPv4). No cmd, digite:

     ipconfig

   Procure por algo como:

     Endereço IPv4. . . . . . . . . . . . . . : 192.168.0.10

2) No OUTRO computador ou celular, CONECTADO NA MESMA REDE,
   abra o navegador e acesse:

     http://192.168.0.10:3000

   (troque pelo IP que apareceu no seu ipconfig)

3) Cada navegador/dispositivo vai receber um número diferente,
   por exemplo:

     Pessoa A: 91234-5678
     Pessoa B: 99876-5432

4) Na Pessoa A, clique em "👤 + Privado" e digite o número
   da Pessoa B (99876-5432). Clique em "Adicionar".

5) Envie uma mensagem, por exemplo "Teste".

6) Na tela da Pessoa B, a mensagem "Teste" deve aparecer
   automaticamente (em tempo real, via Socket.IO).

7) A Pessoa B pode adicionar o número da Pessoa A e responder
   "Funcionou". A pessoa A deve receber a resposta.

IMPORTANTE: nenhuma mensagem aparece sozinha. Se ninguém
digitar e clicar em Enviar (ou gravar e soltar um áudio),
nada acontece na tela do outro usuário.


OPÇÃO B - Duas abas anônimas no mesmo computador (apenas para
testar a interface, simulando dois usuários diferentes)
------------------------------------------------------------
1) Abra uma aba normal em http://localhost:3000
   -> gera o número da "Pessoa A"

2) Abra uma aba ANÔNIMA/PRIVADA (Ctrl+Shift+N no Chrome) em
   http://localhost:3000
   -> gera o número da "Pessoa B" (diferente da primeira,
      porque cada navegador guarda seu próprio número)

3) Repita o mesmo teste de adicionar contato e enviar mensagens.

Obs: abas normais do MESMO navegador compartilham o mesmo
localStorage, então usar duas abas normais pode fazer as duas
mostrarem o MESMO número. Use janela anônima, outro navegador,
ou outro dispositivo para simular usuários diferentes de forma
confiável.


============================================================
 TESTANDO ÁUDIO
============================================================
1) Abra uma conversa.
2) Clique no botão "🎙️ Gravar". O navegador vai pedir
   permissão para usar o microfone — permita.
3) O botão fica vermelho e pulsando, indicando que está
   gravando.
4) Clique novamente no botão (agora "parar") para finalizar.
5) O áudio é convertido, enviado pelo Socket.IO, salvo no
   servidor (pasta data/audio) e entregue ao destinatário,
   que verá um player de áudio (▶️) para ouvir.

Se o microfone não existir ou a permissão for negada, o
sistema mostra um aviso amigável e não trava a aplicação.

IMPORTANTE (celular / outro dispositivo pela rede local):
Por segurança, os navegadores só liberam o microfone em HTTPS
ou em "localhost". Isso significa que gravar áudio funciona
normalmente em http://localhost:3000, mas ao abrir o site por
IP da rede (http://192.168.0.10:3000) em outro celular ou
computador, o navegador BLOQUEIA o microfone e o app mostra um
aviso explicando isso. Enviar texto, imagens, vídeos e outros
arquivos continua funcionando normalmente por IP, só a gravação
de áudio pelo microfone é que exige HTTPS. Para testar áudio
entre dispositivos diferentes, uma opção é usar um túnel HTTPS
gratuito, como "ngrok" ou "localtunnel", apontando para a porta
3000.


============================================================
 SOBRE A REGRA "NUNCA HÁ RESPOSTA AUTOMÁTICA"
============================================================
- O servidor (server.js) NUNCA cria mensagens sozinho.
- Toda mensagem tem o campo "from" preenchido pelo servidor,
  usando o número associado à conexão (socket) que enviou o
  evento — nunca um valor mandado pelo navegador. Isso evita
  que alguém finja ser outra pessoa.
- Não é possível enviar mensagem para o próprio número (nem
  pelo cliente, nem pelo servidor — ambos bloqueiam isso).
- O front-end (public/index.html) só desenha uma mensagem na
  tela quando RECEBE o evento do servidor ('private-message'
  ou 'group-message'). Não existe nenhum código que crie uma
  mensagem "fake" localmente.


============================================================
 BANCO DE DADOS (TURSO) — leia isto antes de hospedar
============================================================
O app guarda tudo (usuários, mensagens, grupos, etc.) num banco
compatível com SQLite. Você tem duas opções:

1) SEM configurar nada (padrão): o app cria um arquivo local em
   data/papo.db. Funciona perfeitamente na sua máquina, mas em
   hosts com disco efêmero (Render free tier, por exemplo) os
   dados são apagados a cada deploy ou quando o serviço "dorme"
   e acorda de novo.

2) Usando o Turso (RECOMENDADO para produção, e gratuito):
   o banco fica hospedado fora do Render, então sobrevive a
   qualquer deploy/reinício, mesmo no plano grátis.

   Passo a passo:
   a) Crie uma conta em https://turso.tech (dá pra entrar com
      GitHub, sem cartão de crédito).
   b) Instale a CLI do Turso (turso.tech tem instruções para
      Windows/Mac/Linux) ou use o dashboard do site.
   c) Crie um banco:  turso db create papo
   d) Pegue a URL:    turso db show papo --url
   e) Gere um token:  turso db tokens create papo
   f) No Render, vá em Environment e crie duas variáveis:
        TURSO_DATABASE_URL = (a URL do passo d, algo como
          "libsql://papo-seunome.turso.io")
        TURSO_AUTH_TOKEN   = (o token do passo e)
   g) Faça o deploy de novo. No log vai aparecer:
        "[Storage] Usando banco remoto no Turso (...)"

Se você já tinha rodado o app antes em modo arquivo local (com
dados em data/papo.db ou nos antigos data/*.json) e quer migrar
esses dados pro Turso, a forma mais simples é: rode o servidor
localmente uma vez já com TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
configuradas no seu .env — a migração automática (que lê os
data/*.json antigos) vai gravar direto no banco do Turso.

============================================================
 PERSISTÊNCIA DE DADOS (ATUALIZADO: agora usa SQLite/Turso)
============================================================
- data/papo.db        -> banco SQLite com usuários, mensagens,
                          grupos, relacionamentos, bloqueios e
                          inscrições de push
- data/audio/          -> arquivos de áudio enviados
- data/files/          -> outros arquivos enviados (imagem,
                          vídeo, PDF, etc.)

Antes, cada informação ficava num arquivo .json separado, e
toda escrita reescrevia o arquivo inteiro do zero. Isso podia
corromper dados se duas escritas acontecessem quase ao mesmo
tempo, ou se o processo caísse no meio de uma gravação.

Agora tudo fica num banco SQLite (data/papo.db), com escritas
atômicas (WAL). Na primeira vez que você rodar esta versão, se
existirem data/*.json antigos, o servidor MIGRA tudo sozinho
para o banco automaticamente (aparece uma mensagem no terminal
avisando). Depois da migração, os arquivos .json antigos podem
ser apagados com segurança (eles não são mais lidos, exceto
para a migração inicial).

Se quiser voltar ao modo antigo (não recomendado), defina a
variável de ambiente STORAGE_DRIVER=json antes de iniciar.

IMPORTANTE - ISSO NÃO SUBSTITUI UM DISCO PERSISTENTE:
O SQLite resolve corrupção/concorrência, mas data/papo.db
continua sendo um ARQUIVO em disco. Em hospedagens com disco
efêmero (ex: Render no plano gratuito), o arquivo ainda pode
ser apagado a cada novo deploy/reinício, a menos que você
configure um volume/disco persistente apontando para a pasta
data/ (Railway e Fly.io oferecem isso; no Render é um add-on
pago chamado "Persistent Disk").

O histórico sobrevive a:
- Atualizar a página (F5)
- Fechar e abrir o navegador
- Reiniciar o servidor (npm start novamente)


============================================================
 PARAR O SERVIDOR
============================================================
No terminal onde ele está rodando, pressione:

    CTRL + C


============================================================
 DÚVIDAS FREQUENTES
============================================================

P: A outra pessoa não consegue acessar pelo IP.
R: Verifique se o Firewall do Windows está bloqueando a porta
   3000. Ao rodar "npm start" pela primeira vez, o Windows
   pode perguntar se permite o Node.js na rede — clique em
   "Permitir acesso".

P: Cada vez que atualizo a página, meu número muda.
R: Isso não deveria acontecer. O número é salvo no
   localStorage do navegador (chave "wa_my_number") e
   reenviado ao servidor a cada conexão; o servidor reconhece
   e devolve o MESMO número, desde que o arquivo
   data/users.json não tenha sido apagado.

P: Limpei o navegador (ou troquei de PC) e o app criou um número
   novo, perdi meus contatos. Como recupero o número antigo?
R: Na tela de boas-vindas, clique em "🔑 Já tenho um número —
   Entrar" e digite o número antigo junto com a CHAVE DE
   RECUPERAÇÃO que foi mostrada quando aquele número foi criado
   (ou que você gerou depois em "Perfil" -> "Ver/gerar minha
   chave"). Sem essa chave não tem como recuperar — por isso é
   importante anotar ela assim que o app mostrar.

P: Posso rodar em outra porta?
R: Sim. Defina a variável de ambiente PORT antes de iniciar,
   por exemplo no PowerShell:

     $env:PORT=4000; npm start
