local _M = {}

local cjson = require "cjson.safe"
local ok_bit, bit = pcall(require, "bit")

local band = ok_bit and bit.band or function(a, b)
    local result = 0
    local bitval = 1
    while a > 0 and b > 0 do
        local a1 = a % 2
        local b1 = b % 2
        if a1 == 1 and b1 == 1 then
            result = result + bitval
        end
        a = math.floor(a / 2)
        b = math.floor(b / 2)
        bitval = bitval * 2
    end
    return result
end

local bor = ok_bit and bit.bor or function(a, b)
    local result = 0
    local bitval = 1
    while a > 0 or b > 0 do
        local a1 = a % 2
        local b1 = b % 2
        if a1 == 1 or b1 == 1 then
            result = result + bitval
        end
        a = math.floor(a / 2)
        b = math.floor(b / 2)
        bitval = bitval * 2
    end
    return result
end

pcall(function()
    cjson.encode_empty_table_as_object(false)
end)

-- Generate UUID v4 (no external deps)
function _M.uuid()
    local f = io.open("/dev/urandom", "rb")
    if f then
        local bytes = f:read(16)
        f:close()
        if bytes and #bytes == 16 then
            local n = { string.byte(bytes, 1, 16) }
            n[7] = bor(band(n[7], 0x0f), 0x40)
            n[9] = bor(band(n[9], 0x3f), 0x80)
            return string.format(
                "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
                unpack(n)
            )
        end
    end

    -- Fallback for environments without /dev/urandom.
    local random = math.random
    local template = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    return string.gsub(template, "[xy]", function(c)
        local v = random(0, 0xf)
        if c == "x" then return string.format("%x", v) end
        return string.format("%x", (v % 4) + 8)
    end)
end

function _M.is_uuid(value)
    if type(value) ~= "string" then
        return false
    end
    local ok, matched = pcall(function()
        return ngx.re.match(value, [[^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$]], "ijo")
    end)
    return ok and matched ~= nil
end

-- Read request body as string
function _M.read_body()
    ngx.req.read_body()
    local body = ngx.req.get_body_data()
    if not body then
        local file = ngx.req.get_body_file()
        if file then
            local f = io.open(file, "r")
            if f then
                body = f:read("*a")
                f:close()
            end
        end
    end
    return body
end

function _M.read_raw_body()
    ngx.req.read_body()
    local body = ngx.req.get_body_data()
    if not body then
        local file = ngx.req.get_body_file()
        if file then
            local f = io.open(file, "rb")
            if f then
                body = f:read("*a")
                f:close()
            end
        end
    end
    return body
end

function _M.json_encode(data)
    return cjson.encode(data)
end

function _M.json_decode(str)
    if type(str) ~= "string" then return nil end
    return cjson.decode(str)
end

function _M.json_response(data, status)
    ngx.status = status or 200
    ngx.header["Content-Type"] = "application/json"
    ngx.say(cjson.encode(data))
    ngx.exit(ngx.status)
end

function _M.error_response(msg, status)
    _M.json_response({ error = msg }, status or 400)
end

return _M
