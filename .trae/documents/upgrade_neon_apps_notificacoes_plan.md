# Plano de Implementação: NEON + Apps (APK/PC) + Correção de Notificações

## Pesquisa do Repositório

**Arquitetura Atual:**
- Servidor Node.js + Express + Socket.IO (arquivo principal: `server.js`)
- Persistência em arquivos JSON em `data/`: `users.json`, `messages.json`, `groups.json`, `relationships.json`, `blocks.json`, `push-subscriptions.json`, `vapid.json`
- Frontend PWA monolítico em `public/index.html` (HTML + CSS + JS inline, ~2000 linhas)
- Service Worker em `public/sw.js` para Web Push e cache básico
- `public/manifest.json` configurado como PWA (display: standalone)
- Dependências: `express`, `socket.io`, `socket.io-client`, `web-push`

**Como os dados são salvos hoje:**
- Tudo passa por funções `readJSON()` / `writeJSON()` em `server.js` (linhas 87-99) — camada de abstração criada justamente para facilitar troca futura de banco (comentário na linha 68-69)

**Problemas conhecidos de notificação (identificados no código):**
1. **Service Worker "morre" no Android**: Chrome mata o SW em background após inatividade; inscrições push somem ou ficam inválidas
2. **Sem renovação de inscrição Push**: O código só se inscreve uma vez (em `register()`), nunca renova a subscription
3. **Sem som em notificações de navegador**: `sendBrowserNotification()` (index.html ~linha 999) não especifica `sound` nem toca áudio programaticamente
4. **SW não trata falhas de entrega**: `push-subscriptions.json` só remove em 404/410, mas há outros erros silenciosos
5. **Mobile (Chrome Android)**: Web Push tem limitações conhecidas de "doze mode"

---

## Arquivos e Módulos a Modificar / Criar

| Arquivo / Pasta | O que vai mudar |
|---|---|
| `server.js` | Substituir `readJSON/writeJSON` por camada PostgreSQL (NEON) via `pg` ou `postgres`. Migrar dados existentes. |
| `package.json` | Adicionar: `pg` (driver PostgreSQL), opcionalmente `dotenv`. |
| `.env.example` | Criar com variáveis: `DATABASE_URL_NEON`, `VAPID_PUBLIC`, `VAPID_PRIVATE`, `PUSH_MAILTO` |
| `data/*.json` | Manter como backup; criaremos script de migração `migrate-json-to-neon.js` |
| `public/index.html` | (a) Tocar som quando chega mensagem em aba aberta; (b) Re-inscrever para push periodicamente; (c) Melhorar tratamento de erro de permissão |
| `public/sw.js` | Adicionar tag única por mensagem (evitar sobrescrever), adicionar `requireInteraction`, som e pattern de vibração melhores; tratar silent push |
| `public/manifest.json` | Adicionar campos: `gcm_sender_id` (opcional), `shortcuts`, melhorar ícones e conf de PWA |
| **App Android (.apk)** | Opção A (recomendada): **Trusted Web Activity (TWA)** — empacota a PWA existente em APK usando `@bubblewrap/cli`. Opção B: **Capacitor**. |
| **App Desktop (.exe)** | **Electron** ou **Tauri** para empacotar a webapp existente. |
| `migrate-json-to-neon.js` | Script Node para ler JSONs existentes e popular o PostgreSQL |

---

## Passos de Implementação (em ordem de dependência)

### FASE 1 — Integração com NEON (PostgreSQL)
1. **Adicionar dependências**: `npm install pg dotenv`
2. **Criar `.env.example`** e `.gitignore` atualizado
3. **Criar camada de dados em `server.js`**:
   - Substituir `readJSON()/writeJSON()` por uma classe `DB` com conexão NEON
   - Tabelas SQL a criar (via migração inicial ou startup):
     - `users(number PK, name, photo, created_at)`
     - `messages(id UUID PK, conv_key, group_id, from_num, to_num, type, content JSONB, deleted, timestamp)`
     - `groups(id UUID PK, name, photo, created_by, created_at)`
     - `group_members(group_id FK, number, status, added_at, PK(group_id,number))`
     - `relationships(conv_key PK, status, requested_by)`
     - `blocks(blocker_num, blocked_num, PK(blocker_num,blocked_num))`
     - `push_subscriptions(id PK, number, endpoint UNIQUE, p256dh, auth, created_at, last_used)`
     - `vapid(id PK=1, public_key, private_key)` (uma linha só)
4. **Refatorar TODAS as funções de dados** em server.js para usar esta nova camada (ex: `registerUser()`, `saveMessage()`, `getHistory()`, `getRelationship()`, `blockUser()`, `savePushSubscription()`, etc.)
5. **Criar `migrate-json-to-neon.js`**: Lê `data/*.json` existentes e insere nas tabelas do NEON (rodado manualmente uma vez)
6. **Manter compatibilidade**: Se `DATABASE_URL_NEON` não estiver definido, continua usando JSON local (fallback seguro)

### FASE 2 — Correção de Notificações
7. **Backend — Melhorar `sendPushToNumber()` em server.js (~linha 164)**:
   - Adicionar timestamp de último uso em cada subscription
   - Tratar mais erros (não só 404/410): 400, 401, 413, 429 (rate limit), 5xx
   - Remover subscriptions inválidas/expiradas
8. **Backend — Rota de heartbeat/renovação**: `POST /api/push/refresh` para atualizar endpoint quando navegador renovar
9. **Frontend index.html**:
   - **Tocar SOM ao receber mensagem** (usando `new Audio('/notification.mp3')` — criar arquivo de som em `public/`)
   - **Re-inscrever para push a cada ~12h** usando `setInterval` em `subscribeForPush()`
   - Re-inscrever também em `socket.on('reconnect')`
   - Logar no console quando push falhar, com UI de aviso
10. **Service Worker `public/sw.js`**:
    - Adicionar `requireInteraction: true` (notificação não some sozinha no Android)
    - Melhorar `tag`: usar conv_id + msg_id para evitar sobrescrever notificações diferentes da mesma conversa
    - `renotify: true` + vibrate pattern agressivo `[200,100,200,100,400]`
    - Tentar tocar som: `sound: '/notification.mp3'` (nem todos OS suportam, mas não faz mal)
11. **Criar som de notificação** em `public/notification.mp3` (usar gerador ou som público tipo "ding" curto)
12. **Manifest PWA aprimorado**: `public/manifest.json` com mais campos para melhorar instalação em Android

### FASE 3 — App para Celular (.apk) e Desktop
13. **Pré-requisito OBRIGATÓRIO**: O app/site precisa estar em **HTTPS com domínio público** (Web Push + PWA + TWA não funcionam em IP local / HTTP). Recomendações:
    - **Deploy do backend**: Render, Railway, Fly.io, Vercel Functions, ou hospedar em VPS + Nginx + Let's Encrypt
    - **Domínio**: precisa de domínio válido (ex: `papo.seudominio.com`)
14. **App Android APK (Opção recomendada: Trusted Web Activity / Bubblewrap)**:
    - Instalar `@bubblewrap/cli` globalmente
    - Instalar Android SDK / JDK (ou usar Bubblewrap na nuvem se disponível)
    - Rodar `bubblewrap init --manifest="https://SEU-DOMINIO/manifest.json"`
    - Configurar Digital Asset Links (DAL) no servidor (`/.well-known/assetlinks.json`)
    - Rodar `bubblewrap build` → gera `.apk` (release assinada com keystore)
    - Instalar APK no celular via USB ou compartilhar
15. **Alternativa Capacitor (se quiser mais nativo / acesso a APIs)**:
    - `npm init @capacitor/app@latest` (nova pasta `app-android`)
    - Configurar `capacitor.config.ts` apontando pro domínio
    - `npx cap add android` → gera projeto Android Studio
    - Adicionar plugins de notificação nativa (`@capacitor/push-notifications`, `@capacitor/local-notifications`) → FCM (Firebase Cloud Messaging)
    - Buildar APK / AAB via Android Studio
16. **App Desktop (.exe para Windows) — Electron / Tauri**:
    - **Electron (mais simples, mas maior ~100MB)**:
      - `npm install -D electron electron-builder`
      - Criar `electron-main.js` (BrowserWindow carregando a URL do app)
      - Configurar `package.json` com `build` para gerar `.exe` portable / instalador NSIS
    - **Tauri (leve ~5MB, mas precisa de Rust)**:
      - Recomendado apenas se já tiver Rust instalado

---

## Dependências e Considerações Importantes

1. **NEON (PostgreSQL)**:
   - É GRATUITO para projetos pequenos (512MB storage, 1GB RAM, 10 conexões)
   - Link para criar projeto: https://console.neon.tech/ — copiar `DATABASE_URL`
   - NEON é serverless: conexões podem encerrar após inatividade → usar `pg.Pool` com `connectionTimeoutMillis` e retry
2. **HTTPS + Domínio PÚBLICO são OBRIGATÓRIOS para**:
   - Notificações Web Push funcionarem de verdade no celular (fora do localhost)
   - TWA / APK ser instalável sem aviso de "não seguro"
   - Service Worker sobreviver mais tempo no Android
3. **VAPID Keys**: As chaves existentes em `data/vapid.json` DEVEM ser as mesmas no ambiente de produção, caso contrário todas as inscrições push antigas ficarão inválidas.
4. **Migração de Dados**: Os JSONs existentes são o "fonte da verdade" até a migração rodar. Vamos criar um script de migração idempotente (roda várias vezes sem duplicar).
5. **Para o APK**:
   - **TWA**: Mais barato de manter, zero duplicação de código (usa o mesmo código web), mas precisa do Digital Asset Links com HTTPS + domínio
   - **Capacitor + FCM**: Melhor garantia de entrega de notificação (FCM é nativo do Android, não depende do Chrome), mas precisa de conta Firebase e manutenção de código nativo

---

## Validação

Após cada fase, validar:

**Fase 1 (NEON):**
- Rodar `node migrate-json-to-neon.js` → verificar dados no dashboard do NEON
- Iniciar servidor com variável `DATABASE_URL_NEON` setada
- Criar novo usuário → ver usuário na tabela
- Enviar mensagem privada → ver linha na tabela `messages`
- Criar grupo, convidar, aceitar → ver `groups`, `group_members`
- Recusar solicitação → ver `blocks` e `relationships`
- **Fallback**: Remover variável `DATABASE_URL_NEON` → volta a usar JSON (garante não quebrar)

**Fase 2 (Notificações):**
- Aba aberta mas foco em outra conversa: chega mensagem → TOCAR SOM + toast + notification
- Aba aberta, conversa aberta: NÃO tocar som (já está visualizando)
- Aba fechada (site fechado): notificação push NOVA aparece e NÃO some sozinha
- Celular Chrome (site instalado como PWA): tela desligada / navegador em background → push chega e vibra
- Desinstalar PWA e instalar de novo → nova inscrição push, antiga removida automaticamente
- Reiniciar servidor: inscrições push permanecem válidas

**Fase 3 (Apps):**
- **PWA**: Chrome → "Instalar aplicativo" → ícone na área de trabalho / tela inicial, abre em janela standalone
- **APK Android**: Instalar APK via USB → abre igual app nativo, sem barra de endereço; notificações chegam; compartilhamento nativo funciona
- **EXE Windows**: Instalar .exe → ícone no desktop; abre em janela; notificações nativas; minimiza para bandeja do sistema

---

## Riscos e Tratamento

| Risco | Tratamento |
|---|---|
| **Conexão NEON cai (serverless)** | Usar `pg.Pool` com `maxUses`, `connectionTimeoutMillis`, `idleTimeoutMillis`; retry lógico em cada query |
| **HTTPS/domínio não disponível ainda** | Manter fallback JSON + rodar em localhost para testar NEON; documentar passo de deploy |
| **Notificações ainda falham no Android (doze mode)** | Alternativa: migrar push do app mobile para FCM via Capacitor (nativa, 99% de entrega) |
| **Chaves VAPID erradas em produção** | Migrar chaves de `data/vapid.json` para `.env` / variáveis de ambiente ANTES de qualquer deploy |
| **Dados duplicados na migração JSON→NEON** | Script de migração idempotente: `INSERT ... ON CONFLICT DO NOTHING` |
| **APK muito grande / build TWA complicado** | Usar alternativa: site PWA com "Adicionar à tela inicial" + domínio público; já funciona bem como "app" |
| **Electron ocupa muito espaço** | Tauri como alternativa; ou documentar que usuário pode acessar pelo navegador sem instalar nada |

---

## Perguntas para Aprovação do Plano

Antes de executar, preciso que você confirme:

1. **Você já tem conta no NEON e a URL `DATABASE_URL`?** (se não, eu explico como criar gratuitamente)
2. **Já tem domínio + hospedagem HTTPS pública?** (obrigatório para APK/TWA e notificações push de verdade no celular fora da rede local)
3. **Para o APK Android, qual opção prefere?**
   - **(A) TWA / Bubblewrap** (RECOMENDADO) — zero duplicação de código, mesmo app web, gera APK mas precisa de domínio HTTPS
   - **(B) Capacitor + FCM** — Mais nativo, notificações garantidas, mas precisa de Firebase + Android Studio + manutenção
4. **Para app Desktop (.exe Windows): Electron (mais fácil, ~100MB) ou Tauri (leve ~5MB mas precisa instalar Rust)?**
5. **Vamos manter o fallback JSON local?** (útil para testar sem internet)
