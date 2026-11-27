package localrun

import (
 "regexp"
 "strconv"
 "strings"
 "path/filepath"
)
type Difference struct {
 Line int `json:"line"`
 Column int `json:"column"`
 Expected string `json:"expected"`
 Actual string `json:"actual"`
}
func normalize(s string)string{
 lines:=strings.Split(strings.ReplaceAll(s,"\r\n","\n"),"\n")
 for i:=range lines{lines[i]=strings.TrimRight(lines[i]," \t")}
 return strings.TrimRight(strings.Join(lines,"\n"),"\n")
}
func visible(s []rune)string{
 if len(s)==0{return "〈末尾〉"}
 if len(s)>80{s=s[:80]}
 return strings.NewReplacer(" ","·","\t","→","\n","↵\n").Replace(string(s))
}
func Compare(expected,actual string)*Difference{
 e,a:=[]rune(normalize(expected)),[]rune(normalize(actual))
 i,line,col:=0,1,1
 for i<len(e)&&i<len(a)&&e[i]==a[i]{if e[i]=='\n'{line++;col=1}else{col++};i++}
 if i==len(e)&&i==len(a){return nil}
 return &Difference{Line:line,Column:col,Expected:visible(e[i:]),Actual:visible(a[i:])}
}
type Diagnostic struct{
 Severity string `json:"severity"`
 Message string `json:"message"`
 Raw string `json:"raw"`
 File string `json:"file,omitempty"`
 Line int `json:"line,omitempty"`
 Column int `json:"column,omitempty"`
}
var diagPattern=regexp.MustCompile("^(.+?):([0-9]+):(?:([0-9]+):)?[ \\t]*(fatal error|error|warning|note):[ \\t]*(.*)$")
func diagnostics(raw,snapshot,source string)[]Diagnostic{
 out:=[]Diagnostic{}
 for _,line:=range strings.Split(strings.ReplaceAll(raw,"\r\n","\n"),"\n"){
  if line==""{continue}
  m:=diagPattern.FindStringSubmatch(line)
  if m==nil{
   if len(out)>0{out[len(out)-1].Raw+="\n"+line}else{out=append(out,Diagnostic{Severity:"info",Message:line,Raw:line})}
   continue
  }
  row,_:=strconv.Atoi(m[2]);col,_:=strconv.Atoi(m[3]);file:=m[1]
  if filepath.Base(file)==filepath.Base(snapshot){file=source}
  out=append(out,Diagnostic{Severity:m[4],Message:m[5],Raw:line,File:file,Line:row,Column:col})
 }
 return out
}
