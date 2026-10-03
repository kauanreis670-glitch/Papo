/**
 * ============================================================
 *  PAPO - Servidor Node.js + Express + Socket.IO
 *  Feito e programado por: Kauan_hexa
 * ============================================================
 *
 *  MODO DE ARMAZENAMENTO:
 *   JSON local (data/*.json) — sempre. Simples, sem dependência
 *   de banco externo. Tudo (usuários, números, mensagens,
 *   contatos, grupos etc.) fica salvo em disco, na pasta data/,
 *   e sobrevive a F5, fechar o navegador e reiniciar o servidor.
 * ============================================================
 *
 * REGRA DE OURO DESTE SERVIDOR:
 *   O SERVIDOR NUNCA CRIA MENSAGENS SOZINHO.
 *
 * Toda mensagem que existe no sistema foi criada porque:
 *   1) Um socket JA REGISTRADO (com numero confirmado pelo servidor)
 *   2) Enviou o evento 'private-message' ou 'group-message'
 *   3) Com um destinatario valido, que REALMENTE existe no servidor
 *
 * O campo "from" de toda mensagem e definido usando o numero
 * associado aquele socket no servidor (socketToNumber), NUNCA
 * um valor enviado pelo cliente. Isso impede que alguem "finja"
 * ser outra pessoa, e impede qualquer tipo de mensagem fantasma
 * ou resposta automatica.
 *
 * ------------------------------------------------------------
 * NOVIDADES DESTA VERSAO:
 *  - PERFIL: cada numero pode ter um "name" e uma "photo"
 *    (dataURL base64) editaveis pelo proprio usuario. O NUMERO
 *    NUNCA pode ser alterado pelo cliente.
 *  - SOLICITACAO DE CONVERSA: a primeira mensagem enviada para
 *    alguem que ainda nao tem uma conversa aceita gera uma
 *    "relationship" com status 'pending'. O destinatario recebe
 *    um pedido com botoes Aceitar/Recusar.
 *      - Aceitar -> conversa normal libera para os dois lados.
 *      - Recusar -> quem recusou BLOQUEIA quem mandou. A partir
 *        dai, toda nova tentativa de mensagem desse numero
 *        bloqueado recebe um aviso de "bloqueado".
 *  - CONVITE DE GRUPO: ao ser adicionado a um grupo, o membro
 *    entra como 'pending' e recebe um convite com Aceitar/Recusar.
 *      - Aceitar -> passa a fazer parte do grupo de verdade.
 *      - Recusar -> sai do grupo e BLOQUEIA quem criou o grupo.
 *  - ENVIO DE ARQUIVOS: alem de texto e audio, agora e possivel
 *    enviar arquivos de qualquer formato (imagem, video, PDF,
 *    documentos, etc.). O arquivo e salvo em data/files e a
 *    mensagem guarda apenas { url, name, mimetype, size }.
 *  - NOTIFICACOES PUSH: tratamento de erro melhorado
 *    (remove inscricoes expiradas por mais motivos),
 *    last_used por subscription, endpoint de refresh.
 * ============================================================
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webpush = require('web-push');
const { createClient } = require('@libsql/client');

// =====================================================================
//  CAMADA DE ARMAZENAMENTO UNIFICADA (Storage = JSON ou PostgreSQL)
// =====================================================================

const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const FILES_DIR = path.join(DATA_DIR, 'files');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const RELATIONSHIPS_FILE = path.join(DATA_DIR, 'relationships.json');
const BLOCKS_FILE = path.join(DATA_DIR, 'blocks.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');
const SQLITE_FILE = path.join(DATA_DIR, 'papo.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

function ensureFile(file, defaultContent) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultContent, null, 2));
  }
}
ensureFile(USERS_FILE, {});
ensureFile(MESSAGES_FILE, {});
ensureFile(GROUPS_FILE, {});
ensureFile(RELATIONSHIPS_FILE, {});
ensureFile(BLOCKS_FILE, {});
ensureFile(PUSH_SUBS_FILE, {});

function readJSON(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Erro ao ler', file, err);
    return {};
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- Storage em JSON (fallback) ----------
class JSONStorage {
  constructor() {
    this.name = 'json';
  }
  async init() { return Promise.resolve(); }

  // ---- users ----
  async getAllUsers() { return readJSON(USERS_FILE); }
  async getUser(number) { const all = readJSON(USERS_FILE); return all[number] || null; }
  async upsertUser(number, user) { const all = readJSON(USERS_FILE); all[number] = user; writeJSON(USERS_FILE, all); }
  async updateUserProfile(number, name, photo) {
    const all = readJSON(USERS_FILE);
    if (!all[number]) return;
    if (name !== undefined) all[number].name = name;
    if (photo !== undefined) all[number].photo = photo;
    writeJSON(USERS_FILE, all);
  }

  // ---- messages ----
  async getMessagesByKey(key) { const all = readJSON(MESSAGES_FILE); return all[key] || []; }
  async appendMessage(key, message) {
    const all = readJSON(MESSAGES_FILE);
    if (!all[key]) all[key] = [];
    all[key].push(message);
    writeJSON(MESSAGES_FILE, all);
  }
  async markMessageDeleted(key, messageId) {
    const all = readJSON(MESSAGES_FILE);
    const list = all[key] || [];
    const m = list.find(x => x.id === messageId);
    if (m) { m.deleted = true; m.content = null; writeJSON(MESSAGES_FILE, all); }
    return m || null;
  }

  async getUsersByNumbers(numbers) {
    const all = readJSON(USERS_FILE);
    const out = {};
    numbers.forEach(n => { if (all[n]) out[n] = all[n]; });
    return out;
  }

  // ---- relationships ----
  async getRelationshipsFor(number) {
    const all = readJSON(RELATIONSHIPS_FILE);
    const out = {};
    Object.keys(all).forEach(k => {
      const parts = k.split('__');
      if (parts.length === 2 && parts.includes(number)) out[k] = all[k];
    });
    return out;
  }
  async getRelationship(key) { const all = readJSON(RELATIONSHIPS_FILE); return all[key] || null; }
  async setRelationship(key, rel) { const all = readJSON(RELATIONSHIPS_FILE); all[key] = rel; writeJSON(RELATIONSHIPS_FILE, all); }

  // ---- blocks ----
  async isBlocked(blockerNumber, blockedNumber) {
    const blocks = readJSON(BLOCKS_FILE);
    return !!(blocks[blockerNumber] && blocks[blockerNumber].includes(blockedNumber));
  }
  async blockUser(blockerNumber, blockedNumber) {
    const blocks = readJSON(BLOCKS_FILE);
    if (!blocks[blockerNumber]) blocks[blockerNumber] = [];
    if (!blocks[blockerNumber].includes(blockedNumber)) blocks[blockerNumber].push(blockedNumber);
    writeJSON(BLOCKS_FILE, blocks);
  }

  // ---- groups ----
  async getAllGroups() { return readJSON(GROUPS_FILE); }
  async getGroup(groupId) { const all = readJSON(GROUPS_FILE); return all[groupId] || null; }
  async upsertGroup(groupId, group) { const all = readJSON(GROUPS_FILE); all[groupId] = group; writeJSON(GROUPS_FILE, all); }
  async updateGroup(groupId, patch) {
    const all = readJSON(GROUPS_FILE);
    if (!all[groupId]) return null;
    Object.assign(all[groupId], patch);
    writeJSON(GROUPS_FILE, all);
    return all[groupId];
  }

  // ---- push subscriptions ----
  async getPushSubsByNumber(number) { const all = readJSON(PUSH_SUBS_FILE); return all[number] || []; }
  async savePushSub(number, subscription) {
    const all = readJSON(PUSH_SUBS_FILE);
    if (!all[number]) all[number] = [];
    all[number] = all[number].filter(s => s.endpoint !== subscription.endpoint);
    all[number].push(Object.assign({}, subscription, { lastUsed: new Date().toISOString() }));
    writeJSON(PUSH_SUBS_FILE, all);
  }
  async removePushSub(number, endpoint) {
    const all = readJSON(PUSH_SUBS_FILE);
    if (!all[number]) return;
    all[number] = all[number].filter(s => s.endpoint !== endpoint);
    writeJSON(PUSH_SUBS_FILE, all);
  }
  async removePushSubAnywhere(endpoint) {
    const all = readJSON(PUSH_SUBS_FILE);
    let changed = false;
    Object.keys(all).forEach((number) => {
      const before = all[number].length;
      all[number] = all[number].filter(s => s.endpoint !== endpoint);
      if (all[number].length !== before) changed = true;
    });
    if (changed) writeJSON(PUSH_SUBS_FILE, all);
  }
  async touchPushSub(number, endpoint) {
    const all = readJSON(PUSH_SUBS_FILE);
    if (all[number] && all[number].find(s => s.endpoint === endpoint)) {
      const sub = all[number].find(s => s.endpoint === endpoint);
      sub.lastUsed = new Date().toISOString();
      writeJSON(PUSH_SUBS_FILE, all);
    }
  }
}

// ---------- Storage em Turso / libSQL (padrão a partir desta versão) ----------
//
// Continua guardando cada registro como um blob JSON (mesma forma dos
// arquivos antigos), mas agora dentro de tabelas de um banco compatível
// com SQLite acessado pela rede (Turso), em vez de arquivos soltos em
// disco. Isso resolve DOIS problemas de uma vez:
//
//  1) Corrupção por escrita concorrente que existia no modo JSON puro
//     (cada escrita reescrevia o arquivo inteiro do zero).
//  2) Perda de dados em hospedagens com disco efêmero (ex: Render free
//     tier apagando o disco a cada deploy/dormida) — porque agora o
//     banco não mora mais no disco do Render, mora no Turso. O disco
//     do Render pode ser apagado à vontade que os dados continuam lá.
//
// CONFIGURAÇÃO:
//  - Sem TURSO_DATABASE_URL definida: usa um arquivo local
//    (data/papo.db) via libSQL — ótimo para rodar na sua máquina.
//  - Com TURSO_DATABASE_URL (e TURSO_AUTH_TOKEN) definidas: conecta no
//    banco remoto do Turso — use isso em produção (Render, etc).
// Rede de segurança: um erro solto (ex.: queda de conexão com o Turso)
// é registrado no log em vez de derrubar o servidor inteiro.
process.on('unhandledRejection', (reason) => {
  console.error('[Erro não tratado] unhandledRejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Erro não tratado] uncaughtException:', err && err.message ? err.message : err);
});

class SQLiteStorage {
  constructor() {
    this.name = 'sqlite';
    const url = process.env.TURSO_DATABASE_URL || `file:${SQLITE_FILE}`;
    const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
    this._makeClient = () => createClient({ url, authToken });
    let raw = this._makeClient();
    const isConnError = (err) => {
      const txt = `${err && err.message || ''} ${err && err.cause && (err.cause.code || err.cause.message) || ''} ${err && err.code || ''}`;
      return /fetch failed|other side closed|UND_ERR|ECONNRESET|ETIMEDOUT|EPIPE|socket|network|terminated/i.test(txt);
    };
    // Tenta de novo (até 3 vezes) quando a conexão com o Turso cai,
    // recriando o cliente pra largar a conexão velha/fechada.
    const withRetry = async (fn) => {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await fn(raw);
        } catch (err) {
          lastErr = err;
          if (!isConnError(err) || attempt === 2) break;
          console.warn(`[Storage] Conexão com o banco falhou (${err.message}). Tentando de novo (${attempt + 1}/2)...`);
          try { raw.close && raw.close(); } catch (_) {}
          raw = this._makeClient();
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      throw lastErr;
    };
    this.db = {
      execute: (stmt) => withRetry(c => c.execute(stmt)),
      batch: (stmts, mode) => withRetry(c => c.batch(stmts, mode))
    };

    // ---- Cache em memória (write-through) ----
    // Cada consulta ao Turso é uma ida-e-volta pela internet (centenas
    // de ms). Guardamos aqui o texto JSON já lido; toda escrita grava no
    // banco E atualiza o cache. Sempre devolvemos objetos novos
    // (JSON.parse) pra ninguém alterar o cache sem querer.
    // Obs.: assume UMA instância do servidor (Render: WEB_CONCURRENCY=1).
    this._users = new Map();       // number -> json string | null
    this._allUsersLoaded = false;
    this._rels = new Map();        // rel_key -> json string
    this._relsLoaded = false;
    this._blocks = new Map();      // blocker -> json string
    this._blocksLoaded = false;
    this._groups = new Map();      // group_id -> json string
    this._groupsLoaded = false;
    this._msgs = new Map();        // conv_key -> json string (LRU simples)
    this._MSG_CACHE_MAX = 300;
    this._locks = new Map();       // conv_key -> Promise (serializa gravações)
  }

  // Fila por chave: evita perder mensagem quando duas chegam juntas.
  _withLock(key, fn) {
    const prev = this._locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._locks.set(key, next);
    next.finally(() => { if (this._locks.get(key) === next) this._locks.delete(key); }).catch(() => {});
    return next;
  }

  _msgCacheSet(key, str) {
    this._msgs.delete(key);
    this._msgs.set(key, str);
    if (this._msgs.size > this._MSG_CACHE_MAX) {
      this._msgs.delete(this._msgs.keys().next().value);
    }
  }

  async _loadAllRels() {
    if (this._relsLoaded) return;
    const res = await this.db.execute('SELECT rel_key, data FROM relationships');
    res.rows.forEach(r => { if (!this._rels.has(r.rel_key)) this._rels.set(r.rel_key, r.data); });
    this._relsLoaded = true;
  }
  async _loadAllBlocks() {
    if (this._blocksLoaded) return;
    const res = await this.db.execute('SELECT blocker, data FROM blocks');
    res.rows.forEach(r => { if (!this._blocks.has(r.blocker)) this._blocks.set(r.blocker, r.data); });
    this._blocksLoaded = true;
  }
  async _loadAllGroups() {
    if (this._groupsLoaded) return;
    const res = await this.db.execute('SELECT group_id, data FROM groups');
    res.rows.forEach(r => { if (!this._groups.has(r.group_id)) this._groups.set(r.group_id, r.data); });
    this._groupsLoaded = true;
  }

  async init() {
    await this.db.execute('CREATE TABLE IF NOT EXISTS users (number TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.execute('CREATE TABLE IF NOT EXISTS messages (conv_key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.execute('CREATE TABLE IF NOT EXISTS groups (group_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.execute('CREATE TABLE IF NOT EXISTS relationships (rel_key TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.execute('CREATE TABLE IF NOT EXISTS blocks (blocker TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this.db.execute('CREATE TABLE IF NOT EXISTS push_subs (number TEXT PRIMARY KEY, data TEXT NOT NULL)');
    await this._migrateFromJSONIfNeeded();
    // Aquece os caches pequenos já no boot (1 consulta cada).
    try {
      await Promise.all([this._loadAllRels(), this._loadAllBlocks(), this._loadAllGroups()]);
    } catch (err) {
      console.warn('[Storage] Não consegui aquecer o cache agora (vai carregar sob demanda):', err.message);
    }
  }

  // Na primeira vez que o servidor roda apontando pra um banco vazio,
  // se existirem os data/*.json antigos (de uma versão anterior rodando
  // em disco local), importa tudo automaticamente — assim ninguém perde
  // números/conversas já criados.
  async _migrateFromJSONIfNeeded() {
    const countRes = await this.db.execute('SELECT COUNT(*) as c FROM users');
    const userCount = Number(countRes.rows[0].c);
    if (userCount > 0) return;

    const oldFiles = [USERS_FILE, MESSAGES_FILE, GROUPS_FILE, RELATIONSHIPS_FILE, BLOCKS_FILE, PUSH_SUBS_FILE];
    const hasOldData = oldFiles.some(f => fs.existsSync(f) && Object.keys(readJSON(f)).length > 0);
    if (!hasOldData) return;

    console.log('[Storage] Encontrei dados antigos em data/*.json — migrando para o banco (só acontece uma vez)...');
    const importTable = async (table, keyCol, file) => {
      const obj = readJSON(file);
      const entries = Object.entries(obj);
      if (entries.length === 0) return;
      const statements = entries.map(([key, value]) => ({
        sql: `INSERT OR REPLACE INTO ${table} (${keyCol}, data) VALUES (?, ?)`,
        args: [key, JSON.stringify(value)]
      }));
      await this.db.batch(statements, 'write');
    };
    await importTable('users', 'number', USERS_FILE);
    await importTable('messages', 'conv_key', MESSAGES_FILE);
    await importTable('groups', 'group_id', GROUPS_FILE);
    await importTable('relationships', 'rel_key', RELATIONSHIPS_FILE);
    await importTable('blocks', 'blocker', BLOCKS_FILE);
    await importTable('push_subs', 'number', PUSH_SUBS_FILE);
    console.log('[Storage] Migração concluída.');
  }

  // ---- users ----
  async getAllUsers() {
    if (!this._allUsersLoaded) {
      const res = await this.db.execute('SELECT number, data FROM users');
      res.rows.forEach(r => { this._users.set(r.number, r.data); });
      this._allUsersLoaded = true;
    }
    const out = {};
    this._users.forEach((str, number) => { if (str) out[number] = JSON.parse(str); });
    return out;
  }
  async getUser(number) {
    if (this._users.has(number)) {
      const str = this._users.get(number);
      return str ? JSON.parse(str) : null;
    }
    if (this._allUsersLoaded) return null;
    const res = await this.db.execute({ sql: 'SELECT data FROM users WHERE number = ?', args: [number] });
    if (!res.rows.length) return null; // não guarda "não existe" (pode ser criado em seguida)
    this._users.set(number, res.rows[0].data);
    return JSON.parse(res.rows[0].data);
  }
  // Vários usuários de uma vez (1 consulta só pros que faltam no cache).
  async getUsersByNumbers(numbers) {
    const out = {};
    const missing = [];
    for (const n of numbers) {
      if (this._users.has(n)) {
        const str = this._users.get(n);
        if (str) out[n] = JSON.parse(str);
      } else if (!this._allUsersLoaded) {
        missing.push(n);
      }
    }
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const res = await this.db.execute({
        sql: `SELECT number, data FROM users WHERE number IN (${chunk.map(() => '?').join(',')})`,
        args: chunk
      });
      res.rows.forEach(r => { this._users.set(r.number, r.data); out[r.number] = JSON.parse(r.data); });
    }
    return out;
  }
  async upsertUser(number, user) {
    const str = JSON.stringify(user);
    await this.db.execute({
      sql: 'INSERT INTO users (number, data) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET data = excluded.data',
      args: [number, str]
    });
    this._users.set(number, str);
  }
  async updateUserProfile(number, name, photo) {
    const user = await this.getUser(number);
    if (!user) return;
    if (name !== undefined) user.name = name;
    if (photo !== undefined) user.photo = photo;
    await this.upsertUser(number, user);
  }

  // ---- messages ----
  async getMessagesByKey(key) {
    if (this._msgs.has(key)) {
      const str = this._msgs.get(key);
      this._msgCacheSet(key, str); // marca como usado recentemente
      return JSON.parse(str);
    }
    const res = await this.db.execute({ sql: 'SELECT data FROM messages WHERE conv_key = ?', args: [key] });
    if (!res.rows.length) return [];
    this._msgCacheSet(key, res.rows[0].data);
    return JSON.parse(res.rows[0].data);
  }
  async appendMessage(key, message) {
    return this._withLock(key, async () => {
      const list = await this.getMessagesByKey(key);
      list.push(message);
      const str = JSON.stringify(list);
      await this.db.execute({
        sql: 'INSERT INTO messages (conv_key, data) VALUES (?, ?) ON CONFLICT(conv_key) DO UPDATE SET data = excluded.data',
        args: [key, str]
      });
      this._msgCacheSet(key, str);
    });
  }
  async markMessageDeleted(key, messageId) {
    return this._withLock(key, async () => {
      const list = await this.getMessagesByKey(key);
      const m = list.find(x => x.id === messageId);
      if (m) {
        m.deleted = true;
        m.content = null;
        const str = JSON.stringify(list);
        await this.db.execute({ sql: 'UPDATE messages SET data = ? WHERE conv_key = ?', args: [str, key] });
        this._msgCacheSet(key, str);
      }
      return m || null;
    });
  }

  // ---- relationships ----
  async getRelationship(key) {
    await this._loadAllRels();
    const str = this._rels.get(key);
    return str ? JSON.parse(str) : null;
  }
  // Todas as relações em que eu participo, numa tacada só.
  async getRelationshipsFor(number) {
    await this._loadAllRels();
    const out = {};
    this._rels.forEach((str, key) => {
      const parts = key.split('__');
      if (parts.length === 2 && parts.includes(number)) out[key] = JSON.parse(str);
    });
    return out;
  }
  async setRelationship(key, rel) {
    const str = JSON.stringify(rel);
    await this.db.execute({
      sql: 'INSERT INTO relationships (rel_key, data) VALUES (?, ?) ON CONFLICT(rel_key) DO UPDATE SET data = excluded.data',
      args: [key, str]
    });
    this._rels.set(key, str);
  }

  // ---- blocks ----
  async isBlocked(blockerNumber, blockedNumber) {
    await this._loadAllBlocks();
    const str = this._blocks.get(blockerNumber);
    if (!str) return false;
    return JSON.parse(str).includes(blockedNumber);
  }
  async blockUser(blockerNumber, blockedNumber) {
    await this._loadAllBlocks();
    const cur = this._blocks.get(blockerNumber);
    const list = cur ? JSON.parse(cur) : [];
    if (!list.includes(blockedNumber)) list.push(blockedNumber);
    const str = JSON.stringify(list);
    await this.db.execute({
      sql: 'INSERT INTO blocks (blocker, data) VALUES (?, ?) ON CONFLICT(blocker) DO UPDATE SET data = excluded.data',
      args: [blockerNumber, str]
    });
    this._blocks.set(blockerNumber, str);
  }

  // ---- groups ----
  async getAllGroups() {
    await this._loadAllGroups();
    const out = {};
    this._groups.forEach((str, id) => { out[id] = JSON.parse(str); });
    return out;
  }
  async getGroup(groupId) {
    await this._loadAllGroups();
    const str = this._groups.get(groupId);
    return str ? JSON.parse(str) : null;
  }
  async upsertGroup(groupId, group) {
    const str = JSON.stringify(group);
    await this.db.execute({
      sql: 'INSERT INTO groups (group_id, data) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET data = excluded.data',
      args: [groupId, str]
    });
    this._groups.set(groupId, str);
  }
  async updateGroup(groupId, patch) {
    const group = await this.getGroup(groupId);
    if (!group) return null;
    Object.assign(group, patch);
    const str = JSON.stringify(group);
    await this.db.execute({ sql: 'UPDATE groups SET data = ? WHERE group_id = ?', args: [str, groupId] });
    this._groups.set(groupId, str);
    return group;
  }

  // ---- push subscriptions ----
  async getPushSubsByNumber(number) {
    const res = await this.db.execute({ sql: 'SELECT data FROM push_subs WHERE number = ?', args: [number] });
    return res.rows.length ? JSON.parse(res.rows[0].data) : [];
  }
  async savePushSub(number, subscription) {
    const list = await this.getPushSubsByNumber(number);
    const filtered = list.filter(s => s.endpoint !== subscription.endpoint);
    filtered.push(Object.assign({}, subscription, { lastUsed: new Date().toISOString() }));
    await this.db.execute({
      sql: 'INSERT INTO push_subs (number, data) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET data = excluded.data',
      args: [number, JSON.stringify(filtered)]
    });
  }
  async removePushSub(number, endpoint) {
    const list = await this.getPushSubsByNumber(number);
    const filtered = list.filter(s => s.endpoint !== endpoint);
    await this.db.execute({
      sql: 'INSERT INTO push_subs (number, data) VALUES (?, ?) ON CONFLICT(number) DO UPDATE SET data = excluded.data',
      args: [number, JSON.stringify(filtered)]
    });
  }
  async removePushSubAnywhere(endpoint) {
    const res = await this.db.execute('SELECT number, data FROM push_subs');
    const statements = [];
    for (const row of res.rows) {
      const list = JSON.parse(row.data);
      const filtered = list.filter(s => s.endpoint !== endpoint);
      if (filtered.length !== list.length) {
        statements.push({ sql: 'UPDATE push_subs SET data = ? WHERE number = ?', args: [JSON.stringify(filtered), row.number] });
      }
    }
    if (statements.length) await this.db.batch(statements, 'write');
  }
  async touchPushSub(number, endpoint) {
    const list = await this.getPushSubsByNumber(number);
    const sub = list.find(s => s.endpoint === endpoint);
    if (sub) {
      sub.lastUsed = new Date().toISOString();
      await this.db.execute({ sql: 'UPDATE push_subs SET data = ? WHERE number = ?', args: [JSON.stringify(list), number] });
    }
  }
}

// ---------- Factory: Turso/libSQL por padrão; STORAGE_DRIVER=json volta ao modo antigo ----------
async function createStorage() {
  if ((process.env.STORAGE_DRIVER || '').toLowerCase() === 'json') {
    console.log('[Storage] Usando armazenamento em JSON local (data/*.json) — STORAGE_DRIVER=json.');
    const storage = new JSONStorage();
    await storage.init();
    return storage;
  }
  if (process.env.TURSO_DATABASE_URL) {
    console.log('[Storage] Usando banco remoto no Turso (' + process.env.TURSO_DATABASE_URL + ').');
  } else {
    console.log('[Storage] TURSO_DATABASE_URL não definida — usando arquivo local (data/papo.db). Defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN em produção.');
  }
  const storage = new SQLiteStorage();
  await storage.init();
  return storage;
}

// =====================================================================
//  INICIO DO SERVIDOR
// =====================================================================

let storage = null;
const PORT = process.env.PORT || 3000;

function convKey(a, b) { return [a, b].sort().join('__'); }
function groupStorageKey(groupId) { return `group__${groupId}`; }

// ------------------------------------------------------------
// VAPID / Notificacoes push (carrega de storage ou de arquivo)
// ------------------------------------------------------------
async function loadOrCreateVapidKeys() {
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;

  // 1) Se veio do env, usa direto
  if (publicKey && privateKey) return { publicKey, privateKey };

  // 2) Senao, tenta ler do arquivo antigo data/vapid.json
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (saved && saved.publicKey && saved.privateKey) {
        console.log('[VAPID] Usando chaves salvas em data/vapid.json. (recomendamos mover para .env)');
        return saved;
      }
    } catch (err) {
      console.error('Erro ao ler chaves VAPID do arquivo, gerando novas...', err);
    }
  }

  // 3) Gera novas e salva tanto no arquivo quanto no PG (se aplicavel)
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
  console.log('[VAPID] Novas chaves geradas e salvas em data/vapid.json.');
  return keys;
}

// ------------------------------------------------------------
// Funcoes de negocio (usam a camada storage acima)
// ------------------------------------------------------------

// ------------------------------------------------------------
// Chave de recuperação (permite recuperar o MESMO número em
// qualquer navegador/dispositivo, mesmo depois de limpar o
// cache/localStorage). A chave só é mostrada em texto puro
// UMA VEZ (na criação, ou quando o dono pede para gerar uma
// nova); no servidor fica salvo só o hash, nunca a chave crua.
//
// FORMATO: 4 letras (A-Z), sempre maiúsculas, sem nenhuma letra
// repetida dentro da mesma chave (ex: "AXQM"). Como a chave sozinha
// já identifica a conta, ela precisa ser ÚNICA entre todos os
// usuários — por isso, ao gerar, conferimos contra as chaves já
// existentes (comparando o hash) e sorteamos de novo se bater com
// alguma outra conta.
// ------------------------------------------------------------
const RECOVERY_KEY_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomRecoveryKeyCandidate() {
  // Sorteia 4 letras distintas (sem repetição) do alfabeto.
  const pool = RECOVERY_KEY_LETTERS.split('');
  let result = '';
  for (let i = 0; i < 4; i++) {
    const idx = crypto.randomInt(0, pool.length);
    result += pool[idx];
    pool.splice(idx, 1); // remove pra não poder repetir
  }
  return result;
}

function hashRecoveryKey(key, salt) {
  return crypto.scryptSync(String(key), salt, 64).toString('hex');
}
function verifyRecoveryKey(key, salt, hash) {
  if (!salt || !hash || !key) return false;
  try {
    const attempt = Buffer.from(hashRecoveryKey(key, salt), 'hex');
    const expected = Buffer.from(hash, 'hex');
    if (attempt.length !== expected.length) return false;
    return crypto.timingSafeEqual(attempt, expected);
  } catch (_) {
    return false;
  }
}

// Sorteia uma chave de recuperação garantindo que ela não bate com
// a chave (já em hash) de nenhum outro usuário existente, já que
// agora a chave sozinha (sem número) é usada pra entrar na conta.
async function generateUniqueRecoveryKey() {
  const allUsers = await storage.getAllUsers();
  const existing = Object.values(allUsers).filter(u => u.recoveryHash && u.recoverySalt);

  let candidate;
  let attempts = 0;
  do {
    candidate = randomRecoveryKeyCandidate();
    attempts++;
  } while (
    attempts < 1000 &&
    existing.some(u => verifyRecoveryKey(candidate, u.recoverySalt, u.recoveryHash))
  );

  return candidate;
}

// Cria o usuário (se ainda não existir) e devolve a chave de
// recuperação em texto puro (só nesse momento ela existe fora
// do hash). Retorna null se o número já existia.
async function registerUser(number) {
  const exists = await storage.getUser(number);
  if (exists) return null;
  const recoveryKey = await generateUniqueRecoveryKey();
  const recoverySalt = crypto.randomBytes(16).toString('hex');
  const recoveryHash = hashRecoveryKey(recoveryKey, recoverySalt);
  await storage.upsertUser(number, {
    number,
    name: null,
    photo: null,
    createdAt: new Date().toISOString(),
    recoverySalt,
    recoveryHash
  });
  return recoveryKey;
}

async function userExists(number) {
  return !!(await storage.getUser(number));
}

function getPublicProfileFromRow(u) {
  if (!u) return null;
  return { number: u.number, name: u.name || null, photo: u.photo || null };
}

async function getPublicProfile(number) {
  return getPublicProfileFromRow(await storage.getUser(number));
}

async function updateProfile(number, { name, photo }) {
  const existing = await storage.getUser(number);
  if (!existing) return { error: 'Usuario nao encontrado.' };

  let newName = undefined;
  let newPhoto = undefined;

  if (typeof name === 'string') {
    const trimmed = name.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
    newName = trimmed || null;
  }
  if (photo === null) {
    newPhoto = null;
  } else if (typeof photo === 'string' && photo.length > 0) {
    if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(photo)) return { error: 'Formato de foto invalido.' };
    if (photo.length > MAX_PHOTO_DATAURL_LENGTH) return { error: 'Foto muito grande. Escolha uma imagem menor.' };
    newPhoto = photo;
  }
  if (newName !== undefined || newPhoto !== undefined) {
    await storage.updateUserProfile(number, newName, newPhoto);
  }
  return { ok: true, profile: await getPublicProfile(number) };
}

// ---- mensagens ----
async function saveMessage(key, message) {
  await storage.appendMessage(key, message);
}
async function getHistory(key) {
  return storage.getMessagesByKey(key);
}

function previewTextForPush(message) {
  if (message.deleted) return 'Mensagem apagada';
  if (message.type === 'text') return message.content;
  if (message.type === 'audio') return '🎤 Mensagem de voz';
  if (message.type === 'file') {
    const mime = ((message.content && message.content.mimetype) || '').toLowerCase();
    if (mime.startsWith('image/')) return '📷 Foto';
    if (mime.startsWith('video/')) return '🎥 Vídeo';
    if (mime.startsWith('audio/')) return '🎤 Áudio';
    return `📄 ${(message.content && message.content.name) || 'Arquivo'}`;
  }
  return 'Nova mensagem';
}

function deleteStoredFileFor(message) {
  try {
    if (message.type === 'audio' && typeof message.content === 'string') {
      const filePath = path.join(AUDIO_DIR, path.basename(message.content));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else if (message.type === 'file' && message.content && message.content.url) {
      const filePath = path.join(FILES_DIR, path.basename(message.content.url));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('Erro ao apagar arquivo fisico da mensagem', err);
  }
}

function saveAudioBuffer(base64DataUrl) {
  const match = /^data:audio\/([a-zA-Z0-9-]+);base64,(.+)$/.exec(base64DataUrl || '');
  if (!match) return { error: 'Formato de audio invalido.' };
  const ext = match[1].split(';')[0];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) return { error: 'Audio vazio.' };
  if (buffer.length > MAX_AUDIO_BYTES) return { error: 'Audio muito grande (maximo 5MB).' };
  const filename = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(AUDIO_DIR, filename), buffer);
  return { url: `/audio/${filename}` };
}

function guessExtension(mimetype, originalName) {
  if (originalName) {
    const extFromName = path.extname(originalName).replace('.', '').toLowerCase();
    if (extFromName && /^[a-z0-9]+$/.test(extFromName)) return extFromName;
  }
  if (mimetype && mimetype.includes('/')) {
    const guess = mimetype.split('/')[1].split('+')[0].replace(/[^a-z0-9]/gi, '');
    if (guess) return guess.toLowerCase();
  }
  return 'bin';
}
function saveGenericFile(base64DataUrl, originalName) {
  const match = /^data:([^;,]+)?(;charset=[^;,]+)?;base64,(.+)$/.exec(base64DataUrl || '');
  if (!match) return { error: 'Formato de arquivo invalido.' };
  const mimetype = (match[1] || 'application/octet-stream').toLowerCase();
  const buffer = Buffer.from(match[3], 'base64');
  if (buffer.length === 0) return { error: 'Arquivo vazio.' };
  if (buffer.length > MAX_FILE_BYTES) return { error: `Arquivo muito grande (maximo ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB).` };
  const safeOriginalName = (originalName || 'arquivo').toString().replace(/[\r\n]/g, '').trim().slice(0, MAX_FILE_NAME_LENGTH) || 'arquivo';
  const ext = guessExtension(mimetype, safeOriginalName);
  const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(FILES_DIR, filename), buffer);
  return { url: `/files/${filename}`, name: safeOriginalName, mimetype, size: buffer.length };
}

// ---- relacionamentos ----
async function getRelationship(a, b) { return storage.getRelationship(convKey(a, b)); }
async function setRelationship(a, b, rel) { await storage.setRelationship(convKey(a, b), rel); return rel; }

// ---- blocks ----
async function isBlocked(blockerNumber, blockedNumber) { return storage.isBlocked(blockerNumber, blockedNumber); }
async function blockUser(blockerNumber, blockedNumber) { await storage.blockUser(blockerNumber, blockedNumber); }

const BLOCKED_MESSAGE_TEXT = 'Você foi bloqueado por este usuário e não pode mais enviar mensagens.';

// ---- grupos ----
function findMember(group, number) { return group && group.members ? (group.members.find(m => m.number === number) || null) : null; }

async function isAcceptedMemberOfGroup(groupId, number) {
  const g = await storage.getGroup(groupId);
  if (!g) return false;
  const m = findMember(g, number);
  return !!(m && m.status === 'accepted');
}

// ---- push ----
async function getPushSubs(number) { return storage.getPushSubsByNumber(number); }

async function savePushSubscription(number, subscription) {
  if (!subscription || !subscription.endpoint) return;
  await storage.savePushSub(number, subscription);
}
async function removePushSubscription(number, endpoint) { await storage.removePushSub(number, endpoint); }
async function removePushSubscriptionByEndpointAnywhere(endpoint) { await storage.removePushSubAnywhere(endpoint); }
async function touchPushSubscription(number, endpoint) { await storage.touchPushSub(number, endpoint); }

async function sendPushToNumber(number, payload) {
  const subs = await getPushSubs(number);
  for (const sub of subs) {
    const endpoint = sub.endpoint;
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      try { await touchPushSubscription(number, endpoint); } catch (_) {}
    } catch (err) {
      const status = err && err.statusCode;
      // 404 / 410 = endpoint nao existe mais -> remover
      // 400 / 401 / 403 / 413 / 429 = subscription invalida, expirada, ou bloqueada
      const removeIt = status === 404 || status === 410 || status === 400 || status === 401 || status === 403 || status === 413 || status === 429;
      if (removeIt) {
        try { await removePushSubscription(number, endpoint); } catch (_) {}
      } else {
        console.error(`Erro ao enviar push para ${number} [status=${status}]:`, err && err.message);
      }
    }
  }
}

// ------------------------------------------------------------
// Constantes / validacao
// ------------------------------------------------------------
const NUMBER_REGEX = /^9\d{4}-\d{4}$/;
const MAX_TEXT_LENGTH = 2000;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 150;
const MAX_GROUP_NAME_LENGTH = 60;
const MAX_PROFILE_NAME_LENGTH = 40;
const MAX_PHOTO_DATAURL_LENGTH = 1_500_000;

// ------------------------------------------------------------
// Geracao de numero unico
// ------------------------------------------------------------
async function generateUniqueNumber() {
  const users = await storage.getAllUsers();
  let number;
  do {
    const p1 = Math.floor(1000 + Math.random() * 9000);
    const p2 = Math.floor(1000 + Math.random() * 9000);
    number = `9${p1}-${p2}`;
  } while (users[number]);
  return number;
}

// =====================================================================
// Boot do servidor (cria storage, carrega VAPID, sobe HTTP/Socket)
// =====================================================================
(async function main() {
  storage = await createStorage();

  const vapidKeys = await loadOrCreateVapidKeys();
  webpush.setVapidDetails(
    process.env.PUSH_MAILTO || 'mailto:contato@papo.local',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  // ------------------------------------------------------------
  // Servidor HTTP + Express + Socket.IO
  // ------------------------------------------------------------
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1536 * 1024 * 1024 });

  app.use(express.json({ limit: '2mb' }));

  // Rota leve pra "acordar"/monitorar o servidor (ex.: UptimeRobot).
  app.get('/health', (req, res) => res.type('text/plain').send('ok'));

  // index.html (~170 KB) agora vai comprimido (gzip/brotli) — bem mais
  // rápido em celular/4G. Comprime 1 vez e reaproveita enquanto o
  // arquivo não mudar.
  const zlib = require('zlib');
  const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
  let indexCache = { mtime: 0, raw: null, gz: null, br: null, etag: null };
  function loadIndex() {
    const st = fs.statSync(INDEX_PATH);
    if (indexCache.mtime !== st.mtimeMs) {
      const raw = fs.readFileSync(INDEX_PATH);
      indexCache = {
        mtime: st.mtimeMs,
        raw,
        gz: zlib.gzipSync(raw, { level: 9 }),
        br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
        etag: `"${st.size}-${Math.floor(st.mtimeMs)}"`
      };
    }
    return indexCache;
  }
  app.get(['/', '/index.html'], (req, res, next) => {
    try {
      const c = loadIndex();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('ETag', c.etag);
      if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
      const ae = String(req.headers['accept-encoding'] || '');
      if (/\bbr\b/.test(ae)) { res.setHeader('Content-Encoding', 'br'); return res.end(c.br); }
      if (/\bgzip\b/.test(ae)) { res.setHeader('Content-Encoding', 'gzip'); return res.end(c.gz); }
      return res.end(c.raw);
    } catch (err) {
      next(); // se der qualquer problema, cai no express.static normal
    }
  });

  // Ícones/sons quase nunca mudam: o navegador pode guardar 1 dia.
  // HTML, sw.js e manifest continuam sempre revalidando (ETag).
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (/\.(png|wav|ico|jpg|jpeg|webp)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  app.use('/audio', express.static(AUDIO_DIR));
  app.use('/files', express.static(FILES_DIR));

  // Well-known (Digital Asset Links) para TWA / APK Android.
  // Quando voce gerar o assetlinks.json via Bubblewrap, cole o conteudo em
  // public/.well-known/assetlinks.json e ele sera servido automaticamente.
  app.use('/.well-known', express.static(path.join(__dirname, 'public', '.well-known')));

  // ---- Rotas HTTP de push ----
  app.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/api/push/subscribe', async (req, res) => {
    const { number, subscription } = req.body || {};
    if (!number || !NUMBER_REGEX.test(number) || !(await userExists(number))) {
      return res.status(400).json({ ok: false, reason: 'Numero invalido.' });
    }
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ ok: false, reason: 'Inscricao invalida.' });
    }
    try {
      await savePushSubscription(number, subscription);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, reason: 'Erro interno.' });
    }
  });

  app.post('/api/push/refresh', async (req, res) => {
    const { number, subscription } = req.body || {};
    if (!number || !NUMBER_REGEX.test(number) || !(await userExists(number))) {
      return res.status(400).json({ ok: false, reason: 'Numero invalido.' });
    }
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return res.status(400).json({ ok: false, reason: 'Inscricao invalida.' });
    }
    try {
      await savePushSubscription(number, subscription);
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, reason: 'Erro interno.' });
    }
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    const { number, endpoint } = req.body || {};
    if (endpoint) {
      try {
        if (number) await removePushSubscription(number, endpoint);
        else await removePushSubscriptionByEndpointAnywhere(endpoint);
      } catch (_) {}
    }
    res.json({ ok: true });
  });

  // ---- Estado de presenca (em memoria) ----
  const onlineUsers = new Map();
  const socketToNumber = new Map();
  const activeCalls = new Map(); // callId -> { from, to }  (chamadas 1:1)
  const callTimeouts = new Map(); // callId -> timeout (encerra sozinho convites 1:1 travados/nao atendidos)
  function clearCallTimeout(callId) {
    const t = callTimeouts.get(callId);
    if (t) { clearTimeout(t); callTimeouts.delete(callId); }
  }
  const groupCalls = new Map();  // groupId -> { callId, initiator, groupName, participants: Map<numero, {status, timeout}> }
  const CALL_RING_TIMEOUT_MS = 45000;
  function broadcastPresence(number, online) { io.emit('presence', { number, online }); }

  // Associa um socket a um número (login normal ou via chave de
  // recuperação): derruba qualquer sessão antiga com esse mesmo
  // número e marca como online.
  function bindSocketToNumber(socket, number) {
    // Se esse MESMO socket já estava logado em outro número (ex: a
    // pessoa usou "Entrar em outro número" sem desconectar), tira o
    // vínculo do número antigo primeiro. Sem isso, o número antigo
    // ficava marcado como "online" pra sempre (apontando pra um socket
    // que já virou outra conta), o que bagunçava presença, contatos e
    // mensagens de quem ainda tentava falar com o número antigo.
    const previousNumberOfThisSocket = socket.data.number;
    if (previousNumberOfThisSocket && previousNumberOfThisSocket !== number) {
      if (onlineUsers.get(previousNumberOfThisSocket) === socket.id) {
        onlineUsers.delete(previousNumberOfThisSocket);
        broadcastPresence(previousNumberOfThisSocket, false);
      }
    }

    const previousSocketId = onlineUsers.get(number);
    if (previousSocketId && previousSocketId !== socket.id) {
      const prevSocket = io.sockets.sockets.get(previousSocketId);
      if (prevSocket) prevSocket.disconnect(true);
    }
    onlineUsers.set(number, socket.id);
    socketToNumber.set(socket.id, number);
    socket.data.number = number;

    // Se essa pessoa tinha caído durante uma chamada (ver
    // 'scheduleGraceDisconnect') e voltou a tempo, cancela o
    // encerramento pendente — pra ninguém nem perceber que ela caiu.
    const pending = pendingDisconnects.get(number);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingDisconnects.delete(number);
    } else {
      broadcastPresence(number, true);
    }
  }

  // ---- Tolerância a quedas de conexão durante uma chamada ----
  // No celular, o navegador pode "pausar" a aba quando o app vai pra
  // segundo plano ou a tela bloqueia, derrubando o socket por alguns
  // segundos mesmo com a ligação (WebRTC) continuando ativa por trás.
  // Por isso, só avisamos "saiu"/encerramos a chamada de verdade se a
  // pessoa não voltar dentro desse prazo.
  const DISCONNECT_GRACE_MS = 25000;
  const pendingDisconnects = new Map(); // numero -> { timeout }

  function scheduleGraceDisconnect(number, socketId) {
    const existing = pendingDisconnects.get(number);
    if (existing) clearTimeout(existing.timeout);

    const timeout = setTimeout(() => {
      pendingDisconnects.delete(number);
      // Se nesse meio tempo ela reconectou (com outro socket), não faz nada.
      if (onlineUsers.has(number)) return;

      broadcastPresence(number, false);

      // Encerra qualquer chamada 1:1 em andamento, avisando o outro lado.
      for (const [callId, c] of activeCalls.entries()) {
        if (c.from === number || c.to === number) {
          const other = c.from === number ? c.to : c.from;
          activeCalls.delete(callId);
          clearCallTimeout(callId);
          const otherSocketId = onlineUsers.get(other);
          if (otherSocketId) io.to(otherSocketId).emit('call:ended', { from: number, callId });
        }
      }

      // O mesmo, só que pras chamadas de GRUPO.
      for (const [groupId, gc] of groupCalls.entries()) {
        if (!gc.participants.has(number)) continue;
        const wasJoined = gc.participants.get(number).status === 'joined';
        clearGroupCallInviteTimeout(groupId, number);
        gc.participants.delete(number);
        if (wasJoined) {
          const remainingJoined = [...gc.participants.entries()].filter(([, p]) => p.status === 'joined');
          remainingJoined.forEach(([num]) => {
            const sId = onlineUsers.get(num);
            if (sId) io.to(sId).emit('groupcall:participant-left', { groupId, callId: gc.callId, number });
          });
          if (remainingJoined.length === 0) {
            for (const [, p] of gc.participants) { if (p.timeout) clearTimeout(p.timeout); }
            groupCalls.delete(groupId);
          }
        }
      }
    }, DISCONNECT_GRACE_MS);

    pendingDisconnects.set(number, { timeout });
  }

  // ------------------------------------------------------------
  // Socket.IO
  // ------------------------------------------------------------
  io.on('connection', (socket) => {

    socket.on('register', async (payload, callback) => {
      payload = payload || {};
      const requested = payload.number;
      let number;
      let recoveryKey = null;

      if (requested && NUMBER_REGEX.test(requested) && (await userExists(requested))) {
        number = requested;
      } else {
        number = await generateUniqueNumber();
        recoveryKey = await registerUser(number);
      }

      bindSocketToNumber(socket, number);

      if (typeof callback === 'function') {
        const response = { ok: true, number, profile: await getPublicProfile(number) };
        // A chave só volta aqui na hora em que a conta é criada.
        // O cliente precisa guardar/mostrar ela agora, porque o
        // servidor nunca mais vai poder mostrar de novo (só o hash
        // fica salvo).
        if (recoveryKey) response.recoveryKey = recoveryKey;
        callback(response);
      }
    });

    // Login manual: recupera um número já existente usando a
    // CHAVE DE RECUPERAÇÃO (funciona em qualquer navegador ou
    // dispositivo, mesmo depois de limpar o cache/localStorage).
    //
    // A chave SOZINHA já é suficiente pra entrar (ela é única entre
    // todas as contas). O número é opcional: se a pessoa informar,
    // conferimos que bate com o dono da chave; se não informar,
    // procuramos a conta dona daquela chave. Só o número, SEM a
    // chave, nunca é suficiente para entrar.
    socket.on('login-with-key', async (payload, callback) => {
      if (typeof callback !== 'function') return;
      payload = payload || {};
      const numberInput = String(payload.number || '').trim();
      const key = String(payload.recoveryKey || '').trim().toUpperCase();

      if (!key) {
        return callback({ ok: false, reason: 'Digite sua chave de recuperação.' });
      }

      let number = null;

      if (numberInput) {
        // Número informado: precisa ser válido E a chave precisa
        // bater com a conta desse número específico.
        if (!NUMBER_REGEX.test(numberInput)) {
          return callback({ ok: false, reason: 'Formato de número inválido. Use 9XXXX-XXXX.' });
        }
        const user = await storage.getUser(numberInput);
        if (!user || !user.recoveryHash || !verifyRecoveryKey(key, user.recoverySalt, user.recoveryHash)) {
          return callback({ ok: false, reason: 'Número ou chave de recuperação inválidos.' });
        }
        number = numberInput;
      } else {
        // Sem número: procura, entre todas as contas, qual é a dona
        // dessa chave de recuperação.
        const allUsers = await storage.getAllUsers();
        for (const [num, user] of Object.entries(allUsers)) {
          if (user.recoveryHash && verifyRecoveryKey(key, user.recoverySalt, user.recoveryHash)) {
            number = num;
            break;
          }
        }
        if (!number) {
          return callback({ ok: false, reason: 'Chave de recuperação inválida.' });
        }
      }

      bindSocketToNumber(socket, number);
      callback({ ok: true, number, profile: await getPublicProfile(number) });
    });

    // Gera (ou substitui) a chave de recuperação do número já
    // logado nesse socket. Usado tanto para contas antigas (que
    // ainda não tinham chave) quanto para quem quer uma chave nova.
    socket.on('generate-recovery-key', async (payload, callback) => {
      if (typeof callback !== 'function') return;
      const number = socketToNumber.get(socket.id);
      if (!number) return callback({ ok: false, reason: 'Você precisa estar conectado.' });
      const user = await storage.getUser(number);
      if (!user) return callback({ ok: false, reason: 'Usuário não encontrado.' });

      const recoveryKey = await generateUniqueRecoveryKey();
      const recoverySalt = crypto.randomBytes(16).toString('hex');
      user.recoverySalt = recoverySalt;
      user.recoveryHash = hashRecoveryKey(recoveryKey, recoverySalt);
      await storage.upsertUser(number, user);

      callback({ ok: true, recoveryKey });
    });

    socket.on('check-user', async (payload, callback) => {
      if (typeof callback !== 'function') return;
      const target = ((payload && payload.number) || '').trim();
      const me = socketToNumber.get(socket.id);
      if (!NUMBER_REGEX.test(target)) return callback({ ok: false, reason: 'Formato de numero invalido. Use 9XXXX-XXXX.' });
      if (!(await userExists(target))) return callback({ ok: false, reason: 'Usuário não encontrado ou offline.' });
      return callback({
        ok: true,
        number: target,
        online: onlineUsers.has(target),
        profile: await getPublicProfile(target),
        blockedByThem: me ? (await isBlocked(target, me)) : false
      });
    });

    socket.on('get-profile', async (payload, callback) => {
      if (typeof callback !== 'function') return;
      const target = (payload && payload.number) || '';
      if (!NUMBER_REGEX.test(target) || !(await userExists(target))) return callback({ ok: false, reason: 'Usuario nao encontrado.' });
      callback({ ok: true, profile: await getPublicProfile(target) });
    });

    socket.on('update-profile', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const result = await updateProfile(me, {
        name: payload && typeof payload.name === 'string' ? payload.name : undefined,
        photo: payload ? payload.photo : undefined
      });
      if (result.error) return callback({ ok: false, reason: result.error });
      io.emit('profile-updated', result.profile);
      callback({ ok: true, profile: result.profile });
    });

    socket.on('get-inbox', async (callback) => {
      if (typeof callback !== 'function') return;
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });

      // Antes: carregava TODOS os usuários (com fotos) e fazia 1 consulta
      // ao banco por usuário, em sequência. Agora: 1 chamada pras relações
      // e 1 pros perfis de quem realmente conversa comigo.
      const relationships = await storage.getRelationshipsFor(me);
      const otherNumbers = Object.keys(relationships)
        .map(k => { const parts = k.split('__'); return parts[0] === me ? parts[1] : parts[0]; });
      const usersMap = await storage.getUsersByNumbers(otherNumbers);

      const privateChats = [];
      Object.keys(relationships).forEach((key) => {
        const parts = key.split('__');
        if (parts.length !== 2 || !parts.includes(me)) return;
        const other = parts[0] === me ? parts[1] : parts[0];
        const rel = relationships[key];
        // popula perfil de "other"
        const p = usersMap[other];
        privateChats.push({
          number: other,
          profile: getPublicProfileFromRow(p),
          online: onlineUsers.has(other),
          status: rel.status,
          requestedBy: rel.requestedBy,
          iAmRequester: rel.requestedBy === me
        });
      });

      const groupsMap = await storage.getAllGroups();
      const myGroups = Object.values(groupsMap)
        .filter(g => findMember(g, me))
        .map(g => ({
          id: g.id,
          name: g.name,
          photo: g.photo || null,
          createdBy: g.createdBy,
          members: g.members,
          myStatus: findMember(g, me).status
        }));

      callback({ ok: true, privateChats, groups: myGroups });
    });

    socket.on('get-history', async (payload, callback) => {
      if (typeof callback !== 'function') return;
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const target = payload && payload.withNumber;
      if (!target || !NUMBER_REGEX.test(target)) return callback({ ok: false, reason: 'Numero invalido.' });
      const rel = await getRelationship(me, target);
      callback({
        ok: true,
        messages: await getHistory(convKey(me, target)),
        relationship: rel,
        blockedByThem: await isBlocked(target, me),
        blockedByMe: await isBlocked(me, target)
      });
    });

    socket.on('get-group-history', async (payload, callback) => {
      if (typeof callback !== 'function') return;
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const groupId = payload && payload.groupId;
      if (!groupId || !(await isAcceptedMemberOfGroup(groupId, me))) {
        return callback({ ok: false, reason: 'Grupo nao encontrado ou voce ainda nao faz parte dele.' });
      }
      callback({ ok: true, messages: await getHistory(groupStorageKey(groupId)) });
    });

    socket.on('private-message', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const from = socketToNumber.get(socket.id);
      if (!from) return callback({ ok: false, reason: 'Remetente nao registrado no servidor.' });
      const to = payload && payload.to;
      const type = payload && payload.type;
      if (!to || !NUMBER_REGEX.test(to)) return callback({ ok: false, reason: 'Destinatario invalido.' });
      if (to === from) return callback({ ok: false, reason: 'Nao e possivel enviar mensagens para o proprio numero.' });
      if (!(await userExists(to))) return callback({ ok: false, reason: 'Usuario destinatario nao existe no servidor.' });
      if (await isBlocked(to, from)) return callback({ ok: false, reason: BLOCKED_MESSAGE_TEXT, blocked: true });

      let content;
      if (type === 'text') {
        const text = ((payload.content) || '').toString();
        if (!text.trim()) return callback({ ok: false, reason: 'Mensagem vazia.' });
        if (text.length > MAX_TEXT_LENGTH) return callback({ ok: false, reason: 'Mensagem muito longa.' });
        content = text;
      } else if (type === 'audio') {
        const result = saveAudioBuffer(payload.content);
        if (result.error) return callback({ ok: false, reason: result.error });
        content = result.url;
      } else if (type === 'file') {
        const result = saveGenericFile(payload.content, payload.fileName);
        if (result.error) return callback({ ok: false, reason: result.error });
        content = result;
      } else {
        return callback({ ok: false, reason: 'Tipo de mensagem invalido.' });
      }

      let rel = await getRelationship(from, to);
      if (!rel) {
        rel = { status: 'pending', requestedBy: from };
        await setRelationship(from, to, rel);
      } else if (rel.status === 'pending' && rel.requestedBy !== from) {
        rel = { status: 'accepted', requestedBy: rel.requestedBy };
        await setRelationship(from, to, rel);
      }

      const message = {
        id: crypto.randomUUID(),
        from, to, type, content,
        timestamp: new Date().toISOString()
      };

      await saveMessage(convKey(from, to), message);
      const targetSocketId = onlineUsers.get(to);
      const fromProfile = await getPublicProfile(from);
      const fromLabel = (fromProfile && fromProfile.name) || from;

      if (rel.status === 'accepted') {
        if (targetSocketId) {
          io.to(targetSocketId).emit('private-message', message);
        } else {
          sendPushToNumber(to, {
            title: fromLabel,
            body: previewTextForPush(message),
            url: `/?openPrivate=${encodeURIComponent(from)}`,
            tag: `private-${from}`,
            msgId: message.id
          });
        }
      } else {
        if (targetSocketId) {
          io.to(targetSocketId).emit('private-message-request', { message, relationship: rel });
        } else {
          sendPushToNumber(to, {
            title: `Solicitação de ${fromLabel}`,
            body: previewTextForPush(message),
            url: `/?openPrivate=${encodeURIComponent(from)}`,
            tag: `private-${from}`,
            msgId: message.id
          });
        }
      }

      socket.emit('private-message', message);
      callback({ ok: true, message, relationship: rel });
    });

    socket.on('respond-private-request', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const from = payload && payload.from;
      const action = payload && payload.action;
      if (!from || !NUMBER_REGEX.test(from)) return callback({ ok: false, reason: 'Numero invalido.' });

      const rel = await getRelationship(me, from);
      if (!rel || rel.status !== 'pending' || rel.requestedBy !== from) {
        return callback({ ok: false, reason: 'Nenhuma solicitacao pendente deste numero.' });
      }
      const fromSocketId = onlineUsers.get(from);

      if (action === 'accept') {
        const updated = { status: 'accepted', requestedBy: rel.requestedBy };
        await setRelationship(me, from, updated);
        if (fromSocketId) io.to(fromSocketId).emit('private-request-accepted', { number: me, profile: await getPublicProfile(me) });
        return callback({ ok: true, status: 'accepted' });
      }
      if (action === 'reject') {
        const updated = { status: 'blocked', requestedBy: rel.requestedBy };
        await setRelationship(me, from, updated);
        await blockUser(me, from);
        if (fromSocketId) io.to(fromSocketId).emit('private-request-rejected', { number: me, message: BLOCKED_MESSAGE_TEXT });
        return callback({ ok: true, status: 'blocked' });
      }
      return callback({ ok: false, reason: 'Acao invalida.' });
    });

    socket.on('create-group', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });

      const name = (((payload && payload.name) || '').trim()).slice(0, MAX_GROUP_NAME_LENGTH);
      let members = (payload && payload.members) || [];
      if (!name) return callback({ ok: false, reason: 'O nome do grupo e obrigatorio.' });

      members = Array.from(new Set(members.map(m => (m || '').trim()).filter(Boolean))).filter(m => m !== me);
      const invalid = members.filter(m => !NUMBER_REGEX.test(m) || !(async (n) => (await userExists(n)))(m));
      // Resolve invalidos de verdade com await:
      const validFlags = await Promise.all(members.map(m => (async () => NUMBER_REGEX.test(m) && (await userExists(m)))()));
      const realInvalid = members.filter((_, i) => !validFlags[i]);
      if (realInvalid.length) return callback({ ok: false, reason: `Numeros nao encontrados: ${realInvalid.join(', ')}` });

      const blockedFlags = await Promise.all(members.map(n => isBlocked(n, me)));
      const blockedOut = members.filter((_, i) => blockedFlags[i]);
      const validMembers = members.filter((_, i) => !blockedFlags[i]);

      if (validMembers.length === 0) return callback({ ok: false, reason: 'Todos os numeros informados bloquearam voce ou sao invalidos.' });

      const groupId = crypto.randomUUID();
      const groupInfo = {
        id: groupId,
        name,
        photo: null,
        members: [
          { number: me, status: 'accepted' },
          ...validMembers.map(number => ({ number, status: 'pending' }))
        ],
        createdBy: me,
        createdAt: new Date().toISOString()
      };
      await storage.upsertGroup(groupId, groupInfo);

      const creatorProfile = await getPublicProfile(me);
      const creatorLabel = (creatorProfile && creatorProfile.name) || me;

      validMembers.forEach((number) => {
        const sId = onlineUsers.get(number);
        if (sId) io.to(sId).emit('group-invite', groupInfo);
        else sendPushToNumber(number, {
          title: 'Convite de grupo',
          body: `${creatorLabel} te chamou para o grupo "${name}"`,
          url: `/?openGroup=${encodeURIComponent(groupId)}`,
          tag: `group-invite-${groupId}`
        });
      });
      callback({ ok: true, group: groupInfo, blockedOut });
    });

    // Adiciona novos membros a um grupo que já existe (botão "+" na
    // tela de editar grupo). Qualquer membro já aceito no grupo pode
    // convidar gente nova — quem entra vira 'pending' e recebe o
    // convite normal de Aceitar/Recusar, igual quando o grupo é criado.
    socket.on('add-group-members', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });

      const groupId = payload && payload.groupId;
      let group = await storage.getGroup(groupId);
      if (!group) return callback({ ok: false, reason: 'Grupo nao encontrado.' });
      if (!(await isAcceptedMemberOfGroup(groupId, me))) return callback({ ok: false, reason: 'Voce nao faz parte deste grupo.' });

      let numbers = (payload && payload.members) || [];
      numbers = Array.from(new Set(numbers.map(n => (n || '').trim()).filter(Boolean)));

      const existingNumbers = new Set((group.members || []).map(m => m.number));
      numbers = numbers.filter(n => n !== me && !existingNumbers.has(n));
      if (numbers.length === 0) return callback({ ok: false, reason: 'Nenhum número novo pra adicionar (já estão no grupo ou o campo veio vazio).' });

      const validFlags = await Promise.all(numbers.map(n => (async () => NUMBER_REGEX.test(n) && (await userExists(n)))()));
      const realInvalid = numbers.filter((_, i) => !validFlags[i]);
      if (realInvalid.length) return callback({ ok: false, reason: `Numeros nao encontrados: ${realInvalid.join(', ')}` });

      const blockedFlags = await Promise.all(numbers.map(n => isBlocked(n, me)));
      const blockedOut = numbers.filter((_, i) => blockedFlags[i]);
      const validMembers = numbers.filter((_, i) => !blockedFlags[i]);
      if (validMembers.length === 0) return callback({ ok: false, reason: 'Todos os numeros informados bloquearam voce ou sao invalidos.' });

      const newMembers = (group.members || []).concat(validMembers.map(number => ({ number, status: 'pending' })));
      group = await storage.updateGroup(groupId, { members: newMembers });

      const adderProfile = await getPublicProfile(me);
      const adderLabel = (adderProfile && adderProfile.name) || me;

      // Convite pros números novos (mesmo fluxo do create-group).
      validMembers.forEach((number) => {
        const sId = onlineUsers.get(number);
        if (sId) io.to(sId).emit('group-invite', group);
        else sendPushToNumber(number, {
          title: 'Convite de grupo',
          body: `${adderLabel} te chamou para o grupo "${group.name}"`,
          url: `/?openGroup=${encodeURIComponent(groupId)}`,
          tag: `group-invite-${groupId}`
        });
      });

      // Avisa quem já está no grupo que a lista de membros mudou,
      // pra atualizar a telinha de editar grupo em tempo real.
      group.members.filter(m => m.status === 'accepted').forEach((m) => {
        const sId = onlineUsers.get(m.number);
        if (sId) io.to(sId).emit('group-members-added', { groupId, group, by: me, added: validMembers });
      });

      callback({ ok: true, group, blockedOut });
    });

    socket.on('respond-group-invite', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const groupId = payload && payload.groupId;
      const action = payload && payload.action;
      const group = await storage.getGroup(groupId);
      if (!group) return callback({ ok: false, reason: 'Grupo nao encontrado.' });
      const member = findMember(group, me);
      if (!member || member.status !== 'pending') return callback({ ok: false, reason: 'Nenhum convite pendente para este grupo.' });

      const creatorSocketId = onlineUsers.get(group.createdBy);

      if (action === 'accept') {
        member.status = 'accepted';
        await storage.updateGroup(groupId, { members: group.members });
        const fresh = await storage.getGroup(groupId);
        if (creatorSocketId) io.to(creatorSocketId).emit('group-invite-accepted', { groupId, by: me });
        return callback({ ok: true, status: 'accepted', group: fresh });
      }
      if (action === 'reject') {
        const newMembers = group.members.filter(m => m.number !== me);
        await storage.updateGroup(groupId, { members: newMembers });
        await blockUser(me, group.createdBy);
        if (creatorSocketId) io.to(creatorSocketId).emit('group-invite-rejected', { groupId, by: me, message: `Você foi bloqueado por ${me}.` });
        return callback({ ok: true, status: 'rejected' });
      }
      return callback({ ok: false, reason: 'Acao invalida.' });
    });

    socket.on('update-group', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const groupId = payload && payload.groupId;
      let group = await storage.getGroup(groupId);
      if (!group) return callback({ ok: false, reason: 'Grupo nao encontrado.' });
      if (!(await isAcceptedMemberOfGroup(groupId, me))) return callback({ ok: false, reason: 'Voce nao faz parte deste grupo.' });

      let changed = false;
      let patch = {};
      if (typeof payload.name === 'string') {
        const trimmed = payload.name.trim().slice(0, MAX_GROUP_NAME_LENGTH);
        if (!trimmed) return callback({ ok: false, reason: 'O nome do grupo nao pode ficar vazio.' });
        patch.name = trimmed;
        changed = true;
      }
      if (payload.photo === null) { patch.photo = null; changed = true; }
      else if (typeof payload.photo === 'string' && payload.photo.length > 0) {
        if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(payload.photo)) return callback({ ok: false, reason: 'Formato de foto invalido.' });
        if (payload.photo.length > MAX_PHOTO_DATAURL_LENGTH) return callback({ ok: false, reason: 'Foto muito grande. Escolha uma imagem menor.' });
        patch.photo = payload.photo;
        changed = true;
      }
      if (!changed) return callback({ ok: false, reason: 'Nada para atualizar.' });

      group = await storage.updateGroup(groupId, patch);

      if (group && group.members) {
        group.members.filter(m => m.status === 'accepted').forEach((m) => {
          const sId = onlineUsers.get(m.number);
          if (sId) io.to(sId).emit('group-updated', { groupId, name: group.name, photo: group.photo, by: me });
        });
      }
      callback({ ok: true, group });
    });

    socket.on('group-message', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const from = socketToNumber.get(socket.id);
      if (!from) return callback({ ok: false, reason: 'Remetente nao registrado no servidor.' });
      const groupId = payload && payload.groupId;
      const type = payload && payload.type;
      const group = await storage.getGroup(groupId);
      if (!group || !(await isAcceptedMemberOfGroup(groupId, from))) {
        return callback({ ok: false, reason: 'Grupo nao encontrado ou voce ainda nao faz parte dele.' });
      }

      let content;
      if (type === 'text') {
        const text = ((payload.content) || '').toString();
        if (!text.trim()) return callback({ ok: false, reason: 'Mensagem vazia.' });
        if (text.length > MAX_TEXT_LENGTH) return callback({ ok: false, reason: 'Mensagem muito longa.' });
        content = text;
      } else if (type === 'audio') {
        const result = saveAudioBuffer(payload.content);
        if (result.error) return callback({ ok: false, reason: result.error });
        content = result.url;
      } else if (type === 'file') {
        const result = saveGenericFile(payload.content, payload.fileName);
        if (result.error) return callback({ ok: false, reason: result.error });
        content = result;
      } else {
        return callback({ ok: false, reason: 'Tipo de mensagem invalido.' });
      }

      const message = {
        id: crypto.randomUUID(),
        from,
        to: groupId,
        groupId,
        groupName: group.name,
        type,
        content,
        timestamp: new Date().toISOString()
      };

      await saveMessage(groupStorageKey(groupId), message);
      const fromProfile = await getPublicProfile(from);
      const fromLabel = (fromProfile && fromProfile.name) || from;

      (group.members || [])
        .filter(m => m.status === 'accepted' && m.number !== from)
        .forEach((m) => {
          const sId = onlineUsers.get(m.number);
          if (sId) io.to(sId).emit('group-message', message);
          else sendPushToNumber(m.number, {
            title: group.name || 'Grupo',
            body: `${fromLabel}: ${previewTextForPush(message)}`,
            url: `/?openGroup=${encodeURIComponent(groupId)}`,
            tag: `group-${groupId}`,
            msgId: message.id
          });
        });

      const meSocketId = onlineUsers.get(from);
      if (meSocketId) io.to(meSocketId).emit('group-message', message);
      callback({ ok: true, message });
    });

    // ============================================================
    //  "ESTA DIGITANDO..." (typing indicator)
    //   -> Nao fica salvo em nenhum lugar, e so um repasse em tempo
    //      real do socket de quem digita para o(s) socket(s) do(s)
    //      destinatario(s). Se ninguem estiver online do outro lado,
    //      simplesmente nao acontece nada (sem fila, sem push).
    // ============================================================
    socket.on('typing', async (payload) => {
      const from = socketToNumber.get(socket.id);
      if (!from) return;
      const isTyping = !!(payload && payload.isTyping);

      if (payload && payload.groupId) {
        const groupId = payload.groupId;
        const group = await storage.getGroup(groupId);
        if (!group) return;
        (group.members || [])
          .filter(m => m.status === 'accepted' && m.number !== from)
          .forEach((m) => {
            const sId = onlineUsers.get(m.number);
            if (sId) io.to(sId).emit('typing', { from, groupId, isTyping });
          });
      } else {
        const to = payload && payload.to;
        if (!to || !NUMBER_REGEX.test(to)) return;
        const targetSocketId = onlineUsers.get(to);
        if (targetSocketId) io.to(targetSocketId).emit('typing', { from, isTyping });
      }
    });

    // ============================================================
    //  CHAMADA DE VOZ (call) + compartilhamento de tela DURANTE a
    //  chamada
    //   -> O servidor NUNCA guarda audio nem video: ele so repassa
    //      (relay) o convite e os sinais WebRTC (offer/answer/ICE)
    //      entre o socket de quem ligou e o socket de quem recebeu.
    //      O audio/tela em si vai direto de um navegador para o
    //      outro (peer-to-peer).
    // ============================================================
    socket.on('call:invite', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const from = socketToNumber.get(socket.id);
      if (!from) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const to = payload && payload.to;
      if (!to || !NUMBER_REGEX.test(to)) return callback({ ok: false, reason: 'Numero invalido.' });
      if (await isBlocked(to, from)) return callback({ ok: false, reason: BLOCKED_MESSAGE_TEXT, blocked: true });
      const targetSocketId = onlineUsers.get(to);
      if (!targetSocketId) return callback({ ok: false, reason: 'Este contato esta offline agora.' });

      // Limpeza defensiva: qualquer chamada "presa" na memória cujos dois
      // participantes já não estão mais online é lixo (sobrou de alguma
      // queda que escapou da limpeza normal) — descarta antes de checar
      // ocupado, pra não bloquear ligações novas por causa de fantasma.
      for (const [oldCallId, c] of activeCalls.entries()) {
        if (!onlineUsers.has(c.from) && !onlineUsers.has(c.to)) {
          activeCalls.delete(oldCallId);
          clearCallTimeout(oldCallId);
        }
      }

      for (const c of activeCalls.values()) {
        if (c.from === to || c.to === to) {
          return callback({ ok: false, reason: 'Este contato ja esta em outra chamada.', busy: true });
        }
        if (c.from === from || c.to === from) {
          return callback({ ok: false, reason: 'Voce ja esta em uma chamada.', busy: true });
        }
      }

      const callId = (payload && payload.callId) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
      activeCalls.set(callId, { from, to });

      // Rede de segurança do servidor: se ninguém atender/cancelar/desligar
      // dentro desse prazo (folga sobre o timeout de 45s do navegador),
      // o servidor mesmo encerra o convite sozinho, pra nunca ficar uma
      // chamada "presa" bloqueando ligações futuras pra esse número.
      const timeoutHandle = setTimeout(() => {
        if (activeCalls.has(callId)) {
          activeCalls.delete(callId);
          const callerSocketId = onlineUsers.get(from);
          const calleeSocketId = onlineUsers.get(to);
          if (callerSocketId) io.to(callerSocketId).emit('call:cancelled', { from: to, callId });
          if (calleeSocketId) io.to(calleeSocketId).emit('call:cancelled', { from, callId });
        }
        callTimeouts.delete(callId);
      }, CALL_RING_TIMEOUT_MS + 5000);
      callTimeouts.set(callId, timeoutHandle);

      const fromProfile = await getPublicProfile(from);
      io.to(targetSocketId).emit('call:incoming', {
        from,
        fromName: (fromProfile && fromProfile.name) || from,
        fromPhoto: (fromProfile && fromProfile.photo) || null,
        callId
      });
      callback({ ok: true, callId });
    });

    socket.on('call:cancel', (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false });
      const to = payload && payload.to;
      const callId = payload && payload.callId;
      if (callId) { activeCalls.delete(callId); clearCallTimeout(callId); }
      if (to && NUMBER_REGEX.test(to)) {
        const targetSocketId = onlineUsers.get(to);
        if (targetSocketId) io.to(targetSocketId).emit('call:cancelled', { from: me, callId });
      }
      callback({ ok: true });
    });

    socket.on('call:answer', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false });
      const to = payload && payload.to;
      const callId = payload && payload.callId;
      const accepted = !!(payload && payload.accepted);
      if (!to || !NUMBER_REGEX.test(to)) return callback({ ok: false, reason: 'Numero invalido.' });
      // Independente de aceitar ou recusar, a chamada deixou de "tocar" —
      // cancela a rede de segurança pra ela não encerrar a ligação à toa
      // mais tarde caso tenha sido aceita.
      if (callId) clearCallTimeout(callId);
      if (!accepted && callId) activeCalls.delete(callId);

      const targetSocketId = onlineUsers.get(to);
      const meProfile = await getPublicProfile(me);
      if (targetSocketId) {
        io.to(targetSocketId).emit('call:answered', {
          from: me,
          fromName: (meProfile && meProfile.name) || me,
          fromPhoto: (meProfile && meProfile.photo) || null,
          callId,
          accepted
        });
      }
      callback({ ok: true });
    });

    // Repasse "cego" dos dados de sinalizacao WebRTC (offer/answer/ICE
    // candidate), inclusive as renegociacoes usadas para ligar/desligar
    // o compartilhamento de tela no meio da chamada. O servidor nao
    // interpreta o conteudo, so entrega ao socket do numero certo.
    socket.on('call:signal', (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false });
      const to = payload && payload.to;
      if (!to || !NUMBER_REGEX.test(to)) return callback({ ok: false, reason: 'Numero invalido.' });
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) io.to(targetSocketId).emit('call:signal', { from: me, callId: payload.callId, data: payload.data });
      callback({ ok: true });
    });

    socket.on('call:hangup', (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false });
      const to = payload && payload.to;
      const callId = payload && payload.callId;
      if (callId) { activeCalls.delete(callId); clearCallTimeout(callId); }
      if (to && NUMBER_REGEX.test(to)) {
        const targetSocketId = onlineUsers.get(to);
        if (targetSocketId) io.to(targetSocketId).emit('call:ended', { from: me, callId });
      }
      callback({ ok: true });
    });

    // ============================================================
    //  CHAMADA DE VOZ EM GRUPO (mesh: cada participante conecta
    //  diretamente com TODO MUNDO que já está na chamada — sem
    //  servidor de mídia central, só o repasse "cego" da sinalização).
    //   -> Se ninguém do grupo está em chamada, quem clica em 📞 CHAMA
    //      todo mundo (toca pros outros).
    //   -> Se a chamada do grupo já está rolando, quem clica ENTRA
    //      direto (como "entrar numa ligação em andamento"), sem tocar
    //      pra si mesmo, e o servidor avisa quem já estava lá pra cada
    //      um montar a conexão com o novo participante.
    // ============================================================
    function clearGroupCallInviteTimeout(groupId, number) {
      const gc = groupCalls.get(groupId);
      if (!gc) return;
      const p = gc.participants.get(number);
      if (p && p.timeout) clearTimeout(p.timeout);
    }

    socket.on('groupcall:invite', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const from = socketToNumber.get(socket.id);
      if (!from) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const groupId = payload && payload.groupId;
      if (!groupId) return callback({ ok: false, reason: 'Grupo invalido.' });

      const group = await storage.getGroup(groupId);
      if (!group) return callback({ ok: false, reason: 'Grupo nao encontrado.' });
      const myMembership = (group.members || []).find(m => m.number === from && m.status === 'accepted');
      if (!myMembership) return callback({ ok: false, reason: 'Voce nao faz parte deste grupo.' });

      const fromProfile = await getPublicProfile(from);
      const fromName = (fromProfile && fromProfile.name) || from;
      const fromPhoto = (fromProfile && fromProfile.photo) || null;

      let gc = groupCalls.get(groupId);

      if (!gc) {
        // Ninguém em chamada nesse grupo ainda: eu inicio e chamo os outros.
        const callId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        gc = { callId, initiator: from, groupName: group.name, participants: new Map() };
        gc.participants.set(from, { status: 'joined', timeout: null });
        groupCalls.set(groupId, gc);

        (group.members || [])
          .filter(m => m.status === 'accepted' && m.number !== from)
          .forEach((m) => {
            const targetSocketId = onlineUsers.get(m.number);
            gc.participants.set(m.number, { status: 'ringing', timeout: null });
            if (targetSocketId) {
              io.to(targetSocketId).emit('groupcall:incoming', {
                groupId, groupName: group.name, callId, from, fromName, fromPhoto
              });
            }
            const timeout = setTimeout(() => {
              const entry = gc.participants.get(m.number);
              if (entry && entry.status === 'ringing') gc.participants.delete(m.number);
            }, CALL_RING_TIMEOUT_MS);
            gc.participants.get(m.number).timeout = timeout;
          });

        return callback({ ok: true, callId, groupName: group.name, participants: [], initiator: from, initiatorName: fromName, initiatorPhoto: fromPhoto });
      }

      // Já existe uma chamada rolando nesse grupo: entro direto, sem
      // tocar pra mim mesmo (como "entrar numa ligação em andamento").
      clearGroupCallInviteTimeout(groupId, from);
      gc.participants.set(from, { status: 'joined', timeout: null });

      const alreadyJoined = [...gc.participants.entries()]
        .filter(([num, p]) => num !== from && p.status === 'joined');

      const alreadyJoinedProfiles = await Promise.all(
        alreadyJoined.map(async ([num]) => {
          const p = await getPublicProfile(num);
          return { number: num, name: (p && p.name) || num, photo: (p && p.photo) || null };
        })
      );

      // Avisa quem já estava na chamada que eu entrei — cada um deles
      // vai esperar a MINHA oferta pra montar a conexão comigo.
      alreadyJoined.forEach(([num]) => {
        const sId = onlineUsers.get(num);
        if (sId) io.to(sId).emit('groupcall:participant-joined', { groupId, callId: gc.callId, number: from, name: fromName, photo: fromPhoto });
      });

      const initiatorProfile = gc.initiator === from ? { name: fromName, photo: fromPhoto } : await getPublicProfile(gc.initiator);
      callback({
        ok: true,
        callId: gc.callId,
        groupName: gc.groupName,
        participants: alreadyJoinedProfiles,
        initiator: gc.initiator,
        initiatorName: (initiatorProfile && initiatorProfile.name) || gc.initiator,
        initiatorPhoto: (initiatorProfile && initiatorProfile.photo) || null
      });
    });

    socket.on('groupcall:decline', (payload) => {
      const me = socketToNumber.get(socket.id);
      if (!me) return;
      const groupId = payload && payload.groupId;
      const gc = groupCalls.get(groupId);
      if (!gc) return;
      clearGroupCallInviteTimeout(groupId, me);
      gc.participants.delete(me);
    });

    // Repasse "cego" da sinalizacao WebRTC entre cada par de participantes.
    socket.on('groupcall:signal', (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false });
      const to = payload && payload.to;
      if (!to || !NUMBER_REGEX.test(to)) return callback({ ok: false, reason: 'Numero invalido.' });
      const targetSocketId = onlineUsers.get(to);
      if (targetSocketId) {
        io.to(targetSocketId).emit('groupcall:signal', {
          from: me, groupId: payload.groupId, callId: payload.callId, data: payload.data
        });
      }
      callback({ ok: true });
    });

    socket.on('groupcall:leave', (payload) => {
      const me = socketToNumber.get(socket.id);
      if (!me) return;
      const groupId = payload && payload.groupId;
      const gc = groupCalls.get(groupId);
      if (!gc) return;
      clearGroupCallInviteTimeout(groupId, me);
      gc.participants.delete(me);

      const remainingJoined = [...gc.participants.entries()].filter(([, p]) => p.status === 'joined');
      remainingJoined.forEach(([num]) => {
        const sId = onlineUsers.get(num);
        if (sId) io.to(sId).emit('groupcall:participant-left', { groupId, callId: gc.callId, number: me });
      });

      if (remainingJoined.length === 0) {
        for (const [, p] of gc.participants) { if (p.timeout) clearTimeout(p.timeout); }
        groupCalls.delete(groupId);
      }
    });

    socket.on('delete-message', async (payload, callback) => {
      if (typeof callback !== 'function') callback = () => {};
      const me = socketToNumber.get(socket.id);
      if (!me) return callback({ ok: false, reason: 'Voce nao esta registrado no servidor.' });
      const messageId = payload && payload.messageId;
      const kind = payload && payload.kind;
      if (!messageId || (kind !== 'private' && kind !== 'group')) return callback({ ok: false, reason: 'Dados invalidos.' });

      let key;
      let notifyNumbers = [];

      if (kind === 'private') {
        const withNumber = payload.withNumber;
        if (!withNumber || !NUMBER_REGEX.test(withNumber)) return callback({ ok: false, reason: 'Numero invalido.' });
        key = convKey(me, withNumber);
        notifyNumbers = [withNumber];
      } else {
        const groupId = payload.groupId;
        const g = await storage.getGroup(groupId);
        if (!g || !(await isAcceptedMemberOfGroup(groupId, me))) return callback({ ok: false, reason: 'Grupo nao encontrado ou voce nao faz parte dele.' });
        key = groupStorageKey(groupId);
        notifyNumbers = g.members.filter(m => m.status === 'accepted' && m.number !== me).map(m => m.number);
      }

      const list = await storage.getMessagesByKey(key);
      const msg = list.find(m => m.id === messageId);
      if (!msg) return callback({ ok: false, reason: 'Mensagem nao encontrada.' });
      if (msg.from !== me) return callback({ ok: false, reason: 'Voce so pode apagar mensagens que voce mesmo enviou.' });

      if (!msg.deleted) {
        deleteStoredFileFor(msg);
        await storage.markMessageDeleted(key, messageId);
      }
      notifyNumbers.forEach((number) => {
        const sId = onlineUsers.get(number);
        if (sId) io.to(sId).emit('message-deleted', { messageId });
      });
      callback({ ok: true });
    });

    socket.on('disconnect', () => {
      const number = socketToNumber.get(socket.id);
      if (number) {
        socketToNumber.delete(socket.id);
        if (onlineUsers.get(number) === socket.id) {
          onlineUsers.delete(number);

          const isInCall = [...activeCalls.values()].some(c => c.from === number || c.to === number)
            || [...groupCalls.values()].some(gc => gc.participants.has(number));

          if (isInCall) {
            // A pessoa está em chamada e a conexão caiu — mas isso pode
            // ser só o app indo pra segundo plano no celular, a tela
            // bloqueando, ou uma queda de internet rápida. Em vez de
            // encerrar a chamada (e avisar "offline") na hora, esperamos
            // um tempinho: se ela reconectar nesse meio tempo (ver
            // 'bindSocketToNumber'), a chamada continua normalmente,
            // sem ninguém perceber a queda.
            scheduleGraceDisconnect(number, socket.id);
          } else {
            broadcastPresence(number, false);
          }
        }
      }
    });
  });

  server.listen(PORT, () => {
    console.log('==================================================');
    console.log(' PAPO rodando!');
    console.log(' Feito e programado por: Kauan_hexa');
    console.log(` Modo de armazenamento: ${storage.name.toUpperCase()}`);
    console.log(` Acesse localmente em: http://localhost:${PORT}`);
    console.log(' Para outra pessoa na mesma rede acessar, use o seu IPv4');
    console.log(' (descubra com "ipconfig" no Windows) na porta ' + PORT);
    console.log('==================================================');
  });
})().catch(err => {
  console.error('FATAL: falha ao inicializar o servidor', err);
  process.exit(1);
});
