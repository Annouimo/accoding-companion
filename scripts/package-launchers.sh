#!/usr/bin/env bash
set -euo pipefail
repo="$(cd -- "$(dirname -- "$0")/.." && pwd)"
out="$(mkdir -p "$1" && cd -- "$1" && pwd)"
companion_version="$(node -p "require(process.argv[1]).version" "$repo/package.json")"
version="$companion_version"
managed_v2=0
case "${2:-}" in
  "") ;;
  --managed-v2) version="$(cat "$repo/launcher/VERSION")"; managed_v2=1 ;;
  *) echo "unknown launcher build mode" >&2; exit 1 ;;
esac
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || exit 1
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

(
  cd "$repo/launcher"
  go mod download
  printf 'Go runtime\n\n'
  cat "$(go env GOROOT)/LICENSE"
  go list -m -f '{{if not .Main}}{{.Path}} {{.Dir}}{{end}}' all |
    while read -r module directory; do
      [[ -n "$directory" ]] || continue
      for file in "$directory"/LICENSE* "$directory"/COPYING* "$directory"/NOTICE*; do
        [[ -f "$file" ]] || continue
        printf '\n\n%s · %s\n\n' "$module" "$(basename "$file")"
        cat "$file"
      done
    done
) > "$stage/THIRD_PARTY_NOTICES.txt"

for os in windows darwin; do
  for arch in amd64 arm64; do
    bundle="$stage/$os-$arch"
    mkdir -p "$bundle/images"
    node "$repo/scripts/render-launcher-guide.mjs" "$repo/docs/launcher/使用说明.html" "$bundle/使用说明.html" "$companion_version" "$version" "$managed_v2"
    cp "$repo/docs/launcher/编译环境配置.html" "$bundle/编译环境配置.html"
    test -s "$bundle/编译环境配置.html"
    cp "$repo/docs/launcher/images/contest-list.png" "$bundle/images/"
    test -s "$bundle/images/contest-list.png"
    test -s "$bundle/使用说明.html"
    grep -Fq "Accoding Companion $companion_version" "$bundle/使用说明.html"
    cp "$repo/LICENSE" "$stage/THIRD_PARTY_NOTICES.txt" "$bundle/"

    if [[ "$os" == windows ]]; then
      binary="$bundle/Accoding Launcher.exe"
    else
      mkdir "$bundle/support"
      binary="$bundle/support/accoding-launcher"
      cp "$repo/launcher/macos.command" "$bundle/Accoding Launcher.command"
      chmod +x "$bundle/Accoding Launcher.command"
    fi
    (cd "$repo/launcher" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -ldflags "-X main.launcherVersion=$version -X main.managedV2Default=$managed_v2" -buildvcs=false -trimpath -o "$binary" .)
    (cd "$bundle" && zip -qr "$out/accoding-launcher-$version-$os-$arch.zip" .)
  done
done
