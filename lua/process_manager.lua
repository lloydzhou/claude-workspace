-- process_manager.lua
-- Single-turn Claude runner with session-level locking.

local _M = {}

local utils = require "utils"
local session_store = require "session_store"
local pipe = require "ngx.pipe"

local LOCK_TTL = 86400

local function lock_key(session_id)
    return "session_lock:" .. session_id
end

local function get_lock_dict()
    return ngx.shared.session_locks
end

local function build_env_vars()
    local env_vars = {}
    local env_keys = {
        "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL",
        "ANTHROPIC_API_KEY", "NODE_PATH", "TMPDIR", "XDG_CONFIG_HOME",
        "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR",
    }

    for _, key in ipairs(env_keys) do
        local val = os.getenv(key)
        if val then
            table.insert(env_vars, key .. "=" .. val)
        end
    end

    return env_vars
end

local function shell_quote(value)
    return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function shell_join(args)
    local parts = {}
    for _, arg in ipairs(args or {}) do
        table.insert(parts, shell_quote(arg))
    end
    return table.concat(parts, " ")
end

local function normalize_body(body)
    if type(body) == "table" then
        return body
    end
    if type(body) ~= "string" then
        return { content = "" }
    end
    local decoded = utils.json_decode(body)
    if type(decoded) == "table" then
        return decoded
    end
    return { content = body }
end

local function normalize_attachments(body)
    local payload = normalize_body(body)
    local list = payload.attachments
    if type(list) ~= "table" then
        return {}
    end
    local attachments = {}
    for _, item in ipairs(list) do
        if type(item) == "string" then
            table.insert(attachments, {
                server_path = item,
                filename = item:match("[^/]+$") or item,
            })
        elseif type(item) == "table" then
            table.insert(attachments, {
                server_path = item.server_path or item.serverPath or item.path or item.file_path or "",
                filename = item.filename or item.name or ((item.server_path or item.serverPath or item.path or item.file_path or ""):match("[^/]+$") or "attachment"),
                mime_type = item.mime_type or item.mimeType or item.content_type,
            })
        end
    end
    return attachments
end

local function extract_turn_text(body)
    local payload = normalize_body(body)
    local text = payload.content
    if type(text) ~= "string" then
        if type(payload.message) == "table" then
            local msg_content = payload.message.content
            if type(msg_content) == "string" then
                text = msg_content
            elseif type(msg_content) == "table" and msg_content[1] and msg_content[1].text then
                text = msg_content[1].text
            end
        end
    end
    return tostring(text or "")
end

local function build_attachment_prompt(attachments, text)
    attachments = attachments or {}
    text = tostring(text or ""):gsub("^%s+", ""):gsub("%s+$", "")
    if #attachments == 0 then
        return text
    end

    local lines = {}
    table.insert(lines, "You must read these local image files first with the Read tool.")
    table.insert(lines, "Do not use analyze_image or any other server_tool_use for these files.")
    table.insert(lines, "Read each file path directly as written below:")
    for _, attachment in ipairs(attachments) do
        if attachment.server_path and attachment.server_path ~= "" then
            table.insert(lines, "- " .. attachment.server_path)
        end
    end
    table.insert(lines, "")
    if text ~= "" then
        table.insert(lines, "Then answer the user's request:")
        table.insert(lines, text)
    else
        table.insert(lines, "Then describe what you observe in the attached images.")
    end
    return table.concat(lines, "\n")
end

local function build_turn_prompt(body)
    local payload = normalize_body(body)
    return build_attachment_prompt(normalize_attachments(payload), extract_turn_text(payload))
end

local function build_stream_json_input_line(session_id, body)
    local prompt = build_turn_prompt(body)
    local event_uuid = (normalize_body(body).uuid) or utils.uuid()
    return utils.json_encode({
        type = "user",
        content = prompt,
        uuid = event_uuid,
        session_id = session_id,
        message = {
            role = "user",
            content = prompt,
        },
        parent_tool_use_id = nil,
    })
end

local function ensure_session_repo(session_dir)
    local git_dir = session_dir .. "/.git"
    local probe = io.open(git_dir, "r")
    if probe then
        probe:close()
        return true
    end

    local ok = os.execute("git -C " .. shell_quote(session_dir) .. " init -q >/dev/null 2>&1")
    if ok ~= true and ok ~= 0 then
        ngx.log(ngx.WARN, "failed to init git repo for session dir ", session_dir, ": ", tostring(ok))
        return nil, "failed to init session repo"
    end

    return true
end

local function build_user_event_line(body, session_id)
    local payload = normalize_body(body)
    local text = build_turn_prompt(payload)
    local attachments = normalize_attachments(payload)
    local event_uuid = payload.uuid or utils.uuid()
    local content = {
        { type = "text", text = text }
    }

    return utils.json_encode({
        type = "user",
        role = "user",
        content = content,
        message = {
            role = "user",
            content = content
        },
        attachments = attachments,
        session_id = session_id,
        uuid = event_uuid,
        isReplay = true,
    })
end

local function is_turn_request(body)
    body = normalize_body(body)
    if body.type == "turn_request" then
        return true
    end
    return body.type == "user" and body.session_id == nil
end

local function summarize_turn(body)
    local text = extract_turn_text(body)
    if text ~= "" then
        return text
    end
    local attachments = normalize_attachments(body)
    if #attachments > 0 then
        return tostring(#attachments) .. " attachment" .. (#attachments == 1 and "" or "s")
    end
    return ""
end

local function extract_text_message(msg)
    if type(msg) ~= "table" then
        return nil
    end

    if type(msg.content) == "string" then
        return msg.content
    end

    if type(msg.content) == "table" then
        local parts = {}
        for _, part in ipairs(msg.content) do
            if type(part) == "table" then
                if type(part.text) == "string" then
                    table.insert(parts, part.text)
                elseif type(part.content) == "string" then
                    table.insert(parts, part.content)
                end
            elseif type(part) == "string" then
                table.insert(parts, part)
            end
        end
        if #parts > 0 then
            return table.concat(parts, "")
        end
    end

    if type(msg.message) == "table" and type(msg.message.content) == "string" then
        return msg.message.content
    end

    if type(msg.message) == "table" and type(msg.message.content) == "table" then
        local parts = {}
        for _, part in ipairs(msg.message.content) do
            if type(part) == "table" then
                if type(part.text) == "string" then
                    table.insert(parts, part.text)
                elseif type(part.content) == "string" then
                    table.insert(parts, part.content)
                end
            elseif type(part) == "string" then
                table.insert(parts, part)
            end
        end
        if #parts > 0 then
            return table.concat(parts, "")
        end
    end

    return nil
end

local function upsert_session(session_id, patch)
    local info, err = session_store.upsert(session_id, patch)
    if not info then
        ngx.log(ngx.ERR, "session store upsert failed for ", session_id,
                ": ", err or "unknown")
        return nil, err
    end

    return info
end

local function session_turn_mode(session_id)
    local info = _M.get(session_id)
    if info and info.claude_initialized then
        return "resume"
    end
    return "session-id"
end

local function acquire_lock(session_id)
    return get_lock_dict():add(lock_key(session_id), ngx.now(), LOCK_TTL)
end

local function release_lock(session_id)
    get_lock_dict():delete(lock_key(session_id))
end

local function publish_to_session(session_id, payload)
    local sock = ngx.socket.tcp()
    sock:settimeouts(1000, 1000, 1000)

    local ok, err = sock:connect("127.0.0.1", 8080)
    if not ok then
        ngx.log(ngx.ERR, "nchan publish connect failed session=", session_id,
                " err=", err)
        return
    end

    local req = table.concat({
        "POST /nchan/pub/", session_id, " HTTP/1.1\r\n",
        "Host: 127.0.0.1:8080\r\n",
        "Content-Type: application/json\r\n",
        "Content-Length: ", #payload, "\r\n",
        "Connection: close\r\n\r\n",
        payload,
    })

    local bytes, send_err = sock:send(req)
    if not bytes then
        ngx.log(ngx.ERR, "nchan publish send failed session=", session_id,
                " err=", send_err)
        sock:close()
        return
    end

    local status_line, read_err = sock:receive("*l")
    if not status_line then
        ngx.log(ngx.ERR, "nchan publish read failed session=", session_id,
                " err=", read_err)
        sock:close()
        return
    end

    local status = tonumber(status_line:match("^HTTP/%d%.%d%s+(%d%d%d)"))
    if not status or (status ~= 200 and status ~= 201 and status ~= 202 and status ~= 204) then
        ngx.log(ngx.ERR, "nchan publish failed session=", session_id,
                " status_line=", status_line)
    end

    while true do
        local line, hdr_err = sock:receive("*l")
        if not line or line == "" then
            break
        end
        if hdr_err then
            break
        end
    end

    sock:close()
end

local function publish_user_event(session_id, body)
    local payload = build_user_event_line(body, session_id)
    upsert_session(session_id, {
        last_user_text = summarize_turn(body),
        last_input_at = ngx.now(),
    })
    publish_to_session(session_id, payload)
    return payload
end

local function stderr_reader(proc, session_id)
    while true do
        local data, err = proc:stderr_read_any(4096)
        if err then
            if err ~= "closed" then
                ngx.log(ngx.ERR, "stderr read error for ", session_id, ": ", err)
            end
            break
        end

        if data then
            ngx.log(ngx.WARN, "stderr[", session_id, "]: ", data)
        end
    end
end

local function stdout_reader(proc, session_id)
    while true do
        local data, err, partial = proc:stdout_read_line()
        if err then
            if err == "closed" and partial then
                local decoded = utils.json_decode(partial)
                publish_to_session(session_id, partial)
                break
            end
            if err ~= "closed" then
                return nil, err
            end
            break
        end

        if data then
            local decoded = utils.json_decode(data)
            if decoded then
                if decoded.type == "system" and decoded.subtype == "init" and decoded.session_id then
                    upsert_session(session_id, {
                        claude_initialized = true,
                        claude_session_id = decoded.session_id,
                    })
                elseif decoded.type == "result" then
                    local session_info = _M.get(session_id) or {}
                    upsert_session(session_id, {
                        last_result = decoded.result,
                        last_exit_code = 0,
                        last_finished_at = ngx.now(),
                        claude_initialized = true,
                        claude_session_id = decoded.session_id or session_info.claude_session_id,
                    })
                end
                publish_to_session(session_id, data)
            else
                publish_to_session(session_id, data)
            end
        end
    end

    return true
end

local function run_turn(session_id, body, session_dir)
    local env_vars = build_env_vars()
    local claude_bin = os.getenv("CLAUDE_BIN") or "claude"
    local turn_mode = session_turn_mode(session_id)
    local proc_args = {
        claude_bin,
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--dangerously-skip-permissions",
    }

    if turn_mode == "resume" then
        table.insert(proc_args, 2, "--resume")
        table.insert(proc_args, 3, _M.get(session_id).claude_session_id or session_id)
    end

    local shell_cmd = "cd " .. shell_quote(session_dir) .. " && exec " .. shell_join(proc_args)
    ngx.log(ngx.INFO, "spawn turn(): claude_bin=", claude_bin,
            " session=", session_id, " mode=", turn_mode,
            " cwd=", session_dir,
            " env_count=", #env_vars)

    local proc, spawn_err = pipe.spawn({"/bin/sh", "-lc", shell_cmd}, {
        merge_stderr = false,
        environ = env_vars,
    })

    if not proc then
        ngx.log(ngx.ERR, "spawn failed for ", session_id, ": ", spawn_err)
        ngx.log(ngx.ERR, "process_error session=", session_id, " stage=spawn error=", spawn_err or "unknown")
        upsert_session(session_id, {
            status = "failed",
            last_error = "spawn failed: " .. (spawn_err or "unknown"),
            last_started_at = ngx.now()
        })
        release_lock(session_id)
        return
    end

    proc:set_timeouts(0, 0, 0, 0)

    local current_info = _M.get(session_id) or {}
    upsert_session(session_id, {
        status = "running",
        pid = proc:pid(),
        last_started_at = ngx.now(),
        last_error = nil,
        claude_initialized = current_info.claude_initialized or false,
        claude_session_id = current_info.claude_session_id,
        turn_count = (current_info.turn_count or 0) + 1,
    })
    ngx.log(ngx.INFO, "process_started session=", session_id, " pid=", proc:pid())

    local stderr_thread = ngx.thread.spawn(stderr_reader, proc, session_id)
    local wait_thread = ngx.thread.spawn(function()
        return proc:wait()
    end)

    local input = build_stream_json_input_line(session_id, body)
    if input:sub(-1) ~= "\n" then
        input = input .. "\n"
    end

    local bytes, write_err = proc:write(input)
    if not bytes then
        ngx.log(ngx.ERR, "stdin write failed for ", session_id, ": ", write_err)
        upsert_session(session_id, {
            status = "failed",
            last_error = "stdin write failed: " .. (write_err or "unknown"),
            last_finished_at = ngx.now()
        })
        ngx.log(ngx.ERR, "process_error session=", session_id, " stage=stdin_write error=", write_err or "unknown")
        pcall(function()
            proc:kill(9)
        end)
        if stderr_thread then
            pcall(ngx.thread.wait, stderr_thread)
        end
        release_lock(session_id)
        return
    end

    local ok, shutdown_err = proc:shutdown("stdin")
    if not ok then
        ngx.log(ngx.WARN, "stdin shutdown warning for ", session_id, ": ", shutdown_err)
    end

    local stdout_ok, stdout_err = stdout_reader(proc, session_id)
    if not stdout_ok then
        ngx.log(ngx.ERR, "stdout read failed for ", session_id, ": ", stdout_err)
        upsert_session(session_id, {
            status = "failed",
            last_error = "stdout read failed: " .. (stdout_err or "unknown"),
            last_finished_at = ngx.now()
        })
        ngx.log(ngx.ERR, "process_error session=", session_id, " stage=stdout_read error=", stdout_err or "unknown")
    end

    local wait_ok, reason, status = ngx.thread.wait(wait_thread)
    local exit_code = status
    if not wait_ok then
        upsert_session(session_id, {
            status = "failed",
            last_error = tostring(reason) .. ":" .. tostring(status),
            last_exit_code = status,
            last_finished_at = ngx.now()
        })
    else
        upsert_session(session_id, {
            status = "idle",
            last_exit_code = exit_code or 0,
            last_finished_at = ngx.now()
        })
    end
    ngx.log(ngx.INFO, "process_exit session=", session_id, " reason=", tostring(reason), " status=", tostring(exit_code))

    if stderr_thread then
        local ok_wait, wait_err = ngx.thread.wait(stderr_thread)
        if not ok_wait and wait_err then
            ngx.log(ngx.WARN, "stderr reader failed for ", session_id, ": ", wait_err)
        end
    end

    release_lock(session_id)
end

function _M.spawn(session_id, body)
    local info, err = session_store.get(session_id)
    if not info then
        return nil, err or "session not found"
    end

    if not is_turn_request(body) then
        return nil, "invalid turn request"
    end

    if not acquire_lock(session_id) then
        return nil, "session busy"
    end

    publish_user_event(session_id, body)

    local prefix = ngx.config.prefix()
    local session_dir = os.getenv("CLAUDE_HUB_DIR") or (prefix .. "projects/" .. session_id)
    os.execute("mkdir -p " .. shell_quote(session_dir))
    local repo_ok, repo_err = ensure_session_repo(session_dir)
    if not repo_ok then
        return nil, repo_err or "failed to init session repo"
    end

    upsert_session(session_id, {
        status = "running",
        last_error = nil,
        last_input_at = ngx.now()
    })

    local ok, err = ngx.timer.at(0, function(premature, sid, turn_body, cwd)
        if premature then
            return
        end
        run_turn(sid, turn_body, cwd)
    end, session_id, body, session_dir)
    if not ok then
        release_lock(session_id)
        upsert_session(session_id, {
            status = "failed",
            last_error = "failed to schedule turn: " .. (err or "unknown"),
            last_finished_at = ngx.now()
        })
        return nil, "failed to schedule turn: " .. (err or "unknown")
    end

    return upsert_session(session_id, {
        status = "running",
        last_scheduled_at = ngx.now()
    })
end

function _M.list()
    local sessions, err = session_store.list()
    if not sessions then
        return nil, err
    end
    local dict = get_lock_dict()
    for _, info in ipairs(sessions) do
        info.locked = dict:get(lock_key(info.session_id)) ~= nil
    end
    return sessions
end

function _M.get(session_id)
    local info, err = session_store.get(session_id)
    if info then
        info.locked = get_lock_dict():get(lock_key(session_id)) ~= nil
    end
    return info, err
end

function _M.delete(session_id)
    local info, err = _M.get(session_id)
    if not info then
        if err == "not found" or not err then
            get_lock_dict():delete(lock_key(session_id))
            return true
        end
        return nil, err
    end

    if info.locked or info.status == "running" then
        return nil, "session busy"
    end

    local ok, del_err = session_store.delete(session_id)
    if not ok then
        return nil, del_err
    end
    get_lock_dict():delete(lock_key(session_id))
    return true
end

function _M.create(session_id)
    local info = {
        session_id = session_id,
        claude_initialized = false,
        turn_count = 0,
        status = "idle",
        created_at = ngx.now()
    }
    local stored, err = session_store.create(info)
    if not stored then
        return nil, err
    end
    return stored
end

return _M
