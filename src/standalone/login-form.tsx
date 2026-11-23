import { useState } from "react";
import { Box, Text, useInput } from "ink";

export function LoginForm({ canRemember, cancel, submit }: {
  canRemember: boolean;
  cancel: () => void;
  submit: (username: string, password: string, remember: boolean) => Promise<string | void>;
}) {
  const [field, setField] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const count = canRemember ? 3 : 2;

  useInput(async (input, key) => {
    if (busy) return;
    if (key.escape || (key.ctrl && input === "c")) { cancel(); return; }
    if (key.tab || key.upArrow || key.downArrow) {
      setField((field + count + (key.shift || key.upArrow ? -1 : 1)) % count);
      return;
    }
    if (key.return) {
      if (!username.trim() || !password) {
        setField(username.trim() ? 1 : 0);
        setError("请输入账号和密码。");
        return;
      }
      setBusy(true);
      setError("");
      const result = await submit(username.trim(), password, remember);
      if (result) {
        setError(result);
        setPassword("");
        setField(1);
        setBusy(false);
      }
      return;
    }
    if (field === 2) {
      if (input === " ") setRemember(!remember);
      return;
    }
    const setValue = field === 0 ? setUsername : setPassword;
    if (key.backspace || key.delete) setValue(value => [...value].slice(0, -1).join(""));
    else if (!key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow && input)
      setValue(value => value + input.replace(/[\x00-\x1f\x7f]/g, ""));
  });

  return <Box flexDirection="column" paddingX={1}>
    <Text bold>登录 Accoding</Text>
    <Text color={field === 0 ? "cyan" : undefined}>账号  {username}{field === 0 ? "▏" : ""}</Text>
    <Text color={field === 1 ? "cyan" : undefined}>密码  {"•".repeat([...password].length)}{field === 1 ? "▏" : ""}</Text>
    {canRemember ? <Text color={field === 2 ? "cyan" : undefined}>
      [{remember ? "x" : " "}] 保持登录
    </Text> : null}
    {busy ? <Text>登录中…</Text> : null}
    {error ? <Text color="red">{error}</Text> : null}
    <Text dimColor>Tab 切换字段{canRemember ? " · Space 勾选" : ""} · Enter 登录 · Esc 取消</Text>
  </Box>;
}
