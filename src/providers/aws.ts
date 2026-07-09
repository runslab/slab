// slab — aws provider (v1: services only). Renders apps onto ECS Fargate:
// image pushed to ECR, one task definition + service per app, logs in
// CloudWatch, endpoint = the task's public IP.
//
// AUTH: slab holds no credentials. Every call shells out to the operator's
// own `aws` CLI, so it runs as whatever identity they already have —
// aws configure keys, an SSO profile, env vars, or an EC2 instance role
// when the daemon lives in EC2. ~/.slab/providers.toml names a profile and
// region at most; never secrets. Everything is created in the user's
// account: cluster `slab`, role `slabEcsExecutionRole`, SG `slab-<port>`,
// repo `slab/<app>`, log group `/slab/<app>`, service `slab-<app>`.
import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { parse } from 'smol-toml'
import { AppRecord } from '../types'
import { slabDir } from '../state'
import { Provider } from './provider'

const EXEC_ROLE = 'slabEcsExecutionRole'
const DEPLOY_WAIT_MS = 240_000
const POLL_MS = 5_000

interface AwsConfig {
  region?: string
  profile?: string
  cluster: string
  cpu: string
  memory: string
}

function loadConfig(): AwsConfig {
  let raw: Record<string, unknown> = {}
  try {
    const file = path.join(slabDir(), 'providers.toml')
    raw = (parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>)
  } catch { /* no config file — defaults + ambient credentials */ }
  const aws = (raw.aws ?? {}) as Record<string, unknown>
  return {
    region: aws.region != null ? String(aws.region) : undefined,
    profile: aws.profile != null ? String(aws.profile) : undefined,
    cluster: aws.cluster != null ? String(aws.cluster) : 'slab',
    cpu: aws.cpu != null ? String(aws.cpu) : '256',
    memory: aws.memory != null ? String(aws.memory) : '512',
  }
}

function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || err.message || '').trim().split('\n').slice(0, 3).join(' ')
        reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')}… failed: ${detail}`))
        return
      }
      resolve(stdout)
    })
    if (input != null && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function createAwsProvider(): Provider {
  const cfg = loadConfig()
  let region: string | null = cfg.region ?? null
  let accountId: string | null = null
  let readyChecked = false

  function base(): string[] {
    const a = ['--output', 'json', '--no-cli-pager']
    if (region) a.push('--region', region)
    if (cfg.profile) a.push('--profile', cfg.profile)
    return a
  }

  async function aws(args: string[]): Promise<any> {
    const out = await run('aws', [...args, ...base()])
    if (!out.trim()) return null
    try { return JSON.parse(out) } catch { return out }
  }

  // Tolerate idempotency errors ("already exists") — everything ensure-shaped
  async function awsTolerate(args: string[], pattern: RegExp): Promise<any> {
    try {
      return await aws(args)
    } catch (err) {
      if (pattern.test((err as Error).message)) return null
      throw err
    }
  }

  async function ready(): Promise<void> {
    if (readyChecked) return
    try {
      await run('aws', ['--version'])
    } catch {
      throw new Error('aws CLI not found — install it (brew install awscli) and run: aws configure')
    }
    if (!region) {
      try {
        const r = (await run('aws', ['configure', 'get', 'region', ...(cfg.profile ? ['--profile', cfg.profile] : [])])).trim()
        region = r || null
      } catch { /* fall through */ }
    }
    if (!region) {
      throw new Error('no AWS region configured — set [aws] region in ~/.slab/providers.toml or run: aws configure')
    }
    let ident: any
    try {
      ident = await aws(['sts', 'get-caller-identity'])
    } catch (err) {
      throw new Error(`AWS credentials not usable: ${(err as Error).message} — run aws configure (or set [aws] profile in ~/.slab/providers.toml)`)
    }
    accountId = ident.Account
    readyChecked = true
  }

  // ── ensure-shaped primitives (all idempotent, all in the user's account) ──

  async function ensureCluster(): Promise<void> {
    await aws(['ecs', 'create-cluster', '--cluster-name', cfg.cluster])
  }

  async function ensureExecutionRole(): Promise<string> {
    try {
      const r = await aws(['iam', 'get-role', '--role-name', EXEC_ROLE])
      return r.Role.Arn
    } catch { /* create below */ }
    const trust = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { Service: 'ecs-tasks.amazonaws.com' }, Action: 'sts:AssumeRole' }],
    })
    const created = await aws(['iam', 'create-role', '--role-name', EXEC_ROLE,
      '--assume-role-policy-document', trust,
      '--description', 'slab: lets Fargate pull ECR images and write CloudWatch logs'])
    await awsTolerate(['iam', 'attach-role-policy', '--role-name', EXEC_ROLE,
      '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'], /./)
    await sleep(8000)   // IAM propagation before first register-task-definition
    return created.Role.Arn
  }

  async function ensureLogGroup(app: AppRecord): Promise<string> {
    const name = `/slab/${app.name}`
    await awsTolerate(['logs', 'create-log-group', '--log-group-name', name], /ResourceAlreadyExists/)
    return name
  }

  async function defaultVpc(): Promise<string> {
    const r = await aws(['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true'])
    const vpc = r.Vpcs?.[0]?.VpcId
    if (!vpc) throw new Error('no default VPC in this region — v1 of the aws provider uses the default VPC (set [aws] region to one that has it)')
    return vpc
  }

  async function ensureSecurityGroup(port: number): Promise<string> {
    const vpc = await defaultVpc()
    const name = `slab-${port}`
    const found = await aws(['ec2', 'describe-security-groups', '--filters',
      `Name=group-name,Values=${name}`, `Name=vpc-id,Values=${vpc}`])
    let sgId = found.SecurityGroups?.[0]?.GroupId
    if (!sgId) {
      const created = await aws(['ec2', 'create-security-group', '--group-name', name,
        '--description', `slab: public ingress on ${port}`, '--vpc-id', vpc])
      sgId = created.GroupId
    }
    await awsTolerate(['ec2', 'authorize-security-group-ingress', '--group-id', sgId,
      '--protocol', 'tcp', '--port', String(port), '--cidr', '0.0.0.0/0'], /Duplicate/)
    return sgId
  }

  async function defaultSubnets(): Promise<string[]> {
    const vpc = await defaultVpc()
    const r = await aws(['ec2', 'describe-subnets', '--filters', `Name=vpc-id,Values=${vpc}`, 'Name=default-for-az,Values=true'])
    const ids = (r.Subnets ?? []).map((s: { SubnetId: string }) => s.SubnetId)
    if (!ids.length) throw new Error('no default subnets found in the default VPC')
    return ids.slice(0, 3)
  }

  async function ensureRepo(app: AppRecord): Promise<string> {
    const name = `slab/${app.name}`
    try {
      const r = await aws(['ecr', 'describe-repositories', '--repository-names', name])
      return r.repositories[0].repositoryUri
    } catch {
      const r = await aws(['ecr', 'create-repository', '--repository-name', name])
      return r.repository.repositoryUri
    }
  }

  async function prepareImage(app: AppRecord, localTag: string): Promise<string> {
    await ready()
    const repoUri = await ensureRepo(app)
    const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com`
    const pwArgs = ['ecr', 'get-login-password', '--region', region!]
    if (cfg.profile) pwArgs.push('--profile', cfg.profile)
    const password = (await run('aws', pwArgs)).trim()
    await run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], password)
    const remote = `${repoUri}:v${app.version + 1}`
    await run('docker', ['tag', localTag, remote])
    await run('docker', ['push', remote])
    return remote
  }

  // Built-and-pushed images are single-arch (whatever the local machine is —
  // arm64 on apple silicon). Fargate defaults to amd64, so the task's
  // runtimePlatform must match the image or placement fails with
  // CannotPullContainerError. Registry-ref images (docker hub) are usually
  // multi-arch — omit runtimePlatform and let Fargate pick.
  async function imageArch(image: string): Promise<string | null> {
    try {
      const out = await run('docker', ['image', 'inspect', '--format', '{{.Architecture}}', image])
      const arch = out.trim()
      return arch === 'arm64' ? 'ARM64' : arch === 'amd64' ? 'X86_64' : null
    } catch {
      return null   // not in the local store (e.g. a hub ref) — let Fargate default
    }
  }

  async function registerTaskDef(app: AppRecord, image: string, env: Record<string, string>, roleArn: string, logGroup: string): Promise<string> {
    const arch = await imageArch(image)
    const def = {
      family: `slab-${app.name}`,
      requiresCompatibilities: ['FARGATE'],
      networkMode: 'awsvpc',
      cpu: cfg.cpu,
      memory: cfg.memory,
      executionRoleArn: roleArn,
      ...(arch ? { runtimePlatform: { cpuArchitecture: arch, operatingSystemFamily: 'LINUX' } } : {}),
      containerDefinitions: [{
        name: app.name,
        image,
        essential: true,
        portMappings: [{ containerPort: app.manifest.port, protocol: 'tcp' }],
        environment: Object.entries(env).map(([name, value]) => ({ name, value })),
        logConfiguration: {
          logDriver: 'awslogs',
          options: { 'awslogs-group': logGroup, 'awslogs-region': region!, 'awslogs-stream-prefix': 'slab' },
        },
      }],
    }
    const r = await aws(['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(def)])
    return r.taskDefinition.taskDefinitionArn
  }

  async function serviceState(app: AppRecord): Promise<{ exists: boolean; running: number; desired: number }> {
    const r = await aws(['ecs', 'describe-services', '--cluster', cfg.cluster, '--services', `slab-${app.name}`])
    const svc = (r.services ?? []).find((s: { status: string }) => s.status !== 'INACTIVE')
    if (!svc) return { exists: false, running: 0, desired: 0 }
    return { exists: true, running: svc.runningCount ?? 0, desired: svc.desiredCount ?? 0 }
  }

  // The endpoint is the running task's public IP + the app port. It changes
  // when the task is replaced — status() refreshes it.
  async function taskEndpoint(app: AppRecord): Promise<string | null> {
    const tasks = await aws(['ecs', 'list-tasks', '--cluster', cfg.cluster, '--service-name', `slab-${app.name}`, '--desired-status', 'RUNNING'])
    const arn = tasks.taskArns?.[0]
    if (!arn) return null
    const d = await aws(['ecs', 'describe-tasks', '--cluster', cfg.cluster, '--tasks', arn])
    const task = d.tasks?.[0]
    if (!task || task.lastStatus !== 'RUNNING') return null
    const eni = task.attachments?.flatMap((a: { details?: Array<{ name: string; value: string }> }) => a.details ?? [])
      .find((x: { name: string }) => x.name === 'networkInterfaceId')?.value
    if (!eni) return null
    const ni = await aws(['ec2', 'describe-network-interfaces', '--network-interface-ids', eni])
    const ip = ni.NetworkInterfaces?.[0]?.Association?.PublicIp
    return ip ? `${ip}:${app.manifest.port}` : null
  }

  async function waitForEndpoint(app: AppRecord): Promise<string | null> {
    const deadline = Date.now() + DEPLOY_WAIT_MS
    while (Date.now() < deadline) {
      const ep = await taskEndpoint(app)
      if (ep) return ep
      await sleep(POLL_MS)
    }
    return null   // service exists; task still pending — status() picks it up later
  }

  async function deploy(app: AppRecord, image: string, env: Record<string, string>): Promise<{ ref: string; endpoint: string | null }> {
    await ready()
    await ensureCluster()
    const roleArn = await ensureExecutionRole()
    const logGroup = await ensureLogGroup(app)
    const taskDefArn = await registerTaskDef(app, image, env, roleArn, logGroup)
    const sg = await ensureSecurityGroup(app.manifest.port)
    const subnets = await defaultSubnets()
    const svc = await serviceState(app)
    const netCfg = `awsvpcConfiguration={subnets=[${subnets.join(',')}],securityGroups=[${sg}],assignPublicIp=ENABLED}`
    if (svc.exists) {
      await aws(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`,
        '--task-definition', taskDefArn, '--desired-count', '1', '--network-configuration', netCfg])
    } else {
      await aws(['ecs', 'create-service', '--cluster', cfg.cluster, '--service-name', `slab-${app.name}`,
        '--task-definition', taskDefArn, '--desired-count', '1', '--launch-type', 'FARGATE',
        '--network-configuration', netCfg])
    }
    const endpoint = await waitForEndpoint(app)
    return { ref: `${cfg.cluster}/slab-${app.name}`, endpoint }
  }

  async function stop(app: AppRecord): Promise<void> {
    await ready()
    await aws(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--desired-count', '0'])
  }

  async function start(app: AppRecord): Promise<{ endpoint: string | null }> {
    await ready()
    await aws(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--desired-count', '1'])
    return { endpoint: await waitForEndpoint(app) }
  }

  async function remove(app: AppRecord): Promise<void> {
    await ready()
    await awsTolerate(['ecs', 'update-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--desired-count', '0'], /ServiceNotFound|ClusterNotFound/)
    await awsTolerate(['ecs', 'delete-service', '--cluster', cfg.cluster, '--service', `slab-${app.name}`, '--force'], /ServiceNotFound|ClusterNotFound/)
    // Kept on purpose (cheap, and useful history): ECR repo, log group, task
    // definitions, the shared cluster/role/SG — documented in docs/providers/aws.md
  }

  async function status(app: AppRecord): Promise<{ state: 'running' | 'stopped' | 'unknown'; endpoint?: string | null }> {
    await ready()
    try {
      const svc = await serviceState(app)
      if (!svc.exists) return { state: 'unknown' }
      if (svc.running > 0) return { state: 'running', endpoint: await taskEndpoint(app) }
      return { state: 'stopped' }
    } catch {
      return { state: 'unknown' }
    }
  }

  async function logs(app: AppRecord, tail: number): Promise<string> {
    await ready()
    try {
      const r = await aws(['logs', 'filter-log-events', '--log-group-name', `/slab/${app.name}`,
        '--limit', String(Math.min(1000, tail))])
      const events = (r.events ?? []) as Array<{ timestamp: number; message: string }>
      return events
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((e) => `${new Date(e.timestamp).toISOString()} ${e.message}`)
        .join('\n')
    } catch (err) {
      return `no logs yet: ${(err as Error).message}`
    }
  }

  return {
    name: 'aws',
    capabilities: { functions: false, jobs: false, systems: false, postgres: false },
    ready,
    prepareImage,
    deploy,
    stop,
    start,
    remove,
    status,
    logs,
  }
}
