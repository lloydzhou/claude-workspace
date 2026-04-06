-- app.lua
-- Main application entry point using router.lua
-- All API routes are defined here in one place

local router = require "router"
local utils = require "utils"
local pm = require "process_manager"
local upload_manager = require "upload_manager"

local _M = {}

-- Build the router with all routes
local function build_router()
    local r = router.new()

    -- --- Session CRUD ---
    r:post("/api/sessions", function(params)
        local id = utils.uuid()
        local info, err = pm.create(id)
        if not info then
            utils.error_response("failed to create session: " .. (err or "unknown"), 500)
            return
        end
        utils.json_response({
            session_id = id,
            subscribe_url = "/sub/" .. id,
            publish_url = "/api/sessions/" .. id .. "/turn",
            info = info
        }, 201)
    end)

    r:get("/api/sessions", function(params)
        local sessions, err = pm.list()
        if not sessions then
            utils.error_response("failed to list sessions: " .. (err or "unknown"), 500)
            return
        end
        utils.json_response({ sessions = sessions })
    end)

    r:get("/api/sessions/:id", function(params)
        local info, err = pm.get(params.id)
        if not info then
            local status = (err == "not found") and 404 or 500
            utils.error_response("failed to load session: " .. (err or "unknown"), status)
            return
        end
        utils.json_response(info)
    end)

    r:delete("/api/sessions/:id", function(params)
        local ok, err = pm.delete(params.id)
        if not ok then
            local status = (err == "session busy") and 409 or 500
            utils.error_response("failed to delete session: " .. (err or "unknown"), status)
            return
        end
        utils.json_response({ status = "deleted", session_id = params.id })
    end)

    local function nchan_auth_handler()
        local headers = ngx.req.get_headers()
        local session_id = headers["X-Channel-Id"] or headers["x-channel-id"]
        if not session_id or session_id == "" then
            utils.error_response("missing channel id", 400)
            return
        end
        if not utils.is_uuid(session_id) then
            utils.error_response("invalid channel id", 403)
            return
        end

        local info = pm.get(session_id)
        if not info then
            utils.error_response("session not found", 403)
            return
        end

        ngx.status = ngx.HTTP_OK
        ngx.say("ok")
        return ngx.exit(ngx.HTTP_OK)
    end

    r:get("/api/nchan/auth", function()
        nchan_auth_handler()
    end)

    r:post("/api/nchan/auth", function()
        nchan_auth_handler()
    end)

    -- --- Publish one Claude turn ---
    r:post("/api/sessions/:id/turn", function(params)
        local session_id = params.id
        if not utils.is_uuid(session_id) then
            utils.error_response("invalid session id", 400)
            return
        end
        local info = pm.get(session_id)
        if not info then
            utils.error_response("session not found", 404)
            return
        end

        local body = utils.read_body()
        if not body or body == "" then
            utils.error_response("empty body")
            return
        end

        local ok, err = pm.spawn(session_id, body)
        if not ok then
            local status = (err == "session busy") and 409 or 500
            utils.error_response(err or "failed to start turn", status)
            return
        end

        utils.json_response({ status = "queued", session_id = session_id }, 202)
    end)

    r:post("/api/sessions/:id/uploads", function(params)
        local session_id = params.id
        if not utils.is_uuid(session_id) then
            utils.error_response("invalid session id", 400)
            return
        end
        local info = pm.get(session_id)
        if not info then
            utils.error_response("session not found", 404)
            return
        end

        local headers = ngx.req.get_headers()
        local raw_body = utils.read_raw_body()
        local uploaded, err = upload_manager.save(session_id, {
            filename = headers["X-Filename"] or headers["x-filename"] or headers["X-Upload-Filename"] or headers["x-upload-filename"] or headers["Content-Disposition"] or headers["content-disposition"],
            mime_type = headers["Content-Type"] or headers["content-type"],
        }, raw_body)
        if not uploaded then
            utils.error_response(err or "failed to upload file", 400)
            return
        end

        utils.json_response({
            uploaded = uploaded,
            session_id = session_id,
        }, 201)
    end)

    -- --- Health check ---
    r:get("/api/health", function(params)
        utils.json_response({ status = "ok", timestamp = ngx.now() })
    end)

    return r
end

-- Cache the router instance at module level (built once per worker)
local r = build_router()

function _M.dispatch()
    local method = ngx.req.get_method()
    local uri = ngx.var.uri

    -- Strip trailing slash (except root)
    if uri ~= "/" and uri:sub(-1) == "/" then
        uri = uri:sub(1, -2)
    end

    local ok, err = r:execute(method, uri, ngx.req.get_uri_args())
    if not ok then
        ngx.log(ngx.WARN, "route not found: ", method, " ", uri, " - ", tostring(err))
        utils.error_response("not found", 404)
    end
end

return _M
