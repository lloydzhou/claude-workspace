window.ClaudeWorkspaceReact = true;

const { useEffect, useMemo, useRef, useState } = React;

function useWorkspaceSnapshot() {
  const read = () => (window.ClaudeWorkspaceStore ? window.ClaudeWorkspaceStore.store.get() : null);
  const [snapshot, setSnapshot] = useState(read);

  useEffect(() => {
    const sync = () => setSnapshot(read());
    let unsubscribe = null;
    const attach = () => {
      const api = window.ClaudeWorkspaceStore;
      if (!api || !api.store || typeof api.store.subscribe !== 'function') {
        return false;
      }
      unsubscribe = api.store.subscribe(sync);
      sync();
      return true;
    };
    attach();
    const poll = window.ClaudeWorkspaceStore ? null : setInterval(() => {
      if (attach()) {
        clearInterval(poll);
      }
    }, 50);
    return () => {
      if (unsubscribe) unsubscribe();
      if (poll) clearInterval(poll);
    };
  }, []);

  return snapshot;
}

function helper(name) {
  return window.ClaudeWorkspaceStore && window.ClaudeWorkspaceStore[name]
    ? window.ClaudeWorkspaceStore[name]
    : null;
}

function SessionList({ state, onSelect }) {
  const formatShortId = helper('formatShortId') || ((id) => id ? id.slice(0, 8) : '--------');
  const truncate = (text, max = 88) => {
    const value = String(text || '').trim();
    if (!value) return '';
    return value.length > max ? `${value.slice(0, max)}…` : value;
  };
  const sessionSummary = (s) => {
    if (!s) return '';
    if (s.last_user_text) return truncate(s.last_user_text);
    if (s.last_result) return truncate(s.last_result);
    if (typeof s.turn_count === 'number') {
      return s.turn_count > 0 ? `${s.turn_count} turn${s.turn_count === 1 ? '' : 's'}` : 'No turns yet';
    }
    return 'No turns yet';
  };
  const currentSession = state?.currentSession || null;
  const sessions = state?.sessions || [];
  const getQueue = helper('getQueue') || (() => []);
  const isBusy = helper('isBusy') || (() => false);

  if (!sessions.length) {
    return <div className="sidebar-section-note">No sessions yet. Create one to begin.</div>;
  }

  return (
    <>
      {sessions.map((s) => {
        const active = s.session_id === currentSession ? 'active' : '';
        const queueCount = getQueue(s.session_id).length;
        const busy = isBusy(s.session_id) || s.status === 'running';
        const statusClass = busy ? 'warn' : (s.status === 'failed' ? 'bad' : 'good');
        const statusLabel = busy ? 'running' : (s.status || 'idle');
        return (
          <button
            type="button"
            className={`session-card ${active}`}
            key={s.session_id}
            onClick={() => onSelect && onSelect(s.session_id)}
          >
            <div className="session-header">
              <div className="session-name">{formatShortId(s.session_id)}</div>
              <div className={`pill ${statusClass}`}>{statusLabel}</div>
            </div>
            <div className="session-summary" title={s.last_user_text || s.last_result || ''}>
              {sessionSummary(s)}
            </div>
            <div className="session-meta">
              {queueCount ? <span className="pill warn">Q {queueCount}</span> : null}
              {s.locked ? <span className="pill warn">locked</span> : null}
            </div>
          </button>
        );
      })}
    </>
  );
}

function QueueView({ state }) {
  const sid = state?.currentSession || null;
  const getQueue = helper('getQueue') || (() => []);
  const queue = sid ? getQueue(sid) : [];
  if (!sid || !queue.length) {
    return null;
  }

  return (
    <>
      {queue.map((item, idx) => (
        <div className="queue-chip" key={`${idx}-${item}`}>
          <strong>#{idx + 1}</strong>
          <span className="queue-item-text">{item.length > 72 ? `${item.slice(0, 72)}…` : item}</span>
        </div>
      ))}
    </>
  );
}

function ConsoleView({ state }) {
  const sid = state?.currentSession || null;
  const getConsoleEntries = helper('getConsoleEntries') || (() => []);
  const formatStamp = helper('formatStamp') || ((iso) => new Date(iso).toLocaleTimeString([], { hour12: false }));
  const entries = sid ? getConsoleEntries(sid) : [];
  const renderData = (data) => {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  if (!sid) {
    return <div className="console-empty">Select a session to inspect raw stream-json and reducer input.</div>;
  }

  if (!entries.length) {
    return <div className="console-empty">No console entries yet. Send a turn or wait for raw stream events.</div>;
  }

  return (
    <>
      {entries.map((entry) => (
        <article className={`console-entry ${entry.kind === 'error' ? 'error' : entry.kind}`} key={entry.id}>
          <div className="console-entry-head">
            <span className="console-entry-title">{entry.title || entry.kind || 'event'}</span>
            <span>{formatStamp(entry.timestamp)}</span>
          </div>
          <pre className="console-entry-body">{renderData(entry.data)}</pre>
        </article>
      ))}
    </>
  );
}

function TranscriptView({ state }) {
  const sid = state?.currentSession || null;
  const loadError = state?.loadError || null;
  const getMessages = helper('getMessages') || (() => []);
  const renderMarkdown = helper('renderMarkdown') || ((text) => text);
  const renderToolBody = helper('renderToolBody') || ((body) => ({ html: body, toolType: null }));
  const formatStamp = helper('formatStamp') || ((iso) => new Date(iso).toLocaleTimeString([], { hour12: false }));
  const formatShortId = helper('formatShortId') || ((id) => id ? id.slice(0, 8) : '--------');
  const describeSystemEvent = helper('describeSystemEvent') || ((msg) => msg.content || 'system event');
  const isLikelyToolCall = helper('isLikelyToolCall') || (() => false);
  const isLikelyToolResult = helper('isLikelyToolResult') || (() => false);

  const messages = sid ? getMessages(sid) : [];
  const currentContent = useMemo(() => {
    if (!sid) {
      if (loadError) {
        return (
          <div className="empty-state">
            <div>
              <h2>Failed to load sessions</h2>
              <p>{loadError}</p>
            </div>
          </div>
        );
      }
      return (
        <div className="empty-state">
          <div>
            <h2>Ready to talk</h2>
            <p>Create a session from the left sidebar, then send a message. Claude turns are started one at a time and the browser will queue extra input while a turn is running.</p>
          </div>
        </div>
      );
    }
    if (!messages.length) {
      return (
        <div className="empty-state">
          <div>
            <h2>Session {formatShortId(sid)}</h2>
            <p>No transcript yet. Send the first message to start a Claude turn.</p>
          </div>
        </div>
      );
    }
    return messages.map((msg, idx) => {
      const body = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
      const pending = msg.pending ? ' pending' : '';
      if (msg.role === 'assistant' && !String(body || '').trim()) {
        return null;
      }
      const isToolCall = isLikelyToolCall(msg, body);
      const isToolResult = isLikelyToolResult(msg, body);
      const role = isToolCall || isToolResult ? 'tool' : (msg.role || 'system');
      const label = msg.kind === 'result'
        ? 'result'
        : (isToolCall ? 'tool call' : (isToolResult ? 'tool result' : (msg.kind || role)));
      const displayBody = body || (msg.kind === 'result' ? describeSystemEvent(msg) : '');
      let bodyTag;
      let toolLabel = label;
      if (role === 'assistant') {
        bodyTag = <div className="message-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(displayBody) }} />;
      } else if (role === 'tool') {
        const toolResult = renderToolBody(displayBody);
        bodyTag = <div className="message-body tool-body" dangerouslySetInnerHTML={{ __html: toolResult.html || '' }} />;
        if (toolResult.toolType && toolResult.toolType !== 'tool') {
          toolLabel = isToolCall ? toolResult.toolType : (isToolResult ? `${toolResult.toolType} result` : toolResult.toolType);
        }
      } else {
        bodyTag = <pre className="message-body">{displayBody}</pre>;
      }
      return (
        <article className={`message-card ${role}${pending}`} key={msg.id || `${idx}-${msg.timestamp}`}>
          <div className="message-head">
            <span className="message-role">{toolLabel}</span>
            <span>{formatStamp(msg.timestamp)}</span>
          </div>
          {bodyTag}
        </article>
      );
    });
  }, [sid, messages, loadError]);

  return <>{currentContent}</>;
}

function AppShell() {
  const state = useWorkspaceSnapshot();
  const formatShortId = helper('formatShortId') || ((id) => id ? id.slice(0, 8) : '--------');
  const current = state?.sessions?.find((s) => s.session_id === state.currentSession) || null;
  const connected = !!state?.connected && !!state?.ws;
  const sid = state?.currentSession || null;
  const getQueue = helper('getQueue') || (() => []);
  const getWsCount = helper('getWsCount') || (() => 0);
  const isBusy = helper('isBusy') || (() => false);
  const isSending = helper('isSending') || (() => false);
  const queueLen = sid ? getQueue(sid).length : 0;
  const wsCount = sid ? getWsCount(sid) : 0;
  const busy = sid ? isBusy(sid) : false;
  const sending = sid ? isSending(sid) : false;
  const transcriptRef = useRef(null);
  const inputRef = useRef(null);
  const [inputValue, setInputValue] = useState('');
  const loadSessions = helper('loadSessions') || (() => Promise.resolve());
  const createSession = helper('createSession') || (() => Promise.resolve());
  const deleteCurrentSession = helper('deleteCurrentSession') || (() => Promise.resolve());
  const selectSession = helper('selectSession') || (() => {});
  const toggleConsoleCollapsed = helper('toggleConsoleCollapsed') || (() => {});
  const toggleSidebarCollapsed = helper('toggleSidebarCollapsed') || (() => {});
  const clearConsole = helper('clearConsole') || (() => {});
  const sendCurrentInput = helper('sendCurrentInput') || (() => false);
  const setTranscriptAutoFollow = helper('setTranscriptAutoFollow') || (() => {});
  const scrollTranscriptToLatest = helper('scrollTranscriptToLatest') || (() => {});
  const currentMessages = sid ? (helper('getMessages') || (() => []))(sid) : [];

  useEffect(() => {
    setInputValue('');
  }, [sid]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [inputValue]);

  useEffect(() => {
    const scroller = transcriptRef.current;
    if (!scroller || !state?.transcriptAutoFollow) return;
    requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
  }, [sid, currentMessages.length, state?.transcriptAutoFollow]);

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text) return;
    const ok = sendCurrentInput(text);
    if (ok !== false) {
      setInputValue('');
    }
  };

  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  const handleTranscriptScroll = (e) => {
    const el = e.currentTarget;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
    setTranscriptAutoFollow(atBottom);
  };

  return (
    <div className={`shell${state?.sidebarCollapsed ? ' sidebar-collapsed' : ''}`} id="shell">
      <aside className="sidebar" id="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <div className="brand-mark">CC</div>
            <div className="brand-copy">
              <div className="brand-title">Claude Workspace</div>
              <div className="brand-subtitle">Nchan-backed sessions with CGI-like turns</div>
            </div>
          </div>
          <button className="icon-btn" id="btn-collapse" title="Collapse sidebar" onClick={toggleSidebarCollapsed}>☰</button>
        </div>

        <div className="sidebar-actions">
          <button className="primary-btn" id="btn-new" onClick={() => createSession().catch(() => {})}>+ New Session</button>
          <button className="secondary-btn" id="btn-refresh" onClick={() => loadSessions().catch(() => {})}>Refresh</button>
        </div>

        <section className="sidebar-section">
          <h3 className="sidebar-section-title">Sessions</h3>
          <div className="sidebar-section-note">Select a session on the left. Each session serializes turns with a lock.</div>
          <div className="session-list" id="session-list">
            <SessionList state={state} onSelect={(id) => selectSession(id, { connect: true })} />
          </div>
        </section>

        <div className="sidebar-footer">
          <div className="sidebar-section-note" id="sidebar-summary">
            {sid ? `Current: ${formatShortId(sid)}` : 'No active session'}
          </div>
          <div className="sidebar-footer-actions">
            <button className="danger-btn" id="btn-delete" onClick={deleteCurrentSession}>Delete Current</button>
            <button
              className="icon-btn console-launcher"
              id="btn-console-toggle"
              title={state?.consoleCollapsed ? 'Action Console' : 'Hide Action Console'}
              aria-label="Action Console"
              onClick={toggleConsoleCollapsed}
            >
              {state?.consoleCollapsed ? '◫' : '▣'}
            </button>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-main">
            <div className="topbar-title" id="topbar-title">{sid ? `Session ${formatShortId(sid)}` : 'No session selected'}</div>
            <div className="topbar-subtitle" id="topbar-subtitle">
              {sid
                ? `session_id=${sid}${current && current.status ? `  status=${current.status}` : ''}`
                : 'Create or pick a session from the left sidebar.'}
            </div>
          </div>

          <div className="topbar-actions">
            <div className={`status-chip${connected ? ' connected' : ''}${busy ? ' busy' : ''}`} id="conn-chip">
              <span className="status-dot"></span>
              <span id="conn-text">{sid ? (busy ? (connected ? 'running' : 'running (reconnecting)') : (connected ? 'connected' : 'reconnecting')) : 'disconnected'}</span>
            </div>
            <div className="pill" id="queue-pill">queue {queueLen}  ws {wsCount}</div>
          </div>
        </header>

        <section className="transcript-shell">
          <button
            className={`jump-latest${state?.transcriptAutoFollow ? '' : ' visible'}`}
            id="btn-jump-latest"
            title="Jump to latest"
            onClick={() => {
              scrollTranscriptToLatest();
              const scroller = transcriptRef.current;
              if (scroller) {
                requestAnimationFrame(() => {
                  scroller.scrollTop = scroller.scrollHeight;
                });
              }
            }}
          >
            ↓ latest
          </button>
          <div className="transcript-scroll" id="transcript-scroll" ref={transcriptRef} onScroll={handleTranscriptScroll}>
            <div className="transcript-frame">
              <div className="transcript-inner" id="transcript">
                <TranscriptView state={state} />
              </div>
            </div>
          </div>
        </section>

        <section className={`console-panel${state?.consoleCollapsed ? ' collapsed' : ''}`} id="console-panel">
          <div className="console-head">
            <div className="console-title">Action Console</div>
            <div className="console-actions">
              <button className="secondary-btn console-toggle" id="btn-console-clear" onClick={() => sid && clearConsole(sid)}>Clear</button>
            </div>
          </div>
          <div className="console-body" id="console-body">
            <ConsoleView state={state} />
          </div>
        </section>

        <footer className="composer">
          <div className="queue-strip" id="queue-strip">
            <QueueView state={state} />
          </div>
          <div className="composer-row">
            <div className="prompt-box">
              <div className="prompt-mark">&gt;</div>
              <textarea
                id="input"
                ref={inputRef}
                placeholder="Ask Claude... Enter to send, Shift+Enter for newline"
                rows="1"
                disabled={!sid || sending}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
              ></textarea>
            </div>
            <button id="btn-send" className="primary-btn" disabled={!sid || sending || !inputValue.trim()} onClick={handleSend}>Send</button>
          </div>
          <div className="hint-line">
            <span>Enter to send, <code>Shift+Enter</code> for newline.</span>
            <span>Input is queued in the browser while a turn is running.</span>
          </div>
        </footer>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('app')).render(<AppShell />);
