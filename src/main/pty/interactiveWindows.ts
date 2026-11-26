/** A console-subsystem held root; Electron's GUI executable cannot be the ConPTY console anchor. */
export const INTERACTIVE_WINDOWS_BOOTSTRAP = String.raw`
$ErrorActionPreference='Stop'
$pipe=$null; $reader=$null; $writer=$null; $command=$null
try {
  function ProtectConsole {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MusterInteractiveConsole {
  private delegate bool Handler(uint kind);
  private static readonly Handler HeldHandler = Handle;
  private static bool Handle(uint kind) { return kind == 0 || kind == 1; }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  public static void Protect() {
    if (!SetConsoleCtrlHandler(HeldHandler, true)) throw new System.ComponentModel.Win32Exception();
  }
  public static void WaitForInputOrExit(System.Threading.Tasks.Task<string> input, System.Diagnostics.Process process) {
    using (var processEvent = new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset)) {
      processEvent.SafeWaitHandle = new Microsoft.Win32.SafeHandles.SafeWaitHandle(process.Handle, false);
      System.Threading.WaitHandle.WaitAny(new [] { ((IAsyncResult)input).AsyncWaitHandle, processEvent });
    }
  }
}
'@ | Out-Null
  [MusterInteractiveConsole]::Protect()
  }
  $name=$env:MUSTER_PTY_OWNER_ENDPOINT.Substring(9)
  $pipe=New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  $pipe.Connect(7000)
  $utf8=New-Object System.Text.UTF8Encoding($false)
  $reader=New-Object System.IO.StreamReader($pipe,$utf8,$false,4096,$true)
  $writer=New-Object System.IO.StreamWriter($pipe,$utf8,4096,$true)
  $writer.AutoFlush=$true; $writer.NewLine=[string][char]10
  function Send($frame) { $writer.WriteLine(($frame | ConvertTo-Json -Compress -Depth 8)) }
  function QuoteArgument([string]$value) {
    # CommandLineToArgvW/libuv quoting, without executing data as PowerShell.
    $result='"'; $slashes=0
    foreach($character in $value.ToCharArray()) {
      if($character -eq [char]92){$slashes++;continue}
      if($character -eq [char]34){$result+=('\' * (2*$slashes+1))+'"';$slashes=0;continue}
      $result+=('\' * $slashes)+$character; $slashes=0
    }
    return $result+('\' * (2*$slashes))+'"'
  }
  Send @{type='hello';token=$env:MUSTER_PTY_OWNER_TOKEN;pid=$PID}
  $pending=$reader.ReadLineAsync(); $launched=$false; $reported=$false
  while($true) {
    if($pending.IsCompleted) {
      $line=$pending.GetAwaiter().GetResult()
      if($null -eq $line){exit 92}
      if($line.Length -gt 16777216){throw 'PTY control frame exceeds limit'}
      $message=$line | ConvertFrom-Json
      if($message.type -eq 'challenge'){Send @{type='proof';nonce=$message.nonce;pid=$PID}}
      elseif($message.type -eq 'run' -and !$launched) {
        $launched=$true
        try {
          # The run frame is sent only after the held root belongs to its Job.
          ProtectConsole
          $info=New-Object System.Diagnostics.ProcessStartInfo
          $info.FileName=[string]$message.command; $info.WorkingDirectory=[string]$message.cwd
          $info.UseShellExecute=$false; $info.CreateNoWindow=$false
          if($message.windowsVerbatimArguments){$info.Arguments=([string[]]$message.args -join ' ')}
          else {$info.Arguments=(($message.args | ForEach-Object {QuoteArgument ([string]$_)}) -join ' ')}
          $info.EnvironmentVariables.Clear()
          foreach($property in $message.env.PSObject.Properties){$info.EnvironmentVariables[$property.Name]=[string]$property.Value}
          $command=New-Object System.Diagnostics.Process; $command.StartInfo=$info
          if(!$command.Start()){throw 'Windows shell could not be started'}
          Send @{type='started'}
        } catch {
          $originalError=$_.Exception.Message
          if($null -ne $command){$command.Dispose();$command=$null}
          Send @{type='failed';error=('Windows interactive command startup failed (PowerShell/Add-Type capability required): '+$originalError)}
        }
      }
      $pending=$reader.ReadLineAsync()
    }
    if($null -ne $command -and !$reported -and $command.HasExited){$reported=$true;Send @{type='completed';code=$command.ExitCode}}
    if($null -ne $command -and !$reported){[MusterInteractiveConsole]::WaitForInputOrExit($pending,$command)}
    else {$pending.Wait()}
  }
} catch {
  $failure='Windows interactive console bootstrap failed (PowerShell/Add-Type capability required): '+$_.Exception.Message
  if($null -ne $writer){try{Send @{type='failed';error=$failure}}catch{}}
  [Console]::Error.WriteLine($failure)
  exit 93
} finally {
  if($null -ne $command){$command.Dispose()}
  if($null -ne $writer){$writer.Dispose()}
  if($null -ne $reader){$reader.Dispose()}
  if($null -ne $pipe){$pipe.Dispose()}
}
`;
