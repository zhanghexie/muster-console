# MUSTER_WINDOWS_JOB_PROTOCOL=opened-challenge-v1
param([Parameter(Mandatory=$true)][int]$WorkerPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CodexJob {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint length, IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
 public static IntPtr Create() {
   IntPtr job = CreateJobObject(IntPtr.Zero, null);
   if(job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   try {
     // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64/arm64 Windows. Kill on last handle close.
     int size = IntPtr.Size == 8 ? 144 : 112;
     IntPtr info = Marshal.AllocHGlobal(size);
     try { for(int i=0;i<size;i++) Marshal.WriteByte(info,i,0); Marshal.WriteInt32(info,16,0x2000); Check(SetInformationJobObject(job,9,info,(uint)size)); }
     finally { Marshal.FreeHGlobal(info); }
     return job;
   } catch { CloseHandle(job); throw; }
 }
 public static IntPtr Open(int pid) {
   // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE.
   IntPtr process = OpenProcess(0x1101, false, pid);
   if(process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
   return process;
 }
 public static void Assign(IntPtr job, IntPtr process) {
   uint exitCode;
   Check(GetExitCodeProcess(process, out exitCode));
   if(exitCode != 259) throw new InvalidOperationException("Worker exited before Job assignment");
   Check(AssignProcessToJobObject(job, process));
 }
 public static void Terminate(IntPtr job) { Check(TerminateJobObject(job,1)); }
 public static int Active(IntPtr job) {
   IntPtr info = Marshal.AllocHGlobal(48);
   try { Check(QueryInformationJobObject(job,1,info,48,IntPtr.Zero)); return Marshal.ReadInt32(info,40); }
   finally { Marshal.FreeHGlobal(info); }
 }
}
"@
$job = [IntPtr]::Zero
$worker = [IntPtr]::Zero
try {
 $job = [CodexJob]::Create()
 $worker = [CodexJob]::Open($WorkerPid)
 # Opening a PID is not identity proof; assignment waits for the owner's challenge.
 [Console]::Out.WriteLine('{"type":"opened"}')
 $command = [Console]::In.ReadLine()
 if ($command -ne 'assign') { return }
 [CodexJob]::Assign($job, $worker)
 [Console]::Out.WriteLine('{"type":"ready"}')
 while ($null -ne ($command = [Console]::In.ReadLine())) {
  if ($command -ne 'reclaim') { continue }
  try {
   [CodexJob]::Terminate($job)
   $deadline = [DateTime]::UtcNow.AddSeconds(3)
   while ([CodexJob]::Active($job) -ne 0) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Job still contains active processes' }
    Start-Sleep -Milliseconds 20
   }
   [Console]::Out.WriteLine('{"type":"released"}')
   break
  } catch { [Console]::Out.WriteLine((@{type='failure'; message=$_.Exception.Message} | ConvertTo-Json -Compress)) }
 }
} catch { [Console]::Out.WriteLine((@{type='failure'; message=$_.Exception.Message} | ConvertTo-Json -Compress)) }
finally {
 if ($worker -ne [IntPtr]::Zero) { [void][CodexJob]::CloseHandle($worker) }
 if ($job -ne [IntPtr]::Zero) { [void][CodexJob]::CloseHandle($job) }
}
