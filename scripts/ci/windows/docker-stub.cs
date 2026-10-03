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
//   BV_STUB_APP_RUNNING      full backups (Task 6): "1" makes `compose ps --status
//                            running -q blackvault` print a container id (the
//                            app is running); anything else prints nothing.
//                            A `ps` WITHOUT --status keeps printing the table
//                            the installers grep.
//   BV_STUB_STDIN_FILE       full backups: the backup program's call (any
//                            `compose exec|run ... dist/scripts/full-backup.mjs`)
//                            writes every byte it was given on standard input
//                            to this file - the only place a passphrase may
//                            arrive.
//   BV_STUB_ENV_FILE         full backups: that call also writes its whole
//                            environment here (NAME=value per line), to prove
//                            the passphrase is not in it.
//   BV_STUB_BACKUP_STDOUT / BV_STUB_BACKUP_STDERR
//                            lines that call prints.
//   BV_STUB_BACKUP_EXIT      its exit code; unset => 0.
//   BV_STUB_BACKUP_SLEEP_MS  it sleeps this long before exiting.
//   BV_STUB_RESTORE_STDIN_FILE / BV_STUB_RESTORE_STDOUT / BV_STUB_RESTORE_STDERR /
//   BV_STUB_RESTORE_EXIT     full restore (Task 7): the same four knobs for the
//                            restore program's call (any `compose run ...
//                            dist/scripts/full-restore.mjs`). restore.bat's
//                            CHECK step is the backup program with --verify,
//                            so it is driven by the BV_STUB_BACKUP_* knobs.
//   BV_STUB_RESTORE_MARKER_DIR  full restore (ruling R24): the HOST uploads folder.
//                            When set, the restore program's call creates
//                            <dir>\.restore-<stamp>.db-started there (<stamp>
//                            from its --stamp argument): "the database step
//                            was reached".
//   BV_STUB_RESTORE_RECOVERY_COPY  full restore (ruling R25): a file path. The
//                            restore program's call copies the first
//                            backups\restore-*-RECOVERY.txt it finds (in the
//                            current folder) there: what is on disk WHILE the
//                            restore runs.
//   BV_STUB_REENCRYPT_STDIN_FILE / BV_STUB_REENCRYPT_STDOUT / BV_STUB_REENCRYPT_STDERR /
//   BV_STUB_REENCRYPT_EXIT   reencrypt-files (Task 8): the same four knobs for
//                            the re-encryption program's call (any `compose run
//                            ... dist/scripts/reencrypt-files.mjs`). The stdin
//                            file is the only place the OLD KEY may arrive;
//                            BV_STUB_ENV_FILE records that call's environment
//                            too. `compose stop` / `compose start` are failed
//                            with BV_STUB_FAIL_ON, as for rotate-key.bat.
//   BV_STUB_LOCK_EXIT / BV_STUB_LOCK_STDOUT / BV_STUB_LOCK_STDERR
//                            full restore: the lock question restore.bat asks
//                            the running app before it stops it (any call with
//                            `--lock-status`): its exit code (unset => 0) and
//                            the line it prints on each stream. It reads no
//                            standard input and never touches
//                            BV_STUB_STDIN_FILE, so the check program's record
//                            there survives it.
//   BV_STUB_ROLLBACK_EXIT    full restore: exit code of the rollback container
//                            (any call naming /bv-snapshot-restore.sh);
//                            unset/"0" => 0. The stub does NOT run the script:
//                            what it does to real files is proven on Linux
//                            (src/lib/backup/full-restore.real-db.test.ts).
//   BV_STUB_CLEAR_MARKER_EXIT  full restore: exit code of the rollback
//                            container for `/bv-snapshot-restore.sh
//                            clear-marker ...` ONLY (the other modes keep
//                            BV_STUB_ROLLBACK_EXIT); unset/"0" => that knob
//                            decides. The stub never removes the marker.
//   BV_STUB_HANDOFF_READONLY full restore: "1" makes `compose stop` mark the
//                            file named by BV_HANDOFF (restore.bat's handoff
//                            file, inherited through the environment) as
//                            read-only, so that restore.bat's later appends
//                            to it fail.
//   BV_STUB_STATE_ANSWER     full restore: what the rollback container prints
//                            for `/bv-snapshot-restore.sh state ...` (started /
//                            complete / untouched), exit 0. Unset => the
//                            generic "[stub] ..." line. For running the
//                            recovery file's PostgreSQL line as printed.
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

        // The lock question (`full-backup.mjs --lock-status`). Before the
        // backup program's branch: it is the same script, but it takes no
        // passphrase and must not be given the backup's knobs.
        if (Array.IndexOf(args, "--lock-status") >= 0)
        {
            string lockOut = Environment.GetEnvironmentVariable("BV_STUB_LOCK_STDOUT");
            if (!string.IsNullOrEmpty(lockOut))
            {
                Console.WriteLine(lockOut);
            }
            string lockErr = Environment.GetEnvironmentVariable("BV_STUB_LOCK_STDERR");
            if (!string.IsNullOrEmpty(lockErr))
            {
                Console.Error.WriteLine(lockErr);
            }
            string lockExit = Environment.GetEnvironmentVariable("BV_STUB_LOCK_EXIT");
            int lockCode;
            return (!string.IsNullOrEmpty(lockExit) && int.TryParse(lockExit, out lockCode)) ? lockCode : 0;
        }

        // Full backups (Task 6): the backup program, through exec or run.
        // Handled before everything else so BV_STUB_FAIL_ON / BV_STUB_RUN_EXIT
        // (the rotation's knobs) never apply to it.
        // Full restore (Task 7): the restore program takes the same path,
        // with its own knobs (BV_STUB_RESTORE_*).
        // reencrypt-files (Task 8): the re-encryption program, the same path
        // again with its own knobs (BV_STUB_REENCRYPT_*).
        bool isRestoreProgram = Array.IndexOf(args, "dist/scripts/full-restore.mjs") >= 0;
        bool isReencryptProgram = Array.IndexOf(args, "dist/scripts/reencrypt-files.mjs") >= 0;
        string programKnobs = isReencryptProgram ? "BV_STUB_REENCRYPT_" : (isRestoreProgram ? "BV_STUB_RESTORE_" : "BV_STUB_BACKUP_");
        if (Array.IndexOf(args, "dist/scripts/full-backup.mjs") >= 0 || isRestoreProgram || isReencryptProgram)
        {
            byte[] input;
            using (Stream stdin = Console.OpenStandardInput())
            using (MemoryStream buffer = new MemoryStream())
            {
                stdin.CopyTo(buffer);
                input = buffer.ToArray();
            }
            string stdinFile = Environment.GetEnvironmentVariable(isReencryptProgram ? "BV_STUB_REENCRYPT_STDIN_FILE" : (isRestoreProgram ? "BV_STUB_RESTORE_STDIN_FILE" : "BV_STUB_STDIN_FILE"));
            if (!string.IsNullOrEmpty(stdinFile))
            {
                File.WriteAllBytes(stdinFile, input);
            }
            string envFile = Environment.GetEnvironmentVariable("BV_STUB_ENV_FILE");
            if (!string.IsNullOrEmpty(envFile))
            {
                System.Text.StringBuilder dump = new System.Text.StringBuilder();
                foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
                {
                    dump.Append(entry.Key).Append('=').Append(entry.Value).Append('\n');
                }
                File.WriteAllText(envFile, dump.ToString(), new System.Text.UTF8Encoding(false));
            }
            if (isRestoreProgram)
            {
                string markerDir = Environment.GetEnvironmentVariable("BV_STUB_RESTORE_MARKER_DIR");
                int stampAt = Array.IndexOf(args, "--stamp");
                if (!string.IsNullOrEmpty(markerDir) && stampAt >= 0 && stampAt + 1 < args.Length)
                {
                    Directory.CreateDirectory(Path.Combine(markerDir, ".restore-" + args[stampAt + 1] + ".db-started"));
                }
                string recoveryCopy = Environment.GetEnvironmentVariable("BV_STUB_RESTORE_RECOVERY_COPY");
                if (!string.IsNullOrEmpty(recoveryCopy) && Directory.Exists("backups"))
                {
                    string[] found = Directory.GetFiles("backups", "restore-*-RECOVERY.txt");
                    if (found.Length > 0)
                    {
                        File.Copy(found[0], recoveryCopy, true);
                    }
                }
            }
            string sleepMs = Environment.GetEnvironmentVariable("BV_STUB_BACKUP_SLEEP_MS");
            int ms;
            if (!string.IsNullOrEmpty(sleepMs) && int.TryParse(sleepMs, out ms))
            {
                System.Threading.Thread.Sleep(ms);
            }
            string backupOut = Environment.GetEnvironmentVariable(programKnobs + "STDOUT");
            if (!string.IsNullOrEmpty(backupOut))
            {
                Console.WriteLine(backupOut);
            }
            string backupErr = Environment.GetEnvironmentVariable(programKnobs + "STDERR");
            if (!string.IsNullOrEmpty(backupErr))
            {
                Console.Error.WriteLine(backupErr);
            }
            string backupExit = Environment.GetEnvironmentVariable(programKnobs + "EXIT");
            int backupCode;
            return (!string.IsNullOrEmpty(backupExit) && int.TryParse(backupExit, out backupCode)) ? backupCode : 0;
        }

        // Full restore (Task 7): the rollback container. Handled before the
        // generic `run` branch so the rotation's knobs never apply to it.
        if (Array.IndexOf(args, "/bv-snapshot-restore.sh") >= 0)
        {
            int modeAt = Array.IndexOf(args, "/bv-snapshot-restore.sh") + 1;
            string stateAnswer = Environment.GetEnvironmentVariable("BV_STUB_STATE_ANSWER");
            if (modeAt < args.Length && args[modeAt] == "state" && !string.IsNullOrEmpty(stateAnswer))
            {
                Console.WriteLine(stateAnswer);
                return 0;
            }
            string clearExit = Environment.GetEnvironmentVariable("BV_STUB_CLEAR_MARKER_EXIT");
            int clearCode;
            if (modeAt < args.Length && args[modeAt] == "clear-marker" && !string.IsNullOrEmpty(clearExit) && int.TryParse(clearExit, out clearCode) && clearCode != 0)
            {
                Console.Error.WriteLine("ERROR: could not restore from the snapshot: [stub] failing on purpose (BV_STUB_CLEAR_MARKER_EXIT)");
                return clearCode;
            }
            string rollbackExit = Environment.GetEnvironmentVariable("BV_STUB_ROLLBACK_EXIT");
            int rollbackCode;
            if (!string.IsNullOrEmpty(rollbackExit) && int.TryParse(rollbackExit, out rollbackCode) && rollbackCode != 0)
            {
                Console.Error.WriteLine("ERROR: could not restore from the snapshot: [stub] failing on purpose (BV_STUB_ROLLBACK_EXIT)");
                return rollbackCode;
            }
            Console.WriteLine("[stub] docker " + joined);
            return 0;
        }

        if (string.Equals(sub, "ps", StringComparison.OrdinalIgnoreCase))
        {
            // Full backups (Task 6): `ps --status running -q blackvault` is
            // how backup.bat asks "is the app running?".
            if (Array.IndexOf(args, "--status") >= 0)
            {
                if (Environment.GetEnvironmentVariable("BV_STUB_APP_RUNNING") == "1")
                {
                    Console.WriteLine("0123456789ab");
                }
                return 0;
            }
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

        if (string.Equals(sub, "stop", StringComparison.OrdinalIgnoreCase) &&
            Environment.GetEnvironmentVariable("BV_STUB_HANDOFF_READONLY") == "1")
        {
            string handoff = Environment.GetEnvironmentVariable("BV_HANDOFF");
            if (!string.IsNullOrEmpty(handoff) && File.Exists(handoff))
            {
                File.SetAttributes(handoff, File.GetAttributes(handoff) | FileAttributes.ReadOnly);
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
