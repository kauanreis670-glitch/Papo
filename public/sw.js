/**
 * ============================================================
 *  SERVICE WORKER - WHATSAPP-REAL / PAPO
 * ============================================================
 * Responsável por:
 *   1) Receber notificações push do servidor mesmo com o site
 *      FECHADO (sem nenhuma aba aberta), e mostrar a notificação
 *      nativa do sistema operacional (celular ou PC).
 *   2) Quando o usuário TOCA na notificação, abrir (ou focar)
 *      o app já direto na conversa correspondente.
 *   3) Tocar som / vibrar corretamente, não deixar notificação
 *      sumir sozinha (requireInteraction), evitar duplicação.
 * ============================================================
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ------------------------------------------------------------
// Chegou uma notificação push (enviada pelo servidor via web-push)
// ------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = {
      title: 'Papo',
      body: (event.data && event.data.text()) || 'Nova mensagem',
      tag: 'papo-msg-generica'
    };
  }

  // TAG UNICA: se tiver msgId, nao sobrescreve a conversa antiga
  // (mas ainda agrupa por conversa)
  const baseTag = data.tag || 'papo-msg';
  const finalTag = data.msgId ? `${baseTag}-${data.msgId}` : baseTag;

  const title = data.title || 'Papo';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    image: data.image || undefined,
    tag: finalTag,
    renotify: true,
    silent: false,
    // Android >= 8: requer canal de notificacao, mas o Chrome usa
    // a tag + o atributo abaixo para mostrar a notificacao sem
    // desaparecer sozinho apos alguns segundos.
    requireInteraction: true,
    data: {
      url: data.url || '/',
      msgId: data.msgId || undefined
    },
    vibrate: [200, 100, 200, 100, 400, 100, 400],
    // Sound: poucos navegadores/OS respeitam esse campo, mas
    // nao faz mal tentar. O som real sera tocado tambem no
    // frontend quando a aba estiver aberta.
    sound: '/notification.wav',
    dir: 'ltr',
    lang: 'pt-BR'
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch(err => {
      console.error('[SW] Erro ao mostrar notificacao:', err);
    })
  );
});

// ------------------------------------------------------------
// Usuário TOCOU na notificação -> abre/foca o app na conversa certa
// ------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Se já existe uma aba/janela do app aberta, foca nela e manda
      // abrir a conversa certa (sem precisar recarregar a página).
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            client.postMessage({ type: 'open-chat', url: targetUrl });
            if ('focus' in client) return client.focus();
          }
        } catch (err) { /* ignora URL invalida */ }
      }
      // Nenhuma aba aberta -> abre uma nova já na conversa certa
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

// ------------------------------------------------------------
// Push subscription expirou / mudou -> pede para o front atualizar
// ------------------------------------------------------------
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    Promise.resolve().then(async () => {
      const newSub = event.newSubscription;
      if (!newSub || !newSub.endpoint) return;
      // Envia para o front para ele fazer POST /api/push/refresh
      const clientList = await self.clients.matchAll({ includeUncontrolled: true });
      for (const c of clientList) {
        try {
          c.postMessage({ type: 'refresh-push-subscription', subscription: newSub.toJSON() });
        } catch (_) {}
      }
    })
  );
});
