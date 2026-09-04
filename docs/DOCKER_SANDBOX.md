# Docker 容器级沙箱（多用户隔离）

> xuanji 的沙箱第三档引擎：`sandbox.engine: "docker"` —— 每条 shell 命令跑在**一次性容器**里（namespace + cgroup 隔离），工作区 bind-mount 进容器，其余全部加固。多用户（小明/小红）天然隔离：**各自的工作区挂到各自的容器**。

---

## 1. 为什么需要容器级

| 档位 | 隔离 | 适合 |
|---|---|---|
| userland（默认） | 路径校验 + 正则（可被绕过） | 本地单用户 |
| docker（本方案） | 内核 namespace/cgroup，**进程/文件/网络/资源全隔离** | 多用户、多租户、不可信任务 |

## 2. 每条命令的容器形态

```
docker run --rm \
  --name xj_<rand> \
  -v <用户工作区>:/workspace -w /workspace \   # 只挂载该用户的工作区
  --network none \                             # 默认断网（agent 主进程调 LLM API 不受影响）
  --cap-drop ALL \                             # 去掉所有 Linux 内核能力
  --security-opt no-new-privileges \           # 禁止提权
  --user <uid>:<gid> \                         # 以宿主用户身份跑 → 工作区文件权限一致
  [--memory 1g] [--cpus 1] [--pids-limit 200]  # 资源配额
  [--read-only --tmpfs /tmp] \                 # rootfs 只读
  <镜像> /bin/sh -c "<命令>"
```

安全要点：
- **文件**：容器只见自己的工作区挂载；rootfs 只读，写不出去
- **网络**：`--network none`，shell 内无法外联；agent 主进程（Node）不在容器内，调 API 不受影响
- **提权**：无 capabilities + no-new-privileges，容器内即使有漏洞也难以逃逸提权
- **资源**：每容器独立限额，一个用户跑满不影响别人
- **清理**：`--rm` 用完即焚；命令超时由工具层 kill 容器（不留孤儿）

## 3. 多用户隔离 —— 小明和小红

核心：**同一镜像，每用户一个容器实例，挂载各自工作区**。

```
小明  →  docker run --rm -v /data/users/xiaoming:/workspace …
小红  →  docker run --rm -v /data/users/xiaohong:/workspace …
```

| 隔离维度 | 机制 |
|---|---|
| 文件系统 | 各自 bind mount，容器内只有自己的 `/workspace` |
| 进程 | 各自 PID namespace，互不可见/互不可杀 |
| 网络 | 各自 Network namespace，默认全断网 |
| 资源 | 各自 cgroup 配额 |
| 数据持久 | 产物写回宿主机各自工作区目录 |

平台化形态（未来做多人服务）：**每任务动态起容器、用完销毁** —— 任务 = `docker run --rm` 一次调用，天然无状态、可水平扩展。

## 4. 配置（`xuanji.config.json`）

```json
{
  "sandbox": {
    "enabled": true,
    "engine": "docker",
    "roots": ["."],
    "docker": {
      "image": "xuanji-agent:latest",
      "memory": "1g",
      "cpus": "1",
      "network": false,
      "readOnly": true
    }
  }
}
```

- `engine`：`userland`（默认）/ `docker`
- 未填 `image` 默认 `node:22-bookworm-slim`（文档建议自建含 git 的镜像，见下）
- 纵深防御仍生效：即使走容器，危险命令模式与路径校验先拦一道

## 5. Agent 镜像（建议）

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

```bash
docker build -t xuanji-agent .
```

## 6. 验证步骤（macOS）

```bash
# 1. 启动 Docker Desktop（或 colima start）
docker info

# 2. 构建镜像
docker build -t xuanji-agent - <<EOF
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
EOF

# 3. 配置 engine=docker 后跑一个 demo
node dist/src/cli/index.js run --config <含 docker sandbox 的配置> "在容器里跑 pwd 并列出文件"
```

预期：命令在容器内执行，只能看到挂载的工作区内容；`rm -rf /tmp/x`、`curl 外网` 等被拒。

## 7. 实测记录

- 命令构造（`buildDockerRunArgs`）：单测断言挂载/断网/去能力/限额/只读等全部参数（2 个用例）
- 无 daemon 环境：工具层 **fail-closed** 拒绝执行并提示启动 Docker（1 个用例）
- 危险命令在进容器前即被拦截（纵深，1 个用例）
- 真容器执行：需本机 Docker daemon（2 个集成用例自动跳过，daemon 就绪即生效）

## 8. 局限

- 需要本机 Docker（客户端已在，daemon 需启动）
- 每次命令起/毁容器有开销（毫秒~百毫秒级）；高频命令场景可演进为"长驻容器 + docker exec"
- 容器共享宿主内核 —— 极端安全要求应上 VM/微虚拟机（如 macOS 的 Virtualization.framework）
