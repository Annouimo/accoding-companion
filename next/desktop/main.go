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
}
func(d *Desktop) Initial()(localrun.Source,error){d.mu.Lock();defer d.mu.Unlock();return d.selected,nil}
func(d *Desktop) ChooseSource()(localrun.Source,error){
 d.mu.Lock();if d.running{d.mu.Unlock();return localrun.Source{},errors.New("请先结束当前运行")};d.mu.Unlock()
 p,e:=d.native.Dialog.OpenFile().SetTitle("选择 C 源文件").AddFilter("C 源文件","*.c").PromptForSingleSelection()
 if e!=nil||p==""{return localrun.Source{},e}
 s,e:=localrun.Open(p);if e!=nil{return s,e}
 d.mu.Lock();defer d.mu.Unlock()
 if d.running{return localrun.Source{},errors.New("正在运行")}
 d.selected=s;return s,nil
}
func(d *Desktop) Run(input,compiler string)(localrun.Result,error){
 d.mu.Lock()
 if d.running||d.selected.Path==""{d.mu.Unlock();return localrun.Result{},errors.New("请选择源文件并结束之前的运行")}
 ctx,cancel:=context.WithCancel(context.Background())
 path:=d.selected.Path;d.running=true;d.cancel=cancel;d.mu.Unlock()
 defer func(){cancel();d.mu.Lock();d.running=false;d.cancel=nil;d.mu.Unlock()}()
 return localrun.Run(ctx,path,input,compiler)
}
func(d *Desktop) Cancel(){d.mu.Lock();defer d.mu.Unlock();if d.cancel!=nil{d.cancel()}}
func main(){
 d:=&Desktop{}
 if len(os.Args)==2{if s,e:=localrun.Open(os.Args[1]);e==nil{d.selected=s}else{fmt.Fprintln(os.Stderr,e)}}
 app:=application.New(application.Options{
  Name:"Companion",Description:"Local C programming companion",
  Services:[]application.Service{application.NewService(d)},
  Assets:application.AssetOptions{Handler:application.BundledAssetFileServer(assets)},
  Mac:application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed:true},
  OnShutdown:d.Cancel,
 })
 d.native=app
 app.Window.NewWithOptions(application.WebviewWindowOptions{Title:"Companion",Width:1000,Height:700,URL:"/"})
 if e:=app.Run();e!=nil{log.Fatal(e)}
}
