const PLUGIN_ID = "com.opencode.py.agent";
const DEFAULT_URL = "http://127.0.0.1:4096";
const REQUEST_TIMEOUT_MS = 15000;
let pluginInstance = null;
let registered = false;

function getAcode() {
  try {
    if (typeof window !== "undefined" && window.acode) return window.acode;
  } catch (_) {}
  try {
    if (typeof acode !== "undefined" && acode) return acode;
  } catch (_) {}
  return null;
}

function registerPlugin() {
  const api = getAcode();
  if (!api || typeof api.setPluginInit !== "function") {
    setTimeout(registerPlugin, 100);
    return;
  }
  if (registered) return;
  registered = true;
  pluginInstance = new OpenCodeAcodePlugin(api);
  try {
  api.setPluginInit(PLUGIN_ID, async (baseUrl, page, options) => {
    const opts = options || {};
    await pluginInstance.init(baseUrl, page, opts.ctx);
  });
  } catch (_) {}
  try {
    api.setPluginUnmount(PLUGIN_ID, () => {
      try { pluginInstance.destroy(); } catch (_) {}
    });
  } catch (_) {}
}

function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildBridgeCommand(url, token, method, bodyText) {
  const parts = [
    "export",
    "OC_URL=" + shQuote(url),
    "OC_TOKEN=" + shQuote(token),
    "OC_METHOD=" + shQuote(method),
    "OC_DATA=" + shQuote(bodyText || ""),
    ";",
    "(command -v curl >/dev/null 2>&1 && if [ -n \"$OC_DATA\" ]; then",
    "curl -sS -m 12 -X \"$OC_METHOD\"",
    "-H 'Accept: application/json'",
    "-H 'Content-Type: application/json'",
    "-H \"Authorization: Bearer $OC_TOKEN\"",
    "--data \"$OC_DATA\" \"$OC_URL\";",
    "else",
    "curl -sS -m 12 -X \"$OC_METHOD\"",
    "-H 'Accept: application/json'",
    "-H \"Authorization: Bearer $OC_TOKEN\"",
    "\"$OC_URL\"; fi)",
    "||",
    "(command -v wget >/dev/null 2>&1 && if [ -n \"$OC_DATA\" ]; then",
    "wget -qO- -T 12",
    "--header='Accept: application/json'",
    "--header='Content-Type: application/json'",
    "--header=\"Authorization: Bearer $OC_TOKEN\"",
    "--post-data=\"$OC_DATA\" \"$OC_URL\";",
    "else",
    "wget -qO- -T 12",
    "--header='Accept: application/json'",
    "--header=\"Authorization: Bearer $OC_TOKEN\"",
    "\"$OC_URL\"; fi)"
  ];
  return parts.join(" ");
}

class OpenCodeAcodePlugin {
  constructor(acodeApi) {
    this.acode = acodeApi || null;
    this.sidebarApps = null;
    this.commands = null;
    this.ctx = null;
    this.page = null;
    this.url = DEFAULT_URL;
    this.token = "";
    this.acodexUrl = "http://localhost:8767";
    this.acodexToken = "";
    this.baseUrl = "";
    this.bridgePort = 8768;
    this.bridgeProcessId = "";
    this.bridgeReady = false;
    this.bridgeError = "";
    this.sessionId = "";
    this.controller = null;
    this.container = null;
    this.edgeHandle = null;
    this.edgeTries = 0;
  }

  async init(baseUrl, page, ctx) {
    this.baseUrl = String(baseUrl || "");
    this.page = page || null;
    this.ctx = ctx || null;
    if (this.ctx) {
      try {
        const savedUrl = await this.ctx.getSecret("server_url");
        if (savedUrl) this.url = savedUrl;
        this.token = "";
      } catch (_) {}
    }
    if (this.acode) {
      try { this.sidebarApps = this.acode.require("sidebarApps"); } catch (_) { this.sidebarApps = null; }
      try { this.commands = this.acode.require("commands"); } catch (_) { this.commands = null; }
    }
    if (this.sidebarApps) {
      try {
        this.sidebarApps.add("icon chat", PLUGIN_ID, "OpenCode Agent", container => this.mount(container), true, container => this.mount(container));
      } catch (_) {}
    }
    if (this.commands) {
      try {
        this.commands.addCommand({
          name: "opencode.agent.open",
          description: "Open OpenCode Agent",
          exec: () => { this.openPage(); return true; }
        });
      } catch (_) {}
    }
    this.addEdgeHandle();
    this.waitForNativeHttp(1500).then(http => {
      if (!http) this.startBridge().catch(() => {});
    });
  }

  addEdgeHandle() {
    try {
      if (this.edgeHandle) return;
      if (typeof document === "undefined" || !document.body || typeof document.createElement !== "function") {
        if (++this.edgeTries < 40) setTimeout(() => this.addEdgeHandle(), 250);
        return;
      }
      const handle = document.createElement("button");
      handle.type = "button";
      handle.textContent = "OpenCode";
      handle.title = "Open OpenCode Agent";
      handle.style.cssText = "position:fixed;right:0;top:38%;z-index:2147483647;writing-mode:vertical-rl;text-orientation:mixed;border:1px solid #4b83d5;border-right:0;border-radius:10px 0 0 10px;background:#205da9;color:#fff;font:600 12px system-ui,sans-serif;padding:12px 5px;box-shadow:0 4px 14px #0008;cursor:pointer";
      handle.onclick = () => { try { this.openPage(); } catch (_) {} };
      document.body.appendChild(handle);
      this.edgeHandle = handle;
    } catch (_) {
      if (++this.edgeTries < 40) setTimeout(() => this.addEdgeHandle(), 250);
    }
  }

  bridgeScriptPath() {
    try {
      if (!this.baseUrl) return "";
      const path = decodeURIComponent(new URL(this.baseUrl).pathname).replace(/\/$/, "");
      return path ? path + "/bridge.js" : "";
    } catch (_) {
      return "";
    }
  }

  async startBridge() {
    if (this.bridgeReady) return true;
    const executor = this.commandBridge();
    const script = this.bridgeScriptPath();
    if (!executor || !script) { this.bridgeError = "Acode bridge path unavailable"; return false; }
    const command = "node " + shQuote(script) + " --port " + this.bridgePort;
    try {
      if (typeof executor.start === "function") {
        this.bridgeProcessId = await executor.start(command, (type) => {
          if (type === "exit") this.bridgeReady = false;
        }, true);
      } else if (typeof executor.execute === "function") {
        this.bridgeProcessId = String(await executor.execute("nohup " + command + " >/dev/null 2>&1 & echo $!", true)).trim();
      } else {
        this.bridgeError = "Acode executor has no process API";
        return false;
      }
    } catch (_) {
      this.bridgeError = "Acode could not start the bundled bridge";
      return false;
    }
    for (let i = 0; i < 20; i++) {
      try {
        const response = await fetch("http://127.0.0.1:" + this.bridgePort + "/__bridge_health", { cache: "no-store" });
        if (response.ok) {
          this.bridgeReady = true;
          this.bridgeError = "";
          return true;
        }
      } catch (_) {
      }
      await sleep(100);
    }
    this.bridgeError = "Bundled bridge did not become ready";
    return false;
  }

  async stopBridge() {
    if (!this.bridgeProcessId) return;
    const executor = this.commandBridge();
    try {
      if (executor && typeof executor.stop === "function") await executor.stop(this.bridgeProcessId);
    } catch (_) {
    }
    this.bridgeProcessId = "";
    this.bridgeReady = false;
  }

  openPage() {
    try {
      if (!this.page) return false;
      const host = document.createElement("div");
      if (typeof this.page.replaceChildren === "function") this.page.replaceChildren();
      else this.page.innerHTML = "";
      if (typeof this.page.appendBody === "function") this.page.appendBody(host);
      else if (typeof this.page.appendChild === "function") this.page.appendChild(host);
      else return false;
      this.mount(host);
      if (typeof this.page.show === "function") this.page.show();
      return true;
    } catch (_) {
      return false;
    }
  }

  mount(container) {
    try {
      if (!container || typeof container.querySelector !== "function") return;
      this.container = container;
      if (typeof container.replaceChildren === "function") container.replaceChildren();
      else container.innerHTML = "";
      container.innerHTML = `<style>
      .oc-panel{display:flex;flex-direction:column;gap:9px;height:100%;padding:11px;box-sizing:border-box;font:13px system-ui,sans-serif;color:#eef2f7;background:#10141c}.oc-head{display:flex;align-items:center;gap:8px;border-bottom:1px solid #2b3545;padding-bottom:8px}.oc-brand{font-weight:700;font-size:16px}.oc-badge{margin-left:auto;padding:4px 8px;border-radius:99px;border:1px solid #3a4659;color:#aeb8c7;font-size:11px;white-space:nowrap}.oc-badge.online{color:#8fe0ad;border-color:#2c8050}.oc-badge.error{color:#ffaaa2;border-color:#87443e}.oc-panel input,.oc-panel textarea{box-sizing:border-box;width:100%;background:#090b10;color:#eef2f7;border:1px solid #344054;border-radius:8px;padding:9px}.oc-panel textarea{min-height:70px;resize:vertical}.oc-panel button{border:0;border-radius:8px;background:#2765ba;color:#fff;padding:9px;font-weight:600}.oc-panel button.secondary{background:#293548}.oc-actions{display:flex;gap:6px;flex-wrap:wrap}.oc-actions button{flex:1}.oc-output{flex:1;min-height:100px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#090b10;border:1px solid #2b3545;border-radius:8px;padding:9px}.oc-error{color:#ffaaa2}.oc-hint{color:#9aa5b5;font-size:12px}
    </style><div class="oc-panel"><div class="oc-head"><span class="oc-brand">OpenCode Agent</span><span id="oc-connection" class="oc-badge">Not connected</span></div><div class="oc-hint">Start the server from the main OpenCode TUI, then connect.</div><div id="oc-diag" class="oc-hint"></div><input id="oc-url" placeholder="Server URL"><input id="oc-token" type="text" autocomplete="off" placeholder="Enter server token"><div class="oc-actions"><button id="oc-connect">Connect</button><button id="oc-new" class="secondary">New session</button><button id="oc-refresh" class="secondary">Refresh</button><button id="oc-stop" class="secondary">Stop task</button></div><div id="oc-output" class="oc-output"></div><textarea id="oc-prompt" placeholder="Ask the agent..."></textarea><button id="oc-send">Send message</button></div>`;
      const get = id => container.querySelector("#" + id);
      const ids = ["oc-url", "oc-token", "oc-connect", "oc-new", "oc-refresh", "oc-stop", "oc-send", "oc-output", "oc-prompt", "oc-connection"];
      for (const id of ids) {
        if (!get(id)) throw new Error("Panel failed to load");
      }
      get("oc-url").value = this.url;
      get("oc-token").value = this.token;
      get("oc-connect").onclick = () => this.runAction(() => this.connect(get("oc-url").value, get("oc-token").value, get("oc-output"), get("oc-connection")), get("oc-output"), get("oc-connection"));
      get("oc-new").onclick = () => this.runAction(() => this.newSession(get("oc-output"), get("oc-connection")), get("oc-output"), get("oc-connection"));
      get("oc-refresh").onclick = () => this.runAction(() => this.refresh(get("oc-output"), get("oc-connection")), get("oc-output"), get("oc-connection"));
      get("oc-stop").onclick = () => this.runAction(() => this.abort(), get("oc-output"), get("oc-connection"));
      get("oc-send").onclick = () => this.runAction(() => this.send(get("oc-prompt"), get("oc-output"), get("oc-connection")), get("oc-output"), get("oc-connection"));
    } catch (error) {
      try {
        container.innerHTML = "<div style='padding:12px;color:#ffaaa2'>OpenCode panel failed to load. Reopen it from the extensions tab.</div>";
      } catch (_) {}
    }
  }

  setConnection(label, state, element) {
    try {
      if (!element) return;
      element.textContent = label;
      element.className = "oc-badge" + (state ? " " + state : "");
    } catch (_) {}
  }

  async saveSettings(url, token) {
    this.url = String(url || "").trim().replace(/\/$/, "") || DEFAULT_URL;
    this.token = String(token || "").trim();
    if (this.ctx) {
      try {
        await this.ctx.setSecret("server_url", this.url);
        await this.ctx.setSecret("server_token", this.token);
      } catch (_) {}
    }
  }

  async waitForNativeHttp(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 0);
    do {
      const http = this.nativeHttp();
      if (http && typeof http.sendRequest === "function") return http;
      await sleep(100);
    } while (Date.now() < deadline);
    return null;
  }

  urlCandidates() {
    const values = [this.url];
    try {
      const parsed = new URL(this.url);
      if (parsed.hostname === "127.0.0.1") values.push("http://localhost:" + parsed.port);
      if (parsed.hostname === "localhost") values.push("http://127.0.0.1:" + parsed.port);
    } catch (_) {
    }
    return values.filter((value, index, list) => list.indexOf(value) === index);
  }

  nativeHttp() {
    try {
      if (typeof window !== "undefined" && window.cordova && window.cordova.plugin && window.cordova.plugin.http) return window.cordova.plugin.http;
    } catch (_) {}
    try {
      if (typeof cordova !== "undefined" && cordova.plugin && cordova.plugin.http) return cordova.plugin.http;
    } catch (_) {}
    return null;
  }

  nativeRequest(method, path, payload, baseUrl) {
    const http = this.nativeHttp();
    if (!http || typeof http.sendRequest !== "function") return null;
    const url = String(baseUrl || this.url).replace(/\/$/, "") + "/api/v1/" + path;
    const options = {
      method,
      headers: { "Accept": "application/json", "Authorization": "Bearer " + this.token },
      responseType: "text",
      serializer: "json",
      connectTimeout: 15,
      readTimeout: 60,
      followRedirect: true
    };
    if (payload !== undefined) options.data = payload;
    return new Promise((resolve, reject) => {
      http.sendRequest(url, options, response => {
        const status = Number(response && response.status) || 0;
        let data = response && response.data;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (_) { data = { error: data }; }
        }
        if (status >= 400) {
          const message = data && data.error ? data.error : "Server returned HTTP " + status;
          reject(new Error(message));
          return;
        }
        resolve(data || {});
      }, error => {
        const message = error && (error.error || error.message || error.exception) ? (error.error || error.message || error.exception) : "Native Acode HTTP request failed";
        reject(new Error(String(message)));
      });
    });
  }

  acodexRequest(method, path, payload) {
    const command = buildBridgeCommand(this.url.replace(/\/$/, "") + "/api/v1/" + path, this.token, method, payload || "");
    const headers = { "Content-Type": "application/json" };
    if (this.acodexToken) headers.Authorization = "Bearer " + this.acodexToken;
    return fetch(this.acodexUrl.replace(/\/$/, "") + "/execute-command", {
      method: "POST",
      headers,
      body: JSON.stringify({ command })
    }).then(async response => {
      const text = await response.text();
      if (!response.ok) throw new Error("AcodeX bridge returned HTTP " + response.status);
      let data = null;
      try { data = JSON.parse(text); } catch (_) { data = null; }
      if (!data) throw new Error("AcodeX bridge returned invalid JSON");
      const output = String(data.output || "").trim();
      if (!output) throw new Error("Server is OFF. Turn server on/off ON in /setting, then connect again.");
      const start = output.lastIndexOf("\n{") >= 0 ? output.lastIndexOf("\n{") + 1 : output.lastIndexOf("{");
      const candidate = start >= 0 ? output.slice(start) : output;
      let result = null;
      try { result = JSON.parse(candidate); } catch (_) { result = null; }
      if (!result) throw new Error("OpenCode response was not valid JSON");
      if (result.error) throw new Error(result.error);
      return result;
    }).catch(error => {
      if (error && error.name === "TypeError") throw new Error("AcodeX bridge is not reachable at " + this.acodexUrl);
      throw error;
    });
  }

  commandBridge() {
    try {
      if (typeof Executor !== "undefined" && Executor && (typeof Executor.execute === "function" || typeof Executor.start === "function")) return Executor;
    } catch (_) {}
    try {
      if (typeof window !== "undefined" && window.Executor && (typeof window.Executor.execute === "function" || typeof window.Executor.start === "function")) return window.Executor;
    } catch (_) {}
    return null;
  }

  bridgeUrl(path) {
    const base = this.bridgeReady ? "http://127.0.0.1:" + this.bridgePort : this.url;
    return base.replace(/\/$/, "") + "/api/v1/" + path;
  }

  diag(text) {
    try {
      const el = this.container && typeof this.container.querySelector === "function"
        ? this.container.querySelector("#oc-diag") : null;
      if (el) el.textContent = String(text || "");
    } catch (_) {}
  }

  async bridgeRequest(method, path, bodyText) {
    const bridge = this.commandBridge();
    if (!bridge) { this.diag("diag: no Acode command bridge found"); throw new Error("Acode command bridge is unavailable"); }
    const command = buildBridgeCommand(this.bridgeUrl(path), this.token, method, bodyText || "");
    let text = "";
    try {
      text = await bridge.execute(command, true);
    } catch (_) {
      try {
        text = await bridge.execute(command, false);
      } catch (_) {
        throw new Error("Could not reach the server. Check that server on/off is ON in /setting.");
      }
    }
    text = String(text || "").trim();
    if (!text) throw new Error("Could not reach the server. Check that server on/off is ON in /setting.");
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error("Server returned an unreadable response.");
    }
    if (data && data.error) throw new Error(data.error);
    return data || {};
  }

  async request(path, options) {
    const opts = options || {};
    const method = opts.method || "GET";
    const headers = { "Accept": "application/json", "Authorization": "Bearer " + this.token };
    if (this.bridgeReady) headers["X-OpenCode-Target"] = this.url;
    let payload;
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof opts.body === "string") payload = opts.body;
      else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(opts.body); }
    }
    const native = await this.waitForNativeHttp(3000);
    if (native) {
      let nativePayload = payload;
      if (typeof nativePayload === "string") {
        try { nativePayload = JSON.parse(nativePayload); } catch (_) { nativePayload = nativePayload; }
      }
      let nativeError = null;
      for (const candidate of this.urlCandidates()) {
        try {
          return await this.nativeRequest(method, path, nativePayload, candidate);
        } catch (error) {
          nativeError = error;
          if (error && (error.message || "").match(/401|Unauthorized|Token/i)) break;
        }
      }
      if (nativeError && (nativeError.message || "").match(/401|Unauthorized|Token/i)) throw nativeError;
      this.diag("diag: native Acode HTTP failed, trying direct/bridge transport");
    }
    const url = this.bridgeUrl(path);
    const fetchOptions = { method, mode: "cors", cache: "no-store", headers };
    if (payload !== undefined) fetchOptions.body = payload;
    this.diag("diag: trying fetch -> " + url);
    let webError = null;
    let webResult = null;
    let timer = null;
    try {
      webResult = await Promise.race([
        fetch(url, fetchOptions).then(async response => {
          const text = await response.text();
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
          if (!response.ok) throw new Error(data.error || ("Server error " + response.status));
          return data;
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Request timed out")), REQUEST_TIMEOUT_MS); })
      ]);
    } catch (error) {
      webError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (webResult) { this.diag("diag: fetch ok"); return webResult; }
    if (webError && webError.name === "TypeError") {
      this.diag("diag: WebView fetch blocked, trying AcodeX execute-command bridge");
      try {
        return await this.acodexRequest(method, path, payload);
      } catch (acodexError) {
        this.diag("diag: AcodeX bridge failed, trying Acode command bridge");
        try {
          return await this.bridgeRequest(method, path, payload);
        } catch (_) {
          throw acodexError;
        }
      }
    }
    throw webError || new Error("Request failed");
  }

  async runAction(action, output, badge) {
    try {
      await action();
    } catch (error) {
      this.setConnection("Error", "error", badge);
      try {
        if (output) {
          output.classList.add("oc-error");
          output.textContent = error && error.message ? error.message : String(error);
        }
      } catch (_) {}
    }
  }

  async connect(url, token, output, badge) {
    this.setConnection("Connecting...", "", badge);
    try {
      await this.saveSettings(url, token);
      if (!this.token) throw new Error("Enter the server token shown in /setting.");
      const nativeReady = await this.waitForNativeHttp(3000);
      if (!nativeReady && !this.bridgeReady) await this.startBridge();
      const info = await this.request("info");
      const sessions = await this.request("sessions");
      const list = (sessions && sessions.sessions) || [];
      this.sessionId = list.length ? list[0].id : "";
      if (!this.sessionId) await this.newSession(output, badge);
      else await this.refresh(output, badge);
      this.setConnection("Connected", "online", badge);
      output.textContent = "Connected to " + (info.directory || this.url) + "\n\n" + output.textContent;
    } catch (error) {
      this.setConnection("Connection failed", "error", badge);
      const detail = error && error.message ? error.message : String(error);
      if (this.bridgeError && !this.bridgeReady) {
        this.setConnection("Bridge unavailable", "error", badge);
        output.textContent = "The server may be ON, but Acode's bundled bridge could not start: " + this.bridgeError;
      } else if (detail.indexOf("401") >= 0 || detail.toLowerCase().indexOf("unauthorized") >= 0 || detail.toLowerCase().indexOf("token") >= 0) {
        output.textContent = "Token rejected. Turn server on/off in /setting again and paste the newly copied token.";
      } else if (detail.toLowerCase().indexOf("server is off") >= 0 || detail.toLowerCase().indexOf("could not reach") >= 0 || detail.toLowerCase().indexOf("bridge is not reachable") >= 0) {
        this.setConnection("Server OFF", "error", badge);
        output.textContent = "Server is OFF. Turn server on/off ON in /setting, then tap Connect again.";
      } else {
        output.textContent = detail;
      }
      try { output.classList.add("oc-error"); } catch (_) {}
    }
  }

  async newSession(output, badge) {
    const data = await this.request("sessions", { method: "POST", body: { title: "Acode session" } });
    if (!data || !data.id) throw new Error("Server did not create a session.");
    this.sessionId = data.id;
    output.textContent = "New session ready.";
    this.setConnection("Connected", "online", badge);
  }

  async refresh(output, badge) {
    if (!this.sessionId) {
      this.setConnection("Connect first", "error", badge);
      return;
    }
    const data = await this.request("sessions/" + encodeURIComponent(this.sessionId));
    const messages = (data && data.messages) || [];
    const lines = [];
    for (const message of messages) {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      lines.push((message.role || "assistant") + ": " + content);
    }
    output.textContent = lines.length ? lines.join("\n\n") : "No messages yet.";
    const active = Boolean(data && data.runtime && data.runtime.active);
    this.setConnection(active ? "Working..." : "Connected", active ? "" : "online", badge);
  }

  async send(input, output, badge) {
    const content = String((input && input.value) || "").trim();
    if (!content) {
      this.setConnection("Enter a message", "", badge);
      return;
    }
    if (!this.sessionId) {
      this.setConnection("Connect first", "error", badge);
      return;
    }
    input.value = "";
    try {
      await this.request("sessions/" + encodeURIComponent(this.sessionId) + "/messages", { method: "POST", body: { content } });
      try {
        await this.stream(output, badge);
      } catch (streamError) {
        if (streamError && streamError.name === "TypeError") {
          await this.pollTurn(output, badge);
        } else {
          throw streamError;
        }
      }
    } catch (error) {
      output.textContent += "\n" + (error && error.message ? error.message : String(error));
    }
  }

  async pollTurn(output, badge) {
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      await this.refresh(output, badge);
      const label = badge && badge.textContent ? badge.textContent : "";
      if (label !== "Working...") return;
    }
    this.setConnection("Still working — tap Refresh", "", badge);
  }

  async stream(output, badge) {
    if (this.controller) { try { this.controller.abort(); } catch (_) {} }
    this.controller = new AbortController();
    this.setConnection("Working...", "", badge);
    if (this.nativeHttp()) {
      try {
        await this.pollTurn(output, badge);
        return;
      } catch (error) {
        this.setConnection("Error", "error", badge);
        output.textContent += "\n" + (error && error.message ? error.message : String(error));
        return;
      }
    }
    try {
      const streamHeaders = { "Authorization": "Bearer " + this.token };
      if (this.bridgeReady) streamHeaders["X-OpenCode-Target"] = this.url;
      const response = await fetch(this.bridgeUrl("sessions/" + encodeURIComponent(this.sessionId) + "/events?after=0"), { mode: "cors", cache: "no-store", headers: streamHeaders, signal: this.controller.signal });
      if (!response.ok) throw new Error("Event stream failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let split = -1;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const lines = block.split("\n");
          for (const line of lines) {
            if (line.indexOf("data:") !== 0) continue;
            let event = null;
            try { event = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (!event) continue;
            if (event.kind === "text_delta") output.textContent += event.text || "";
            if (event.kind === "error" || event.kind === "turn_error") output.textContent += "\n" + (event.error || "Agent error");
            if (event.kind === "turn_complete") { await this.refresh(output, badge); return; }
          }
        }
      }
    } catch (error) {
      if (error && error.name === "AbortError") return;
      this.setConnection("Disconnected", "error", badge);
      throw error;
    }
  }

  async abort() {
    if (!this.sessionId) return;
    try {
      await this.request("sessions/" + encodeURIComponent(this.sessionId) + "/abort", { method: "POST", body: {} });
    } catch (_) {}
  }

  async destroy() {
    try {
      if (this.controller) this.controller.abort();
    } catch (_) {}
    this.stopBridge().catch(() => {});
    try {
      if (this.edgeHandle && typeof this.edgeHandle.remove === "function") this.edgeHandle.remove();
    } catch (_) {}
    this.edgeHandle = null;
    try {
      if (this.commands && typeof this.commands.removeCommand === "function") this.commands.removeCommand("opencode.agent.open");
    } catch (_) {}
    try {
      if (this.sidebarApps && typeof this.sidebarApps.remove === "function") this.sidebarApps.remove(PLUGIN_ID);
    } catch (_) {}
    this.container = null;
  }
}

registerPlugin();
