// Package localrun runs explicitly selected, ordinary single-file C programs.
// It has no dependency on the GUI, OJ, or user metadata.
package localrun

import (
 "bytes"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "errors"
 "fmt"
 "io"
 "os"
 "os/exec"
 "path/filepath"
 "regexp"
 "runtime"
 "strings"
 "sync"
 "time"
)

const maxSource = 2 * 1024 * 1024
const maxInput = 1024 * 1024
const maxOutput = 4 * 1024 * 1024

type Source struct {
 Path string `json:"path"`
 Directory string `json:"directory"`
 Name string `json:"name"`
}

type Process struct {
 Stdout string `json:"stdout"`
 Stderr string `json:"stderr"`
 ExitCode int `json:"exitCode"`
 ElapsedMS int64 `json:"elapsedMs"`
 State string `json:"state"`
}

type Result struct {
 Source Source `json:"source"`
 SourceDigest string `json:"sourceDigest"`
 Compiler string `json:"compiler"`
 State string `json:"state"`
 Compilation Process `json:"compilation"`
 Execution *Process `json:"execution,omitempty"`
 Stale bool `json:"stale"`
}

func Open(path string) (Source,error) {
 p,e:=filepath.Abs(path)
 if e!=nil{return Source{},e}
 if !strings.EqualFold(filepath.Ext(p),".c"){return Source{},errors.New("本阶段仅支持普通 .c 文件")}
 st,e:=os.Lstat(p)
 if e!=nil{return Source{},e}
 if !st.Mode().IsRegular(){return Source{},errors.New("请选择普通 C 源文件，而不是目录或链接")}
 return Source{Path:p,Directory:filepath.Dir(p),Name:filepath.Base(p)},nil
}

func readSource(s Source)([]byte,error){
 f,e:=os.Open(s.Path);if e!=nil{return nil,e};defer f.Close()
 st,e:=f.Stat();if e!=nil{return nil,e};if !st.Mode().IsRegular(){return nil,errors.New("源文件不是普通文件")}
 b,e:=io.ReadAll(io.LimitReader(f,maxSource+1));if e!=nil{return nil,e}
 if len(b)>maxSource{return nil,errors.New("源文件超过 2 MiB")}
 return b,nil
}

// Conservative gate for this slice, not a C preprocessor or sandbox.
// Reject non-literal and local include directives rather than misrepresent
// them as independently compilable source. Ordinary macros are allowed.
var include = regexp.MustCompile("(?m)^[ \\t]*#[ \\t]*include\\b([^\\r\\n]*)")
var systemInclude = regexp.MustCompile("^[ \\t]*<[A-Za-z0-9_+./-]+>[ \\t]*(?://.*)?$")
func checkSource(b []byte) error {
 s:=strings.ReplaceAll(strings.ReplaceAll(string(b),"\\\r\n",""),"\\\n","")
 for _,m:=range include.FindAllStringSubmatch(s,-1){
  if !systemInclude.MatchString(m[1])||strings.Contains(m[1],"..")||strings.Contains(m[1],"</"){
   return errors.New("03a 暂不支持本地、宏生成或复杂 include（Exam Kit 在阶段 04 接入）")
  }
 }
 return nil
}
func compilerPath(explicit string)(string,error){
 names:=[]string{explicit}
 if explicit==""{
  names=[]string{os.Getenv("CC")}
  if runtime.GOOS=="windows"{names=append(names,"gcc")}else{names=append(names,"cc")}
 }
 for _,n:=range names{if n==""{continue};p,e:=exec.LookPath(n);if e==nil{return filepath.Abs(p)}}
 return "",errors.New("未找到 C 编译器，请安装 GCC/Clang 或在编译器栏填写现有可执行文件路径")
}
func digest(b []byte)string{h:=sha256.Sum256(b);return hex.EncodeToString(h[:])}

type capture struct{ mu sync.Mutex; out,err bytes.Buffer; limit int; hit bool; stop context.CancelFunc }
type sink struct{ c *capture; stderr bool }
func(s sink)Write(p []byte)(int,error){
 c:=s.c;c.mu.Lock();defer c.mu.Unlock()
 left:=c.limit-c.out.Len()-c.err.Len()
 n:=len(p);if n>left{n=left;c.hit=true;c.stop()}
 if s.stderr{_,_=c.err.Write(p[:n])}else{_,_=c.out.Write(p[:n])}
 return len(p),nil
}

func process(parent context.Context,exe string,args []string,cwd,input string,env []string,timeout time.Duration) Process{
 ctx,stop:=context.WithTimeout(parent,timeout);defer stop()
 start:=time.Now()
 c:=&capture{limit:maxOutput,stop:stop}
 cmd:=exec.CommandContext(ctx,exe,args...)
 cmd.Dir=cwd;cmd.Env=env;cmd.Stdin=strings.NewReader(input)
 cmd.Stdout=sink{c:c};cmd.Stderr=sink{c:c,stderr:true}
 configureProcess(cmd)
 cmd.WaitDelay=2*time.Second
 if ctx.Err()!=nil{return Process{ExitCode:-1,State:"cancelled"}}
 err:=cmd.Run()
 c.mu.Lock();defer c.mu.Unlock()
 r:=Process{Stdout:c.out.String(),Stderr:c.err.String(),ExitCode:-1,ElapsedMS:time.Since(start).Milliseconds(),State:"ok"}
 if cmd.ProcessState!=nil{r.ExitCode=cmd.ProcessState.ExitCode()}
 switch{
 case c.hit:r.State="output_limit"
 case parent.Err()!=nil:r.State="cancelled"
 case errors.Is(ctx.Err(),context.DeadlineExceeded):r.State="timeout"
 case err!=nil:
  r.State="failed"
  if r.Stderr==""{r.Stderr=err.Error()}
 }
 return r
}

func childEnv(compiler string)[]string{
 if runtime.GOOS!="windows"{return nil}
 env:=os.Environ()
 for i,v:=range env{if strings.EqualFold(strings.SplitN(v,"=",2)[0],"PATH"){
  env[i]="Path="+filepath.Dir(compiler)+string(os.PathListSeparator)+strings.SplitN(v,"=",2)[1];return env
 }}
 return append(env,"Path="+filepath.Dir(compiler))
}
func artifactArg(cwd,p string)string{
 r,e:=filepath.Rel(cwd,p);if e!=nil{return p};return "."+string(filepath.Separator)+r
}

// Run captures the source bytes once, compiles a temporary copy, then runs
// the executable with exactly the provided stdin (no implicit newline).
// The source directory remains cwd; this is not a security sandbox.
func Run(ctx context.Context,path,input,compiler string)(result Result,err error){
 if len(input)>maxInput{return result,errors.New("输入超过 1 MiB")}
 s,e:=Open(path);if e!=nil{return result,e}
 b,e:=readSource(s);if e!=nil{return result,e}
 if e=checkSource(b);e!=nil{return result,e}
 cc,e:=compilerPath(compiler);if e!=nil{return result,e}
 result=Result{Source:s,SourceDigest:digest(b),Compiler:cc,State:"compilation_failed"}
 defer func(){current,e:=readSource(s);result.Stale=e!=nil||digest(current)!=result.SourceDigest}()
 dir,e:=os.MkdirTemp("","companion-run-");if e!=nil{return result,e}
 defer func(){if e:=os.RemoveAll(dir);e!=nil&&err==nil{err=fmt.Errorf("清理临时目录失败: %w",e)}}()
 snapshot:=filepath.Join(dir,"source.c");program:=filepath.Join(dir,"program")
 if runtime.GOOS=="windows"{program+=".exe"}
 if e=os.WriteFile(snapshot,b,0600);e!=nil{return result,e}
 env:=childEnv(cc)
 result.Compilation=process(ctx,cc,[]string{"-std=c99","-O2","-Wall","-Wextra",artifactArg(s.Directory,snapshot),"-o",artifactArg(s.Directory,program),"-lm"},s.Directory,"",env,30*time.Second)
 if result.Compilation.State!="ok"{
  if result.Compilation.State!="failed"{result.State=result.Compilation.State}
  return result,nil
 }
 r:=process(ctx,program,nil,s.Directory,input,env,2*time.Second)
 result.Execution=&r
 result.State=r.State
 if r.State=="ok"{result.State="ran"}else if r.State=="failed"{result.State="runtime_failed"}
 return result,nil
}
