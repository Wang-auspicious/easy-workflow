import {execFile} from 'node:child_process';
import os from 'node:os';
import {promisify} from 'node:util';

export interface MemorySnapshot {
  physicalTotalMB: number;
  physicalAvailableMB: number;
  commitLimitMB: number | null;
  commitAvailableMB: number | null;
  source: 'windows-performance' | 'physical-only';
  checkedAt: number;
}

export const MEMORY_CACHE_MS = 3000;
export const MEMORY_MAX_AGE_MS = 15000;
const execute = promisify(execFile);

export function physicalMemorySnapshot(): MemorySnapshot {
  return {
    physicalTotalMB: Math.round(os.totalmem() / 1048576),
    physicalAvailableMB: Math.round(os.freemem() / 1048576),
    commitLimitMB: null,
    commitAvailableMB: null,
    source: 'physical-only',
    checkedAt: Date.now(),
  };
}

// GetPerformanceInfo reports the system commit limit and current committed pages.
// Page-file capacity is kept separate from physical RAM. The child process runs
// asynchronously, so inventory collection cannot block browser RPC processing.
const WINDOWS_MEMORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EasyWorkflowMemoryNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct PerformanceInformation {
    public uint Size;
    public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal;
    public UIntPtr PhysicalAvailable, SystemCache, KernelTotal, KernelPaged;
    public UIntPtr KernelNonpaged, PageSize;
    public uint HandleCount, ProcessCount, ThreadCount;
  }
  [DllImport("psapi.dll", SetLastError = true)]
  public static extern bool GetPerformanceInfo(out PerformanceInformation information, uint size);
}
'@
$information = New-Object EasyWorkflowMemoryNative+PerformanceInformation
$size = [Runtime.InteropServices.Marshal]::SizeOf($information)
if (-not [EasyWorkflowMemoryNative]::GetPerformanceInfo([ref]$information, $size)) {
  throw 'GetPerformanceInfo failed'
}
$pageMB = $information.PageSize.ToUInt64() / 1048576.0
@{
  physicalTotalMB = $information.PhysicalTotal.ToUInt64() * $pageMB
  physicalAvailableMB = $information.PhysicalAvailable.ToUInt64() * $pageMB
  commitLimitMB = $information.CommitLimit.ToUInt64() * $pageMB
  commitAvailableMB = ($information.CommitLimit.ToUInt64() - $information.CommitTotal.ToUInt64()) * $pageMB
} | ConvertTo-Json -Compress
`;

async function queryWindowsMemory(): Promise<MemorySnapshot> {
  const {stdout} = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', WINDOWS_MEMORY_SCRIPT,
  ], {windowsHide: true, timeout: 5000, maxBuffer: 16384, encoding: 'utf8'});
  const value: unknown = JSON.parse(stdout.trim());
  if (!value || typeof value !== 'object') throw new Error('Invalid system memory snapshot');
  const fields = value as Record<string, unknown>;
  const number = (key: string) => {
    const result = fields[key];
    if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) {
      throw new Error(`Invalid system memory field: ${key}`);
    }
    return Math.floor(result);
  };
  const result: MemorySnapshot = {
    physicalTotalMB: number('physicalTotalMB'),
    physicalAvailableMB: number('physicalAvailableMB'),
    commitLimitMB: number('commitLimitMB'),
    commitAvailableMB: number('commitAvailableMB'),
    source: 'windows-performance',
    checkedAt: Date.now(),
  };
  if (result.physicalTotalMB <= 0 || result.physicalAvailableMB > result.physicalTotalMB ||
      result.commitLimitMB! <= 0 || result.commitAvailableMB! > result.commitLimitMB!) {
    throw new Error('Inconsistent system memory snapshot');
  }
  return result;
}

/** Coalesces refreshes and expires commit measurements without hiding live RAM pressure. */
export class MemoryMonitor {
  private cached: MemorySnapshot | undefined;
  private pending: Promise<void> | undefined;
  private lastAttempt = -Infinity;
  readonly query: () => Promise<MemorySnapshot>;
  readonly physical: () => MemorySnapshot;
  readonly now: () => number;

  constructor(query: () => Promise<MemorySnapshot>, physical = physicalMemorySnapshot,
    now = Date.now) {
    this.query = query;
    this.physical = physical;
    this.now = now;
  }

  snapshot(): MemorySnapshot {
    void this.refresh();
    const physical = this.physical();
    if (!this.cached || this.now() - this.cached.checkedAt > MEMORY_MAX_AGE_MS) return physical;
    return {...this.cached, physicalTotalMB: physical.physicalTotalMB,
      physicalAvailableMB: physical.physicalAvailableMB};
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.now() - this.lastAttempt < MEMORY_CACHE_MS) return Promise.resolve();
    this.lastAttempt = this.now();
    this.pending = this.query().then(snapshot => {
      this.cached = snapshot;
    }).catch(() => {
      // A failed/expired measurement never authorizes the low-RAM exception.
    }).finally(() => {this.pending = undefined;});
    return this.pending;
  }
}

const systemMemory = new MemoryMonitor(process.platform === 'win32' ? queryWindowsMemory :
  async () => physicalMemorySnapshot());

export function readSystemMemory(): MemorySnapshot {
  return systemMemory.snapshot();
}

export function refreshSystemMemory(): Promise<void> {
  return systemMemory.refresh();
}
