$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies @('System.dll', 'System.Core.dll', [System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location) -TypeDefinition @'
using System;
using System.Text;
using System.Linq;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class AllPetTerminal {
 [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetConsoleTitle(StringBuilder s, uint n);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool SetConsoleTitle(string s);
 [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] pids, uint n);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 public static string Birth(int pid) { try { return Process.GetProcessById(pid).StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); } catch { return null; } }
 public static uint WindowPID(string window) { uint pid; GetWindowThreadProcessId(new IntPtr(long.Parse(window)), out pid); return pid; }
 public static uint[] ConsolePIDs(int pid) {
  FreeConsole(); if (!AttachConsole((uint)pid)) return new uint[0];
  try { var ids = new uint[1024]; uint n = GetConsoleProcessList(ids, 1024); return ids.Take((int)Math.Min(n,1024)).ToArray(); } finally { FreeConsole(); }
 }
 static AutomationElement Find(AutomationElement root, int[] id) {
  if (id == null || id.Length == 0) return null;
  foreach (AutomationElement item in root.FindAll(TreeScope.Descendants, Condition.TrueCondition)) {
   try { if (item.GetRuntimeId().SequenceEqual(id)) return item; } catch {}
  } return null;
 }
 public class Target { public string window; public int[] control; public int[] tab; }
 public static Target Capture(int pid) {
  FreeConsole(); if (!AttachConsole((uint)pid)) return null;
  var old = new StringBuilder(32768); string marker = "AllPet-" + Guid.NewGuid().ToString("N"); bool changed = false;
  try {
   IntPtr handle = GetConsoleWindow();
   // A real conhost window is unique to this console. Pseudoconsole message-only HWNDs are never used.
   if (handle != IntPtr.Zero && IsWindowVisible(handle)) return new Target { window = handle.ToInt64().ToString() };
   GetConsoleTitle(old, (uint)old.Capacity);
   changed = SetConsoleTitle(marker); if (!changed) return null;
   for (int attempt = 0; attempt < 6; attempt++) {
    System.Threading.Thread.Sleep(40);
    var found = new List<Target>();
    foreach (var app in Process.GetProcessesByName("WindowsTerminal")) {
     IntPtr hwnd = app.MainWindowHandle; if (hwnd == IntPtr.Zero) continue;
     var root = AutomationElement.FromHandle(hwnd);
     var controls = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "TermControl"));
     foreach (AutomationElement control in controls) {
      if (control.Current.HelpText != marker && control.Current.Name != marker) continue;
      int[] tab = null;
      foreach (AutomationElement item in root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem))) {
       if (item.Current.Name.Contains(marker)) { if (tab != null) { tab = null; break; } tab = item.GetRuntimeId(); }
      }
      found.Add(new Target { window = hwnd.ToInt64().ToString(), control = control.GetRuntimeId(), tab = tab });
     }
    }
    if (found.Count == 1) return found[0];
   }
  } finally {
   // Do not overwrite a title that the agent changed while we were probing.
   var current = new StringBuilder(32768); GetConsoleTitle(current, (uint)current.Capacity);
   if (changed && current.ToString() == marker) SetConsoleTitle(old.ToString());
   FreeConsole();
  }
  return null;
 }
 public static bool View(string window, int[] control) {
  try {
   IntPtr hwnd = new IntPtr(long.Parse(window));
   if (GetForegroundWindow() != hwnd || !IsWindowVisible(hwnd) || IsIconic(hwnd)) return false;
   if (control == null || control.Length == 0) return true;
   var focus = AutomationElement.FocusedElement;
   return focus != null && focus.GetRuntimeId().SequenceEqual(control) && !focus.Current.IsOffscreen;
  } catch { return false; }
 }
 public static bool Focus(string window, int[] control, int[] tab) {
  try {
   IntPtr hwnd = new IntPtr(long.Parse(window));
   if (!IsWindowVisible(hwnd)) return false;
   var root = AutomationElement.FromHandle(hwnd);
   if (control != null && control.Length > 0) {
    if (tab != null && tab.Length > 0) {
     var item = Find(root, tab); if (item == null) return false;
     object pattern; if (item.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) ((SelectionItemPattern)pattern).Select(); else return false;
    }
    var pane = Find(root, control); if (pane == null) return false;
    pane.SetFocus();
   }
   if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
   SetForegroundWindow(hwnd); return View(window, control);
  } catch { return false; }
 }
 [StructLayout(LayoutKind.Sequential)] struct UNIQUE_PROCESS { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct PROCESS_INFO {
  public UNIQUE_PROCESS process;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
  public uint type, status, session;
  [MarshalAs(UnmanagedType.Bool)] public bool restartable;
 }
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, int flags, StringBuilder key);
 [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint n, string[] files, uint na, IntPtr apps, uint ns, IntPtr services);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] PROCESS_INFO[] infos, ref uint reason);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
 public static uint[] Owners(string file) {
  uint session; if (RmStartSession(out session, 0, new StringBuilder(33)) != 0) return new uint[0];
  try {
   if (RmRegisterResources(session, 1, new string[] { file }, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) return new uint[0];
   uint needed, count=0, reason=0; int result=RmGetList(session,out needed,ref count,null,ref reason);
   if (result != 234 || needed > 1024) return new uint[0];
   var infos = new PROCESS_INFO[needed]; count=needed;
   if (RmGetList(session,out needed,ref count,infos,ref reason) != 0) return new uint[0];
   return infos.Take((int)count).Select(x=>x.process.pid).ToArray();
  } finally { RmEndSession(session); }
 }
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
 try {
  $r = $line | ConvertFrom-Json
  $result = @{ type='terminal-result'; requestID=$r.requestID }
  if ($r.operation -eq 'bind') {
   $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
   $bindings = @()
   foreach ($task in @($r.tasks | Select-Object -First 48)) {
    $owners = @(); if ($task.sourcePath -and [IO.File]::Exists($task.sourcePath)) { $owners = @([AllPetTerminal]::Owners($task.sourcePath)) }
    $matches = @($rows | Where-Object {
     $name = $_.Name -replace '\.exe$',''
     $agent = $name -eq $task.platform -or ($name -in @('node','bun','python','python3') -and $_.CommandLine -match ('[/\\](?:' + [regex]::Escape($task.platform) + '(?:\.js|\.mjs)?|(?:claude-code|pi-coding-agent)[/\\].*)["\s]'))
     $identity = $_.ProcessId -in $owners -or ($task.sessionID -and $_.CommandLine -match ('(?:^|["\s])' + [regex]::Escape($task.sessionID) + '(?:["\s]|$)'))
     if (!$identity -and $_.ProcessId -eq $task.processID -and $task.updatedAt) {
      $birth = [AllPetTerminal]::Birth([int]$_.ProcessId)
      if ($birth) { $identity = ([DateTime]::FromFileTimeUtc([long]$birth) -le [DateTime]::new(2001,1,1,0,0,0,[DateTimeKind]::Utc).AddSeconds([double]$task.updatedAt)) }
     }
     $agent -and $identity
    })
    if ($matches.Count -ne 1) { continue }
    $agent = $matches[0]; $console = @([AllPetTerminal]::ConsolePIDs([int]$agent.ProcessId)); $anchor = $agent
    for ($i=0; $i -lt 32; $i++) {
     $parent = $rows | Where-Object ProcessId -eq $anchor.ParentProcessId | Select-Object -First 1
     if (!$parent -or $parent.ProcessId -notin $console) { break }; $anchor = $parent
    }
    $start = [AllPetTerminal]::Birth([int]$anchor.ProcessId)
    if (!$start) { continue }
    $target = [AllPetTerminal]::Capture([int]$agent.ProcessId)
    $locator = @{ version=1; os='win32'; pid=[int]$anchor.ProcessId; start=$start }
    if ($target) { $locator.window=$target.window; $locator.control=$target.control; $locator.tab=$target.tab }
    $bindings += @{ id=$task.id; terminalLocator=$locator }
   }
   $result.bindings = @($bindings)
  } elseif ($r.locator) {
   $loc = $r.locator
   $valid = ([AllPetTerminal]::Birth([int]$loc.pid) -eq $loc.start)
   $result.valid = $valid
   if ($valid) { $result.pids = @([AllPetTerminal]::ConsolePIDs([int]$loc.pid)) }
   if ($valid -and $loc.window) {
    $result.windowProcessID = [AllPetTerminal]::WindowPID($loc.window)
    if ($r.operation -eq 'view') { $result.viewed = [AllPetTerminal]::View($loc.window, [int[]]$loc.control) }
    if ($r.operation -eq 'focus') { $result.succeeded = [AllPetTerminal]::Focus($loc.window, [int[]]$loc.control, [int[]]$loc.tab) }
   }
  }
  [Console]::WriteLine(($result | ConvertTo-Json -Compress -Depth 12))
 } catch { [Console]::WriteLine((@{ type='terminal-result'; requestID=$r.requestID; error='Windows 终端接口不可用' } | ConvertTo-Json -Compress)) }
}
