import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-launch-"));
const windows = process.platform === "win32";
let installFetches = 0;
const packages = new Map();
const server = http.createServer((req, res) => {
  const key = decodeURIComponent(req.url.split("?")[0].slice(1));
  const pkg = packages.get(key);
  if (pkg) {
    const versions = Object.fromEntries([...pkg.versions].map(([version, value]) =>
      [version, { ...value.metadata, dist: { tarball: value.url } }]));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: key, "dist-tags": { latest: pkg.latest }, versions }));
  } else {
    const match = [...packages.values()].flatMap((entry) => [...entry.versions.values()])
      .find((entry) => new URL(entry.url).pathname === "/" + key);
    if (match) { installFetches++; res.end(match.tarball); }
    else { res.statusCode = 404; res.end("{}"); }
  }
});

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (value) => { output += value; });
    child.stderr.on("data", (value) => { output += value; });
    child.on("error", reject);
    child.on("close", (status) =>
      status === 0 ? resolve(output) : reject(Error(`${command} exited ${status}\n${output}`)));
  });
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const env = { ...process.env, npm_config_prefix: path.join(temp, "global prefix"),
    npm_config_cache: path.join(temp, "npm cache"), npm_config_registry: registry,
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
  const cli = "@annouimo/accoding-companion";
  const preset = "@annouimo/c-exam-kit-preset";
  for (const [name, versions] of [[cli, ["0.2.0", "0.2.1"]], [preset, ["0.6.4"]]]) {
    const release = { latest: versions[0], versions: new Map() };
    packages.set(name, release);
    for (const version of versions) {
      const source = await fs.mkdtemp(path.join(temp, "package-"));
      const entry = name === cli ? "dist/accoding.mjs" : "preset/manifest.json";
      const fixture = name === cli
        ? `#!/usr/bin/env node\nconsole.log(process.argv.includes("--version") ? "${version}" : "LAUNCHED ${version}");\n`
        : JSON.stringify({ schemaVersion: 1, language: "c", standard: "c99", components: [{}] });
      await fs.mkdir(path.dirname(path.join(source, entry)));
      await fs.writeFile(path.join(source, entry), fixture);
      const metadata = { name, version };
      await fs.writeFile(path.join(source, "package.json"), JSON.stringify(metadata));
      const npmCli = process.env.npm_execpath;
      assert.ok(npmCli, "run this smoke test through npm run");
      const out = await run(process.execPath,
        [npmCli, "pack", source, "--ignore-scripts", "--pack-destination", temp, "--silent"], env);
      const file = out.trim().split(/\r?\n/).at(-1);
      release.versions.set(version, { metadata, url: registry + file, tarball: await fs.readFile(path.join(temp, file)) });
    }
  }
  const launch = () => windows
    ? run("cmd.exe", ["/d", "/c", "launch.cmd -Yes"], env)
    : run("bash", ["launch.command", "--yes"], env);
  assert.match(await launch(), /LAUNCHED 0\.2\.0/);
  assert.equal(installFetches, 2, "fresh launch installs both packages");
  assert.match(await launch(), /LAUNCHED 0\.2\.0/);
  assert.equal(installFetches, 2, "up-to-date launch does not download packages");
  packages.get(cli).latest = "0.2.1";
  assert.match(await launch(), /LAUNCHED 0\.2\.1/);
  assert.equal(installFetches, 3, "only the changed package is downloaded");
  await new Promise((resolve) => server.close(resolve));
  assert.match(await launch(), /LAUNCHED 0\.2\.1/);
  console.log("Launcher passed fresh install, direct launch, update and offline startup.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
