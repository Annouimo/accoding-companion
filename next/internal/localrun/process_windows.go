//go:build windows

package localrun

import (
 "os"
 "os/exec"
 "strconv"
 "syscall"
)

// Best-effort tree termination for 03a; robust job-object ownership and
// descendant cleanup are specifically required in 03b.
func configureProcess(cmd *exec.Cmd){
 cmd.SysProcAttr=&syscall.SysProcAttr{HideWindow:true,CreationFlags:0x08000000}
 cmd.Cancel=func()error{
  if cmd.Process==nil{return os.ErrProcessDone}
  killer:=exec.Command("taskkill","/PID",strconv.Itoa(cmd.Process.Pid),"/T","/F")
  killer.SysProcAttr=&syscall.SysProcAttr{HideWindow:true,CreationFlags:0x08000000}
  if killer.Run()==nil{return nil}
  return cmd.Process.Kill()
 }
}
