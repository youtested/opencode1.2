# Changelog

## 0.1.9

- Added a flush-edge OpenCode launch tab.
- Tapping the edge tab opens the Acode chat panel.
- The tab is removed cleanly when the plugin unloads.

## 0.1.8

- Fixed Acode browser compatibility by enabling CORS for managed servers.
- Refreshed the chat panel with a cleaner phone-friendly layout and connection states.
- Replaced the plugin icon with a code/chat icon.

## 0.1.7

- Removed server controls from the Acode plugin.
- The plugin is now chat-only; the main TUI `/setting` popup owns the shared Server ON/OFF switch.

## 0.1.6

- Kept the single Server ON/OFF switch inside the visible Server settings popup.
- The switch now uses the shared control service for every client.

## 0.1.5

- Connected Acode to the shared control service used by all clients.
- Kept one Server ON/OFF switch in the settings popup.
- The switch now starts or stops the coding server through the shared controller.

## 0.1.4

- Added a server ON/OFF switch inside the settings popup.
- Added centered Server Started and Server Stopped confirmations.
- Added a centered copyable server token display.

## 0.1.3

- Added a reliable Acode page fallback for the chat panel.
- Added an `Open OpenCode Agent` command for direct access.
- Made sidebar loading tolerant of unavailable optional Acode modules.

## 0.1.2

- Added project-level Start Server and Stop Server controls to the Acode panel.
- The toggle now uses the same managed server controller as the CLI.

## 0.1.1

- Fixed the Acode manifest and included the required plugin icon.
- Lowered the minimum Acode version for broader phone compatibility.

## 0.1.0

- Added Acode sidebar bridge for the local OpenCode server.
- Added encrypted server URL and token storage through the Acode plugin context.
- Added session creation, prompt sending, streaming output, refresh, and stop controls.
