import {
  describeSystemEvent,
  formatStamp,
  normalizeAction,
  normalizeTimestamp,
  parseWsPayload,
  reduceTranscriptActions,
  actionText,
} from '../shared/stream.js';

import {
  formatAttachmentChip,
  normalizeAttachments,
} from '../shared/attachments.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
    set: (updates) => {
      state = { ...state, ...updates };
      listeners.forEach((fn) => fn(state));
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function createRemoteSessionClient({ apiBase = '', sessionId = null } = {}) {
  const store = createStore({
    sessionId,
    session: null,
    connected: false,
    busy: false,
    sending: false,
    wsCount: 0,
    queue: [],
    actions: [],
    messages: [],
    console: [],
    loadError: null,
    lastMessageId: '',
    seenMessageIds: {},
  });

  let ws = null;
  let wsToken = 0;
  let replayBuffer = [];
  let replayTimer = null;
  let hydrating = false;
  let reconnectTimer = null;
  let connectTimer = null;
  let lastConnectedSessionId = null;

  const nowIso = () => new Date().toISOString();
  const api = async (path, opts = {}) => {
    const res = await fetch(`${apiBase}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) {
      const msg = data && data.error ? data.error : res.statusText;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  };

  const clone = (obj) => ({ ...(obj || {}) });
  const getState = () => store.get();
  const setState = (updates) => store.set(updates);

  const getConsole = () => getState().console || [];
  const getActions = () => getState().actions || [];
  const getQueue = () => getState().queue || [];
  const isBusy = () => !!getState().busy;
  const isSending = () => !!getState().sending;
  const getLastMessageId = () => getState().lastMessageId || '';

  const pushConsole = (entry) => {
    const next = getConsole().slice();
    next.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: entry.timestamp || nowIso(),
      kind: entry.kind || 'event',
      source: entry.source || 'cli',
      title: entry.title || '',
      data: entry.data,
    });
    setState({ console: next.slice(-250) });
  };

  const recomputeMessages = () => {
    setState({ messages: reduceTranscriptActions(getActions()) });
  };

  const setSessionPatch = (patch) => {
    setState({ session: { ...(getState().session || { session_id: sessionId }), ...patch } });
  };

  const clearTimer = (timer) => {
    if (timer) clearTimeout(timer);
    return null;
  };

  const clearReplay = () => {
    replayBuffer = [];
    hydrating = false;
    replayTimer = clearTimer(replayTimer);
  };

  const flushReplay = () => {
    if (!hydrating) return;
    hydrating = false;
    replayTimer = clearTimer(replayTimer);
    if (replayBuffer.length) {
      ingestMessages(replayBuffer);
    }
    replayBuffer = [];
  };

  const queueReplay = (parsed) => {
    replayBuffer.push(parsed);
    replayTimer = clearTimer(replayTimer);
    replayTimer = setTimeout(flushReplay, 180);
  };

  const ingestMessages = (parsedMessages) => {
    if (!Array.isArray(parsedMessages) || !parsedMessages.length) return;
    const nextActions = getActions().slice();
    const consoleEntries = [];
    const seen = clone(getState().seenMessageIds);
    let wsCount = getState().wsCount || 0;
    let lastMessageId = getLastMessageId();

    for (const parsed of parsedMessages) {
      const payload = parsed && typeof parsed === 'object' ? parsed.payload : parsed;
      const meta = parsed && typeof parsed === 'object' ? parsed.meta : null;
      if (meta && meta.id) {
        if (seen[meta.id]) continue;
        seen[meta.id] = true;
        lastMessageId = meta.id;
        consoleEntries.push({ kind: 'ws', source: 'cli', title: `ws meta id=${meta.id}`, data: meta, timestamp: nowIso() });
      }
      wsCount += 1;
      consoleEntries.push({ kind: 'ws', source: 'cli', title: `ws message #${wsCount}`, data: payload, timestamp: nowIso() });
      nextActions.push(normalizeAction(payload, 'remote'));
    }

    setState({
      actions: nextActions,
      console: [...getConsole(), ...consoleEntries].slice(-250),
      wsCount,
      seenMessageIds: seen,
      lastMessageId,
    });
    recomputeMessages();
  };

  const connect = async ({ resume = false } = {}) => {
    disconnect();
    if (!sessionId) return;
    wsToken += 1;
    const token = wsToken;
    const proto = (globalThis.location && globalThis.location.protocol === 'https:') ? 'wss:' : 'ws:';
    const url = new URL(`${proto}//${globalThis.location ? globalThis.location.host : '127.0.0.1:8080'}/sub/${sessionId}`);
    if (resume && getLastMessageId()) {
      url.searchParams.set('last_event_id', getLastMessageId());
    }
    ws = new WebSocket(url.toString(), 'ws+meta.nchan');
    setState({ connected: false });

    ws.onopen = () => {
      if (token !== wsToken) return;
      lastConnectedSessionId = sessionId;
      setState({ connected: true });
      hydrating = true;
      replayBuffer = [];
      pushConsole({ kind: 'ws', source: 'cli', title: 'ws open', data: { session_id: sessionId } });
      replayTimer = clearTimer(replayTimer);
      replayTimer = setTimeout(flushReplay, 180);
    };

    ws.onmessage = (event) => {
      if (token !== wsToken) return;
      let payload;
      let meta = null;
      try {
        const parsed = parseWsPayload(event.data);
        meta = parsed.meta;
        payload = parsed.payload;
        if (typeof payload === 'string' && payload.trim()) {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = { type: 'assistant', content: payload };
          }
        }
      } catch {
        payload = { type: 'assistant', content: event.data };
      }
      const parsed = { payload, meta };
      if (hydrating) {
        queueReplay(parsed);
        return;
      }
      ingestMessages([parsed]);

      const msg = normalizeAction(payload, 'remote');
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        setSessionPatch({ claude_session_id: msg.session_id, status: 'running', locked: true });
        setState({ busy: true });
        return;
      }
      if (msg.type === 'result') {
        setSessionPatch({ status: 'idle', locked: false, last_finished_at: Date.now() / 1000 });
        setState({ busy: false });
        reconnectTimer = clearTimer(reconnectTimer);
        reconnectTimer = setTimeout(() => flushQueue(), 120);
      }
    };

    ws.onclose = () => {
      if (token !== wsToken) return;
      clearReplay();
      setState({ connected: false });
      pushConsole({ kind: 'ws', source: 'cli', title: 'ws close', data: { session_id: sessionId } });
      if (sessionId === lastConnectedSessionId) {
        reconnectTimer = clearTimer(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          if (sessionId === lastConnectedSessionId && !getState().connected) {
            connect({ resume: true }).catch(() => {});
          }
        }, 3000);
      }
    };

    ws.onerror = () => {
      if (token !== wsToken) return;
      setState({ connected: false });
      pushConsole({ kind: 'error', source: 'cli', title: 'ws error', data: { session_id: sessionId } });
    };
  };

  const disconnect = () => {
    replayTimer = clearTimer(replayTimer);
    reconnectTimer = clearTimer(reconnectTimer);
    connectTimer = clearTimer(connectTimer);
    hydrating = false;
    replayBuffer = [];
    wsToken += 1;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    setState({ connected: false });
  };

  const setSending = (value) => setState({ sending: value });

  const setBusy = (value) => setState({ busy: value });

  const setQueue = (queue) => setState({ queue });

  const enqueue = (turn) => {
    const next = getQueue().slice();
    const text = typeof turn === 'string' ? turn : String(turn?.text || turn?.content || '');
    next.push({
      text,
      attachments: normalizeAttachments(turn?.attachments || []),
    });
    setQueue(next);
    pushConsole({ kind: 'queue', source: 'cli', title: 'queued input', data: next[next.length - 1], timestamp: nowIso() });
  };

  const dequeue = () => {
    const next = getQueue().slice();
    const item = next.shift();
    setQueue(next);
    if (item) {
      pushConsole({ kind: 'queue', source: 'cli', title: 'dequeued input', data: item, timestamp: nowIso() });
    }
    return item;
  };

  const uploadLocalAttachment = async (filePath, mimeTypeOverride = '') => {
    if (!sessionId || !filePath) return null;
    const data = await readFile(filePath);
    const filename = path.basename(filePath);
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mimeTypeByExt = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    };
    const mimeType = mimeTypeOverride || mimeTypeByExt[ext] || 'application/octet-stream';
    const res = await api(`/api/sessions/${sessionId}/uploads`, {
      method: 'POST',
      headers: {
        'X-Filename': filename,
        'Content-Type': mimeType,
      },
      body: data,
    });
    return res.uploaded;
  };

  const flushQueue = async () => {
    if (!sessionId || !getQueue().length || isBusy() || isSending()) return;
    const next = dequeue();
    if (next) await sendTurn(next);
  };

  const sendTurn = async (turn) => {
    if (!sessionId) return false;
    if (isSending()) return false;
    const draft = typeof turn === 'string'
      ? { text: String(turn || '').trim(), attachments: [] }
      : {
          text: String(turn?.text || turn?.content || '').trim(),
          attachments: normalizeAttachments(turn?.attachments || []),
        };
    const clean = draft.text;
    if (!clean && !draft.attachments.length) return false;
    setSending(true);
    try {
      const msg = {
        type: 'turn_request',
        content: clean,
        attachments: draft.attachments.map((attachment) => attachment.serverPath).filter(Boolean),
      };
      pushConsole({ kind: 'request', source: 'cli', title: 'turn request', data: msg, timestamp: nowIso() });
      await api(`/api/sessions/${sessionId}/turn`, { method: 'POST', body: JSON.stringify(msg) });
      setSessionPatch({ status: 'running', locked: true });
      setBusy(true);
      return true;
    } catch (err) {
      if (err.status === 409) {
        enqueue(draft);
        pushConsole({ kind: 'queue', source: 'cli', title: 'busy -> queue', data: { text: clean, attachments: draft.attachments, status: err.status, message: err.message }, timestamp: nowIso() });
        return true;
      }
      pushConsole({ kind: 'error', source: 'cli', title: 'turn failed', data: { text: clean, attachments: draft.attachments, status: err.status, message: err.message }, timestamp: nowIso() });
      return false;
    } finally {
      setSending(false);
    }
  };

  const loadSession = async () => {
    if (!sessionId) return null;
    try {
      const data = await api(`/api/sessions/${sessionId}`);
      setState({ session: data, loadError: null });
      return data;
    } catch (err) {
      setState({ loadError: err.message || 'Failed to load session' });
      return null;
    }
  };

  const ensureConnected = async () => {
    await loadSession();
    await connect({ resume: !!getLastMessageId() });
  };

  const getMessages = () => getState().messages || [];

  const getCurrentSummary = () => {
    const session = getState().session;
    if (!session) return null;
    return {
      id: session.session_id,
      status: session.status,
      claude_session_id: session.claude_session_id,
      turn_count: session.turn_count,
      last_user_text: session.last_user_text,
      last_result: session.last_result,
      locked: !!session.locked,
    };
  };

  return {
    store,
    api,
    ensureConnected,
    connect,
    disconnect,
    loadSession,
    sendTurn,
    uploadLocalAttachment,
    flushQueue,
    getMessages,
    getConsole,
    getQueue,
    isBusy,
    isSending,
    getCurrentSummary,
    getLastMessageId,
    formatStamp,
    describeSystemEvent,
    actionText,
    subscribe: store.subscribe,
    getState,
  };
}

export {
  createRemoteSessionClient,
};
