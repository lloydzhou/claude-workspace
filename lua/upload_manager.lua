-- upload_manager.lua
-- Save a raw binary attachment to disk and return its server path.

local _M = {}

local utils = require "utils"
local session_store = require "session_store"

local function shell_quote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function sanitize_filename(name)
    local value = tostring(name or "attachment")
    value = value:gsub("[\\/%z]", "_")
    value = value:gsub("[^%w%._%-]+", "_")
    value = value:gsub("^_+", "")
    value = value:gsub("_+$", "")
    if value == "" then
        return "attachment"
    end
    return value
end

local function ensure_dir(path)
    local ok = os.execute("mkdir -p " .. shell_quote(path))
    return ok == true or ok == 0
end

local function upload_root()
    local prefix = ngx.config.prefix()
    local date_dir = os.date("%Y/%m/%d")
    return prefix .. "projects/upload/" .. date_dir
end

local function write_binary(path, bytes)
    local file, err = io.open(path, "wb")
    if not file then
        return nil, err or "failed to open file"
    end
    local ok, write_err = file:write(bytes)
    file:close()
    if not ok then
        return nil, write_err or "failed to write file"
    end
    return true
end

local function extract_meta(meta)
    meta = type(meta) == "table" and meta or {}
    local filename = meta.filename or meta.name or meta["x-filename"] or meta["X-Filename"] or meta.file_name or "attachment"
    if type(filename) == "string" then
        local disp = filename:match('filename="?([^";]+)"?')
        if disp and disp ~= "" then
            filename = disp
        end
    end
    local mime_type = meta.mime_type or meta["content-type"] or meta["Content-Type"] or "application/octet-stream"
    return sanitize_filename(filename), mime_type
end

function _M.save(session_id, meta, raw_body)
    if not utils.is_uuid(session_id) then
        return nil, "invalid session id"
    end

    local info = session_store.get(session_id)
    if not info then
        return nil, "session not found"
    end

    if type(raw_body) ~= "string" or raw_body == "" then
        return nil, "empty upload body"
    end

    local filename, mime_type = extract_meta(meta)
    local root = upload_root()
    if not ensure_dir(root) then
        return nil, "failed to create upload directory"
    end

    local asset_id = utils.uuid()
    local ext = filename:match("(%.[%w]+)$") or ""
    local stored_name = asset_id .. ext
    local stored_path = root .. "/" .. stored_name

    local ok, err = write_binary(stored_path, raw_body)
    if not ok then
        return nil, err or "failed to write upload"
    end

    return {
        id = asset_id,
        filename = filename,
        mime_type = mime_type,
        size = #raw_body,
        server_path = stored_path,
    }
end

return _M
