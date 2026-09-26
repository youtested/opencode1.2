# OpenCode Agent for Acode

This plugin is a chat client for the coding server controlled by the main OpenCode TUI or shared control service.

1. Start or stop the coding server from the main OpenCode `/setting` popup, or with the shared control service:
```sh
opencode-control --coding-directory .
```
2. Install the plugin from Acode Plugins.
3. Open `Open OpenCode Agent` from the command palette or the extensions sidebar.
4. Enter the coding server URL and token.
5. Use the chat panel to send messages.

The plugin is chat-only and uses the coding server started by the main TUI or shared control service. A small OpenCode tab is fixed to the far edge of the Acode window; tap it to launch the chat panel. Managed servers allow the Acode WebView to connect while still requiring the server token.
