type Source={path:string;directory:string;name:string};
type Process={stdout:string;stderr:string;exitCode:number;elapsedMs:number;state:string};
type Result={source:Source;sourceDigest:string;compiler:string;state:string;compilation:Process;execution?:Process;stale:boolean};
type Runtime={Call:{ByName(name:string,...args:unknown[]):Promise<unknown>}};
let runtime:Runtime|undefined;
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const open=el<HTMLButtonElement>("open"),run=el<HTMLButtonElement>("run"),cancel=el<HTMLButtonElement>("cancel");
const input=el<HTMLTextAreaElement>("input"),compiler=el<HTMLInputElement>("compiler");
const status=el("status"),result=el("result");
let source:Source|undefined,busy=false;
async function call<T>(method:string,...args:unknown[]):Promise<T>{
 if(!runtime)throw Error("未连接 Companion 本地后端");
 return await runtime.Call.ByName("main.Desktop."+method,...args) as T;
}
function select(s:Source){if(!s.path)return;source=s;el("folder").textContent=s.directory;el("file").textContent=s.name;el("title").textContent=s.name;el("path").textContent=s.path;el("work").hidden=false;result.hidden=true;status.textContent="准备就绪";}
function setBusy(b:boolean){busy=b;open.disabled=b;run.disabled=b;input.disabled=b;compiler.disabled=b;cancel.disabled=!b;}
const labels:Record<string,string>={ran:"运行完成（未比较输出）",compilation_failed:"编译失败",runtime_failed:"运行失败",timeout:"超时",cancelled:"已取消",output_limit:"输出超限"};
function show(r:Result){result.hidden=false;status.textContent=labels[r.state]??r.state;el("meta").textContent=r.compiler+(r.execution?" · "+r.execution.elapsedMs+" ms · 退出码 "+r.execution.exitCode:"");el("stdout").textContent=r.execution?.stdout||"（无输出）";el("stderr").textContent=r.execution?.stderr||"（无）";el("diagnostics").textContent=[r.compilation.stdout,r.compilation.stderr].filter(Boolean).join("\n")||"（无）";el("stale").hidden=!r.stale;}
open.onclick=async()=>{if(busy)return;try{const s=await call<Source>("ChooseSource");select(s)}catch(e){status.textContent=String(e)}};
run.onclick=async()=>{if(!source||busy)return;setBusy(true);result.hidden=true;status.textContent="正在编译与运行…";try{show(await call<Result>("Run",input.value,compiler.value.trim()))}catch(e){status.textContent=String(e)}finally{setBusy(false)}};
cancel.onclick=async()=>{cancel.disabled=true;try{await call("Cancel")}catch(e){status.textContent=String(e)}};
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"&&!busy&&source){e.preventDefault();run.click()}});
async function boot(){try{const path="/wails/runtime.js";runtime=await import(path) as Runtime;if(typeof runtime.Call?.ByName!=="function")throw Error("运行时不可用");open.disabled=false;status.textContent="请选择 C 文件";select(await call<Source>("Initial"))}catch(e){status.textContent="无法连接本地应用；请通过原生 Companion 启动。"+String(e);open.disabled=true}}
void boot();
