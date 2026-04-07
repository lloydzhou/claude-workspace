import { marked } from 'marked';
import hljs from 'highlight.js';
import {
  formatAttachmentChip,
  normalizeAttachments,
} from '../shared/attachments.js';

function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get: () => state,
  set: (updates) => {
    state = { ...state, ...updates };
    listeners.forEach((fn) => fn(state));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('claude-hub:statechange'));
    }
  },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const store = createStore({
  sessions: [],
  currentSession: null,
  connected: false,
  ws: null,
  actionsBySession: {},
  messagesBySession: {},
  consoleBySession: {},
  wsCountBySession: {},
  queueBySession: {},
  busyBySession: {},
  sendingBySession: {},
  lastMessageIdBySession: {},
  seenMessageIdsBySession: {},
  loadError: null,
  sidebarCollapsed: false,
  consoleCollapsed: true,
  transcriptAutoFollow: true,
});

function nowIso() {
  return new Date().toISOString();
}

function generateUuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function cloneMap(map) {
  return { ...(map || {}) };
}

const CURRENT_SESSION_KEY = 'claude-hub.current-session';
const WS_REPLAY_WINDOW_MS = 180;
const wsReplayBuffers = new Map();
const wsReplayTimers = new Map();
const wsHydratingSessions = new Set();
const wsConnectTimers = new Map();
const wsReconnectTimers = new Map();
const wsSessionTokens = new Map();
let activeWsSessionId = null;

function normalizeTimestamp(value) {
  if (value == null || value === '') {
    return nowIso();
  }
  if (typeof value === 'string' && /^\d+:\d+$/.test(value)) {
    const [seconds] = value.split(':', 1);
    const ts = Number(seconds);
    if (Number.isFinite(ts)) {
      return new Date(ts * 1000).toISOString();
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    if (/^\d+:\d+$/.test(value)) {
      const [seconds] = value.split(':', 1);
      const ts = Number(seconds);
      if (Number.isFinite(ts)) {
        return new Date(ts * 1000).toISOString();
      }
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber).toISOString();
    }
  }
  return nowIso();
}

function getActions(sessionId) {
  return store.get().actionsBySession[sessionId] || [];
}

function getCurrentSession() {
  return store.get().currentSession;
}

function getMessages(sessionId) {
  return store.get().messagesBySession[sessionId] || [];
}

function getConsoleEntries(sessionId) {
  return store.get().consoleBySession[sessionId] || [];
}

function getQueue(sessionId) {
  return store.get().queueBySession[sessionId] || [];
}

function normalizeTurnDraft(input, attachments = []) {
  const text = typeof input === 'string' ? input : String(input?.text || input?.content || '');
  const normalizedAttachments = normalizeAttachments(attachments);
  return {
    text,
    attachments: normalizedAttachments,
  };
}

function formatTurnSummary(turn) {
  if (!turn) return '';
  const draft = typeof turn === 'string'
    ? normalizeTurnDraft(turn)
    : normalizeTurnDraft(turn.text || turn.content || '', turn.attachments || []);
  const parts = [];
  const text = String(draft.text || '').trim();
  if (text) {
    parts.push(text.length > 120 ? `${text.slice(0, 120)}…` : text);
  }
  if (draft.attachments.length) {
    parts.push(draft.attachments.map((attachment, idx) => formatAttachmentChip(idx + 1, attachment)).join('  '));
  }
  return parts.join('\n');
}

function getLastMessageId(sessionId) {
  return store.get().lastMessageIdBySession[sessionId] || '';
}

function getSeenMessageIds(sessionId) {
  return store.get().seenMessageIdsBySession[sessionId] || {};
}

function hasSeenMessageId(sessionId, messageId) {
  if (!sessionId || !messageId) return false;
  return !!getSeenMessageIds(sessionId)[messageId];
}

function markSeenMessageId(sessionId, messageId) {
  if (!sessionId || !messageId) return;
  const seenMessageIdsBySession = cloneMap(store.get().seenMessageIdsBySession);
  const next = { ...getSeenMessageIds(sessionId), [messageId]: true };
  seenMessageIdsBySession[sessionId] = next;
  store.set({ seenMessageIdsBySession });
}

function setLastMessageId(sessionId, messageId) {
  if (!sessionId || !messageId) return;
  const lastMessageIdBySession = cloneMap(store.get().lastMessageIdBySession);
  lastMessageIdBySession[sessionId] = messageId;
  store.set({ lastMessageIdBySession });
}

function clearReplayTimer(sessionId) {
  const timer = wsReplayTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    wsReplayTimers.delete(sessionId);
  }
}

function clearReplayState(sessionId) {
  if (!sessionId) return;
  clearReplayTimer(sessionId);
  wsReplayBuffers.delete(sessionId);
  wsHydratingSessions.delete(sessionId);
}

function clearSeenMessageIds(sessionId) {
  if (!sessionId) return;
  const seenMessageIdsBySession = cloneMap(store.get().seenMessageIdsBySession);
  delete seenMessageIdsBySession[sessionId];
  store.set({ seenMessageIdsBySession });
}

function clearConnectTimer(sessionId) {
  const timer = wsConnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    wsConnectTimers.delete(sessionId);
  }
}

function clearReconnectTimer(sessionId) {
  const timer = wsReconnectTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    wsReconnectTimers.delete(sessionId);
  }
}

function scheduleConnect(sessionId, opts = {}, delay = 120) {
  if (!sessionId) return;
  clearConnectTimer(sessionId);
  const timer = setTimeout(() => {
    wsConnectTimers.delete(sessionId);
    connectWS(sessionId, opts);
  }, delay);
  wsConnectTimers.set(sessionId, timer);
}

function nextWsToken(sessionId) {
  const next = (wsSessionTokens.get(sessionId) || 0) + 1;
  wsSessionTokens.set(sessionId, next);
  return next;
}

function currentWsToken(sessionId) {
  return wsSessionTokens.get(sessionId) || 0;
}

function beginReplayWindow(sessionId) {
  if (!sessionId) return;
  wsHydratingSessions.add(sessionId);
  wsReplayBuffers.set(sessionId, []);
  clearReplayTimer(sessionId);
  const timer = setTimeout(() => {
    flushReplayWindow(sessionId);
  }, WS_REPLAY_WINDOW_MS);
  wsReplayTimers.set(sessionId, timer);
}

function flushReplayWindow(sessionId) {
  if (!sessionId || !wsHydratingSessions.has(sessionId)) return;
  clearReplayTimer(sessionId);
  const buffer = wsReplayBuffers.get(sessionId) || [];
  wsReplayBuffers.delete(sessionId);
  wsHydratingSessions.delete(sessionId);
  if (!buffer.length) return;
  ingestIncomingMessages(sessionId, buffer);
}

function queueReplayMessage(sessionId, parsed) {
  if (!sessionId) return;
  const buffer = wsReplayBuffers.get(sessionId) || [];
  buffer.push(parsed);
  wsReplayBuffers.set(sessionId, buffer);
  clearReplayTimer(sessionId);
  const timer = setTimeout(() => {
    flushReplayWindow(sessionId);
  }, WS_REPLAY_WINDOW_MS);
  wsReplayTimers.set(sessionId, timer);
}

function isBusy(sessionId) {
  return !!store.get().busyBySession[sessionId];
}

function getWsCount(sessionId) {
  return store.get().wsCountBySession[sessionId] || 0;
}

function setTranscriptAutoFollow(value) {
  const next = !!value;
  if (store.get().transcriptAutoFollow === next) return;
  store.set({ transcriptAutoFollow: next });
}

function scrollTranscriptToLatest() {
  setTranscriptAutoFollow(true);
}

function isSending(sessionId) {
  return !!store.get().sendingBySession[sessionId];
}

function setSending(sessionId, value) {
  const sendingBySession = cloneMap(store.get().sendingBySession);
  sendingBySession[sessionId] = value;
  store.set({ sendingBySession });
}

function pushConsole(sessionId, entry) {
  const consoleBySession = cloneMap(store.get().consoleBySession);
  const next = getConsoleEntries(sessionId).slice();
  next.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: entry.timestamp || nowIso(),
    kind: entry.kind || 'event',
    source: entry.source || 'ui',
    title: entry.title || '',
    data: entry.data,
  });
  consoleBySession[sessionId] = next.slice(-250);
  store.set({ consoleBySession });
}

function setBusy(sessionId, value) {
  const busyBySession = cloneMap(store.get().busyBySession);
  busyBySession[sessionId] = value;
  store.set({ busyBySession });
}

function bumpWsCount(sessionId) {
  const wsCountBySession = cloneMap(store.get().wsCountBySession);
  const next = (wsCountBySession[sessionId] || 0) + 1;
  wsCountBySession[sessionId] = next;
  store.set({ wsCountBySession });
  return next;
}

function toggleConsoleCollapsed() {
  const next = !store.get().consoleCollapsed;
  store.set({ consoleCollapsed: next });
}

function toggleSidebarCollapsed() {
  const next = !store.get().sidebarCollapsed;
  store.set({ sidebarCollapsed: next });
}

function clearConsole(sessionId) {
  if (!sessionId) return;
  const consoleBySession = cloneMap(store.get().consoleBySession);
  consoleBySession[sessionId] = [];
  store.set({ consoleBySession });
}

function extractTextValue(value) {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(extractTextValue).filter(Boolean).join('');
  }
  if (typeof value === 'object') {
    const parts = [];
    if (typeof value.text === 'string') parts.push(value.text);
    if (typeof value.content === 'string') parts.push(value.content);
    if (Array.isArray(value.content)) parts.push(extractTextValue(value.content));
    if (typeof value.delta === 'string') parts.push(value.delta);
    if (value.delta && typeof value.delta === 'object') parts.push(extractTextValue(value.delta));
    if (typeof value.result === 'string') parts.push(value.result);
    if (typeof value.error === 'string') parts.push(value.error);
    if (typeof value.message === 'object') parts.push(extractTextValue(value.message));
    return parts.filter(Boolean).join('');
  }
  return '';
}

function getAssistantContentBlocks(action) {
  if (!action || typeof action !== 'object') return [];
  const candidates = [
    action.content,
    action.raw && action.raw.content,
    action.message && action.message.content,
    action.raw && action.raw.message && action.raw.message.content,
  ];
  for (const blocks of candidates) {
    if (Array.isArray(blocks) && blocks.length) return blocks;
  }
  return [];
}

function extractThinkingText(action) {
  const blocks = getAssistantContentBlocks(action);
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || block.type !== 'thinking') continue;
    const text = typeof block.thinking === 'string'
      ? block.thinking
      : (typeof block.text === 'string' ? block.text : extractTextValue(block.content));
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function normalizeAction(payload, source = 'remote') {
  if (!payload || typeof payload !== 'object') {
    return {
      type: 'assistant',
      content: typeof payload === 'string' ? payload : String(payload || ''),
      timestamp: nowIso(),
      source,
      raw: payload,
    };
  }

  return {
    ...payload,
    type: payload.type || 'assistant',
    subtype: payload.subtype,
    content: payload.content,
    error: payload.error,
    result: payload.result,
    session_id: payload.session_id,
    pid: payload.pid,
    is_error: payload.is_error,
    timestamp: normalizeTimestamp(payload.timestamp),
    source,
    raw: payload,
  };
}

function actionText(action) {
  if (!action || typeof action !== 'object') {
    return '';
  }
  // Handle assistant messages with content blocks (tool_use, text, thinking, etc)
  if (action.type === 'assistant') {
    const blocks = getAssistantContentBlocks(action);
    const textParts = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (textParts.length) return textParts.join('');
  }
  const direct = extractTextValue(action.content);
  if (direct) return direct;
  if (action.type === 'result') {
    return extractTextValue(action.result);
  }
  if (action.type === 'system') {
    return extractTextValue(action.error) || extractTextValue(action.content);
  }
  if (action.message) {
    return extractTextValue(action.message);
  }
  return '';
}

function getToolUseBlocks(action) {
  if (!action || typeof action !== 'object') return [];
  if (action.type === 'assistant' && Array.isArray(action.content)) {
    return action.content.filter(b => b.type === 'tool_use');
  }
  if (action.raw && typeof action.raw === 'object' && Array.isArray(action.raw.content)) {
    return action.raw.content.filter(b => b.type === 'tool_use');
  }
}

function getToolResultBlocks(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'user' && Array.isArray(action.content)) {
    return action.content.filter(b => b.tool_result_id !== undefined);
  }
  if (action.raw && typeof action.raw === 'object' && Array.isArray(action.raw.content)) {
    return action.raw.content.filter(b => b.tool_result_id !== undefined);
  }
}

function getThinkingBlocks(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'assistant' && Array.isArray(action.content)) {
    return action.content.filter(b => b.type === 'thinking');
  }
  if (action.raw && typeof action.raw === 'object' && Array.isArray(action.raw.content)) {
    return action.raw.content.filter(b => b.type === 'thinking');
  }
}

function isLikelyJsonText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (!(value.startsWith('{') || value.startsWith('['))) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isLikelyToolCall(action, text) {
  const value = String(text || '').trim();
  if (!value) return false;

  if (action && action.type === 'assistant') {
    if (isLikelyJsonText(value)) return true;
    if (/^\{.*\}$/.test(value) && /query|search|tool/i.test(value)) return true;
  }

  return false;
}

function isLikelyToolResult(action, text) {
  const value = String(text || '').trim();
  if (!value) return false;

  if (action && action.type === 'user') {
    if (/^Web search results for query:/i.test(value)) return true;
    if (/^Tool (result|output):/i.test(value)) return true;
    if (/^Search results:/i.test(value)) return true;
  }

  return false;
}

function isAssistantBoundary(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.type === 'result') return true;
  if (action.type !== 'assistant') return false;
  const subtype = String(action.subtype || '').toLowerCase();
  return subtype.includes('stop') || subtype.includes('done') || subtype.includes('complete') || subtype.includes('final');
}

function reduceTranscriptActions(actions) {
  const extractStreamEvent = (action) => {
    if (!action || typeof action !== 'object') return null;
    if (action.raw && typeof action.raw === 'object' && action.raw.event) {
      return action.raw.event;
    }
    if (action.event && typeof action.event === 'object') {
      return action.event;
    }
    if (action.content && typeof action.content === 'object' && action.content.event) {
      return action.content.event;
    }
    return null;
  };

  const messages = [];
  let assistantDraft = null;
  let thinkingDraft = null;
  let toolDraft = null;
  let activeStreamBlockKind = null;
  const hasStreamEvent = actions.some((action) => !!extractStreamEvent(action));

  const pushMessage = (message) => {
    messages.push(message);
    return message;
  };

  const startAssistant = (timestamp) => {
    if (assistantDraft) {
      return assistantDraft;
    }
    assistantDraft = pushMessage({
      id: `assistant-${messages.length}-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: timestamp || nowIso(),
      pending: true,
    });
    return assistantDraft;
  };

  const appendAssistantText = (text, timestamp) => {
    if (!text) return;
    const assistant = startAssistant(timestamp);
    assistant.content += text;
    assistant.timestamp = timestamp || assistant.timestamp || nowIso();
    assistant.pending = true;
  };

  const startThinking = (timestamp) => {
    if (thinkingDraft) return thinkingDraft;
    finalizeAssistant();
    thinkingDraft = pushMessage({
      id: `thinking-${messages.length}-${Date.now()}`,
      role: 'assistant',
      kind: 'thinking',
      content: '',
      timestamp: timestamp || nowIso(),
      pending: true,
    });
    return thinkingDraft;
  };

  const appendThinkingText = (text, timestamp) => {
    if (!text) return;
    const thinking = startThinking(timestamp);
    thinking.content += text;
    thinking.timestamp = timestamp || thinking.timestamp || nowIso();
    thinking.pending = true;
  };

  const startToolUse = (timestamp, toolBlock = null) => {
    if (toolDraft) return toolDraft;
    finalizeAssistant();
    finalizeThinking();
    toolDraft = pushMessage({
      id: `tool-${messages.length}-${Date.now()}`,
      role: 'tool',
      kind: 'tool_use',
      tool_name: toolBlock && toolBlock.name ? toolBlock.name : '',
      content: '',
      timestamp: timestamp || nowIso(),
      pending: true,
    });
    return toolDraft;
  };

  const appendToolInput = (text, timestamp) => {
    if (!text) return;
    const tool = startToolUse(timestamp);
    tool.content += text;
    tool.timestamp = timestamp || tool.timestamp || nowIso();
    tool.pending = true;
  };

  const finalizeToolUse = () => {
    if (toolDraft) {
      if (!String(toolDraft.content || '').trim()) {
        messages.pop();
      } else {
        toolDraft.pending = false;
      }
      toolDraft = null;
    }
  };

  const finalizeThinking = () => {
    if (thinkingDraft) {
      if (!String(thinkingDraft.content || '').trim()) {
        messages.pop();
      } else {
        thinkingDraft.pending = false;
      }
      thinkingDraft = null;
    }
  };

  const finalizeAssistant = () => {
    if (assistantDraft) {
      if (!String(assistantDraft.content || '').trim()) {
        messages.pop();
      } else {
        assistantDraft.pending = false;
      }
      assistantDraft = null;
    }
  };

  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }

    if (action.type === 'user') {
      const text = actionText(action);
      if (!text) {
        continue;
      }
      finalizeAssistant();
      pushMessage({
        id: `user-${messages.length}-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: action.timestamp || nowIso(),
      });
      continue;
    }

    const ev = extractStreamEvent(action);
    if (ev) {
      const stamp = action.timestamp || nowIso();

      if (ev.type === 'content_block_start' && ev.content_block) {
        activeStreamBlockKind = ev.content_block.type || null;
        if (activeStreamBlockKind === 'thinking') {
          startThinking(stamp);
        } else if (activeStreamBlockKind === 'tool_use') {
          startToolUse(stamp, ev.content_block);
        }
        continue;
      }

      if (ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'thinking_delta' || typeof ev.delta.thinking === 'string') {
          appendThinkingText(ev.delta.thinking || ev.delta.text || '', stamp);
          continue;
        }
        if (ev.delta.type === 'input_json_delta' || typeof ev.delta.partial_json === 'string') {
          appendToolInput(ev.delta.partial_json || ev.delta.text || '', stamp);
          continue;
        }
        if (typeof ev.delta.text === 'string') {
          appendAssistantText(ev.delta.text, stamp);
          continue;
        }
        if (typeof ev.delta.partial_json === 'string') {
          appendAssistantText(ev.delta.partial_json, stamp);
          continue;
        }
      }

      if (ev.type === 'message_delta' && ev.delta) {
        if (ev.delta.type === 'thinking_delta' || typeof ev.delta.thinking === 'string') {
          appendThinkingText(ev.delta.thinking || ev.delta.text || '', stamp);
          continue;
        }
        if (ev.delta.type === 'input_json_delta' || typeof ev.delta.partial_json === 'string') {
          appendToolInput(ev.delta.partial_json || ev.delta.text || '', stamp);
          continue;
        }
        if (typeof ev.delta.text === 'string') {
          appendAssistantText(ev.delta.text, stamp);
        }
        continue;
      }

      if (ev.type === 'text_delta' && typeof ev.text === 'string') {
        appendAssistantText(ev.text, stamp);
        continue;
      }

      if (ev.type === 'content_block_stop') {
        if (activeStreamBlockKind === 'thinking') {
          finalizeThinking();
        } else if (activeStreamBlockKind === 'tool_use') {
          finalizeToolUse();
        } else {
          finalizeAssistant();
        }
        activeStreamBlockKind = null;
        continue;
      }

      if (ev.type === 'message_stop') {
        finalizeThinking();
        finalizeToolUse();
        finalizeAssistant();
        activeStreamBlockKind = null;
        continue;
      }
    }

    if (action.type === 'assistant') {
      if (hasStreamEvent) {
        continue;
      }
      const blocks = getAssistantContentBlocks(action);
      if (blocks.length) {
        const stamp = action.timestamp || nowIso();
        let sawBlock = false;
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'thinking') {
            const text = typeof block.thinking === 'string'
              ? block.thinking
              : (typeof block.text === 'string' ? block.text : extractTextValue(block.content));
            if (text) {
              finalizeAssistant();
              pushMessage({
                id: `thinking-${messages.length}-${Date.now()}`,
                role: 'assistant',
                kind: 'thinking',
                content: text,
                timestamp: stamp,
                pending: false,
              });
              sawBlock = true;
            }
            continue;
          }
          if (block.type === 'tool_use') {
            finalizeAssistant();
            finalizeThinking();
            const toolContent = {
              name: block.name || 'tool',
              input: block.input && typeof block.input === 'object' ? block.input : {},
            };
            pushMessage({
              id: `tool-${messages.length}-${Date.now()}`,
              role: 'tool',
              kind: 'tool_use',
              tool_name: block.name || 'tool',
              content: JSON.stringify(toolContent, null, 2),
              timestamp: stamp,
              pending: false,
            });
            sawBlock = true;
            continue;
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            appendAssistantText(block.text, stamp);
            sawBlock = true;
          }
        }
        if (sawBlock) {
          continue;
        }
      }
      const text = actionText(action);
      if (text) {
        appendAssistantText(text, action.timestamp || nowIso());
      }
      continue;
    }

    if (action.type === 'result') {
      finalizeAssistant();
      continue;
    }

    if (action.type === 'stderr') {
      finalizeAssistant();
      messages.push({
        id: `stderr-${messages.length}-${Date.now()}`,
        role: 'error',
        kind: 'stderr',
        content: actionText(action) || 'stderr',
        timestamp: action.timestamp || nowIso(),
      });
      continue;
    }

    if (action.type === 'system') {
      if (action.subtype === 'init') {
        continue;
      }
    }
  }

  return messages;
}

function recomputeMessages(sessionId) {
  const messagesBySession = cloneMap(store.get().messagesBySession);
  const actions = getActions(sessionId);
  messagesBySession[sessionId] = reduceTranscriptActions(actions);
  store.set({ messagesBySession });
}

function clearLogs(sessionId) {
  const actionsBySession = cloneMap(store.get().actionsBySession);
  const messagesBySession = cloneMap(store.get().messagesBySession);
  const consoleBySession = cloneMap(store.get().consoleBySession);
  const wsCountBySession = cloneMap(store.get().wsCountBySession);
  const lastMessageIdBySession = cloneMap(store.get().lastMessageIdBySession);
  const seenMessageIdsBySession = cloneMap(store.get().seenMessageIdsBySession);
  actionsBySession[sessionId] = [];
  messagesBySession[sessionId] = [];
  consoleBySession[sessionId] = [];
  wsCountBySession[sessionId] = 0;
  delete lastMessageIdBySession[sessionId];
  delete seenMessageIdsBySession[sessionId];
  store.set({ actionsBySession, messagesBySession, consoleBySession, wsCountBySession, lastMessageIdBySession, seenMessageIdsBySession });
}

function appendLog(sessionId, entry) {
  const actionsBySession = cloneMap(store.get().actionsBySession);
  const next = getActions(sessionId).slice();
  const normalized = normalizeAction({
    timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() / 1000 : undefined,
    ...entry,
  }, entry.source || 'remote');
  next.push(normalized);
  actionsBySession[sessionId] = next;
  store.set({ actionsBySession });
  pushConsole(sessionId, {
    kind: 'action',
    source: normalized.source || 'remote',
    title: `${normalized.type || 'event'}${normalized.subtype ? `:${normalized.subtype}` : ''}`,
    data: normalized,
    timestamp: normalized.timestamp,
  });
  recomputeMessages(sessionId);
}

function ingestIncomingMessages(sessionId, parsedMessages) {
  if (!Array.isArray(parsedMessages) || !parsedMessages.length) {
    return;
  }

  const actionsBySession = cloneMap(store.get().actionsBySession);
  const next = getActions(sessionId).slice();
  const consoleEntries = [];

  for (const parsed of parsedMessages) {
    const payload = parsed && typeof parsed === 'object' ? parsed.payload : parsed;
    const meta = parsed && typeof parsed === 'object' ? parsed.meta : null;

    if (meta && meta.id) {
      if (hasSeenMessageId(sessionId, meta.id)) {
        continue;
      }
      markSeenMessageId(sessionId, meta.id);
      setLastMessageId(sessionId, meta.id);
      consoleEntries.push({
        kind: 'ws',
        source: 'browser',
        title: `ws meta id=${meta.id}`,
        data: meta,
        timestamp: nowIso(),
      });
    }

    const count = bumpWsCount(sessionId);
    consoleEntries.push({
      kind: 'ws',
      source: 'browser',
      title: `ws message #${count}`,
      data: payload,
      timestamp: nowIso(),
    });

    const msg = normalizeIncoming(
      meta && meta.id
        ? { ...payload, message_id: meta.id, timestamp: meta.id }
        : payload,
    );
    next.push(msg);
  }

  actionsBySession[sessionId] = next;
  store.set({ actionsBySession });

  const consoleBySession = cloneMap(store.get().consoleBySession);
  const existing = getConsoleEntries(sessionId).slice();
  existing.push(...consoleEntries);
  consoleBySession[sessionId] = existing.slice(-250);
  store.set({ consoleBySession });

  recomputeMessages(sessionId);
}

function removeActionById(sessionId, actionId) {
  if (!actionId) return;
  const actionsBySession = cloneMap(store.get().actionsBySession);
  const next = getActions(sessionId).filter((action) => action.id !== actionId);
  actionsBySession[sessionId] = next;
  store.set({ actionsBySession });
  recomputeMessages(sessionId);
}

function replaceActions(sessionId, nextActions) {
  const actionsBySession = cloneMap(store.get().actionsBySession);
  actionsBySession[sessionId] = nextActions.slice();
  store.set({ actionsBySession });
  recomputeMessages(sessionId);
}

function enqueue(sessionId, turn) {
  const queueBySession = cloneMap(store.get().queueBySession);
  const next = getQueue(sessionId).slice();
  next.push(normalizeTurnDraft(turn?.text || turn?.content || turn || '', turn?.attachments || []));
  queueBySession[sessionId] = next;
  store.set({ queueBySession });
  pushConsole(sessionId, {
    kind: 'queue',
    source: 'ui',
    title: 'queued input',
    data: next[next.length - 1],
  });
}

function dequeue(sessionId) {
  const queueBySession = cloneMap(store.get().queueBySession);
  const next = getQueue(sessionId).slice();
  const item = next.shift();
  queueBySession[sessionId] = next;
  store.set({ queueBySession });
  if (item) {
    pushConsole(sessionId, {
      kind: 'queue',
      source: 'ui',
      title: 'dequeued input',
      data: item,
    });
  }
  return item;
}

async function uploadAttachment(sessionId, file) {
  if (!sessionId || !file) {
    return null;
  }
  const body = file instanceof Blob ? file : new Blob([file]);
  const filename = file.name || file.filename || 'attachment';
  const mimeType = file.type || file.mimeType || 'application/octet-stream';
  const res = await fetch(`/api/sessions/${sessionId}/uploads`, {
    method: 'POST',
    headers: {
      'X-Filename': filename,
      'Content-Type': mimeType,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.error ? data.error : res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data.uploaded;
}

function setSessionStatus(sessionId, patch) {
  const sessions = store.get().sessions.slice();
  const idx = sessions.findIndex((s) => s.session_id === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], ...patch };
    store.set({ sessions });
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
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
}

function formatShortId(id) {
  return id ? id.slice(0, 8) : '--------';
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Markdown rendering ─────────────────────────── */
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

function hasMarkdownSyntax(s) {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

function renderMarkdown(text) {
  if (!text || !text.trim()) return '';
  if (typeof marked === 'undefined' || !hasMarkdownSyntax(text)) {
    return escapeHtml(text);
  }
  try {
    return marked.parse(text, { async: false, breaks: true, gfm: true });
  } catch {
    return escapeHtml(text);
  }
}

function highlightCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });
}

function detectToolType(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const input = obj.input && typeof obj.input === 'object' ? obj.input : obj;
  const toolName = String(obj.name || '').toLowerCase();
  if (toolName === 'read') return 'read';
  if (toolName === 'bash') return 'bash';
  if (toolName === 'write') return 'write';
  if (toolName === 'edit') return 'edit';
  if (toolName === 'glob') return 'glob';
  if (toolName === 'grep') return 'grep';
  if (toolName === 'search') return 'search';
  if (input.command !== undefined) return 'bash';
  if ((input.file_path || input.path) && (input.content !== undefined || input.new_string !== undefined)) return 'write';
  if ((input.file_path || input.path) && (input.old_string !== undefined)) return 'edit';
  if (input.pattern !== undefined && (input.glob !== undefined)) return 'glob';
  if (input.pattern !== undefined) return 'grep';
  if ((input.file_path || input.path) && !input.content && !input.old_string && !input.new_string) return 'read';
  if (input.query !== undefined || input.search !== undefined) return 'search';
  return null;
}

function truncateStr(s, maxLen) {
  if (!s) return '';
  s = String(s);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

function renderToolBody(body) {
  if (!body || !body.trim()) return '';

  try {
    const obj = JSON.parse(body);
    const toolType = detectToolType(obj);
    const input = obj.input && typeof obj.input === 'object' ? obj.input : obj;
    const lines = [];
    const extraFields = [];

    switch (toolType) {
      case 'bash': {
        lines.push(`<code>${escapeHtml(truncateStr(input.command, 160))}</code>`);
        if (input.description) {
          lines.push(`<span class="tool-label">desc</span> ${escapeHtml(truncateStr(input.description, 120))}`);
        }
        const extra = Object.entries(input).filter(([k]) => !['command','description'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      case 'write': {
        const filePath = input.file_path || input.path || '';
        const content = input.content || input.new_string || '';
        const lineCount = content.split('\n').length;
        lines.push(`<code>${escapeHtml(truncateStr(filePath, 120))}</code> <span class="tool-label">${lineCount} line${lineCount !== 1 ? 's' : ''}</span>`);
        const extra = Object.entries(input).filter(([k]) => !['file_path','path','content','new_string'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      case 'edit': {
        const filePath = input.file_path || input.path || '';
        lines.push(`<code>${escapeHtml(truncateStr(filePath, 120))}</code>`);
        if (input.old_string) {
          lines.push(`<span class="tool-label">old</span> <code>${escapeHtml(truncateStr(input.old_string, 80))}</code>`);
        }
        if (input.new_string) {
          lines.push(`<span class="tool-label">new</span> <code>${escapeHtml(truncateStr(input.new_string, 80))}</code>`);
        }
        const extra = Object.entries(input).filter(([k]) => !['file_path','path','old_string','new_string','replace_all'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      case 'read': {
        const filePath = input.file_path || input.path || '';
        lines.push(`<code>${escapeHtml(truncateStr(filePath, 120))}</code>`);
        const extra = Object.entries(input).filter(([k]) => !['file_path','path','offset','limit'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      case 'glob': {
        lines.push(`<span class="tool-label">pattern</span> <code>${escapeHtml(truncateStr(input.pattern, 80))}</code>`);
        if (input.path) {
          lines.push(`<span class="tool-label">path</span> <code>${escapeHtml(truncateStr(input.path, 80))}</code>`);
        }
        const extra = Object.entries(input).filter(([k]) => !['pattern','path','glob'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      case 'grep': {
        lines.push(`<span class="tool-label">pattern</span> <code>${escapeHtml(truncateStr(input.pattern, 80))}</code>`);
        if (input.path) {
          lines.push(`<span class="tool-label">path</span> <code>${escapeHtml(truncateStr(input.path, 80))}</code>`);
        }
        const extra = Object.entries(input).filter(([k]) => !['pattern','path','output_mode','glob','type','context','head_limit','offset','-i'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      case 'search': {
        lines.push(`<code>${escapeHtml(truncateStr(input.query || input.search, 120))}</code>`);
        const extra = Object.entries(input).filter(([k]) => !['query','search'].includes(k));
        if (extra.length) extraFields.push(...extra);
        break;
      }
      default: {
        const parts = [];
        for (const [key, val] of Object.entries(input)) {
          parts.push(`<span class="tool-label">${escapeHtml(key)}</span> ${escapeHtml(truncateStr(typeof val === 'string' ? val : JSON.stringify(val), 120))}`);
        }
        if (parts.length) {
          lines.push(...parts);
        }
        break;
      }
    }

    if (extraFields.length) {
      lines.push(`<details><summary>params (${extraFields.length})</summary><pre>${escapeHtml(JSON.stringify(Object.fromEntries(extraFields), null, 2))}</pre></details>`);
    }

    return { html: `<div class="message-body tool-body">${lines.join('<br>')}</div>`, toolType: toolType || 'tool' };
  } catch {
    if (/^Web search results for query:/i.test(body)) {
      return { html: `<div class="message-body tool-body"><span class="tool-label">search</span> ${escapeHtml(body)}</div>`, toolType: 'search' };
    }
    if (/^Tool (result|output):/i.test(body)) {
      return { html: `<div class="message-body tool-body"><span class="tool-label">result</span> ${escapeHtml(body)}</div>`, toolType: 'result' };
    }
    return { html: `<pre class="message-body">${escapeHtml(body)}</pre>`, toolType: null };
  }
}

function describeSystemEvent(msg) {
  if (msg.subtype === 'init') {
    return `init session=${msg.session_id || 'unknown'}`;
  }
  if (msg.type === 'result') {
    return msg.is_error ? `result error: ${msg.result || 'unknown'}` : (msg.result || 'completed');
  }
  return msg.content || 'system event';
}

function normalizeIncoming(msg) {
  if (!msg || typeof msg !== 'object') {
    return {
      type: 'assistant',
      content: typeof msg === 'string' ? msg : String(msg || ''),
      timestamp: nowIso(),
    };
  }
  return {
    ...msg,
    type: msg.type || 'assistant',
    subtype: msg.subtype,
    content: msg.content ?? msg.error ?? '',
    message_id: msg.message_id || msg.id || '',
    timestamp: normalizeTimestamp(msg.message_id || msg.id || msg.timestamp),
    session_id: msg.session_id,
    pid: msg.pid,
    reason: msg.reason,
    status: msg.status,
    error: msg.error,
    result: msg.result,
    is_error: msg.is_error,
    event: msg.event,
    message: msg.message,
    source: msg.source,
    local: msg.local,
    id: msg.id,
    raw: msg,
  };
}

async function loadSessions() {
  const data = await api('/api/sessions');
  const sessions = (data.sessions || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  store.set({ sessions, loadError: null });
  if (!store.get().currentSession) {
    const persisted = localStorage.getItem(CURRENT_SESSION_KEY);
    if (persisted) {
      const found = sessions.find((s) => s.session_id === persisted);
      if (found) {
        selectSession(found.session_id, { connect: true });
      }
    }
  }
}

async function createSession() {
  const data = await api('/api/sessions', { method: 'POST' });
  selectSession(data.session_id, { connect: false });
  await loadSessions();
  selectSession(data.session_id, { connect: true });
  clearLogs(data.session_id);
}

async function deleteCurrentSession() {
  const sid = store.get().currentSession;
  if (!sid) return;
  if (!confirm(`Delete session ${sid}?`)) return;
  try {
    await api(`/api/sessions/${sid}`, { method: 'DELETE' });
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
    return;
  }
  const sessions = store.get().sessions.filter((s) => s.session_id !== sid);
  const next = sessions[0] ? sessions[0].session_id : null;
  disconnectWS();
  clearSeenMessageIds(sid);
  store.set({ sessions, currentSession: next });
  if (next) {
    localStorage.setItem(CURRENT_SESSION_KEY, next);
  } else {
    localStorage.removeItem(CURRENT_SESSION_KEY);
  }
  if (next) {
    connectWS(next);
  }
}

function selectSession(sessionId, opts = {}) {
  const connect = opts.connect !== false;
  const current = store.get().currentSession;
  if (sessionId && current === sessionId && store.get().ws && connect) {
    return;
  }
  if (!sessionId && !current) {
    return;
  }
  if (current && current !== sessionId) {
    clearConnectTimer(current);
    clearReconnectTimer(current);
  }
  if (activeWsSessionId && activeWsSessionId !== sessionId) {
    disconnectWS(activeWsSessionId);
  }
  store.set({ currentSession: sessionId || null });
  setTranscriptAutoFollow(true);
  if (sessionId) {
    localStorage.setItem(CURRENT_SESSION_KEY, sessionId);
  } else {
    localStorage.removeItem(CURRENT_SESSION_KEY);
  }
  if (connect && sessionId) {
    const resume = !!getLastMessageId(sessionId);
    scheduleConnect(sessionId, { resume }, 120);
  } else {
    disconnectWS(sessionId);
  }
}

function disconnectWS(sessionId = activeWsSessionId) {
  const ws = store.get().ws;
  const sid = sessionId || activeWsSessionId || store.get().currentSession;
  clearConnectTimer(sid);
  clearReconnectTimer(sid);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  if (sid) {
    wsSessionTokens.set(sid, (wsSessionTokens.get(sid) || 0) + 1);
  }
  clearReplayState(sid);
  if (activeWsSessionId === sid) {
    activeWsSessionId = null;
  }
  store.set({ ws: null, connected: false });
}

function parseWsPayload(raw) {
  if (typeof raw !== 'string') {
    return { meta: null, payload: raw };
  }

  if (!raw.startsWith('id:') && !raw.startsWith('content-type:')) {
    return { meta: null, payload: raw };
  }

  const parts = raw.split(/\r?\n\r?\n/);
  const head = parts.shift() || '';
  const body = parts.join('\n\n');
  const meta = {};
  head.split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  });
  return { meta, payload: body };
}

function connectWS(sessionId, opts = {}) {
  disconnectWS(activeWsSessionId);
  if (!sessionId) return;
  clearReconnectTimer(sessionId);
  const wsToken = nextWsToken(sessionId);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const resume = !!opts.resume;
  const lastMessageId = resume ? getLastMessageId(sessionId) : '';
  const url = new URL(`${proto}//${location.host}/sub/${sessionId}`);
  if (resume && lastMessageId) {
    url.searchParams.set('last_event_id', lastMessageId);
  }
  const ws = new WebSocket(url.toString(), 'ws+meta.nchan');

  ws.onopen = () => {
    if (currentWsToken(sessionId) !== wsToken) return;
    activeWsSessionId = sessionId;
    store.set({ connected: true, ws });
    beginReplayWindow(sessionId);
    if (sessionId) {
      pushConsole(sessionId, {
        kind: 'ws',
        source: 'browser',
        title: 'ws open',
        data: { session_id: sessionId },
      });
    }
  };

  ws.onmessage = (event) => {
    if (currentWsToken(sessionId) !== wsToken) return;
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
    if (wsHydratingSessions.has(sessionId)) {
      queueReplayMessage(sessionId, parsed);
      return;
    }
    ingestIncomingMessages(sessionId, [parsed]);

    const msg = normalizeIncoming(payload);
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      setSessionStatus(sessionId, {
        claude_session_id: msg.session_id,
        status: 'running',
        locked: true,
      });
      setBusy(sessionId, true);
      return;
    }

    if (msg.type === 'result') {
      setSessionStatus(sessionId, {
        status: 'idle',
        locked: false,
        last_finished_at: Date.now() / 1000,
      });
      setBusy(sessionId, false);
      setTimeout(() => flushQueue(sessionId), 120);
      return;
    }
  };

  ws.onclose = () => {
    if (currentWsToken(sessionId) !== wsToken) return;
    clearReplayState(sessionId);
    clearConnectTimer(sessionId);
    if (activeWsSessionId === sessionId) {
      activeWsSessionId = null;
    }
    store.set({ connected: false, ws: null });
    if (sessionId) {
      pushConsole(sessionId, {
        kind: 'ws',
        source: 'browser',
        title: 'ws close',
        data: { session_id: sessionId },
      });
    }
    if (store.get().currentSession === sessionId) {
      clearReconnectTimer(sessionId);
      const timer = setTimeout(() => {
        wsReconnectTimers.delete(sessionId);
        if (store.get().currentSession === sessionId && !store.get().ws) {
          connectWS(sessionId, { resume: true });
        }
      }, 3000);
      wsReconnectTimers.set(sessionId, timer);
    }
  };

  ws.onerror = () => {
    if (currentWsToken(sessionId) !== wsToken) return;
    store.set({ connected: false });
    if (sessionId) {
      pushConsole(sessionId, {
        kind: 'error',
        source: 'browser',
        title: 'ws error',
        data: { session_id: sessionId },
      });
    }
  };
}

async function dispatchTurn(sessionId, turn) {
  const draft = normalizeTurnDraft(turn?.text || turn?.content || turn || '', turn?.attachments || []);
  const msg = {
    type: 'turn_request',
    content: draft.text,
    attachments: draft.attachments.map((attachment) => attachment.serverPath).filter(Boolean),
  };

  if (isSending(sessionId)) {
    return false;
  }

  setSending(sessionId, true);
  try {
    pushConsole(sessionId, {
      kind: 'request',
      source: 'browser',
      title: 'turn request',
      data: msg,
    });
    await api(`/api/sessions/${sessionId}/turn`, {
      method: 'POST',
      body: JSON.stringify(msg),
    });
    setSessionStatus(sessionId, { status: 'running', locked: true });
    setBusy(sessionId, true);
    return true;
  } catch (err) {
    if (err.status === 409) {
      enqueue(sessionId, draft);
      pushConsole(sessionId, {
        kind: 'queue',
        source: 'browser',
        title: 'busy -> queue',
        data: { text: draft.text, attachments: draft.attachments, status: err.status, message: err.message },
      });
      return false;
    }
    pushConsole(sessionId, {
      kind: 'error',
      source: 'browser',
      title: 'turn failed',
      data: { text: draft.text, attachments: draft.attachments, status: err.status, message: err.message },
    });
    return false;
  } finally {
    setSending(sessionId, false);
  }
}

function flushQueue(sessionId) {
  const queue = getQueue(sessionId);
  if (!queue.length || isBusy(sessionId)) return;
  const next = dequeue(sessionId);
  if (!next) return;
  dispatchTurn(sessionId, next);
}

function sendCurrentInput(explicitText, explicitAttachments = []) {
  const sid = store.get().currentSession;
  if (!sid) return;
  if (isSending(sid)) return;
  if (typeof explicitText !== 'string') return false;
  const text = explicitText.trim();
  const turn = { text, attachments: normalizeAttachments(explicitAttachments) };
  if (!turn.text && !turn.attachments.length) return;

  pushConsole(sid, {
    kind: 'input',
    source: 'browser',
    title: 'local input',
    data: turn,
    timestamp: nowIso(),
  });
  if (isBusy(sid)) {
    enqueue(sid, turn);
    return true;
  }
  dispatchTurn(sid, turn);
  return true;
}

(async function init() {
  await loadSessions().catch((err) => {
    store.set({ loadError: err.message || 'Failed to load sessions' });
    console.error('Failed to load sessions:', err);
  });
  setInterval(() => {
    loadSessions().catch(() => {});
  }, 5000);
})();

if (typeof window !== 'undefined') {
  window.ClaudeHubReact = true;
  window.ClaudeHubStore = {
    store,
    getCurrentSession,
    getMessages,
    getConsoleEntries,
    getQueue,
    getActions,
    isBusy,
    isSending,
    formatShortId,
    formatStamp,
    renderMarkdown,
    renderToolBody,
    describeSystemEvent,
    isLikelyToolCall,
    isLikelyToolResult,
    getLastMessageId,
    loadSessions,
    createSession,
    deleteCurrentSession,
    selectSession,
    toggleConsoleCollapsed,
    toggleSidebarCollapsed,
    clearConsole,
    clearLogs,
    sendCurrentInput,
    uploadAttachment,
    scrollTranscriptToLatest,
    setTranscriptAutoFollow,
    formatTurnSummary,
    normalizeTurnDraft,
  };
  window.dispatchEvent(new CustomEvent('claude-hub:ready'));
}
