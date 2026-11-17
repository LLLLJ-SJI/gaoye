param([Parameter(Mandatory=$true)][string]$RequestFile,
      [Parameter(Mandatory=$true)][string]$SubmissionFile)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PaperDoubaoInput {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    public static void Key(byte key, bool up) { keybd_event(key, 0, up ? 2u : 0u, UIntPtr.Zero); }
    public static void Paste() {
        Key(0x11, false);
        try { Key(0x56, false); Key(0x56, true); }
        finally { Key(0x11, true); }
    }
    public static void Enter() { Key(0x0D, false); Key(0x0D, true); }
}
'@
$request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($request)) { throw 'empty_request' }
$trueCondition = [Windows.Automation.Condition]::TrueCondition
$root = [Windows.Automation.AutomationElement]::RootElement
$windows = @($root.FindAll('Children', $trueCondition) | Where-Object {
    $_.Current.Name -eq '豆包' -or $_.Current.Name -like '* - 豆包'
})
if ($windows.Count -ne 1) { throw 'doubao_window_not_unique' }
$window = $windows[0]
$handle = [IntPtr]$window.Current.NativeWindowHandle

function Get-Controls {
    $window.FindAll('Descendants', $trueCondition)
}

$wasMinimized = [PaperDoubaoInput]::IsIconic($handle)
if ($wasMinimized) {
    [void][PaperDoubaoInput]::ShowWindowAsync($handle, 9)
    Start-Sleep -Milliseconds 250
}
$controls = @(Get-Controls)
$project = @($controls | Where-Object {
    ($_.Current.Name -eq '论文工作站' -and $_.Current.HelpText -eq '论文工作站' -and
     $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button')
})
$local = @($controls | Where-Object {
    $_.Current.Name -eq '本地电脑' -and $_.Current.ControlType.ProgrammaticName -eq 'ControlType.Button'
})
if (!$project.Count -or !$local.Count) { throw 'doubao_project_not_selected' }
$editors = @($controls | Where-Object {
    ($_.Current.ControlType.ProgrammaticName -in @('ControlType.Edit','ControlType.Group') -and
     $_.Current.ClassName -match '(?:^|\s)ProseMirror(?:\s|$)' -and
     $_.Current.IsKeyboardFocusable -and !$_.Current.IsOffscreen)
})
if ($editors.Count -ne 1) { throw 'doubao_composer_unavailable' }
$value = $null
$text = $null
if (!$editors[0].TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$value) -and
    !$editors[0].TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$text)) {
    throw 'doubao_composer_unavailable'
}
function Read-Composer {
    if ($value) { return ([string]$value.Current.Value).Trim() }
    return ([string]$text.DocumentRange.GetText(-1)).Trim()
}
function Confirm-Submission {
    # A successful send can open a new chat while the old editor remains in UIA's cache.
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        Start-Sleep -Milliseconds 120
        if ($window.Current.Name -ne $windowTitle) { return $true }
        try {
            $remaining = Read-Composer
            if (!$remaining -or $remaining -like '发消息或创建任务*') { return $true }
        } catch [Windows.Automation.ElementNotAvailableException] { return $true }
    }
    return $false
}
$wanted = $request.Trim()
$before = Read-Composer
if ($before -and $before -notlike '发消息或创建任务*' -and $before -ne $request.Trim()) {
    throw 'doubao_composer_has_draft'
}
if ($value -and $before -ne $wanted) {
    try { $value.SetValue($wanted) } catch {}
    Start-Sleep -Milliseconds 450
}
function Focus-Composer {
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        [void][PaperDoubaoInput]::SetForegroundWindow($handle)
        $editors[0].SetFocus()
        Start-Sleep -Milliseconds 160
        $focus = [Windows.Automation.AutomationElement]::FocusedElement
        if ([PaperDoubaoInput]::GetForegroundWindow() -eq $handle -and $focus -and
            $focus.Current.ProcessId -eq $window.Current.ProcessId -and
            $focus.Current.ClassName -match '(?:^|\s)ProseMirror(?:\s|$)') { return }
    }
    throw 'doubao_focus_unavailable'
}

if ((Read-Composer) -ne $wanted) {
    Focus-Composer
    if ((Read-Composer) -notin @($before, $wanted)) { throw 'doubao_composer_has_draft' }
    $clipboard = [Windows.Forms.Clipboard]::GetDataObject()
    try {
        [Windows.Forms.Clipboard]::SetText($wanted)
        [PaperDoubaoInput]::Paste()
        for ($attempt = 0; $attempt -lt 15 -and (Read-Composer) -ne $wanted; $attempt++) {
            Start-Sleep -Milliseconds 100
        }
    } finally {
        if ($clipboard) { [Windows.Forms.Clipboard]::SetDataObject($clipboard, $true) }
        else { [Windows.Forms.Clipboard]::Clear() }
    }
}
if ((Read-Composer) -ne $wanted) { throw 'doubao_input_mismatch' }

$send = @()
for ($attempt = 0; $attempt -lt 15 -and $send.Count -eq 0; $attempt++) {
    Start-Sleep -Milliseconds 150
    $send = @(Get-Controls | Where-Object {
        ($_.Current.AutomationId -eq 'flow-end-msg-send' -and
         $_.Current.IsEnabled -and !$_.Current.IsOffscreen)
    })
}
$windowTitle = $window.Current.Name
if ($send.Count -ne 1) { Focus-Composer }
if ((Read-Composer) -ne $wanted) { throw 'doubao_input_mismatch' }
[IO.File]::WriteAllText($SubmissionFile, 'attempted')
if ($send.Count -eq 1) {
    $send[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
    $focus = [Windows.Automation.AutomationElement]::FocusedElement
    if ([PaperDoubaoInput]::GetForegroundWindow() -ne $handle -or
        !$focus -or $focus.Current.ProcessId -ne $window.Current.ProcessId -or
        $focus.Current.ClassName -notmatch '(?:^|\s)ProseMirror(?:\s|$)' -or (Read-Composer) -ne $wanted) {
        Remove-Item -LiteralPath $SubmissionFile
        throw 'doubao_send_unavailable'
    }
    [PaperDoubaoInput]::Enter()
}
if (!(Confirm-Submission)) {
    throw 'doubao_send_unconfirmed'
}
[IO.File]::WriteAllText($SubmissionFile, 'submitted')
'DOUBAO_SUBMITTED'
