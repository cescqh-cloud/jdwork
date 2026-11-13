param(
    [ValidateSet('Window', 'Approve')][string]$Mode,
    [string]$Title,
    [string]$EvidencePath,
    [int]$WorkbenchPid,
    [string]$ConfirmLabel,
    [int]$ConfirmCount = 2
)

$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Approve') {
    if ((Get-Process -Id $WorkbenchPid).ProcessName -ne 'PiWorkbench') {
        throw 'Confirmation test must target the packaged test process'
    }
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $byProcess = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $WorkbenchPid)
    $byTitle = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
    $byDialog = [System.Windows.Automation.AndCondition]::new($byProcess, $byTitle)
    $byButton = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $ConfirmLabel)
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LiyuanFixtureButton {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
    $previousWindow = 0
    $accepted = 0
    $deadline = [DateTime]::UtcNow.AddSeconds(50)
    while ($accepted -lt $ConfirmCount -and [DateTime]::UtcNow -lt $deadline) {
        $prompt = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $byDialog)
        if ($null -eq $prompt) {
            $previousWindow = 0
        } elseif ($prompt.Current.NativeWindowHandle -ne $previousWindow) {
            $button = $prompt.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $byButton)
            if ($null -ne $button) {
                $previousWindow = $prompt.Current.NativeWindowHandle
                $invoke = $null
                if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
                    $invoke.Invoke()
                } else {
                    $handle = $button.Current.NativeWindowHandle
                    if ($button.Current.ProcessId -ne $WorkbenchPid -or $handle -eq 0) {
                        throw "Cannot address test confirmation control. Type $($button.Current.ControlType.ProgrammaticName), class $($button.Current.ClassName), HWND $handle."
                    }
                    if (-not [LiyuanFixtureButton]::PostMessage([IntPtr]$handle, 0x00f5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Unable to click the test confirmation button' }
                }
                $accepted++
            }
        }
        Start-Sleep -Milliseconds 130
    }
    if ($accepted -ne $ConfirmCount) { throw "Expected $ConfirmCount test dialogs, approved $accepted" }
    exit
}

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = [System.Windows.Forms.Form]::new()
$form.Text = $Title
$form.Width = 460
$form.Height = 215
$form.StartPosition = 'CenterScreen'
$form.ShowInTaskbar = $false
$inputField = [System.Windows.Forms.TextBox]::new()
$inputField.AccessibleName = 'Fixture value'
$inputField.SetBounds(28, 30, 370, 28)
$applyButton = [System.Windows.Forms.Button]::new()
$applyButton.Text = 'Apply fixture value'
$applyButton.SetBounds(28, 72, 160, 32)
$status = [System.Windows.Forms.Label]::new()
$status.Text = 'Awaiting fixture'
$status.SetBounds(28, 125, 370, 24)
$applyButton.Add_Click({
    $status.Text = 'Applied ' + $inputField.Text
    [System.IO.File]::WriteAllText($EvidencePath, $inputField.Text)
})
$form.Controls.AddRange(@($inputField, $applyButton, $status))
[System.Windows.Forms.Application]::Run($form)
