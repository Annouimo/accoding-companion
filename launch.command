#!/usr/bin/env bash
# Accoding Companion launcher for macOS and Linux.
set -euo pipefail
CLI="@routilet/accoding-companion"
PRESET="@routilet/c-exam-kit-preset"
mode=both
yes=0
launch=1
channel=latest
for arg in "$@"; do
  case "$arg" in
    --software-only) mode=software ;;
    --preset-only) mode=preset ;;
    --no-launch) launch=0 ;;
    --yes) yes=1 ;;
    --next) channel=next ;;
    --latest) channel=latest ;;
    --help|-h) echo "Usage: launch.command [--software-only|--preset-only] [--latest|--next] [--yes] [--no-launch]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
confirm() {
  if [[ "$yes" == 1 ]]; then return 0; fi
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == [Yy] || "$answer" == [Yy][Ee][Ss] ]]
}
if [[ "$(uname -s)" == Darwin ]]; then
  export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
fi
valid_node=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  if node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'; then
    valid_node=1
  fi
fi
if [[ "$valid_node" == 0 ]]; then
  echo "Node.js 22.12 or later and npm are required."
  if [[ "$(uname -s)" == Darwin ]] && command -v brew >/dev/null 2>&1; then
    if confirm "Install Node.js using your existing Homebrew installation?"; then
      brew install node
      echo "Double-click the launcher again after Node.js is installed."
      exit 0
    fi
  fi
  echo "Official installation: https://nodejs.org/en/download/"
  if confirm "Open the official download page?"; then
    if [[ "$(uname -s)" == Darwin ]]; then open "https://nodejs.org/en/download/" || true
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "https://nodejs.org/en/download/" || true
    fi
  fi
  echo "Install Node.js LTS and rerun this script."
  exit 2
fi
echo "Node $(node --version), npm $(npm --version): ready"
echo "Release channel: $channel"

remote_version() {
  local version
  version="$(npm view "$1@$channel" version --prefer-online --fetch-retries=0 --fetch-timeout=5000 2>/dev/null | tail -1)" || return 1
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || return 1
  echo "$version"
}
global_root="$(npm root --global)"
local_version() {
  node -e '
    try { console.log(require(process.argv[1]).version || "not installed"); }
    catch { console.log("not installed"); }
  ' "$global_root/$1/package.json"
}
cli_entry="$global_root/$CLI/dist/accoding.mjs"
manifest="$global_root/$PRESET/preset/manifest.json"
legacy_cli="$global_root/@annouimo/accoding-companion/dist/accoding.mjs"
start_companion() {
  if [[ "$launch" == 1 && "$mode" != preset && -f "$cli_entry" ]]; then
    exec node "$cli_entry"
  elif [[ "$launch" == 1 && "$mode" != preset && -f "$legacy_cli" ]]; then
    exec node "$legacy_cli"
  fi
}
needs_cli=0
needs_preset=0
if [[ "$mode" != preset ]]; then
  current_cli="$(local_version "$CLI")"
  if newest_cli="$(remote_version "$CLI")" && [[ -n "$newest_cli" ]]; then
    if [[ "$current_cli" != "$newest_cli" || ! -f "$cli_entry" ]]; then
      echo "Accoding Companion: $current_cli -> $newest_cli"
      needs_cli=1
    fi
  elif [[ ! -f "$cli_entry" && ! -f "$legacy_cli" ]]; then
    echo "Cannot download Accoding Companion. Check your connection and open the launcher again." >&2
    exit 1
  else
    echo "Update check unavailable. Opening the installed version."
    start_companion
    exit 0
  fi
fi
if [[ "$mode" != software ]]; then
  current_preset="$(local_version "$PRESET")"
  if newest_preset="$(remote_version "$PRESET")" && [[ -n "$newest_preset" ]]; then
    if [[ "$current_preset" != "$newest_preset" || ! -f "$manifest" ]]; then
      echo "C Exam Kit: $current_preset -> $newest_preset"
      needs_preset=1
    fi
  elif [[ "$mode" == preset || ! -f "$cli_entry" ]]; then
    echo "Cannot download C Exam Kit. Check your connection and open the launcher again." >&2
    exit 1
  fi
fi
if [[ "$needs_cli" == 0 && "$needs_preset" == 0 ]]; then
  start_companion
  exit 0
fi
if ! confirm "Proceed with installation/update?"; then
  start_companion
  exit 0
fi
if [[ "$needs_cli" == 1 ]]; then
  if [[ -f "$legacy_cli" && ! -f "$cli_entry" ]]; then
    echo "The old global CLI owns the accoding command. Use the new native launcher, or run npm uninstall -g @annouimo/accoding-companion, then rerun this script." >&2
    start_companion
    exit 2
  fi
  npm install --global --ignore-scripts --no-audit --no-fund "$CLI@$newest_cli"
  echo "Software installed: $(node "$cli_entry" --version)"
fi
if [[ "$needs_preset" == 1 ]]; then
  npm install --global --ignore-scripts --no-audit --no-fund "$PRESET@$newest_preset"
  node - "$manifest" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (data.schemaVersion!==1 || data.language!=="c" || data.standard!=="c99" ||
    !Array.isArray(data.components)) throw Error("Invalid preset manifest");
NODE
  echo "C Exam Kit $newest_preset installed. Existing coursework is unchanged."
fi
start_companion
