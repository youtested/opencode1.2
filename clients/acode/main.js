function requireAcode(name) {
  try { return window.acode ? window.acode.require(name) : null; } catch (_) { return null; }
}
const sidebarApps = requireAcode("sidebarApps");
const commands = requireAcode("commands");
const pageApi = requireAcode("page");
const DEFAULT_URL = "http://127.0.0.1:4096";

class OpenCodeAcodePlugin {
  constructor() {
    this.ctx = null;
    this.url = DEFAULT_URL;
    this.token = "";
    this.sessionId = "";
    this.controller = null;
    this.container = null;
    this.page = null;
    this.edgeHandle = null;
  }

  async init(pageElement, _cacheFile, _cacheFileUrl, _firstInit, ctx) {
    this.page = pageElement;
    this.ctx = ctx || null;
    if (this.ctx) {
      try {
        this.url = (await this.ctx.getSecret("server_url")) || DEFAULT_URL;
        this.token = (await this.ctx.getSecret("server_token")) || "";
      } catch (_) {
        this.url = DEFAULT_URL;
        this.token = "";
      }
    }
    if (sidebarApps) {
      sidebarApps.add("icon chat", "opencode.agent", "OpenCode Agent", container => this.mount(container), true, container => this.mount(container));
    }
    if (commands) {
      commands.addCommand({
        name: "opencode.agent.open",
        description: "Open OpenCode Agent",
        exec: () => {
          this.openPage();
          return true;
        }
      });
    }
    this.addEdgeHandle();
  }

  addEdgeHandle() {
    if (this.edgeHandle || typeof document === "undefined") return;
    if (!document.body) { setTimeout(() => this.addEdgeHandle(), 50); return; }
    const handle = document.createElement("button");
    handle.type = "button";
    handle.textContent = "OpenCode";
    handle.title = "Open OpenCode Agent";
    handle.setAttribute("aria-label", "Open OpenCode Agent");
    handle.style.cssText = "position:fixed;right:0;top:38%;z-index:2147483647;writing-mode:vertical-rl;text-orientation:mixed;border:1px solid #4b83d5;border-right:0;border-radius:10px 0 0 10px;background:#205da9;color:#fff;font:600 12px system-ui,sans-serif;padding:12px 5px;box-shadow:0 4px 14px #0008;cursor:pointer";
    handle.onclick = () => this.openPage();
    document.body.appendChild(handle);
    this.edgeHandle = handle;
  }

  removeEdgeHandle() {
    if (this.edgeHandle) this.edgeHandle.remove();
    this.edgeHandle = null;
  }

  openPage() {
    if (!this.page) {
      if (!pageApi) return false;
      this.page = pageApi("OpenCode Agent");
    }
    const host = document.createElement("div");
    if (typeof this.page.replaceChildren === "function") this.page.replaceChildren();
    else this.page.innerHTML = "";
    if (typeof this.page.appendBody === "function") this.page.appendBody(host);
    else this.page.appendChild(host);
    this.mount(host);
    if (typeof this.page.show === "function") this.page.show();
    return true;
  }

  mount(container) {
    this.container = container;
    container.replaceChildren();
    container.innerHTML = `<style>
      .oc-panel{display:flex;flex-direction:column;gap:10px;height:100%;padding:12px;box-sizing:border-box;font:13px/1.45 system-ui,-apple-system,sans-serif;color:#eef2f7;background:linear-gradient(180deg,#151923 0%,#0b0e14 100%)}
      .oc-header{display:flex;align-items:center;gap:9px;padding:2px 1px 8px;border-bottom:1px solid #293140}.oc-brand{font-size:16px;font-weight:700;letter-spacing:.1px}.oc-brand small{display:block;color:#8d99aa;font-size:11px;font-weight:400;margin-top:2px}.oc-badge{margin-left:auto;border:1px solid #394558;border-radius:999px;padding:4px 9px;color:#aeb8c7;font-size:11px;background:#111722}.oc-badge.online{color:#8fe0ad;border-color:#2c8050;background:#12321f}.oc-badge.error{color:#ffaaa2;border-color:#87443e;background:#321a1a}
      .oc-hint{color:#8d99aa;font-size:12px;padding:0 1px}.oc-fields{display:grid;gap:7px}.oc-panel input,.oc-panel textarea{width:100%;box-sizing:border-box;background:#0a0d12;color:#eef2f7;border:1px solid #303a4a;border-radius:9px;padding:10px 11px;outline:none}.oc-panel input:focus,.oc-panel textarea:focus{border-color:#5d8fe0;box-shadow:0 0 0 2px #274a7b55}.oc-panel textarea{min-height:76px;resize:vertical}.oc-actions{display:flex;gap:7px;flex-wrap:wrap}.oc-panel button{border:1px solid #334155;border-radius:9px;background:#1c2635;color:#eef2f7;padding:9px 12px;font-weight:600}.oc-panel button.primary{background:#2861b8;border-color:#4b83d5}.oc-panel button:hover{border-color:#6ea0ec}.oc-output{flex:1;min-height:110px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080a0e;color:#dce4ee;border:1px solid #252e3c;border-radius:10px;padding:11px}.oc-output:empty::before{content:"Your conversation will appear here.";color:#657184}.oc-error{color:#ffaaa2}.oc-send{width:100%;margin-top:1px}@media(max-width:520px){.oc-panel{padding:9px}.oc-actions button{flex:1}.oc-output{min-height:90px}}
    </style><div class="oc-panel"><header class="oc-header"><div class="oc-brand">OpenCode Agent<small>AI coding inside Acode</small></div><span id="oc-connection" class="oc-badge">Not connected</span></header><div class="oc-hint">Start the coding server from the main OpenCode `/setting` popup, then connect below.</div><div class="oc-fields"><input id="oc-url" placeholder="Server URL (for example http://127.0.0.1:4096)"><input id="oc-token" type="password" autocomplete="off" placeholder="Server token"></div><div class="oc-actions"><button id="oc-connect" class="primary">Connect</button><button id="oc-new">New session</button><button id="oc-refresh">Refresh</button><button id="oc-stop">Stop task</button></div><div id="oc-output" class="oc-output"></div><textarea id="oc-prompt" placeholder="Ask the coding agent..."></textarea><button id="oc-send" class="primary oc-send">Send message</button></div>`;
    const get = id => container.querySelector("#" + id);
    get("oc-url").value = this.url;
    get("oc-token").value = this.token;
    get("oc-connect").onclick = () => this.connect(get("oc-url").value, get("oc-token").value, get("oc-output"), get("oc-connection"));
    get("oc-new").onclick = () => this.newSession(get("oc-output"), get("oc-connection"));
    get("oc-refresh").onclick = () => this.refresh(get("oc-output"), get("oc-connection"));
    get("oc-stop").onclick = () => this.abort();
    get("oc-send").onclick = () => this.send(get("oc-prompt"), get("oc-output"), get("oc-connection"));
  }

  setConnection(label, state) {
    if (!this.container) return;
    const badge = this.container.querySelector("#oc-connection");
    if (!badge) return;
    badge.textContent = label;
    badge.className = "oc-badge" + (state ? " " + state : "");
  }

  async saveSettings(url, token) {
    this.url = url.trim().replace(/\/$/, "");
    this.token = token.trim();
    if (this.ctx) {
      try {
        await this.ctx.setSecret("server_url", this.url);
        await this.ctx.setSecret("server_token", this.token);
      } catch (_) {
      }
    }
  }

  async api(path, options = {}) {
    const headers = Object.assign({ "Accept": "application/json", "Authorization": "Bearer " + this.token }, options.headers || {});
    if (options.body && typeof options.body !== "string") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(this.url + "/api/v1/" + path, Object.assign({ mode: "cors", cache: "no-store" }, options, { headers }));
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { error: text }; }
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  async connect(url, token, output, status) {
    status.textContent = "Connecting...";
    status.className = "oc-badge";
    output.classList.remove("oc-error");
    try {
      await this.saveSettings(url, token);
      const info = await this.api("info");
      status.textContent = "Connected";
      status.className = "oc-badge online";
      const sessions = await this.api("sessions");
      this.sessionId = sessions.sessions && sessions.sessions[0] ? sessions.sessions[0].id : "";
      if (!this.sessionId) await this.newSession(output, status);
      else await this.refresh(output, status);
      output.textContent = "Connected to " + info.directory + "\n\n" + (output.textContent || "");
    } catch (error) {
      status.textContent = "Connection failed";
      status.className = "oc-badge error";
      output.classList.add("oc-error");
      output.textContent = error.name === "TypeError"
        ? "Could not reach the server. Check the URL, token, and that the server is running."
        : error.message;
    }
  }

  async newSession(output, status) {
    const data = await this.api("sessions", { method: "POST", body: { title: "Acode session" } });
    this.sessionId = data.id;
    output.textContent = "New session ready.";
    status.textContent = "Connected";
    status.className = "oc-badge online";
  }

  async refresh(output, status) {
    if (!this.sessionId) return;
    const data = await this.api("sessions/" + encodeURIComponent(this.sessionId));
    const text = (data.messages || []).map(message => (message.role || "assistant") + ": " + (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n\n");
    output.textContent = text || "No messages yet.";
    status.textContent = data.runtime && data.runtime.active ? "Working..." : "Connected";
    status.className = "oc-badge" + (data.runtime && data.runtime.active ? "" : " online");
  }

  async send(input, output, status) {
    const content = input.value.trim();
    if (!content || !this.sessionId) { status.textContent = this.sessionId ? "Enter a message" : "Connect first"; return; }
    input.value = "";
    try {
      await this.api("sessions/" + encodeURIComponent(this.sessionId) + "/messages", { method: "POST", body: { content } });
      await this.stream(output, status);
    } catch (error) { output.textContent += "\n" + error.message; }
  }

  async stream(output, status) {
    if (this.controller) this.controller.abort();
    this.controller = new AbortController();
    status.textContent = "Working...";
    status.className = "oc-badge";
    try {
      const response = await fetch(this.url + "/api/v1/sessions/" + encodeURIComponent(this.sessionId) + "/events?after=0", { mode: "cors", cache: "no-store", headers: { Authorization: "Bearer " + this.token }, signal: this.controller.signal });
      if (!response.ok) throw new Error("Event stream failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const event = JSON.parse(line.slice(5).trim());
            if (event.kind === "text_delta") output.textContent += event.text || "";
            if (event.kind === "error" || event.kind === "turn_error") output.textContent += "\n" + (event.error || "Agent error");
            if (event.kind === "turn_complete") { await this.refresh(output, status); return; }
          }
        }
      }
    } catch (error) {
      if (error.name !== "AbortError") { status.textContent = "Disconnected"; status.className = "oc-badge error"; output.textContent += "\n" + error.message; }
    }
  }

  async abort() {
    if (!this.sessionId) return;
    try { await this.api("sessions/" + encodeURIComponent(this.sessionId) + "/abort", { method: "POST", body: {} }); } catch (_) {}
  }

  async destroy() {
    if (this.controller) this.controller.abort();
    if (commands) commands.removeCommand("opencode.agent.open");
    if (sidebarApps) sidebarApps.remove("opencode.agent");
    this.removeEdgeHandle();
    this.container = null;
  }
}

if (window.acode) {
  const instance = new OpenCodeAcodePlugin();
  window.acode.setPluginInit("com.opencode.py.agent", async (baseUrl, page, options) => instance.init(page, options.cacheFile, options.cacheFileUrl, options.firstInit, options.ctx));
  window.acode.setPluginUnmount("com.opencode.py.agent", () => instance.destroy());
}
