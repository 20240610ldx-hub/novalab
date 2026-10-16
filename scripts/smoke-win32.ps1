# The smoke owns this launcher. Its Job Object owns every Bridge/kernel descendant.
param([string]$Node, [string]$Loader, [string]$Main)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

public static class SmokeJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long PerProcessTime, PerJobTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, ThisUserTime, ThisKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint Pid, Tid;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, System.Text.StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    static string Quote(string value) {
        // These are file paths/URLs, never arbitrary shell arguments.
        if (value.Contains("\"")) throw new ArgumentException("Invalid path");
        return "\"" + value + "\"";
    }

    public static int Run(string node, string loader, string main) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var info = new ProcessInfo();
        IntPtr nullInput = IntPtr.Zero;
        Process bridge = null;
        bool assigned = false;
        try {
            var limits = new ExtendedLimit();
            limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var startup = new Startup();
            startup.Size = (uint)Marshal.SizeOf(startup);
            startup.Flags = 0x100; // STARTF_USESTDHANDLES
            nullInput = CreateFile("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (nullInput == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            startup.Input = nullInput; // Bridge must not share the launcher's control pipe.
            startup.Output = GetStdHandle(-11);
            startup.Error = GetStdHandle(-12);
            Check(SetHandleInformation(startup.Input, 1, 1));
            Check(SetHandleInformation(startup.Output, 1, 1));
            Check(SetHandleInformation(startup.Error, 1, 1));
            var command = new System.Text.StringBuilder(Quote(node)
                + (String.IsNullOrEmpty(loader) ? "" : " --import " + Quote(loader)) + " " + Quote(main));
            // Suspend before any code/descendants run; establish ownership before resuming.
            Check(CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004,
                IntPtr.Zero, Environment.CurrentDirectory, ref startup, out info));
            Check(AssignProcessToJobObject(job, info.Process));
            assigned = true;
            bridge = Process.GetProcessById((int)info.Pid);
            if (ResumeThread(info.Thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
            Console.WriteLine("NOVALAB_SMOKE_BRIDGE_PID=" + info.Pid);
            Console.Out.Flush();
            var stop = Task.Run(() => Console.In.ReadLine()); // Parent closing stdin requests cleanup.
            while (!stop.IsCompleted && !bridge.HasExited) {
                Thread.Sleep(100);
                bridge.Refresh();
            }
            uint exitCode;
            Check(GetExitCodeProcess(info.Process, out exitCode));
            int result = exitCode == 259 ? 0 : unchecked((int)exitCode);
            Check(TerminateJobObject(job, 1));
            var deadline = Stopwatch.StartNew();
            for (;;) {
                Accounting accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) break;
                if (deadline.ElapsedMilliseconds > 15000) throw new TimeoutException("Smoke job processes did not exit");
                Thread.Sleep(25);
            }
            bridge.WaitForExit();
            Console.WriteLine("NOVALAB_SMOKE_JOB_EMPTY");
            Console.Out.Flush();
            return result;
        } finally {
            // Setup failure cannot leave a suspended unowned process behind.
            if (!assigned && info.Process != IntPtr.Zero) TerminateProcess(info.Process, 1);
            CloseHandle(job);
            if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
            if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
            if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
            if (bridge != null) bridge.Dispose();
        }
    }
}
'@
try {
    exit ([SmokeJob]::Run($Node, $Loader, $Main))
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
