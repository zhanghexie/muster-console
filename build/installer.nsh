; 自定义 NSIS include（electron-builder nsis.include）。
; 目的：彻底去掉静默升级的 UAC 提权。electron-builder 的 installer.nsi 在 install Section 里
; 只要 hasPerMachineInstallation==1（HKLM\Software\<APP_GUID> 有 per-machine 残留记录，目录被手删
; 也算）且 /S 静默，就强制 UAC_RunElevated；UAC 无人点则安装无限期挂起（2026-09-13 实测）。
; 本仓安装方式本就是 per-user（perMachine:false），这里在 initMultiUser 之后镜像 /currentuser
; 的完整语义：只清提权标志不够——initMultiUser 已按残留选定 per-machine 模式（INSTDIR=HKLM
; 残留路径、Shell 上下文=all），不切模式会以未提权的 per-machine 上下文继续安装（HKLM 注册表/
; 全用户快捷方式静默失败）却正常退出。setInstallModePerUser 整体切回 per-user：HKCU 有记录则
; 原位升级，无记录装 %LOCALAPPDATA%\Programs\<app>。显式传 /allusers 时尊重原语义（该提权仍提权）。
!macro customInit
  !ifndef INSTALL_MODE_PER_ALL_USERS
    !insertmacro _metaagentDisablePerMachineResidue
  !endif
!macroend

!macro customInstall
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\install.ps1" -Action Install -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "MetaAgent CLI registration failed: $1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "MetaAgent CLI registration failed. The existing command was preserved.$\r$\n$1" /SD IDOK
  ${Else}
    DetailPrint "$1"
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\install.ps1" -Action Uninstall -InstallDir "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "MetaAgent CLI cleanup failed: $1"
  ${EndIf}
!macroend

!macro _metaagentDisablePerMachineResidue
  !include "FileFunc.nsh"
  ${GetParameters} $R0
  ${GetOptions} $R0 "/allusers" $R1
  ${If} ${Errors}
    ${If} $hasPerMachineInstallation == "1"
      StrCpy $hasPerMachineInstallation "0"
      StrCpy $hasPerUserInstallation "1"
      !insertmacro setInstallModePerUser
    ${EndIf}
  ${EndIf}
!macroend
