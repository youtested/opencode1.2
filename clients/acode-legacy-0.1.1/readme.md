# OpenCode Agent for Acode

This plugin is self-contained: it includes its own Node bridge, so it does not require the separate AcodeX plugin or server.

1. Start the coding server from the main OpenCode TUI with `/setting` or `Ctrl+S`.
2. Turn on `server on/off`.
3. Install this plugin ZIP in Acode.
4. Open `Open OpenCode Agent` from the command palette or extensions sidebar.
5. Enter the coding server URL and token.
6. Tap Connect.

The bundled bridge is started automatically through Acode's executor and forwards API and streaming requests to the Termux server.
