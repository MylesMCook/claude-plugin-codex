// Test-only native launcher. A job object kills the mock's descendants on timeout.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

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
    try {
      string[] config = File.ReadAllLines(Assembly.GetExecutingAssembly().Location + ".mock");
      if (config.Length != 2 || !File.Exists(config[0]) || !File.Exists(config[1])) return 91;
      // No fixture code runs before job assignment. The launcher supplies the
      // first stdin byte, then forwards the original stdin without changing argv.
      string bootstrap = "if(require('node:fs').readSync(0,Buffer.alloc(1),0,1,null)!==1)process.exit(95);"
        + "import(require('node:url').pathToFileURL(process.argv[1]).href);";
      var command = new StringBuilder("-e ").Append(Quote(bootstrap)).Append(" ").Append(Quote(config[1]));
      foreach (string argument in args) command.Append(" ").Append(Quote(argument));
      job = CreateJobObject(IntPtr.Zero, null);
      var limits = new ExtendedLimits();
      limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) return 92;
      child = Process.Start(new ProcessStartInfo(config[0], command.ToString()) {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
      });
      if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(); return 93; }
      child.StandardInput.BaseStream.WriteByte(1);
      child.StandardInput.BaseStream.Flush();
      Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream)
        .ContinueWith(task => { try { child.StandardInput.Close(); } catch {} });
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
      if (job != IntPtr.Zero) CloseHandle(job);
      if (child != null) child.Dispose();
    }
  }
}
