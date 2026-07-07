// Git-sourced apps: clone into ~/.slab/repos/<name>, pull on redeploy.
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'

const REPOS_DIR = path.join(process.env.SLAB_DIR ?? path.join(os.homedir(), '.slab'), 'repos')

export function looksLikeGitUrl(s: string): boolean {
  return /^(https?:\/\/|git@|file:\/\/)/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s) && !fs.existsSync(s)
}

// "jasonmimick/slab" -> full URL; anything else passes through
export function normalizeGitUrl(s: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s}.git`
  return s
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`))
      else resolve(stdout)
    })
  })
}

// Clone (or update) the repo and return the local checkout path.
export async function cloneOrPull(gitUrl: string, dirName: string): Promise<string> {
  fs.mkdirSync(REPOS_DIR, { recursive: true })
  const dest = path.join(REPOS_DIR, dirName)
  if (fs.existsSync(path.join(dest, '.git'))) {
    await git(['pull', '--ff-only'], dest)
  } else {
    await git(['clone', '--depth', '1', gitUrl, dest])
  }
  return dest
}

// Derive a checkout dir name from the URL: last path segment sans .git
export function repoDirName(gitUrl: string): string {
  const base = gitUrl.replace(/\/+$/, '').split('/').pop() ?? 'repo'
  return base.replace(/\.git$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-')
}
