function normalizeAttachmentRef(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    return {
      serverPath: value,
      filename: value.split('/').pop() || value,
      mimeType: '',
    };
  }
  if (typeof value !== 'object') return null;
  const serverPath = value.server_path || value.serverPath || value.path || value.file_path || '';
  const filename = value.filename || value.name || (serverPath ? serverPath.split('/').pop() : '') || 'attachment';
  return {
    id: value.id || '',
    filename,
    mimeType: value.mime_type || value.mimeType || value.content_type || '',
    serverPath,
    size: value.size || 0,
  };
}

function normalizeAttachments(list) {
  return (Array.isArray(list) ? list : []).map(normalizeAttachmentRef).filter(Boolean);
}

function formatAttachmentLabel(index) {
  return `[Image #${index}]`;
}

function formatAttachmentChip(index, attachment) {
  const ref = normalizeAttachmentRef(attachment);
  if (!ref) return formatAttachmentLabel(index);
  const suffix = ref.filename ? ` ${ref.filename}` : '';
  return `${formatAttachmentLabel(index)}${suffix}`;
}

export {
  formatAttachmentChip,
  formatAttachmentLabel,
  normalizeAttachmentRef,
  normalizeAttachments,
};
