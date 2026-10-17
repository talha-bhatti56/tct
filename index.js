
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

const RESTART_DELAY = 2000;
const DATA_DIR = process.env.TCT_DATA_DIR || "/data";
const TCT_DATA_DIR = path.join(DATA_DIR, "data");

const platformMap = {
  linux: "tct-linux",
  win32: "tct-windows.exe",
  darwin: "tct-macos"
};

const binaryName = platformMap[process.platform] || "tct-linux";
const bundledBinaryPath = path.join(__dirname, binaryName);
const fallbackBinaryPath = path.join(DATA_DIR, binaryName);

const DOWNLOAD_URL =
  `https://github.com/i-tct/tct/releases/latest/download/${binaryName}`;

const CONFIG_TEMPLATE_URL =
  "https://gist.githubusercontent.com/i-tct/1433de6fbe3a14f2178e5429b46c31c0/raw";

let programPath = null;
let child = null;
let restarting = false;
let shuttingDown = false;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TCT_DATA_DIR, { recursive: true });

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) {
      return reject(new Error("Too many download redirects"));
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch (err) {
      return reject(err);
    }

    if (parsedUrl.protocol !== "https:") {
      return reject(new Error("Only HTTPS downloads are allowed"));
    }

    const request = https.get(parsedUrl, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.resume();

        if (!location) {
          return reject(new Error("Redirect did not include a location"));
        }

        const nextUrl = new URL(location, parsedUrl).toString();

        return downloadFile(nextUrl, destPath, redirects + 1)
          .then(resolve)
          .catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(
          new Error(`Download failed: HTTP ${res.statusCode}`)
        );
      }

      const file = fs.createWriteStream(destPath);

      res.pipe(file);

      file.on("finish", () => {
        file.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      file.on("error", (err) => {
        file.destroy();
        fs.unlink(destPath, () => reject(err));
      });

      res.on("error", (err) => {
        file.destroy();
        fs.unlink(destPath, () => reject(err));
      });
    });

    request.on("error", reject);
  });
}

async function downloadBinary() {
  for (const candidate of [bundledBinaryPath, fallbackBinaryPath]) {
    if (!fs.existsSync(candidate)) continue;

    const stats = fs.statSync(candidate);

    if (stats.isFile() && stats.size > 100000) {
      programPath = candidate;

      if (process.platform !== "win32") {
        fs.chmodSync(programPath, 0o755);
      }

      console.log(`Using existing TCT binary: ${programPath}`);
      return;
    }

    console.warn(`Ignoring invalid binary file: ${candidate}`);
  }

  // /app is read-only on Deplexo. Never download the binary there.
  if (process.env.TCT_REQUIRE_BUNDLED_BINARY === "true") {
    throw new Error(
      "TCT binary is missing from the Docker image. Rebuild the image."
    );
  }

  console.log(`Downloading TCT binary to writable storage: ${fallbackBinaryPath}`);

  await downloadFile(DOWNLOAD_URL, fallbackBinaryPath);

  const stats = fs.statSync(fallbackBinaryPath);

  if (!stats.isFile() || stats.size <= 100000) {
    throw new Error("Downloaded TCT binary is invalid or incomplete");
  }

  if (process.platform !== "win32") {
    fs.chmodSync(fallbackBinaryPath, 0o755);
  }

  programPath = fallbackBinaryPath;
  console.log("TCT binary downloaded successfully.");
}

function luaEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function generateMonitorPlugin() {
  const apiUrl = process.env.MONITOR_API_URL;
  const apiToken = process.env.MONITOR_API_TOKEN;

  if (!apiUrl || !apiToken) {
    console.log(
      "V2 Monitor plugin: environment variables not configured."
    );
    return;
  }

  const pluginDir = path.join(TCT_DATA_DIR, "plugins");
  fs.mkdirSync(pluginDir, { recursive: true });

  const pluginPath = path.join(pluginDir, "v2_monitor.lua");

  const plugin = `-- @name: V2 Trading Monitor
-- @commands: v2status
-- @global: true

local API_URL = "${luaEscape(apiUrl)}"
local API_TOKEN = "${luaEscape(apiToken)}"

local function get_headers()
  return {
    ["Authorization"] = "Bearer " .. API_TOKEN
  }
end

local function get_status()
  local code, body, err = bot.http_request(
    API_URL .. "/status",
    "GET",
    get_headers(),
    ""
  )

  if not code or code ~= 200 then
    bot.log_error("V2 Monitor API failed: HTTP " .. tostring(code) .. " " .. tostring(err))
    return nil
  end

  local data = bot.json_decode(body)

  if not data then
    bot.log_error("V2 Monitor returned invalid JSON.")
    return nil
  end

  return data
end

local function reason_from_comment(comment)
  comment = comment or ""
  local lower = string.lower(comment)

  if string.find(lower, "sl", 1, true) then
    return "SL"
  end

  if string.find(lower, "tp", 1, true) then
    return "TP"
  end

  return "OTHER"
end

local function format_number(value, decimals)
  value = tonumber(value) or 0
  return string.format("%." .. tostring(decimals) .. "f", value)
end

local function send_open_alert(position)
  local side = position.side or "UNKNOWN"
  local emoji = side == "LONG" and "??" or "??"
  local side_text = side == "LONG" and "BUY" or "SELL"

  local message =
    emoji .. " XAUUSDr " .. side_text .. "\\n\\n" ..
    "Entry: " .. format_number(position.entry, 3) .. "\\n" ..
    "SL: " .. format_number(position.sl, 3) .. "\\n" ..
    "TP: " .. format_number(position.tp, 3) .. "\\n" ..
    "Risk: 0.50%"

  local jid = bot.get_bot_jid()

  if jid then
    bot.send_message(jid, message)
  end
end

local function send_close_alert(deal)
  local side = deal.deal_side or "UNKNOWN"
  local emoji = side == "BUY" and "??" or "??"
  local reason = reason_from_comment(deal.comment)
  local result = tonumber(deal.profit) or 0
  local sign = result >= 0 and "+" or ""

  local message =
    emoji .. " XAUUSDr " .. side .. " CLOSED\\n\\n" ..
    "Result: " .. sign .. format_number(result, 2) .. " USD\\n" ..
    "Reason: " .. reason

  local jid = bot.get_bot_jid()

  if jid then
    bot.send_message(jid, message)
  end
end

local function initialize_state(data)
  local positions = {}

  if data.positions then
    for _, position in ipairs(data.positions) do
      positions[tostring(position.position_id)] = true
    end
  end

  local exits = {}

  if data.recent_deals then
    for _, deal in ipairs(data.recent_deals) do
      if deal.entry_type == "EXIT" then
        exits[tostring(deal.ticket)] = true
      end
    end
  end

  bot.plugin_store("known_positions", bot.json_encode(positions))
  bot.plugin_store("known_exits", bot.json_encode(exits))
  bot.plugin_store("initialized", "1")

  bot.log_info(
    "V2 Monitor initialized baseline without sending historical alerts."
  )
end

local function load_table(key)
  local raw = bot.plugin_fetch(key)

  if not raw or raw == "" then
    return {}
  end

  local data = bot.json_decode(raw)

  if not data then
    return {}
  end

  return data
end

local function poll_monitor()
  local data = get_status()

  if not data then
    return
  end

  local initialized = bot.plugin_fetch("initialized")

  if initialized ~= "1" then
    initialize_state(data)
    return
  end

  local known_positions = load_table("known_positions")
  local known_exits = load_table("known_exits")
  local current_positions = {}

  if data.positions then
    for _, position in ipairs(data.positions) do
      local position_id = tostring(position.position_id)

      current_positions[position_id] = true

      if not known_positions[position_id] then
        send_open_alert(position)
        bot.log_info(
          "V2 Monitor: new position alert sent for " .. position_id
        )
      end
    end
  end

  if data.recent_deals then
    for _, deal in ipairs(data.recent_deals) do
      if deal.entry_type == "EXIT" then
        local ticket = tostring(deal.ticket)

        if not known_exits[ticket] then
          send_close_alert(deal)
          bot.log_info(
            "V2 Monitor: close alert sent for deal " .. ticket
          )
          known_exits[ticket] = true
        end
      end
    end
  end

  bot.plugin_store("known_positions", bot.json_encode(current_positions))
  bot.plugin_store("known_exits", bot.json_encode(known_exits))
end

function on_cron(time)
  if time.minute % 5 ~= 0 then
    return
  end

  poll_monitor()
end

function on_message(msg)
  if not msg.command or msg.command ~= "v2status" then
    return
  end

  if not bot.is_owner(msg.sender) and not bot.is_sudo(msg.sender) then
    bot.reply(msg.chat, "? Owner/Sudo only.", msg.id, msg.sender)
    return
  end

  local data = get_status()

  if not data then
    bot.reply(msg.chat, "? V2 Monitor API unavailable.", msg.id, msg.sender)
    return
  end

  local position_count = 0

  if data.positions then
    for _ in ipairs(data.positions) do
      position_count = position_count + 1
    end
  end

  bot.reply(
    msg.chat,
    "? V2 Monitor API connected.\\n\\n" ..
    "Symbol: XAUUSDr\\n" ..
    "Active V2 positions: " .. tostring(position_count),
    msg.id,
    msg.sender
  )
end
`;

  fs.writeFileSync(pluginPath, plugin, "utf8");
  console.log(`V2 Monitor plugin generated: ${pluginPath}`);
}

async function generateConfig() {
  const candidates = [
    "TCTfile",
    "tctfile",
    "tctfile.yml",
    "config.yml"
  ].map((name) => path.join(DATA_DIR, name));

  let configFile = path.join(DATA_DIR, "tctfile");
  let content = "";
  let found = false;

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      configFile = candidate;
      content = fs.readFileSync(candidate, "utf8");
      console.log(`Detected existing config file: ${configFile}`);
      found = true;
      break;
    }
  }

  if (!found) {
    console.log("No config file found. Downloading default template...");

    try {
      await downloadFile(CONFIG_TEMPLATE_URL, configFile);
      content = fs.readFileSync(configFile, "utf8");
      console.log("Default config template downloaded.");
    } catch (err) {
      console.error("Failed to download config template:", err.message);
    }
  }

  let lines = content ? content.split("\n") : [];

  const legacyKeys = [
    "SESSION_ID",
    "PREFIX",
    "TIMEZONE",
    "OPENWEATHER_API_KEY",
    "MISTRAL_API_KEY"
  ];

  lines = lines.filter(
    (line) =>
      !legacyKeys.some((key) =>
        new RegExp(`^${key}\\s*:`, "i").test(line)
      )
  );

  const botsIndex = lines.findIndex((line) =>
    /^\s*BOTS\s*:/i.test(line)
  );

  if (botsIndex !== -1) {
    lines = lines.slice(0, botsIndex);
  }

  if (process.env.SESSION_ID) {
    lines.push("");
    lines.push("BOTS:");

    const sessions = process.env.SESSION_ID.split(",");

    for (const session of sessions) {
      const trimmed = session.trim();

      if (!trimmed) continue;

      lines.push(`  - SESSION_ID: "${trimmed}"`);

      if (process.env.PREFIX) {
        lines.push(`    PREFIX: "${process.env.PREFIX}"`);
      }

      if (process.env.TIMEZONE) {
        lines.push(`    TIMEZONE: "${process.env.TIMEZONE}"`);
      }

      if (process.env.OPENWEATHER_API_KEY) {
        lines.push(
          `    OPENWEATHER_API_KEY: "${process.env.OPENWEATHER_API_KEY}"`
        );
      }

      if (process.env.MISTRAL_API_KEY) {
        lines.push(
          `    MISTRAL_API_KEY: "${process.env.MISTRAL_API_KEY}"`
        );
      }
    }
  }

  const forceOverrideEnvVars = (key, value) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    const escaped = String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    const newLine = `${key}: "${escaped}"`;
    const regex = new RegExp(`^${key}\\s*:`, "i");
    let keyFound = false;

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        lines[i] = newLine;
        keyFound = true;
        break;
      }
    }

    if (!keyFound) {
      lines.push(newLine);
    }
  };

  forceOverrideEnvVars("POSTGRES_URL", process.env.POSTGRES_URL);
  forceOverrideEnvVars(
    "POSTGRES_SYNC_INTERVAL",
    process.env.POSTGRES_SYNC_INTERVAL
  );

  const dynamicPort =
    process.env.PORT ||
    process.env.server_port ||
    process.env.SERVER_PORT;

  if (dynamicPort) {
    forceOverrideEnvVars("SERVER_PORT", dynamicPort);
  }

  fs.writeFileSync(configFile, lines.join("\n"), "utf8");

  console.log("===== GENERATED TCT CONFIG CHECK =====");

  lines.forEach((line, index) => {
    let safeLine = line;

    if (/SESSION_ID:/i.test(safeLine)) {
      safeLine = safeLine.replace(
        /SESSION_ID:\s*".*"/i,
        'SESSION_ID: "***REDACTED***"'
      );
    }

    if (/MONITOR_API_TOKEN/i.test(safeLine)) {
      safeLine = safeLine.replace(/:.*/, ': "***REDACTED***"');
    }

    console.log(
      String(index + 1).padStart(3, "0") + " | " + safeLine
    );
  });

  console.log("===== END GENERATED TCT CONFIG CHECK =====");
}

async function start() {
  if (shuttingDown || restarting) return;

  try {
    await generateConfig();
    generateMonitorPlugin();

    console.log(`Starting TCT from ${programPath}`);
    console.log(`TCT working directory: ${DATA_DIR}`);

    child = spawn(programPath, [], {
      cwd: DATA_DIR,
      stdio: "inherit",
      env: process.env
    });

    child.on("close", (code, signal) => {
      console.log(
        `TCT process exited. Code: ${code}; signal: ${signal || "none"}`
      );

      child = null;
      scheduleRestart();
    });

    child.on("error", (err) => {
      console.error("Failed to start TCT:", err.message);
      child = null;
      scheduleRestart();
    });
  } catch (err) {
    console.error("Startup failed:", err.message);
    scheduleRestart();
  }
}

function scheduleRestart() {
  if (shuttingDown || restarting) return;

  restarting = true;

  console.log(`Restarting in ${RESTART_DELAY / 1000}s...`);

  setTimeout(async () => {
    restarting = false;

    if (!shuttingDown) {
      await start();
    }
  }, RESTART_DELAY);
}

async function main() {
  try {
    await downloadBinary();
    await start();
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
}

function shutdown() {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log("Shutting down...");

  if (child) {
    child.kill("SIGTERM");
  }

  setTimeout(() => process.exit(0), 1000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();
