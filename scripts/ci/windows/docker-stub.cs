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
//   BV_STUB_LOGS_FILE        `docker compose logs` prints this file's raw
//                            bytes (UTF-8, as the real CLI does), standing in
//                            for the container log the scripts read the
//                            first-time setup token from. Unset => the generic
//                            "[stub] ..." line, which holds no token.
//   BV_STUB_PROBE_ANSWER     fix round 1 (C1): what `compose run ... --probe
//                            ...` prints on stdout (OLD / NEW / NEITHER).
//                            Checked independently of BV_STUB_FAIL_ON, so a
//                            scenario can fail the real rotation run while
//                            still controlling what the recovery probe says.
//   BV_STUB_PROBE_STATUS     exit code for the probe call; unset/"0" => 0.
//   BV_STUB_PROBE_FILES      spec 3b Task 5: a SECOND probe stdout line,
//                            e.g. "FILES old=3 new=0 rot=3", printed after
//                            BV_STUB_PROBE_ANSWER. Unset => one line only.
//   BV_STUB_RUN_EXIT         final review F5: exit code of the (non-probe)
//                            rotation `compose run`, e.g. 3 = the CLI refused
//                            up front. Unset/"0" => normal handling.
//   BV_STUB_RUN_HANDSHAKE    fix round 2 (N5): a path prefix. The (non-probe)
//                            rotation `compose run` writes PREFIX.ready, then
//                            waits up to 60 s for PREFIX.ack before returning.
//                            Lets a scenario act at an exact point — after the
//                            .bat has written .new, before the key-file swap
//                            (e.g. lock .new so the SECOND move fails).
//
// Task 4: `compose up` also appends a line "ENV BLACKVAULT_UPLOADS_SNAPSHOT=
// [<value>]" to BV_STUB_LOG, reporting what update.bat passed through its own
// environment for that one call — proof the uploads-snapshot marker reaches
// the container's environment, without disturbing the "compose up -d" line
// itself (several existing scenarios match it with EXACT equality).

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

            // Task 4: `compose up -d` (the app start) also logs the uploads
            // snapshot marker it was handed, on its OWN line - never appended
            // to the "compose up -d" line itself, which existing scenarios
            // match with exact equality (Get-CallIndex).
            if (args.Length > 1 &&
                string.Equals(args[0], "compose", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(args[1], "up", StringComparison.OrdinalIgnoreCase))
            {
                string uploadsMarker = Environment.GetEnvironmentVariable("BLACKVAULT_UPLOADS_SNAPSHOT") ?? "";
                File.AppendAllText(log, "ENV BLACKVAULT_UPLOADS_SNAPSHOT=[" + uploadsMarker + "]" + Environment.NewLine);
            }
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

        if (string.Equals(sub, "run", StringComparison.OrdinalIgnoreCase))
        {
            bool isProbe = false;
            foreach (string a in args)
            {
                if (a == "--probe") { isProbe = true; break; }
            }
            if (isProbe)
            {
                // Independent of BV_STUB_FAIL_ON on purpose: a scenario fails
                // the real rotation run via BV_STUB_FAIL_ON=run and separately
                // controls what the recovery probe reports via these two.
                string probeStatus = Environment.GetEnvironmentVariable("BV_STUB_PROBE_STATUS");
                if (!string.IsNullOrEmpty(probeStatus) && probeStatus != "0")
                {
                    int code;
                    return int.TryParse(probeStatus, out code) ? code : 1;
                }
                string answer = Environment.GetEnvironmentVariable("BV_STUB_PROBE_ANSWER");
                if (!string.IsNullOrEmpty(answer))
                {
                    Console.WriteLine(answer);
                }
                string filesLine = Environment.GetEnvironmentVariable("BV_STUB_PROBE_FILES");
                if (!string.IsNullOrEmpty(filesLine))
                {
                    Console.WriteLine(filesLine);
                }
                return 0;
            }

            string runExit = Environment.GetEnvironmentVariable("BV_STUB_RUN_EXIT");
            if (!string.IsNullOrEmpty(runExit) && runExit != "0")
            {
                int code;
                Console.Error.WriteLine("[stub] rotation run exiting " + runExit + " (BV_STUB_RUN_EXIT)");
                return int.TryParse(runExit, out code) ? code : 1;
            }

            string handshake = Environment.GetEnvironmentVariable("BV_STUB_RUN_HANDSHAKE");
            if (!string.IsNullOrEmpty(handshake))
            {
                File.WriteAllText(handshake + ".ready", "");
                DateTime deadline = DateTime.UtcNow.AddSeconds(60);
                while (!File.Exists(handshake + ".ack"))
                {
                    if (DateTime.UtcNow > deadline)
                    {
                        Console.Error.WriteLine("[stub] BV_STUB_RUN_HANDSHAKE: no .ack within 60 s");
                        return 1;
                    }
                    System.Threading.Thread.Sleep(100);
                }
            }
        }

        string failOn = Environment.GetEnvironmentVariable("BV_STUB_FAIL_ON");
        if (!string.IsNullOrEmpty(failOn) && string.Equals(sub, failOn, StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("[stub] docker compose " + sub + ": failing on purpose (BV_STUB_FAIL_ON)");
            return 1;
        }

        if (string.Equals(sub, "logs", StringComparison.OrdinalIgnoreCase))
        {
            string logsFile = Environment.GetEnvironmentVariable("BV_STUB_LOGS_FILE");
            if (!string.IsNullOrEmpty(logsFile))
            {
                // Raw bytes, not Console.Write: the console encoding would
                // re-encode the em dash, and the real docker writes UTF-8.
                byte[] bytes = File.ReadAllBytes(logsFile);
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(bytes, 0, bytes.Length);
                }
                return 0;
            }
        }

        // `joined` already begins with "compose", so this prints
        // "[stub] docker compose up -d", not "...docker compose compose up -d".
        Console.WriteLine("[stub] docker " + joined);
        return 0;
    }
}
