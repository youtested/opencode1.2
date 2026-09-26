# Changelog

## 0.1.22

- The server token field is visible and empty on every fresh install.
- The plugin uses only the token entered by the user.

## 0.1.20

- Uses Acode's bundled native `cordova.plugin.http` as the primary Termux transport.
- Uses polling for chat updates when native HTTP is active.
- Keeps the bundled Node bridge only as a fallback.

## 0.1.19

- Fixed false “Server OFF” reporting when only the bridge failed.
- Added a process-start fallback for Acode versions without Executor.start.
- Kept the bridge and proxy server bundled inside this ZIP.

## 0.1.18

- Bundled a self-contained Node HTTP/SSE bridge inside the plugin ZIP.
- The plugin starts and stops the bridge automatically through Acode Executor.
- Removed the need to install the separate AcodeX plugin for this connection.

## 0.1.17

- Added AcodeX `/execute-command` bridge fallback for Termux server access.
- Shows Server OFF clearly when the TUI server switch is off.
- Uses the same token and server URL for direct and bridged requests.

## 0.1.16

- Added Acode command-bridge fallback when WebView fetch cannot reach the local server.
- Extended network timeouts for slower Termux devices.
- Distinguished WebView network failures from rejected tokens.

## 0.1.14

- Added explicit stale-token feedback for rejected connections.
- Prevented connection buttons from freezing on network errors.

## 0.1.13

- Added request timeouts so Acode cannot freeze waiting for the server.
- Made secret saving non-blocking.
- Added error handling to every button action.

## 0.1.12

- Waited for Acode's API before registering the plugin.
- Added visible connection state indicators.
- Added a command/page fallback if the sidebar API is unavailable.

## 0.1.11

- Bound the plugin to Acode's direct `acode` global as well as `window.acode`.
- Added a DOM fallback for older Acode WebViews.

## 0.1.1

- Restored the earlier Acode chat client layout that worked on the phone.
- Kept the plugin manifest and icon compatible with Acode.
