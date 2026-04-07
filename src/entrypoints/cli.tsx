#!/usr/bin/env bun
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { marked } from 'marked';
import { createRemoteSessionClient } from '../runtime/remote-session.js';
import { captureClipboardImage } from '../runtime/clipboard-image.js';
import { formatAttachmentChip, normalizeAttachments } from '../shared/attachments.js';

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseArgs(argv) {
  const args = [...argv];
  const result = { _: [] };
  while (args.length) {
    const arg = args.shift();
    if (arg === 'list') {
      result.command = 'list';
      continue;
    }
    if (arg === '--session-id') {
      result.sessionId = args.shift() || '';
      continue;
    }
    if (arg === '--base-url') {
      result.baseUrl = args.shift() || '';
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    result._.push(arg);
  }
  return result;
}

async function listSessions(baseUrl = '') {
  const res = await fetch(`${baseUrl}/api/sessions`);
  const data = await res.json();
  const sessions = (data.sessions || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (!sessions.length) {
    process.stdout.write('No sessions yet.\n');
    return;
  }
  process.stdout.write('SESSION ID        STATUS   TURNS  SUMMARY\n');
  process.stdout.write('----------------  -------  -----  --------------------------------\n');
  for (const s of sessions) {
    const summary = s.last_user_text || s.last_result || (typeof s.turn_count === 'number' ? `${s.turn_count} turn${s.turn_count === 1 ? '' : 's'}` : '');
    process.stdout.write(`${String(s.session_id || '').padEnd(36)}  ${(s.status || 'idle').padEnd(7)}  ${String(s.turn_count || 0).padEnd(5)}  ${String(summary).slice(0, 40)}\n`);
  }
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

function ThinkingMessage({ text }) {
  try {
    const tokens = marked.lexer(text);
    const elements = [];
    for (const token of tokens) {
      if (token.type === 'heading') {
        const prefix = '#'.repeat(Math.min(token.depth, 4)) + ' ';
        elements.push(
          <Box key={`h-${elements.length}`}>
            <Text bold color="white">{prefix}{token.text}</Text>
          </Box>
        );
      } else if (token.type === 'paragraph') {
        const inlineParts = renderInlineMarkdown(token.text || '', elements.length);
        elements.push(
          <Box key={`p-${elements.length}`} marginBottom={1}>
            {inlineParts}
          </Box>
        );
      } else if (token.type === 'code') {
        elements.push(
          <Box key={`cb-${elements.length}`} marginBottom={1}>
            <Text color="gray">  ┌ {token.text}</Text>
          </Box>
        );
      } else if (token.type === 'codespan') {
        elements.push(
          <Text key={`ci-${elements.length}`} color="cyan">{` ${token.text} `}</Text>
        );
      } else if (token.type === 'list') {
        for (let i = 0; i < token.items.length; i++) {
          const item = token.items[i];
          const prefix = token.ordered ? `  ${i + 1}. ` : '  • ';
          const inlineParts = renderInlineMarkdown(item.text || '', elements.length);
          elements.push(
            <Box key={`li-${elements.length}`}>
              <Text dimColor>{prefix}</Text>
              {inlineParts}
            </Box>
          );
        }
      } else if (token.type === 'blockquote') {
        const inlineParts = renderInlineMarkdown(token.text || '', elements.length);
        elements.push(
          <Box key={`bq-${elements.length}`}>
            <Text dimColor>  │ </Text>
            {inlineParts}
          </Box>
        );
      } else if (token.type === 'space') {
        // skip whitespace tokens
      } else if (token.text) {
        const inlineParts = renderInlineMarkdown(token.text, elements.length);
        elements.push(
          <Box key={`t-${elements.length}`}>
            {inlineParts}
          </Box>
        );
      }
    }
    return elements.length ? <>{elements}</> : <Text dimColor>{text}</Text>;
  } catch {
    return <Text dimColor>{text}</Text>;
  }
}

function renderInlineMarkdown(text, baseKey) {
  const parts = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;
  let keyIdx = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`${baseKey}-t-${keyIdx++}`}>{text.slice(lastIndex, match.index)}</Text>);
    }
    if (match[2]) {
      parts.push(<Text key={`${baseKey}-b-${keyIdx++}`} bold>{match[2]}</Text>);
    } else if (match[3]) {
      parts.push(<Text key={`${baseKey}-i-${keyIdx++}`} italic>{match[3]}</Text>);
    } else if (match[4]) {
      parts.push(<Text key={`${baseKey}-c-${keyIdx++}`} color="cyan">`{match[4]}`</Text>);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(<Text key={`${baseKey}-e-${keyIdx++}`}>{text.slice(lastIndex)}</Text>);
  }
  return parts.length ? <>{parts}</> : <Text dimColor>{text}</Text>;
}

function WorkingIndicator({ busy, busySince }) {
  const [frameIdx, setFrameIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const spinRef = useRef(null);

  useEffect(() => {
    if (!busy) {
      if (spinRef.current) clearInterval(spinRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    spinRef.current = setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    timerRef.current = setInterval(() => {
      if (busySince) {
        setElapsed(Math.floor((Date.now() - busySince) / 1000));
      }
    }, 1000);
    return () => {
      if (spinRef.current) clearInterval(spinRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [busy, busySince]);

  if (!busy) return null;
  return (
    <Box>
      <Text color="yellow">{SPINNER_FRAMES[frameIdx]}</Text>
      <Text> Working (</Text>
      <Text bold>{formatElapsed(elapsed)}</Text>
      <Text dimColor> • esc to interrupt)</Text>
      <Text>)</Text>
    </Box>
  );
}

function WelcomeScreen({ sessionId, baseUrl }) {
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text bold color="blue">  claude-hub</Text>
      <Text> </Text>
      <Text>  <Text dimColor>Model:   </Text><Text>remote</Text></Text>
      <Text>  <Text dimColor>Server:  </Text><Text>{baseUrl}</Text></Text>
      <Text>  <Text dimColor>Session: </Text><Text>{sessionId.slice(0, 8)}</Text></Text>
      <Text> </Text>
      <Text dimColor>  Type a message and press Enter to begin.</Text>
      <Text dimColor>  Ctrl+C twice to exit.</Text>
    </Box>
  );
}

function MessageLine({ message }) {
  const role = message.role || 'system';
  const color = message.kind === 'thinking'
    ? 'gray'
    : (message.kind === 'tool_use'
      ? 'cyan'
      : (role === 'user' ? 'green' : role === 'assistant' ? 'white' : role === 'error' ? 'red' : 'gray'));
  const raw = String(message.content || '').trim();
  const lines = raw ? raw.split('\n') : [''];
  const toolPayload = (() => {
    if (message.kind !== 'tool_use' || !raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  const toolName = String(message.tool_name || toolPayload?.name || 'tool').trim() || 'tool';
  const toolInput = toolPayload && typeof toolPayload.input === 'object'
    ? toolPayload.input
    : (toolPayload && typeof toolPayload === 'object' ? toolPayload : {});
  const toolDisplayInput = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const toolLine = (() => {
    if (message.kind !== 'tool_use') return lines[0] || '<empty>';
    if (!toolPayload) return lines[0] || '<empty>';
    if (toolName.toLowerCase() === 'read') {
      return `tool use: Read ${toolDisplayInput.file_path || toolDisplayInput.path || '<unknown>'}`;
    }
    if (toolName.toLowerCase() === 'bash' && typeof toolDisplayInput.command === 'string') {
      return `tool use: bash ${toolDisplayInput.command}`;
    }
    if (toolName.toLowerCase() === 'search') {
      const query = toolDisplayInput.query || toolDisplayInput.search || '';
      return `tool use: search ${query}`;
    }
    return `tool use: ${toolName}`;
  })();
  if (message.kind === 'thinking') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="gray">•</Text>
          {message.pending ? <Text color="yellow"> •</Text> : null}
          <Text> </Text>
          <Text dimColor>thinking:</Text>
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <ThinkingMessage text={raw} />
        </Box>
      </Box>
    );
  }
  const headText = message.kind === 'tool_use'
    ? toolLine
    : (lines[0] || '<empty>');
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color}>
          •
        </Text>
        {message.pending ? <Text color="yellow"> •</Text> : null}
        <Text> </Text>
        <Text dimColor={message.kind === 'thinking'}>{headText}</Text>
      </Box>
      {message.kind === 'tool_use' && toolPayload ? (
        <Box>
          <Text dimColor>  </Text>
          <Text dimColor>{JSON.stringify(toolDisplayInput, null, 2)}</Text>
        </Box>
      ) : null}
      {lines.slice(1).map((line, idx) => (
        <Box key={`${message.id}-${idx}`}>
          <Text dimColor>  </Text>
          <Text dimColor={message.kind === 'thinking'}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

function AttachmentLine({ attachments }) {
  const items = normalizeAttachments(attachments || []);
  if (!items.length) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {items.map((attachment, idx) => (
        <Box key={attachment.id || `${attachment.filename}-${idx}`}>
          <Text color="cyan">{formatAttachmentChip(idx + 1, attachment)}</Text>
        </Box>
      ))}
    </Box>
  );
}

function InputController({ value, setValue, onSubmit, onExit, onImagePaste, canSubmitEmpty = false }) {
  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      onExit();
      return;
    }
    if (key.ctrl && inputChar === 'v') {
      if (onImagePaste) {
        void onImagePaste();
      }
      return;
    }
    if (key.return) {
      const next = value.trim();
      if (!next && !canSubmitEmpty) return;
      setValue('');
      onSubmit(next);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    if (key.escape) {
      setValue('');
      return;
    }
    if (inputChar && !key.ctrl && !key.meta) {
      setValue((prev) => prev + inputChar);
    }
  });

  return null;
}

function SessionTui({ sessionId, baseUrl = '' }) {
  const { exit } = useApp();
  const client = useMemo(() => createRemoteSessionClient({ apiBase: baseUrl, sessionId }), [baseUrl, sessionId]);
  const [state, setState] = useState(client.getState());
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimer = React.useRef(null);
  const busySinceRef = useRef(null);
  const inputEnabled = !!process.stdin.isTTY && !!process.stdout.isTTY;

  useEffect(() => client.subscribe((newState) => {
    if (newState.busy && !state.busy) {
      busySinceRef.current = Date.now();
    }
    setState(newState);
  }), [client]);

  useEffect(() => {
    setInput('');
    setAttachments([]);
  }, [sessionId]);

  useEffect(() => {
    if (!exitArmed) return undefined;
    exitTimer.current = setTimeout(() => setExitArmed(false), 1800);
    return () => {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
    };
  }, [exitArmed]);

  useEffect(() => {
    client.ensureConnected().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
    });
    return () => client.disconnect();
  }, [client]);

  const handleSubmit = async (text) => {
    const trimmed = String(text || '').trim();
    if (/^\/attach\s+/i.test(trimmed)) {
      const paths = trimmed.replace(/^\/attach\s+/i, '').trim().split(/\s+/).filter(Boolean);
      if (!paths.length) return;
      for (const filePath of paths) {
        try {
          const uploaded = await client.uploadLocalAttachment(filePath);
          if (uploaded) {
            setAttachments((prev) => prev.concat([{
              id: uploaded.id,
              filename: uploaded.filename,
              mimeType: uploaded.mime_type,
              serverPath: uploaded.server_path,
              size: uploaded.size,
            }]));
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(err);
        }
      }
      return;
    }
    if (!trimmed && !attachments.length) return;
    const ok = await client.sendTurn({ text: trimmed, attachments });
    if (ok !== false) {
      setInput('');
      setAttachments([]);
    }
  };

  const handleClipboardImagePaste = async () => {
    const clip = await captureClipboardImage();
    if (!clip) {
      return;
    }
    try {
      const uploaded = await client.uploadLocalAttachment(clip.path, clip.mimeType);
      if (uploaded) {
        setAttachments((prev) => prev.concat([{
          id: uploaded.id,
          filename: uploaded.filename,
          mimeType: uploaded.mime_type,
          serverPath: uploaded.server_path,
          size: uploaded.size,
        }]));
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      if (clip.cleanup) {
        await clip.cleanup().catch(() => {});
      }
    }
  };

  const session = client.getCurrentSummary() || { id: sessionId };
  const messages = state.messages || [];
  const queue = state.queue || [];
  const summary = `session=${session.id}  status=${session.status || 'loading'}  connected=${state.connected ? 'yes' : 'no'}  busy=${state.busy ? 'yes' : 'no'}  queue=${queue.length}`;
  const promptText = input;
  const showCursor = !!inputEnabled;
  const columns = Math.max(process.stdout.columns || 80, 10);
  const rule = '─'.repeat(columns - 1);

  return (
    <Box flexDirection="column">
      {inputEnabled ? (
        <InputController
          value={input}
          setValue={setInput}
          onSubmit={(text) => handleSubmit(text)}
          onImagePaste={() => handleClipboardImagePaste()}
          canSubmitEmpty={attachments.length > 0}
          onExit={() => {
            if (exitArmed) {
              exit();
              return;
            }
            setExitArmed(true);
          }}
        />
      ) : null}
      <Box marginBottom={1}>
        <Text color="yellow">claude-hub</Text>
        <Text dimColor>  {summary}</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {messages.length ? messages.map((m) => <MessageLine key={m.id} message={m} />) : <WelcomeScreen sessionId={sessionId} baseUrl={baseUrl} />}
      </Box>
      {state.busy ? (
        <Box marginBottom={1}>
          <WorkingIndicator busy={state.busy} busySince={busySinceRef.current} />
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={0}>
        <Text dimColor>{rule}</Text>
        <AttachmentLine attachments={attachments} />
        <Box>
          <Text color="green">&gt; </Text>
          <Text>{promptText}</Text>
          {showCursor ? <Text color="green">█</Text> : null}
        </Box>
        <Text dimColor>{rule}</Text>
        <Text dimColor>
          {exitArmed ? 'Press Ctrl+C again to exit.' : 'accept edits on (shift+tab to cycle)'}
        </Text>
      </Box>
      {!inputEnabled? (
        <Text dimColor>
          Raw mode is unavailable in this environment; TUI input is disabled.
        </Text>
      ) : null}
    </Box>
  );
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const baseUrl = argv.baseUrl || process.env.CLAUDE_HUB_URL || 'http://127.0.0.1:8080';

  if (argv.help) {
    process.stdout.write(`claude-hub\n\n`);
    process.stdout.write(`Usage:\n`);
    process.stdout.write(`  claude-hub list\n`);
    process.stdout.write(`  claude-hub --session-id <id>\n`);
    process.stdout.write(`  claude-hub --session-id <id> --base-url http://127.0.0.1:8080\n`);
    return;
  }

  if (!argv.sessionId) {
    process.stderr.write('Missing --session-id. Try `claude-hub list` first.\n');
    process.exitCode = 1;
    return;
  }

  if (!isUuid(argv.sessionId)) {
    process.stderr.write(`Invalid --session-id: ${argv.sessionId}\n`);
    process.exitCode = 1;
    return;
  }

  const preflightClient = createRemoteSessionClient({ apiBase: baseUrl, sessionId: argv.sessionId });
  const session = await preflightClient.loadSession();
  if (!session) {
    process.stderr.write(`Session not found: ${argv.sessionId}\n`);
    process.exitCode = 1;
    return;
  }

  render(<SessionTui sessionId={argv.sessionId} baseUrl={baseUrl} />, {
    exitOnCtrlC: false,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}

export { main };
