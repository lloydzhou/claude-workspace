import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function createTempFile(extension = '.png') {
  const dir = await mkdtemp(join(os.tmpdir(), 'claude-hub-clipboard-'));
  return join(dir, `clipboard${extension.startsWith('.') ? extension : `.${extension}`}`);
}

async function cleanupTempDir(filePath) {
  if (!filePath) return;
  const dir = dirname(filePath);
  await rm(dir, { recursive: true, force: true });
}

async function captureMacClipboardImage() {
  const tempFile = await createTempFile('.png');
  try {
    await execFileAsync('osascript', [
      '-e',
      'set png_data to (the clipboard as «class PNGf»)',
      '-e',
      `set fp to open for access POSIX file ${appleScriptQuote(tempFile)} with write permission`,
      '-e',
      'write png_data to fp',
      '-e',
      'close access fp',
    ]);
    return {
      path: tempFile,
      filename: 'clipboard.png',
      mimeType: 'image/png',
      cleanup: async () => cleanupTempDir(tempFile),
    };
  } catch {
    await cleanupTempDir(tempFile);
    return null;
  }
}

async function captureLinuxClipboardImage() {
  const tempFile = await createTempFile('.png');
  const pngCmd = `xclip -selection clipboard -t image/png -o > ${shellQuote(tempFile)} 2>/dev/null || wl-paste --type image/png > ${shellQuote(tempFile)} 2>/dev/null`;
  const bmpFile = tempFile.replace(/\.png$/, '.bmp');
  const bmpCmd = `xclip -selection clipboard -t image/bmp -o > ${shellQuote(bmpFile)} 2>/dev/null || wl-paste --type image/bmp > ${shellQuote(bmpFile)} 2>/dev/null`;

  try {
    let result = await execFileAsync('bash', ['-lc', pngCmd], { windowsHide: true });
    if (result.stderr && String(result.stderr).trim()) {
      // ignore
    }
    if (await fileExists(tempFile)) {
      return {
        path: tempFile,
        filename: 'clipboard.png',
        mimeType: 'image/png',
        cleanup: async () => cleanupTempDir(tempFile),
      };
    }

    result = await execFileAsync('bash', ['-lc', bmpCmd], { windowsHide: true });
    if (result.stderr && String(result.stderr).trim()) {
      // ignore
    }
    if (await fileExists(bmpFile)) {
      return {
        path: bmpFile,
        filename: 'clipboard.bmp',
        mimeType: 'image/bmp',
        cleanup: async () => cleanupTempDir(bmpFile),
      };
    }
    await cleanupTempDir(tempFile);
    return null;
  } catch {
    await cleanupTempDir(tempFile);
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function captureClipboardImage() {
  if (process.platform === 'darwin') {
    return captureMacClipboardImage();
  }
  if (process.platform === 'linux') {
    return captureLinuxClipboardImage();
  }
  return null;
}
