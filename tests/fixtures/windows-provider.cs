// Test-only native launcher. A job object kills the mock's descendants on timeout.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Security.AccessControl;
using System.Security.Principal;

class MockProvider {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessEntry {
    public uint Size, Usage, Pid;
    public UIntPtr Heap;
    public uint Module, Threads, Parent;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

  static void ListProcesses() {
    DateTime cutoff = DateTime.UtcNow;
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new InvalidOperationException();
    var output = new StringBuilder("[");
    var entry = new ProcessEntry(); entry.Size = (uint)Marshal.SizeOf(entry);
    try {
      if (!Process32FirstW(snapshot, ref entry)) throw new InvalidOperationException();
      do {
        try {
          using (var process = Process.GetProcessById((int)entry.Pid)) {
            DateTime started = process.StartTime.ToUniversalTime();
            // Never pair a stale snapshot parent with a reused PID's identity.
            if (started > cutoff) continue;
            string identity = started.ToString("o");
            if (output.Length > 1) output.Append(",");
            output.Append("{\"pid\":").Append(entry.Pid).Append(",\"parent\":").Append(entry.Parent)
              .Append(",\"identity\":\"").Append(identity).Append("\"}");
          }
        } catch (System.ComponentModel.Win32Exception) {}
          catch (InvalidOperationException) {} catch (ArgumentException) {}
      } while (Process32NextW(snapshot, ref entry));
      Console.WriteLine(output.Append("]"));
    } finally { CloseHandle(snapshot); }
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern uint GetNamedSecurityInfoW(string target, int objectType, uint information,
    out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  static void ReadAcl(string target) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetNamedSecurityInfoW(target, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) throw new System.ComponentModel.Win32Exception((int)error);
    RawSecurityDescriptor acl;
    try {
      var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      acl = new RawSecurityDescriptor(bytes, 0);
    } finally { LocalFree(descriptor); }
    var output = new StringBuilder("{\"protected\":")
      .Append((acl.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? "true" : "false")
      .Append(",\"user\":\"").Append(WindowsIdentity.GetCurrent().User.Value)
      .Append("\",\"owner\":\"").Append(acl.Owner.Value).Append("\",\"entries\":[");
    foreach (GenericAce entry in acl.DiscretionaryAcl) {
      var rule = entry as QualifiedAce;
      if (output[output.Length - 1] != '[') output.Append(",");
      output.Append("{\"sid\":\"").Append(rule == null ? "unknown" : rule.SecurityIdentifier.Value)
        .Append("\",\"allow\":")
        .Append(rule != null && rule.AceQualifier == AceQualifier.AccessAllowed && !rule.IsCallback ? "true" : "false")
        .Append(",\"rights\":").Append(rule == null ? 0 : rule.AccessMask)
        .Append(",\"inheritance\":").Append((int)entry.AceFlags & 3)
        .Append(",\"propagation\":").Append(((int)entry.AceFlags >> 2) & 3).Append("}");
    }
    Console.WriteLine(output.Append("]}"));
  }

  static string Quote(string value) {
    var output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      output.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
      output.Append(character);
      slashes = 0;
    }
    output.Append('\\', slashes * 2);
    return output.Append('"').ToString();
  }

  static int Main(string[] args) {
    IntPtr job = IntPtr.Zero;
    Process child = null;
    string gate = null;
    try {
      // The pristine utility binary has no provider config. Copied providers
      // always forward arbitrary arguments, including these utility flag names.
      if (!File.Exists(Assembly.GetExecutingAssembly().Location + ".mock")) {
        if (args.Length == 1 && args[0] == "--list-processes") { ListProcesses(); return 0; }
        if (args.Length == 2 && args[0] == "--acl") { ReadAcl(args[1]); return 0; }
      }
      string[] config = File.ReadAllLines(Assembly.GetExecutingAssembly().Location + ".mock");
      if (config.Length != 2 || !File.Exists(config[0]) || !File.Exists(config[1])) return 91;
      // Keep stdin as an inherited byte stream. Framework StreamWriter can emit
      // a UTF-8 BOM under a UTF-8 console, so readiness uses a separate gate.
      gate = Path.Combine(Path.GetTempPath(), "claude-mock-gate-" + Guid.NewGuid());
      string bootstrap = "const fs=require('node:fs'),gate=process.env.CLAUDE_MOCK_GATE;"
        + "while(!fs.existsSync(gate))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);"
        + "fs.unlinkSync(gate);import(require('node:url').pathToFileURL(process.argv[1]).href);";
      var command = new StringBuilder("-e ").Append(Quote(bootstrap)).Append(" ").Append(Quote(config[1]));
      foreach (string argument in args) command.Append(" ").Append(Quote(argument));
      job = CreateJobObject(IntPtr.Zero, null);
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) return 92;
      var start = new ProcessStartInfo(config[0], command.ToString()) {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = false, RedirectStandardOutput = true, RedirectStandardError = true
      };
      start.EnvironmentVariables["CLAUDE_MOCK_GATE"] = gate;
      child = Process.Start(start);
      if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); return 93; }
      File.WriteAllText(gate, "");
      Task output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      Task error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      child.WaitForExit();
      // Descendants may still own output pipes. Kill them before draining EOF.
      CloseHandle(job);
      job = IntPtr.Zero;
      Task.WaitAll(output, error);
      return child.ExitCode;
    } catch { return 94; }
    finally {
      if (gate != null && File.Exists(gate)) File.Delete(gate);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (child != null) child.Dispose();
    }
  }
}
