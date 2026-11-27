export {};
type Source={path:string;directory:string;name:string};
type Nav={root:string;source:Source};
type Entry={path:string;name:string;directory:boolean};
type Orphan={name:string;count:number};
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
let root="",expanded=new Set<string>(),treeEntries=new Map<string,Entry[]>(),refreshing=false,navEpoch=0,seenMissing=new Set<string>();
const compilerByLanguage:Record<string,string>={c:"",cpp:""};
const language=(s:Source)=>/\.c$/i.test(s.name)?"c":"cpp";
const status=el("status"),result=el("result"),stale=el("stale");
const labels:Record<string,string>={completed:"测试完成",passed:"通过",mismatch:"输出不一致",ran:"已运行（无预期）",compilation_failed:"编译失败",runtime_failed:"运行失败",timeout:"超时",cancelled:"已取消",output_limit:"输出超限"};
async function call<T>(method:string,...args:unknown[]):Promise<T>{
 if(!runtime)throw Error("未连接 Companion 本地后端");
 return await runtime.Call.ByName("main.Desktop."+method,...args) as T;
}
function markStale(){if(last)stale.hidden=false;}
function changes(){dirty=true;markStale();updateControls();}
function updateControls(){
 btn("open").disabled=btn("openFolder").disabled=busy||!runtime;btn("new").disabled=btn("refreshTree").disabled=busy||!root;btn("rename").disabled=btn("import").disabled=busy||!source||!loaded;
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
async function select(nav:Nav){
 if(!nav.root)return;
 navEpoch++;
 if(root!==nav.root){root=nav.root;expanded=new Set([root]);treeEntries.clear();seenMissing.clear()}
 el("folder").textContent=root;
 source=nav.source.path?nav.source:undefined;cases=[];selected=0;last=undefined;dirty=false;loaded=false;result.hidden=true;el("orphans").replaceChildren();
 el("title").textContent=source?.name??"选择一个源文件";el("path").textContent=source?.path??root;el("work").hidden=!source;
 if(source){compiler.value=compilerByLanguage[language(source)];const wasMissing=seenMissing.has(source.path);if(wasMissing)await call("Invalidate",source.path);await reload();
  if(seenMissing.has(source.path)&&revision!=="missing"){if(!confirm("此路径曾消失，存在旧测试数据。是否继续使用这些样例？")){loaded=false;status.textContent="未确认旧样例；请重新选择文件";}else seenMissing.delete(source.path)}
  if(loaded){const cached=await call<Result|null>("Cached",compiler.value.trim());if(cached){if(seenMissing.has(source.path))cached.stale=true;show(cached)}await showOrphans()}
 }
 await refreshTree(true);updateControls();
}
async function showOrphans(){
 const box=el("orphans");box.replaceChildren();if(!source||cases.length||dirty||!loaded)return;
 try{const list=await call<Orphan[]>("Orphans");if(!list.length)return;box.append(node("p","发现未关联的测试数据","muted"));
 for(const o of list){const b=document.createElement("button");b.textContent=o.name+" · "+o.count+" 组 · 恢复";b.onclick=()=>void navigate(async()=>{if(!confirm("复制旧样例到当前文件？原数据保留。"))return;applySet(await call<CaseSet>("Restore",o.name,revision));markStale();await showOrphans()});box.append(b)}
 }catch(e){box.append(node("p",String(e),"muted"))}
}
function drawTree(){
 const host=el("file");host.replaceChildren();
 function branch(dir:string,container:HTMLElement,depth:number){
  if(depth>24)return;
  for(const e of treeEntries.get(dir)??[]){
   const b=document.createElement("button");b.textContent=(e.directory?(expanded.has(e.path)?"▾ ":"▸ "):"  ")+e.name;b.disabled=busy;b.setAttribute("aria-current",String(source?.path===e.path));
   if(e.directory){b.onclick=()=>{if(expanded.has(e.path)){expanded.delete(e.path);drawTree()}else{expanded.add(e.path);void refreshTree(true)}}}else{b.onclick=()=>void navigate(async()=>select(await call<Nav>("Select",e.path)))}
   container.append(b);
   if(e.directory&&expanded.has(e.path)){const child=node("div","","branch");container.append(child);branch(e.path,child,depth+1)}
  }
 }
 if(root)branch(root,host,0);
}
async function refreshTree(force=false){
 if(!root||refreshing||(!force&&busy))return;
 refreshing=true;const epoch=navEpoch,base=root;
 try{
  const next=new Map<string,Entry[]>();const queue=[base];const present=new Set<string>();let scanned=0;
  while(queue.length&&scanned<128){const dir=queue.shift()!;scanned++;
   let list:Entry[];try{list=await call<Entry[]>("List",dir)}catch(e){if(dir===base)throw e;continue}
   if(epoch!==navEpoch)return;next.set(dir,list);
   for(const e of list){if(!e.directory)present.add(e.path);else if(expanded.has(e.path))queue.push(e.path)}
  }
  for(const [dir,entries] of next){const old=treeEntries.get(dir)??[];for(const e of old){if(!e.directory&&!present.has(e.path)){seenMissing.add(e.path);await call("Invalidate",e.path);if(epoch!==navEpoch)return}}}
  const changed=JSON.stringify([...next])!==JSON.stringify([...treeEntries]);treeEntries=next;if(changed||force)drawTree();
  el("treeNotice").textContent=queue.length?"展开目录过多，最多刷新 128 个目录。":"";
  if(source&&!busy){
   const selectedPath=source.path;const exists=await call<boolean>("CheckSelected");
   if(epoch!==navEpoch||source?.path!==selectedPath)return;
   if(!exists){seenMissing.add(selectedPath);markStale();loaded=false;updateControls();status.textContent="源文件已移走或删除；样例仍保留。"}
  }
  if(last&&source&&!dirty&&!busy){const id=last.runId;if(!(await call<boolean>("IsCurrent",compiler.value.trim()))&&last?.runId===id&&epoch===navEpoch)markStale()}
 }catch(e){el("treeNotice").textContent=String(e);markStale()}finally{refreshing=false}
}
async function navigate(action:()=>Promise<void>){
 if(busy||dirty&&!confirm("放弃尚未保存的样例修改？"))return;
 busy=true;navEpoch++;updateControls();drawTree();try{await action()}catch(e){status.textContent=String(e)}finally{busy=false;updateControls();drawTree();void refreshTree(true)}
}
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
 busy=true;updateControls();renderCases();drawTree();
 try{await save();status.textContent="正在编译与运行…";const r=await call<Result>("RunBatch",compiler.value.trim(),revision,all?-1:selected);show(r)}
 catch(e){status.textContent=String(e)}finally{busy=false;renderCases();drawTree()}
}
btn("open").onclick=()=>void navigate(async()=>select(await call<Nav>("ChooseSource")));
btn("openFolder").onclick=()=>void navigate(async()=>select(await call<Nav>("ChooseFolder")));
btn("refreshTree").onclick=()=>void refreshTree(true);
btn("new").onclick=()=>void navigate(async()=>{
 if(!root)return;const name=prompt("文件名（03c 仅创建普通模板，默认 Exam Kit 在 04 接入）","A.c");if(!name)return;
 const dir=source?.directory??root;await select(await call<Nav>("Create",dir,name))
});
btn("rename").onclick=()=>void navigate(async()=>{if(!source)return;const name=prompt("新文件名",source.name);if(name&&name!==source.name)await select(await call<Nav>("Rename",name))});
btn("import").onclick=()=>void navigate(async()=>{if(!loaded)return;const append=cases.length>0;if(append&&!confirm("将导入的测试数据追加到现有样例？"))return;const s=await call<CaseSet|null>("Import",revision,append);if(s){applySet(s);markStale();await showOrphans()}});
setInterval(()=>{void refreshTree()},1500);
btn("reload").onclick=()=>void navigate(async()=>{markStale();if(source&&seenMissing.has(source.path))await call("Invalidate",source.path);await reload();if(source&&seenMissing.has(source.path)&&revision!=="missing"){if(!confirm("此路径曾消失，是否继续使用旧样例？")){loaded=false;return}seenMissing.delete(source.path)}await showOrphans()});
btn("add").onclick=()=>{cases.push({input:"",expected:null});selected=cases.length-1;changes();renderCases()};
btn("remove").onclick=()=>{if(!confirm("删除当前样例？保存后才会写入磁盘。"))return;cases.splice(selected,1);selected=Math.max(0,Math.min(selected,cases.length-1));changes();renderCases()};
input.oninput=()=>{if(cases[selected]){cases[selected].input=input.value;changes()}};
expected.oninput=()=>{if(cases[selected]){cases[selected].expected=expected.value;changes()}};
compare.onchange=()=>{if(cases[selected]){cases[selected].expected=compare.checked?expected.value:null;changes();renderCases()}};
compiler.oninput=()=>{if(source)compilerByLanguage[language(source)]=compiler.value;markStale()};
btn("save").onclick=async()=>{busy=true;updateControls();try{await save()}catch(e){status.textContent=String(e)}finally{busy=false;renderCases()}};
btn("run").onclick=()=>void run(false);btn("all").onclick=()=>void run(true);
btn("cancel").onclick=async()=>{btn("cancel").disabled=true;try{await call("Cancel")}catch(e){status.textContent=String(e)}};
window.addEventListener("focus",async()=>{if(last&&!busy&&!dirty){const id=last.runId;try{if(!(await call<boolean>("IsCurrent",compiler.value.trim()))&&last?.runId===id)markStale()}catch{markStale()}}});
document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter"&&!busy&&source){e.preventDefault();void run(false)}});
window.addEventListener("beforeunload",e=>{if(dirty){e.preventDefault();e.returnValue=""}});
async function boot(){try{const path="/wails/runtime.js";runtime=await import(path) as Runtime;if(typeof runtime.Call?.ByName!=="function")throw Error("运行时不可用");status.textContent="请选择 C 文件";updateControls();await select(await call<Nav>("Initial"))}catch(e){runtime=undefined;status.textContent="无法连接本地应用："+String(e);updateControls()}}
void boot();
