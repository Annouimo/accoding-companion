import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { compareStable, releaseDecision } from "./npm-release-state.mjs";

const emit = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, key+"="+value+"\n");
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const npmView = (spec, field) => JSON.parse(execFileSync("npm", ["view", spec, field, "--json", "--registry=https://registry.npmjs.org", "--fetch-retries=2", "--fetch-timeout=15000"], {encoding:"utf8", timeout:90000}));
const pkg = JSON.parse(readFileSync("package.json","utf8"));
const version = pkg.version, launcher = readFileSync("launcher/VERSION","utf8").trim();
if(pkg.name!=="@routilet/accoding-companion" || !stable.test(version) || !stable.test(launcher)) throw Error("Invalid declared release versions");
if(process.env.EXPECTED_VERSION && process.env.EXPECTED_VERSION!==version) throw Error("Expected Companion version mismatch");
const event=process.env.GITHUB_EVENT_NAME;
const mode=event==="pull_request"?"DRY_RUN":event==="push"?"AUTO":process.env.REQUESTED_MODE||"AUTO";
if(!["AUTO","DRY_RUN","PUBLISH_LATEST","PUBLISH_LAUNCHERS"].includes(mode)) throw Error("Unknown release mode");
if(mode!=="DRY_RUN" && process.env.GITHUB_REF!=="refs/heads/main") throw Error("Publish only from main");
emit("version",version); emit("launcher_version",launcher); emit("mode",mode);

let publish=false, release=false;
if(mode==="AUTO" || mode==="PUBLISH_LATEST") {
  const versions=npmView(pkg.name,"versions");
  publish=releaseDecision(version,typeof versions==="string"?[versions]:versions);
}
if(mode==="AUTO" || mode==="PUBLISH_LAUNCHERS") {
  const pages=JSON.parse(execFileSync("gh",["api","--paginate","--slurp","repos/"+process.env.GITHUB_REPOSITORY+"/releases?per_page=100"],{encoding:"utf8",timeout:90000}));
  if(!Array.isArray(pages)||!pages.every(Array.isArray)) throw Error("Invalid release list");
  const releases=pages.flat();
  if(!releases.every(r=>typeof r.tag_name==="string"&&Array.isArray(r.assets))) throw Error("Invalid release metadata");
  const files=["darwin-amd64","darwin-arm64","windows-amd64","windows-arm64"].map(p=>"accoding-launcher-"+launcher+"-"+p+".zip");
  const matching=releases.filter(r=>r.tag_name==="launcher-v"+launcher||r.assets.some(a=>files.includes(a.name)));
  if(matching.length && !matching.some(r=>!r.draft&&!r.prerelease&&files.every(n=>r.assets.some(a=>a.name===n&&a.state==="uploaded")))) throw Error("Existing incomplete Launcher release; inspect instead of overwriting");
  if(!matching.length && releases.some(r=>{
    const m=r.tag_name.match(/^launcher-v(\d+\.\d+\.\d+)$/);
    return m&&stable.test(m[1])&&compareStable(m[1],launcher)>0;
  })) throw Error("Refusing Launcher version downgrade");
  release=!matching.length;
}
emit("publish",publish); emit("launcher",release);
console.log("Companion "+version+": "+(publish?"publish":"skip")+", Launcher "+launcher+": "+(release?"publish":"skip"));

if(publish||release) {
  for(const [key,name,range,expected] of [
    ["preset","@routilet/c-exam-kit",pkg.dependencies?.["@routilet/c-exam-kit"],process.env.EXPECTED_PRESET],
    ["observer","@routilet/c-observer",pkg.optionalDependencies?.["@routilet/c-observer"],process.env.EXPECTED_OBSERVER]
  ]) {
    if(!range) throw Error("Missing dependency "+name);
    const latest=npmView(name+"@latest","version"), compatible=[npmView(name+"@"+range,"version")].flat();
    if(typeof latest!=="string"||!stable.test(latest)||!compatible.includes(latest)||(expected&&latest!==expected)) throw Error("Published latest does not satisfy expected stable dependency "+name+" "+range);
    emit(key,latest);
  }
}
