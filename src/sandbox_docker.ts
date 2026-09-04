/**
 * Docker engine for the sandbox — every shell command runs inside a
 * throwaway container (namespace + cgroup isolation), with the workspace
 * bind-mounted and the container otherwise hardened:
 *
 *   docker run --rm \
 *     --name xj-<rand> \
 *     -v <workspace>:/workspace -w /workspace \
 *     --network none \                    # 默认断网（agent 主进程调 API 不受影响）
 *     --cap-drop ALL \                    # 去掉所有内核能力
 *     --security-opt no-new-privileges \
 *     --user <uid>:<gid> \                # 以宿主用户运行 → 工作区文件权限一致
 *     [--memory 1g] [--cpus 1] [--pids-limit 200]
 *     [--read-only --tmpfs /tmp] \        # 只读 rootfs
 *     <image> /bin/sh -c "<command>"
 *
 * Multi-user isolation (小明的容器 ≠ 小红的容器) is achieved by simply
 * mounting each user's own workspace directory — see docs/DOCKER_SANDBOX.md.
 */

import { spawn } from 'node:child_process';

export interface DockerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 20_000;

/** Build the `docker run` argv (pure — unit-testable). */
export function buildDockerRunArgs(opts: {
  workspace: string;
  command: string;
  image: string;
  memory?: string;
  cpus?: string;
  network?: boolean;
  readOnly?: boolean;
  hostUid?: number;
  hostGid?: number;
}): { args: string[]; name: string } {
  const name = `xj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const args = ['run', '--rm', '--name', name];
  args.push('-v', `${opts.workspace}:/workspace`, '-w', '/workspace');
  if (opts.network !== true) args.push('--network', 'none');
  args.push('--cap-drop', 'ALL');
  args.push('--security-opt', 'no-new-privileges');
  if (opts.hostUid !== undefined && opts.hostGid !== undefined) {
    args.push('--user', `${opts.hostUid}:${opts.hostGid}`);
  }
  if (opts.memory) args.push('--memory', opts.memory);
  if (opts.cpus) args.push('--cpus', opts.cpus);
  args.push('--pids-limit', '200');
  if (opts.readOnly !== false) {
    args.push('--read-only', '--tmpfs', '/tmp');
  }
  args.push(opts.image, '/bin/sh', '-c', opts.command);
  return { args, name };
}

/**
 * Run one shell command inside a throwaway container. On timeout the
 * `docker run` client is killed AND the container is force-killed so no
 * container leaks.
 */
export function runInDocker(
  command: string,
  opts: {
    workspace: string;
    image?: string;
    memory?: string;
    cpus?: string;
    network?: boolean;
    readOnly?: boolean;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<DockerRunResult> {
  return new Promise<DockerRunResult>((resolve) => {
    const timeoutMs = Math.min(opts.timeoutMs ?? 30_000, 60_000);
    const { args, name } = buildDockerRunArgs({
      workspace: opts.workspace,
      command,
      image: opts.image ?? 'node:22-bookworm-slim',
      memory: opts.memory,
      cpus: opts.cpus,
      network: opts.network,
      readOnly: opts.readOnly,
      hostUid: typeof process.getuid === 'function' ? process.getuid() : undefined,
      hostGid: typeof process.getgid === 'function' ? process.getgid() : undefined,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('docker', args, { env: opts.env ?? process.env });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // 兜底：确保容器也被杀掉，不留孤儿
      void spawn('docker', ['kill', name], { stdio: 'ignore' });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr || `docker 启动失败: ${err.message}`, timedOut: false });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/** Probe whether a usable Docker daemon exists (cached). */
let dockerOk: boolean | null = null;
export function hasDocker(): Promise<boolean> {
  if (dockerOk !== null) return Promise.resolve(dockerOk);
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      dockerOk = false;
      resolve(false);
    }, 3000);
    child.on('error', () => {
      clearTimeout(timer);
      dockerOk = false;
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      dockerOk = code === 0;
      resolve(dockerOk);
    });
  });
}
