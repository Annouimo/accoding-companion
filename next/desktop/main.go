package main

import (
 "context"
 "embed"
 "errors"
 "fmt"
 "log"
 "os"
 "path/filepath"
 "sync"

 "github.com/Routilet/accoding-companion/next/internal/localrun"
 "github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

type Desktop struct{
 native *application.App
 mu sync.Mutex
 selected localrun.Source
 running bool
 cancel context.CancelFunc
 done chan struct{}
 root string
 last map[string]localrun.BatchResult
 order []string
}
type Navigation struct { Root string `json:"root"`; Source localrun.Source `json:"source"` }
func(d *Desktop) nav()Navigation{return Navigation{d.root,d.selected}}
func(d *Desktop) Initial()(Navigation,error){d.mu.Lock();defer d.mu.Unlock();return d.nav(),nil}
func(d *Desktop) ChooseSource()(Navigation,error){
 d.mu.Lock();if d.running{d.mu.Unlock();return Navigation{},errors.New("请先结束当前运行")};d.mu.Unlock()
 p,e:=d.native.Dialog.OpenFile().SetTitle("选择 C/C++ 源文件").AddFilter("C/C++ 源文件","*.c;*.cpp;*.cc;*.cxx").PromptForSingleSelection()
 if e!=nil||p==""{return Navigation{},e}
 s,e:=localrun.Open(p);if e!=nil{return Navigation{},e}
 root,e:=localrun.OpenDirectory(s.Directory);if e!=nil{return Navigation{},e}
 s,e=localrun.Open(filepath.Join(root,s.Name));if e!=nil{return Navigation{},e}
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return Navigation{},errors.New("正在运行")}
 d.root=root;d.selected=s;return d.nav(),nil
}
func(d *Desktop) ChooseFolder()(Navigation,error){
 p,e:=d.native.Dialog.OpenFile().SetTitle("打开文件夹").CanChooseFiles(false).CanChooseDirectories(true).PromptForSingleSelection()
 if e!=nil||p==""{return Navigation{},e}
 root,e:=localrun.OpenDirectory(p);if e!=nil{return Navigation{},e}
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return Navigation{},errors.New("正在运行")}
 d.root=root;d.selected=localrun.Source{};return d.nav(),nil
}
func(d *Desktop) List(dir string)([]localrun.Entry,error){
 d.mu.Lock();root:=d.root;d.mu.Unlock();return localrun.ListDirectory(root,dir)
}
func(d *Desktop) Select(path string)(Navigation,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return Navigation{},errors.New("正在运行")}
 p,e:=localrun.Within(d.root,path);if e!=nil{return Navigation{},e}
 s,e:=localrun.Open(p);if e!=nil{return Navigation{},e}
 d.selected=s;return d.nav(),nil
}
func(d *Desktop) Create(dir,name string)(Navigation,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return Navigation{},errors.New("正在运行")}
 s,e:=localrun.CreateSource(d.root,dir,name);if e!=nil{return Navigation{},e}
 d.selected=s;return d.nav(),nil
}
func(d *Desktop) Rename(name string)(Navigation,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.running||d.selected.Path==""{return Navigation{},errors.New("当前不能重命名")}
 old:=d.selected.Path
 s,e:=localrun.RenameSource(d.root,old,name);if e!=nil{return Navigation{},e}
 delete(d.last,old);delete(d.last,s.Path);d.selected=s;return d.nav(),nil
}
func(d *Desktop) Orphans()([]localrun.Orphan,error){
 d.mu.Lock();defer d.mu.Unlock()
 return localrun.ListOrphans(d.selected.Path)
}
func(d *Desktop) Restore(name,rev string)(localrun.CaseSet,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return localrun.CaseSet{},errors.New("正在运行")}
 return localrun.RestoreOrphan(d.selected.Path,name,rev)
}
func(d *Desktop) Import(rev string,appendExisting bool)(*localrun.CaseSet,error){
 d.mu.Lock();selected:=d.selected.Path;d.mu.Unlock()
 p,e:=d.native.Dialog.OpenFile().SetTitle("导入测试数据").AddFilter("JSON","*.json").ShowHiddenFiles(true).PromptForSingleSelection()
 if e!=nil||p==""{return nil,e}
 d.mu.Lock();defer d.mu.Unlock()
 if d.running||selected==""||selected!=d.selected.Path{return nil,errors.New("文件已切换")}
 cs,e:=localrun.ImportCases(selected,p,rev,appendExisting);return &cs,e
}
func(d *Desktop) Cached(compiler string)(*localrun.BatchResult,error){
 d.mu.Lock();defer d.mu.Unlock()
 r,ok:=d.last[d.selected.Path];if !ok{return nil,nil}
 r.Stale=r.Stale||!localrun.Current(r,compiler)
 return &r,nil
}
func(d *Desktop) remember(r localrun.BatchResult){
 if d.last==nil{d.last=map[string]localrun.BatchResult{}}
 path:=r.Source.Path
 for i,p:=range d.order{if p==path{d.order=append(d.order[:i],d.order[i+1:]...);break}}
 d.order=append(d.order,path);d.last[path]=r
 // Keep only a small session cache; a result may contain large outputs.
 for len(d.order)>4{delete(d.last,d.order[0]);d.order=d.order[1:]}
}
// CheckSelected validates the current path even if its parent is collapsed.
func(d *Desktop) CheckSelected()(bool,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.selected.Path==""{return false,nil}
 _,e:=localrun.Within(d.root,d.selected.Path)
 if e==nil{_,e=localrun.Open(d.selected.Path)}
 if e!=nil{delete(d.last,d.selected.Path);return false,nil}
 return true,nil
}
func(d *Desktop) Invalidate(path string){
 d.mu.Lock();defer d.mu.Unlock();delete(d.last,path)
}
func(d *Desktop) LoadCases()(localrun.CaseSet,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.selected.Path==""{return localrun.CaseSet{},errors.New("请选择源文件")}
 return localrun.LoadCases(d.selected.Path)
}
func(d *Desktop) SaveCases(cs []localrun.Case,rev string)(localrun.CaseSet,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.running||d.selected.Path==""{return localrun.CaseSet{},errors.New("当前不能保存")}
 return localrun.SaveCases(d.selected.Path,cs,rev)
}
func(d *Desktop) RunBatch(compiler,revision string,selection int)(localrun.BatchResult,error){
 d.mu.Lock()
 if d.running||d.selected.Path==""{d.mu.Unlock();return localrun.BatchResult{},errors.New("请选择源文件并结束之前的运行")}
 ctx,cancel:=context.WithCancel(context.Background())
 path:=d.selected.Path;d.running=true;d.cancel=cancel;d.done=make(chan struct{});d.mu.Unlock()
 defer func(){cancel();d.mu.Lock();d.running=false;d.cancel=nil;close(d.done);d.done=nil;d.mu.Unlock()}()
 r,e:=localrun.RunBatch(ctx,path,compiler,revision,selection)
 if e==nil{d.mu.Lock();d.remember(r);d.mu.Unlock()}
 return r,e
}
func(d *Desktop) IsCurrent(compiler string)(bool,error){
 d.mu.Lock();defer d.mu.Unlock()
 r,ok:=d.last[d.selected.Path];if !ok{return false,nil}
 return !r.Stale&&localrun.Current(r,compiler),nil
}
func(d *Desktop) Cancel(){d.mu.Lock();defer d.mu.Unlock();if d.cancel!=nil{d.cancel()}}
func(d *Desktop) shutdown(){
 d.mu.Lock();if d.cancel!=nil{d.cancel()};done:=d.done;d.mu.Unlock()
 if done!=nil{<-done}
}
func main(){
 d:=&Desktop{}
 if len(os.Args)==2{if s,e:=localrun.Open(os.Args[1]);e==nil{if root,e:=localrun.OpenDirectory(s.Directory);e==nil{d.root=root;d.selected,_=localrun.Open(filepath.Join(root,s.Name))}}else if root,e:=localrun.OpenDirectory(os.Args[1]);e==nil{d.root=root}else{fmt.Fprintln(os.Stderr,e)}}
 app:=application.New(application.Options{
  Name:"Companion",Description:"Local C programming companion",
  Services:[]application.Service{application.NewService(d)},
  Assets:application.AssetOptions{Handler:application.BundledAssetFileServer(assets)},
  Mac:application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed:true},
  OnShutdown:d.shutdown,
 })
 d.native=app
 app.Window.NewWithOptions(application.WebviewWindowOptions{Title:"Companion",Width:1000,Height:700,URL:"/"})
 if e:=app.Run();e!=nil{log.Fatal(e)}
}
