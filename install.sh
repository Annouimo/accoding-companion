#!/usr/bin/env bash
# Accoding Companion install/update: manually invoked; never runs on app startup.
set -euo pipefail
CLI="@annouimo/accoding-companion"
PRESET="@annouimo/c-exam-kit-preset"
mode=both
yes=0
channel=latest
for arg in "$@"; do
  case "$arg" in
    --software-only) mode=software ;;
    --preset-only) mode=preset ;;
    --yes) yes=1 ;;
    --next) channel=next ;;
    --latest) channel=latest ;;
    --help|-h) echo "Usage: install.sh [--software-only|--preset-only] [--latest|--next] [--yes]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
confirm() {
  if [[ "$yes" == 1 ]]; then return 0; fi
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" == [Yy] || "$answer" == [Yy][Ee][Ss] ]]
}
valid_node=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)); then valid_node=1; fi
fi
if [[ "$valid_node" == 0 ]]; then
  echo "Node.js LTS (22+) and npm are required."
  if [[ "$(uname -s)" == Darwin ]] && command -v brew >/dev/null 2>&1; then
    if confirm "Install Node.js using your existing Homebrew installation?"; then
      brew install node
      echo "Open a new terminal and rerun the installer."
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
  npm view "$1@$channel" version --prefer-online --fetch-retries=1 2>/dev/null | tail -1
}
global_root="$(npm root --global)"
local_version() {
  node -e '
    try { console.log(require(process.argv[1]).version || "not installed"); }
    catch { console.log("not installed"); }
  ' "$global_root/$1/package.json"
}
needs_cli=0
needs_preset=0
if [[ "$mode" != preset ]]; then
  newest_cli="$(remote_version "$CLI")"
  if [[ -z "$newest_cli" ]]; then
    echo "Could not query $CLI from the configured npm registry." >&2; exit 1
  fi
  current_cli="$(local_version "$CLI")"
  echo "Software: $current_cli -> $newest_cli"
  if [[ "$current_cli" != "$newest_cli" ]]; then needs_cli=1; fi
fi
if [[ "$mode" != software ]]; then
  newest_preset="$(remote_version "$PRESET")"
  if [[ ! "$newest_preset" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
    echo "Could not resolve a valid C Exam Kit version." >&2; exit 1
  fi
  manifest="$global_root/$PRESET/preset/manifest.json"
  current_preset="$(local_version "$PRESET")"
  echo "C Exam Kit: $current_preset -> $newest_preset"
  if [[ "$current_preset" != "$newest_preset" || ! -f "$manifest" ]]; then needs_preset=1; fi
fi
if [[ "$needs_cli" == 0 && "$needs_preset" == 0 ]]; then
  echo "Everything selected is already up to date."
  exit 0
fi
if ! confirm "Proceed with installation/update?"; then
  echo "Cancelled; existing files were not changed."
  exit 0
fi
if [[ "$needs_cli" == 1 ]]; then
  npm install --global --ignore-scripts --no-audit --no-fund "$CLI@$newest_cli"
  echo "Software installed: $(accoding --version)"
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
echo "Run 'accoding' to launch."
