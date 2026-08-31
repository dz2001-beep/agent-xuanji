# 沙箱安全防护方案（Sandbox Security）

> 让 agent 在受限环境中执行 —— 即使模型"失控"，也伤不到宿主机。

---

## 1. 威胁模型

agent 的核心风险：**模型是不可信的输入**（可能被 prompt 注入诱导、或自身幻觉），它驱动的工具调用可能造成：

| 威胁 | 示例 | 后果 |
|---|---|---|
| 文件破坏 | `rm -rf`、覆盖项目文件 | 数据丢失 |
| 敏感信息泄露 | 读取 `/etc/passwd`、`.env`、家目录文件 | 凭据泄露 |
| 恶意命令执行 | `curl x | sh`、fork bomb | 主机被控/资源耗尽 |
| 越界写入 | 写系统目录、其它项目 | 污染环境 |
| 资源滥用 | 无限循环、大文件 | 磁盘/CPU 耗尽 |

**原则：默认拒绝、按需放行（fail-closed），纵深防御。**

## 2. 分层防护架构

```
模型输出
  ↓
① 策略引擎（Policy）     —— 按"工具 + 参数"裁决 allow/deny/ask，人工审批，fail-closed
  ↓
② 沙箱（Sandbox）        —— 路径强制在工作区内 + 危险命令拦截  ← 本方案
  ↓
③ 工具执行               —— 超时击杀（toolTimeoutMs）、输出截断
  ↓
④ 审计（Trace）          —— 全事件记录 + 链路回放，问题可溯源
```

每层独立生效：策略层管"该不该做"，沙箱层管"能不能做坏"，审计层管"做了什么"。

## 3. 实现（`src/sandbox.ts`）

### 3.1 路径沙箱（Path Jail）

```ts
export interface SandboxConfig {
  enabled: boolean;             // 总开关（默认关闭，开启后生效）
  roots?: string[];             // 允许的根目录（默认：当前工作区）
  allowExternal?: boolean;      // 是否放行根目录外的绝对路径（默认 false）
  denyCommandPatterns?: RegExp[]; // 额外危险命令模式
}
```

fs 三件套（`fs.read_file` / `fs.write_file` / `fs.list_dir`）的路径解析统一走：

```ts
export function resolveAllowedPath(p: string, cwd: string, cfg: SandboxConfig): string {
  const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const inside = roots.some((r) => isPathWithin(r, resolved));   // 规范化 + 边界校验
  if (inside) return resolved;
  if (cfg.allowExternal) return resolved;
  throw new SandboxError('沙箱拒绝: 路径超出允许范围 …');
}
```

- 相对路径先按工作区解析，再校验是否落在 `roots` 内（`..` 穿越同样被拦截，因为基于 `path.resolve` 后的真实路径判断）
- 越界在**任何 I/O 发生之前**拒绝

### 3.2 危险命令拦截（Command Guard）

```ts
export const DEFAULT_DENY_PATTERNS = [
  /(^|[;&|]\s*)\s*rm\s+(-[a-z]*r[a-z]*\s+)?\//i,  // rm -rf /…
  /\bmkfs/i,                                        // 创建文件系统
  /\bdd\s+if=/,                                     // 写块设备
  /:\(\)\s*\{/,                                     // fork bomb
  /\bshutdown\b|\breboot\b|\bpoweroff\b/,
  /\bsudo\s+rm\b/,
  />\s*\/dev\/sd[a-z]/i,                            // 写裸设备
  /\bcurl\s+[^\s|;&]+\s*\|\s*(ba)?sh\b/i,           // curl | sh
];
```

- `shell.run` 执行前先过模式检查 + shell cwd 也须在 roots 内
- 可通过 `denyCommandPatterns` 追加自定义规则（如 `git push`）

### 3.3 接线

- `HarnessConfig.sandbox` → `Harness.run` → `RunOptions.sandbox` → `ToolContext.sandbox` → 内置工具守卫
- **默认关闭**（向后兼容）；开启后对 fs/shell 生效

## 4. 配置示例（`xuanji.config.json`）

```json
{
  "sandbox": {
    "enabled": true,
    "roots": ["."],
    "allowExternal": false,
    "denyCommandPatterns": ["git push"]
  }
}
```

开启后：agent 只能读写工作区内文件，`rm -rf`、`curl | sh` 等危险命令直接拒绝，shell 工作目录也被限定在工作区。

## 5. 实测行为

```
fs.read_file("/etc/passwd")   → 沙箱拒绝: 路径超出允许范围…
fs.read_file("ok.txt")        → ✅ 正常读取（工作区内）
shell.run("rm -rf /tmp/x")    → 沙箱拒绝: 命令命中危险模式…
shell.run("npm test")         → ✅ 正常执行
```

## 6. 局限性（诚实说明）

- **用户态沙箱**：路径与命令拦截是代码层防护，不是操作系统级隔离（无 seccomp/容器/网络命名空间）
- **网络未隔离**：agent 仍可联网（联网搜索/API 调用是特性）；如需出网管控需系统级方案
- **绕过面**：shell 内的复杂注入（如 `python -c`）可绕过正则 —— 因此必须与 ①策略审批 ③超时 ④审计 配合
- **生产建议**：在 Docker / VM / 无网容器中运行 agent 进程，叠加本沙箱作为纵深防御

## 7. 测试

`test/sandbox.test.ts`（11 个用例）：
- `isPathWithin` 边界（根/后代/兄弟/祖先）
- `resolveAllowedPath` 区内放行 / 越界拒绝 / allowExternal 放行
- `checkCommandAllowed` 全部危险模式拦截 / 正常命令放行 / 自定义模式
- 工具集成：沙箱开启时读区外拒绝、危险命令拦截；关闭时行为不变（向后兼容）
