# Smoke test for the helper on Windows (the counterpart of smoke.sh). It opens one small always-on-top
# window on the desktop for about 25 seconds: no mouse or keyboard input is sent, nothing is brought to the front.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\k-float\tests\smoke.ps1 [-Bin <k-float.exe>] [-Shot <file.png>]
# Run it in the interactive desktop session (a terminal there, or `hc exec --on <machine>`); not over ssh.
param(
  [string]$Bin = (Join-Path $PSScriptRoot "..\target\release\k-float.exe"),
  [string]$Shot = ""
)
$ErrorActionPreference = "Stop"
$D = Join-Path $env:TEMP ("k-float-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path "$D\windows" -Force | Out-Null
$script:fail = 0
function ok($m) { Write-Output "ok   $m" }
function bad($m) { Write-Output "FAIL $m"; $script:fail = 1 }
function check($name, $cond) { if ($cond) { ok $name } else { bad $name } }
function events { if (Test-Path "$D\events\demo.jsonl") { @(Get-Content "$D\events\demo.jsonl" -Encoding UTF8) } else { @() } }
function has($name, $text) { check $name ([bool](events | Where-Object { $_.Contains($text) })) }
function spec($o, [switch]$Bom) {
  [IO.File]::WriteAllText("$D\windows\demo.json", ($o | ConvertTo-Json -Compress -Depth 5), (New-Object Text.UTF8Encoding($Bom.IsPresent)))
}

Add-Type @"
using System; using System.Runtime.InteropServices;
public class KFloatWin {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
}
"@
function win { [KFloatWin]::FindWindow([NullString]::Value, "k-float-smoke") }   # $null would arrive as "", which matches no window class
function exstyle { [KFloatWin]::GetWindowLong((win), -20) }
# The window's opacity as Windows has it (0-255), or -1 when it has none.
function alpha {
  $key = [uint32]0; $a = [byte]0; $flags = [uint32]0
  if ([KFloatWin]::GetLayeredWindowAttributes((win), [ref]$key, [ref]$a, [ref]$flags) -and ($flags -band 2)) { [int]$a } else { -1 }
}

$html = "<body style='font:16px sans-serif;background:#fff7c2;margin:14px'><b>k-float smoke test</b><h3 id=h>hello</h3><p style='font-size:12px'>closes itself</p><script>float.onData(d=>{h.textContent='count '+d.count;float.send({got:d.count})})</script></body>"
$s = @{ title = "k-float-smoke"; x = 160; y = 160; width = 300; height = 170; html = $html; data = @{ count = 1 } }
spec $s

$front = [KFloatWin]::GetForegroundWindow()
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = & $Bin start $D
$sw.Stop()
check "start ($r)" ($r -like "started*")
# Reading its output above ends when nothing holds that pipe any more: the helper must not.
check ("start returned in {0:n1} s" -f $sw.Elapsed.TotalSeconds) ($sw.Elapsed.TotalSeconds -lt 8)
Start-Sleep -Seconds 5
check "second start is a no-op" ((& $Bin start $D) -eq "running")
has "ready event" '"type":"ready"'
has "page got the first data and answered" '"data":{"got":1}'
check "window exists and is visible" ((win) -ne [IntPtr]::Zero -and [KFloatWin]::IsWindowVisible((win)))
check "always on top (WS_EX_TOPMOST)" (((exstyle) -band 0x8) -ne 0)
# Anything of ours in front is the failure (the window, or a console the helper was started in);
# the person switching between other windows meanwhile is not.
$now = [KFloatWin]::GetForegroundWindow()
$owner = [uint32]0; [void][KFloatWin]::GetWindowThreadProcessId($now, [ref]$owner)
$name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
$sb = New-Object Text.StringBuilder 256; [void][KFloatWin]::GetClassName($now, $sb, 256); $class = "$sb"
[void]$sb.Clear(); [void][KFloatWin]::GetWindowText($now, $sb, 256)
check "did not take the foreground (same as before: $($now -eq $front); in front: $name / $class)" ($now -eq $front -or ($now -ne (win) -and $name -ne "k-float" -and "$sb" -notlike "*k-float*"))
$rect = New-Object KFloatWin+RECT
[void][KFloatWin]::GetWindowRect((win), [ref]$rect)
Write-Output ("     window rect: {0},{1} {2}x{3}" -f $rect.L, $rect.T, ($rect.R - $rect.L), ($rect.B - $rect.T))

# A spec written the way Windows PowerShell 5 writes UTF-8 (with a byte order mark) must still be read.
$s.data = @{ count = 7 }; spec $s -Bom
Start-Sleep -Milliseconds 1500
has "data update (file with a BOM) reached the page" '"data":{"got":7}'
check "no reload on data update" (@(events | Where-Object { $_.Contains('"type":"ready"') }).Count -eq 1)

if ($Shot) {
  # The window and a margin around it: enough to show it sits on top of what is open there,
  # without photographing the whole screen (it is someone's desktop).
  Add-Type -AssemblyName System.Drawing
  $m = 140
  $w = ($rect.R - $rect.L) + 2 * $m; $h = ($rect.B - $rect.T) + 2 * $m
  $from = New-Object Drawing.Point(($rect.L - $m), ($rect.T - $m))
  $bmp = New-Object Drawing.Bitmap($w, $h)
  $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($from, [Drawing.Point]::Empty, (New-Object Drawing.Size($w, $h)))
  $bmp.Save($Shot, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  Write-Output "     shot: $Shot"
}

$s.opacity = 0.6; spec $s
Start-Sleep -Milliseconds 1200
check "opacity 0.6 (layered window, alpha $(alpha) of 255)" ((alpha) -eq 153)
check "no reload on opacity update" (@(events | Where-Object { $_.Contains('"type":"ready"') }).Count -eq 1)

$s.clickThrough = $true; spec $s
Start-Sleep -Milliseconds 1200
check "click-through (WS_EX_TRANSPARENT)" (((exstyle) -band 0x20) -ne 0)
# Turning click-through on or off rewrites the window's styles: the opacity must survive both.
check "opacity kept with click-through on (alpha $(alpha))" ((alpha) -eq 153)
$s.clickThrough = $false; spec $s
Start-Sleep -Milliseconds 1200
check "opacity kept with click-through off again (alpha $(alpha))" ((alpha) -eq 153)
check "no warning about click-through or opacity" (-not (events | Where-Object { $_.Contains('"type":"warning"') }))

# Collapse to a button and back, from the spec (no mouse or keyboard input is sent, so the page's
# float.collapse() / a click on the button / dragging it are NOT exercised here: do those by hand).
# Without the system's frame, as kirin-inbox has it: the window is the page and nothing else.
function r { $q = New-Object KFloatWin+RECT; [void][KFloatWin]::GetWindowRect((win), [ref]$q); $q }
function onDisk { Get-Content "$D\windows\demo.json" -Raw -Encoding UTF8 | ConvertFrom-Json }
function desc($q) { "{0},{1} {2}x{3}" -f $q.L, $q.T, ($q.R - $q.L), ($q.B - $q.T) }
$s.frame = $false; spec $s
Start-Sleep -Milliseconds 1500
$full = r
$scale = [KFloatWin]::GetDpiForWindow((win)) / 96.0
$side = [int][Math]::Round(44 * $scale)
Write-Output ("     scale {0:p0}; expanded, no frame: {1}" -f $scale, (desc $full))
$resized = @(events | Where-Object { $_.Contains('"type":"resized"') }).Count
$s.collapsed = $true; $s.collapsedWidth = 44; $s.collapsedHeight = 44; spec $s
Start-Sleep -Milliseconds 1500
$small = r
# The point of the size limits set while collapsed: Windows' own smallest window is wider than this.
check "collapsed to 44 x 44 logical = $side px (window: $(desc $small))" ([Math]::Abs(($small.R - $small.L) - $side) -le 2 -and [Math]::Abs(($small.B - $small.T) - $side) -le 2)
check "collapsed at the top-right corner (right $($small.R) / $($full.R), top $($small.T) / $($full.T))" ([Math]::Abs($small.R - $full.R) -le 2 -and [Math]::Abs($small.T - $full.T) -le 2)
check "opacity kept while collapsed (alpha $(alpha))" ((alpha) -eq 153)
Start-Sleep -Milliseconds 800
$now = onDisk
check "spec keeps the expanded size while collapsed ($($now.width) x $($now.height), collapsed $($now.collapsed))" ($now.collapsed -eq $true -and $now.width -eq 300 -and $now.height -eq 170)
check "no resized event for collapsing" (@(events | Where-Object { $_.Contains('"type":"resized"') }).Count -eq $resized)
# Expand: the place in the file is the button's now, so read it back before writing (as a mod does).
$s.x = $now.x; $s.y = $now.y; $s.collapsed = $false; spec $s
Start-Sleep -Milliseconds 1500
$back = r
check "expanded to the size and place it had ($(desc $back); was $(desc $full))" ([Math]::Abs($back.L - $full.L) -le 2 -and [Math]::Abs($back.T - $full.T) -le 2 -and [Math]::Abs($back.R - $full.R) -le 2 -and [Math]::Abs($back.B - $full.B) -le 2)
check "opacity kept after expanding (alpha $(alpha))" ((alpha) -eq 153)
Start-Sleep -Milliseconds 800
$now = onDisk
check "spec after expanding ($($now.width) x $($now.height), collapsed $($now.collapsed))" ($now.collapsed -eq $false -and $now.width -eq 300 -and $now.height -eq 170)
check "no resized event for expanding" (@(events | Where-Object { $_.Contains('"type":"resized"') }).Count -eq $resized)

# hoverOpacity: the mouse is not moved here, so only the case it happens to be in is checked.
$s.x = $now.x; $s.y = $now.y; $s.hoverOpacity = 1; spec $s
Start-Sleep -Milliseconds 1200
$q = r; $pt = New-Object KFloatWin+POINT; [void][KFloatWin]::GetCursorPos([ref]$pt)
$a = alpha
if ($pt.X -ge $q.L -and $pt.X -lt $q.R -and $pt.Y -ge $q.T -and $pt.Y -lt $q.B) {
  # 255 with the mouse on it; 153 if another window lies between the mouse and it.
  check "hoverOpacity: the mouse is inside the window's rectangle (alpha $a; 255 = hovered, 153 = something is in front)" ($a -eq 255 -or $a -eq 153)
} else {
  check "hoverOpacity: the mouse is elsewhere, the window keeps its opacity (alpha $a)" ($a -eq 153)
  Write-Output "     NOT checked: opaque with the mouse over it (move the mouse onto the window by hand and watch)"
}
check "no reload for any of this" (@(events | Where-Object { $_.Contains('"type":"ready"') }).Count -eq 1)
check "still no warning" (-not (events | Where-Object { $_.Contains('"type":"warning"') }))

Remove-Item "$D\windows\demo.json"
Start-Sleep -Milliseconds 1200
has "closed by spec" '"by":"spec"'
check "window gone" ((win) -eq [IntPtr]::Zero)

& $Bin stop $D | Out-Null
Start-Sleep -Milliseconds 800
check "stop ends the helper" (-not (Get-CimInstance Win32_Process -Filter "Name='k-float.exe'" | Where-Object { $_.CommandLine -like "*$D*" }))

if ($script:fail) { Write-Output "--- events"; events; Write-Output "--- log"; if (Test-Path "$D\helper.log") { Get-Content "$D\helper.log" } }
Remove-Item -Recurse -Force $D -ErrorAction SilentlyContinue
exit $script:fail
