import { spawn } from "node:child_process";

function writeClipboard(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:["pipe","ignore","ignore"],windowsHide:true});
    const timer=setTimeout(()=>{child.kill();reject(new Error("剪贴板命令超时"));},4000);
    child.once("error",error=>{clearTimeout(timer);reject(error);});
    child.once("close",code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error(command+" 退出码 "+code));});
    child.stdin.on("error",()=>{ /* close/error carries the outcome */ });
    child.stdin.end(text,"utf8");
  });
}
export async function copyExample(text: string): Promise<void> {
  const commands: [string,string[]][] = process.platform==="win32" ?
    [["powershell.exe",["-NoProfile","-NonInteractive","-Command","[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())"]]] :
    process.platform==="darwin" ? [["pbcopy",[]]] :
    [...(process.env.WAYLAND_DISPLAY?[["wl-copy",[]] as [string,string[]]]:[]),["xclip",["-selection","clipboard"]],["xsel",["--clipboard","--input"]]];
  for(const [command,args] of commands) {
    try {await writeClipboard(command,args,text);return;} catch { /* try next platform command */ }
  }
  throw new Error("没有可用的系统剪贴板；请手动选择代码文本。");
}
