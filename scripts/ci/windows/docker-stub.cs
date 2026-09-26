// A fake `docker` for the Windows CI job. Compiled to docker.exe by
// Test-WindowsInstallers.ps1, which explains the whole arrangement.
//
// WHY THIS IS AN .exe AND NOT A .cmd — this is the important part.
//
// The first live run of this job used a docker.cmd stub. It silently
// invalidated most of the run, because of a cmd.exe rule:
//
//     Invoking a batch file from another batch file WITHOUT `call`
//     transfers control and NEVER RETURNS.
//
// install.bat and update.bat invoke Docker bare — `%COMPOSE% build`, not
// `call %COMPOSE% build` — which is correct, because the real docker is
// docker.exe and an executable returns normally. But with a .cmd stub, the
// FIRST such line ended the calling script outright, taking the stub's exit
// code with it. Everything after it never ran: no `up -d`, no summary, no
// error message. Worse, the pre-PostgreSQL update.bat probes Docker on line
// 10 with a bare `docker compose version`, so it died before `git pull` — the
// byte-offset resume scenario was testing nothing at all.
//
// The version parsing survived only because the current scripts read it via
// `for /f ... (`docker compose version --short`)`, and a for/f backtick
// command runs in a subshell, which does return.
//
// So the stub must be a real executable. PATHEXT resolves .EXE before .CMD,
// so this also wins over any leftover stub.
//
// Controlled by environment variables:
//   BV_STUB_LOG              append every invocation here (for assertions)
//   BV_STUB_COMPOSE_VERSION  what `docker compose version` reports.
//                            Unset => the command FAILS, i.e. "no Compose v2".
//   BV_STUB_FAIL_ON          a compose subcommand that should exit 1
//                            (e.g. "build") to exercise the failure paths.

using System;
using System.IO;

internal static class DockerStub
{
    private static int Main(string[] args)
    {
        string joined = string.Join(" ", args);

        string log = Environment.GetEnvironmentVariable("BV_STUB_LOG");
        if (!string.IsNullOrEmpty(log))
        {
            // Appending, never truncating: one run makes several calls and the
            // assertions read the whole sequence.
            File.AppendAllText(log, joined + Environment.NewLine);
        }

        if (args.Length == 0 || !string.Equals(args[0], "compose", StringComparison.OrdinalIgnoreCase))
        {
            Console.WriteLine("[stub] docker " + joined);
            return 0;
        }

        string sub = args.Length > 1 ? args[1] : "";

        if (string.Equals(sub, "version", StringComparison.OrdinalIgnoreCase))
        {
            string version = Environment.GetEnvironmentVariable("BV_STUB_COMPOSE_VERSION");
            if (string.IsNullOrEmpty(version))
            {
                // "Compose v2 is not installed here", which require_compose
                // must detect. Reports failure, not an empty string.
                return 1;
            }
            Console.WriteLine(version);
            return 0;
        }

        if (string.Equals(sub, "ps", StringComparison.OrdinalIgnoreCase))
        {
            // The scripts pipe this into `findstr /i "healthy running"`.
            Console.WriteLine("NAME                STATUS");
            Console.WriteLine("blackvault-app      Up 4 seconds (healthy)");
            return 0;
        }

        string failOn = Environment.GetEnvironmentVariable("BV_STUB_FAIL_ON");
        if (!string.IsNullOrEmpty(failOn) && string.Equals(sub, failOn, StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("[stub] docker compose " + sub + ": failing on purpose (BV_STUB_FAIL_ON)");
            return 1;
        }

        // `joined` already begins with "compose", so this prints
        // "[stub] docker compose up -d", not "...docker compose compose up -d".
        Console.WriteLine("[stub] docker " + joined);
        return 0;
    }
}
