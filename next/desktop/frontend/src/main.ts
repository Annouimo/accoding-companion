export {};
type Source={path:string;directory:string;name:string};
type Case={input:string;expected:string|null};
type CaseSet={cases:Case[];revision:string};
type Process={stdout:string;stderr:string;exitCode:number;elapsedMs:number;state:string};
type Difference={line:number;column:number;expected:string;actual:string};
type CaseResult={index:number;input:string;expected:string|null;process:Process;state:string;difference?:Difference};
type Diagnostic={severity:string;message:string;raw:string;file?:string;line?:number;column?:number};
type Result={runId:string;source:Source;sourceDigest:string;compiler:string;state:string;compilation:Process;cases:CaseResult[];diagnostics:Diagnostic[];stale:boolean};
type Runtime={Call:{ByName(name:string,...args:unknown[]):Promise<unknown>}};
let runtime:Runtime|undefined,source:Source|undefined,busy=false,dirty=false,loaded=false,selected=0,revision="missing",cases:Case[]=[],last:Result|undefined;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const btn=(id:string)=>el<HTMLButtonElement>(id);
const input=el<HTMLTextAreaElement>("input"),expected=el<HTMLTextAreaElement>("expected"),compare=el<HTMLInputElement>("compare"),compiler=el<HTMLInputElement>("compiler");
const status=el("status"),result=el("result"),stale=el("stale");
const labels:Record<string,string>={completed:"测试完成",passed:"通过",mismatch:"输出不一致",ran:"已运行（无预期）",compilation_failed:"编译失败",runtime_failed:"运行失败",timeout:"超时",cancelled:"已取消",output_limit:"输出超限"};
async function call<T>(method:string,...args:unknown[]):Promise<T>{
 if(!runtime)throw Error("未连接 Companion 本地后端");
 return await runtime.Call.ByName("main.Desktop."+method,...args) as T;
}
function markStale(){if(last)stale.hidden=false;}
function changes(){dirty=true;markStale();updateControls();}
function updateControls(){
 btn("open").disabled=busy||!runtime;
 for(const id of ["add","save","reload","remove","run","all"])btn(id).disabled=busy||!source||(!loaded&&id!=="reload");
 btn("save").disabled||=!dirty;btn("remove").disabled||=!cases.length;btn("add").disabled||=cases.length>=32;
 btn("cancel").disabled=!busy;input.disabled=compare.disabled=compiler.disabled=busy||!loaded;expected.disabled=busy||!loaded||!compare.checked;
 el("saved").textContent=!loaded?"测试数据读取失败；不会覆盖原文件。":dirty?"有未保存修改；运行前将保存样例。":"样例已同步到磁盘（空列表不会自动写入）。";
}
function renderCases(){
 const tabs=el("tabs");tabs.replaceChildren();
 cases.forEach((_,i)=>{const b=document.createElement("button");b.textContent="样例 "+(i+1);b.setAttribute("aria-selected",String(i===selected));b.disabled=busy;b.onclick=()=>{selected=i;renderCases()};tabs.append(b)});
 const c=cases[selected];el("empty").hidden=!!c;el("editor").hidden=!c;
 input.value=c?.input??"";compare.checked=c?.expected!==null&&!!c;expected.value=c?.expected??"";
 btn("run").textContent=c?"运行当前样例":"空输入运行";updateControls();
}
function applySet(s:CaseSet){cases=s.cases??[];revision=s.revision;dirty=false;loaded=true;selected=Math.min(selected,Math.max(0,cases.length-1));renderCases();}
async function reload(){loaded=false;updateControls();try{applySet(await call<CaseSet>("LoadCases"));status.textContent="测试数据已读取"}catch(e){status.textContent=String(e)}finally{updateControls()}}
async function select(s:Source){if(!s.path)return;source=s;cases=[];selected=0;last=undefined;result.hidden=true;el("folder").textContent=s.directory;el("file").textContent=s.name;el("title").textContent=s.name;el("path").textContent=s.path;el("work").hidden=false;await reload();}
async function save(){if(!dirty)return;applySet(await call<CaseSet>("SaveCases",cases,revision));status.textContent="测试数据已保存";}
function node(tag:string,text:string,cls=""){const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;}
function output(title:string,text:string){const d=node("div","");d.append(node("h3",title),node("pre",text||"（空输出）"));return d;}
function show(r:Result){
 last=r;result.hidden=false;stale.hidden=!r.stale;status.textContent=labels[r.state]??r.state;
 const passed=r.cases.filter(c=>c.state==="passed").length,compared=r.cases.filter(c=>c.expected!==null).length;
 el("meta").textContent=r.compiler+" · "+(compared?passed+"/"+compared+" 已运行的比较样例通过":"已运行 "+r.cases.length+" 组");
 const wrap=el("results");wrap.replaceChildren();
 for(const c of r.cases){
  const d=node("article","","resultcard");
  d.append(node("h3","样例 "+(c.index+1)+" · "+(labels[c.state]??c.state)),node("p",c.process.elapsedMs+" ms · 退出码 "+c.process.exitCode,"muted"),output("本次输入",c.input));
  const row=node("div","","outputs");if(c.expected!==null)row.append(output("预期输出",c.expected));row.append(output("实际输出",c.process.stdout));d.append(row);
  if(c.difference){const df=c.difference;const block=node("div","","difference");block.append(node("p","首处差异 · 第 "+df.line+" 行，第 "+df.column+" 列"),node("pre","预期："+df.expected+"\n实际："+df.actual));d.append(block)}
  if(c.process.stderr)d.append(output("标准错误",c.process.stderr));wrap.append(d)
 }
 const diag=el("diagnostics");diag.replaceChildren();
 for(const x of r.diagnostics??[]){const d=node("div","","diagnostic");d.append(node("p",x.severity+" · "+(x.file?x.file+":"+x.line+"："+x.message:x.message)),node("pre",x.raw));diag.append(d)}
 if(r.compilation.stdout)diag.append(output("编译输出",r.compilation.stdout));
 if(!diag.childElementCount)diag.append(node("p","无编译诊断","muted"));
}
async function run(all:boolean){
 if(busy||!source||!loaded)return;
 busy=true;updateControls();renderCases();
 try{await save();status.textContent="正在编译与运行…";const r=await call<Result>("RunBatch",compiler.value.trim(),revision,all?-1:selected);show(r)}
 catch(e){status.textContent=String(e)}finally{busy=false;renderCases()}
}
btn("open").onclick=async()=>{if(busy||dirty&&!confirm("放弃尚未保存的样例修改？"))return;try{const s=await call<Source>("ChooseSource");if(s.path)await select(s)}catch(e){status.textContent=String(e)}};
btn("reload").onclick=async()=>{if(dirty&&!confirm("放弃尚未保存的样例修改？"))return;markStale();await reload()};
btn("add").onclick=()=>{cases.push({input:"",expected:null});selected=cases.length-1;changes();renderCases()};
btn("remove").onclick=()=>{if(!confirm("删除当前样例？保存后才会写入磁盘。"))return;cases.splice(selected,1);selected=Math.max(0,Math.min(selected,cases.length-1));changes();renderCases()};
input.oninput=()=>{if(cases[selected]){cases[selected].input=input.value;changes()}};
expected.oninput=()=>{if(cases[selected]){cases[selected].expected=expected.value;changes()}};
compare.onchange=()=>{if(cases[selected]){cases[selected].expected=compare.checked?expected.value:null;changes();renderCases()}};
compiler.oninput=markStale;
btn("save").onclick=async()=>{busy=true;updateControls();try{await save()}catch(e){status.textContent=String(e)}finally{busy=false;renderCases()}};
btn("run").onclick=()=>void run(false);btn("all").onclick=()=>void run(true);
btn("cancel").onclick=async()=>{btn("cancel").disabled=true;try{await call("Cancel")}catch(e){status.textContent=String(e)}};
window.addEventListener("focus",async()=>{if(last&&!busy&&!dirty){const id=last.runId;try{if(!(await call<boolean>("IsCurrent",compiler.value.trim()))&&last?.runId===id)markStale()}catch{markStale()}}});
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"&&!busy&&source){e.preventDefault();void run(false)}});
window.addEventListener("beforeunload",e=>{if(dirty){e.preventDefault();e.returnValue=""}});
async function boot(){try{const path="/wails/runtime.js";runtime=await import(path) as Runtime;if(typeof runtime.Call?.ByName!=="function")throw Error("运行时不可用");status.textContent="请选择 C 文件";updateControls();await select(await call<Source>("Initial"))}catch(e){runtime=undefined;status.textContent="无法连接本地应用："+String(e);updateControls()}}
void boot();
