const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

function nowIso() {
  return new Date().toISOString();
}

function isNchanMessageId(value) {
  return typeof value === 'string' && /^\d+:\d+$/.test(value);
}

function normalizeTimestamp(value) {
  if (value == null || value === '') return nowIso();
  if (isNchanMessageId(value)) {
    const [seconds] = value.split(':', 1);
    const ts = Number(seconds);
    if (Number.isFinite(ts)) return new Date(ts * 1000).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (isNchanMessageId(value)) {
      const [seconds] = value.split(':', 1);
      const ts = Number(seconds);
      if (Number.isFinite(ts)) return new Date(ts * 1000).toISOString();
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber).toISOString();
    }
  }
  return nowIso();
}

function extractTextValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(extractTextValue).filter(Boolean).join('');
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
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'thinking') continue;
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
    message_id: payload.message_id,
    timestamp: normalizeTimestamp(payload.timestamp),
    source,
    raw: payload,
  };
}

function actionText(action) {
  if (!action || typeof action !== 'object') return '';
  if (action.type === 'assistant') {
    const blocks = getAssistantContentBlocks(action);
    const textParts = [];
    for (const block of blocks) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (textParts.length) return textParts.join('');
  }
  const direct = extractTextValue(action.content);
  if (direct) return direct;
  if (action.type === 'result') return extractTextValue(action.result);
  if (action.type === 'system') return extractTextValue(action.error) || extractTextValue(action.content);
  if (action.message) return extractTextValue(action.message);
  return '';
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

function normalizeSessionList(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return [];
  }
  if (typeof value === 'object') {
    return Object.keys(value).length ? Object.values(value) : [];
  }
  return [];
}

function reduceTranscriptActions(actions) {
  const extractStreamEvent = (action) => {
    if (!action || typeof action !== 'object') return null;
    if (action.raw && typeof action.raw === 'object' && action.raw.event) return action.raw.event;
    if (action.event && typeof action.event === 'object') return action.event;
    if (action.content && typeof action.content === 'object' && action.content.event) return action.content.event;
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
    if (assistantDraft) return assistantDraft;
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
    if (!action || typeof action !== 'object') continue;

    if (action.type === 'user') {
      const text = actionText(action);
      if (!text) continue;
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
        if (typeof ev.delta.text === 'string') appendAssistantText(ev.delta.text, stamp);
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
      if (hasStreamEvent) continue;
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
        if (sawBlock) continue;
      }
      const text = actionText(action);
      if (text) appendAssistantText(text, action.timestamp || nowIso());
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
      if (action.subtype === 'init') continue;
    }
  }

  return messages;
}

function formatShortId(id) {
  return id ? id.slice(0, 8) : '--------';
}

function formatStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false });
}

function describeSystemEvent(msg) {
  if (msg.subtype === 'init') return `init session=${msg.session_id || 'unknown'}`;
  if (msg.type === 'result') return msg.is_error ? `result error: ${msg.result || 'unknown'}` : (msg.result || 'completed');
  return msg.content || 'system event';
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

export {
  actionText,
  describeSystemEvent,
  extractTextValue,
  formatShortId,
  formatStamp,
  isAssistantBoundary,
  isLikelyJsonText,
  isLikelyToolCall,
  isLikelyToolResult,
  normalizeAction,
  normalizeSessionList,
  normalizeTimestamp,
  parseWsPayload,
  reduceTranscriptActions,
  getAssistantContentBlocks,
  extractThinkingText,
};
