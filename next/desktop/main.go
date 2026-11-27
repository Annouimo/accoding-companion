package main

import (
 "context"
 "embed"
 "errors"
 "fmt"
 "log"
 "os"
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
 last *localrun.BatchResult
}
func(d *Desktop) Initial()(localrun.Source,error){d.mu.Lock();defer d.mu.Unlock();return d.selected,nil}
func(d *Desktop) ChooseSource()(localrun.Source,error){
 d.mu.Lock();if d.running{d.mu.Unlock();return localrun.Source{},errors.New("请先结束当前运行")};d.mu.Unlock()
 p,e:=d.native.Dialog.OpenFile().SetTitle("选择 C 源文件").AddFilter("C 源文件","*.c").PromptForSingleSelection()
 if e!=nil||p==""{return localrun.Source{},e}
 s,e:=localrun.Open(p);if e!=nil{return s,e}
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return localrun.Source{},errors.New("正在运行")}
 d.selected=s;d.last=nil;return s,nil
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
 if e==nil{d.mu.Lock();d.last=&r;d.mu.Unlock()}
 return r,e
}
func(d *Desktop) IsCurrent(compiler string)(bool,error){
 d.mu.Lock();defer d.mu.Unlock()
 if d.last==nil||d.last.Source.Path!=d.selected.Path{return false,nil}
 return localrun.Current(*d.last,compiler),nil
}
func(d *Desktop) Cancel(){d.mu.Lock();defer d.mu.Unlock();if d.cancel!=nil{d.cancel()}}
func(d *Desktop) shutdown(){
 d.mu.Lock();if d.cancel!=nil{d.cancel()};done:=d.done;d.mu.Unlock()
 if done!=nil{<-done}
}
func main(){
 d:=&Desktop{}
 if len(os.Args)==2{if s,e:=localrun.Open(os.Args[1]);e==nil{d.selected=s}else{fmt.Fprintln(os.Stderr,e)}}
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
