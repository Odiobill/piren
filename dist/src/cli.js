#!/usr/bin/env node
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initVault, scaffoldAgentDirectory } from "./init.js";
import { spawnPiRun, buildPiRunCommand } from "./run.js";
import { formatSetupReport, setupPiren } from "./setup.js";
import { buildAgentConfigYaml, readPiDefaultModel, runWizard } from "./wizard.js";
import { ReadlinePrompt } from "./prompt.js";
import { GatewayServer } from "./gateway-http.js";
import { TelegramBotApiHttpClient, TelegramTransport, runTelegramPolling } from "./telegram-transport.js";
import { DiscordBotApiHttpClient, DiscordTransport, runDiscordGateway, createNativeDiscordGatewaySocket } from "./discord-transport.js";
import { PiRpcClient } from "./gateway-rpc.js";
import { askAgent } from "./ask.js";
import { cleanPiren, formatCleanReport } from "./clean.js";
import { readVersion } from "./version.js";
import { executePirenUpdate, formatUpdateReport } from "./update.js";
import { validateAgentName, agentDirPath, executeAddAgent, executeRemoveAgent, executeCloneAgent, } from "./agent-manage.js";
import { resolveGatewayToken, assertAuthGate, isLocalhostBind, defaultTokenFilePath } from "./gateway-auth.js";
import { formatHelp, formatCommandHelp, isHelpRequest } from "./help.js";
import { parseArgs, bootstrapOptions, KNOWN_COMMANDS, } from "./parse-args.js";
import { loadPirenContext } from "./bootstrap.js";
import { formatAgentsReport, listPirenAgents, listFallbackCandidates, formatFallbackReport } from "./agents.js";
import { schedulerDryRun, readYamlConfig, resolveEnabledAgents, DEFAULT_CONFIG_PATH } from "./scheduler-cli.js";
import { schedulerOnce, createSchedulerExecutors } from "./scheduler-once.js";
import { resolveSchedulerConfig, runSchedulerLoop, createSchedulerLoopController, createRealSchedulerLoopSleep, } from "./scheduler-loop.js";
import { createAskRunner } from "./scheduler-executor.js";
import { doctorPiren, formatDoctorReport } from "./doctor.js";
import { parsePackageManifest, mergeEffectivePackages, diagnosePackages, formatPackageList, formatPackageExplain, formatPackageDoctor, } from "./package-manifest.js";
import { createRealGroupWriteDeps, readGroupConfig, createGroup, addAgentToGroup, removeAgentFromGroup, setFallbackOrder, validateGroups, formatGroupList, formatGroupConfig, formatValidationReport, } from "./group-config.js";
import { resolveAgentGroups, parseGroupConfigs } from "./agent-groups.js";
import { createRealCronWriteDeps, createCronJob, createScriptCronJob, enableCronJob, disableCronJob, validateCronJobs, formatCronList, formatCronShow, formatCronRuns, formatCronValidationReport, readCronJobFile, } from "./cron-cli.js";
import { detectServiceManager, executeServiceAction, formatServiceReport, resolvePirenCommand, updateServiceStatusYaml, validateTransport, validateAction, validateServiceMethod, crontabAvailableFromInvocation, systemdUserAvailableFromInvocation, } from "./service-lifecycle.js";
import { createRealSkillCliDeps, scanAllSkills, filterSkills, showSkill, explainSkill, createSkill, moveSkill, promoteSkill, demoteSkill, listConflicts, validateSkills, formatSkillList, formatSkillShow, formatSkillExplain, formatSkillConflicts, formatSkillValidation, parseScope, formatScope, } from "./skill-cli.js";
import { createRealTaskCliDeps, resolveTaskIdOrPath, readVaultFile, readTaskDetail, formatTaskList, formatTaskDetail, isValidCliPriority, CLI_PRIORITIES, } from "./task-cli.js";
import { sanitizeDeviceId } from "./scheduler-once.js";
import { createInboxTask, listInboxTasks, claimInboxTask, updateInboxTaskStatus, } from "./inbox.js";
const thisDir = dirname(fileURLToPath(import.meta.url));
// Resolve the public directory (frontend static files) relative to this
// module's location. From source: src/ -> ../public. From compiled dist:
// dist/src/ -> ../public = dist/public. The build script copies public/
// to dist/public/ so the path works in both environments.
function resolvePublicDir() {
    return join(thisDir, "..", "public");
}
const argv = process.argv.slice(2);
const parsed = parseArgs(argv);
const { agentDir, agentName, command, force, yes, vaultRoot, piArgs, port, host, token, positionals } = parsed;
// Help takes priority. `piren --help` / `piren -h` shows top-level help;
// `piren <cmd> --help` shows that command's help. The `--` passthrough is
// respected so `piren run -- --help` forwards the flag to Pi.
const helpRequested = isHelpRequest(argv);
const commandExplicitlyGiven = argv.includes(command) && command !== "status";
if (helpRequested) {
    console.log(commandExplicitlyGiven ? formatCommandHelp(command) : formatHelp());
    process.exit(0);
}
if (!KNOWN_COMMANDS.includes(command)) {
    console.error(formatHelp());
    console.error("");
    console.error(`Unknown command: ${command}`);
    process.exit(2);
}
try {
    if (command === "init") {
        const initOptions = agentName === undefined
            ? { vaultRoot: vaultRoot ?? process.cwd(), force }
            : { vaultRoot: vaultRoot ?? process.cwd(), agentName, force };
        const result = await initVault(initOptions);
        console.log("Piren vault initialized");
        console.log(`vault_root: ${result.vaultRoot}`);
        console.log(`agent_name: ${result.agentName}`);
        console.log(`agent_dir: ${result.agentDir}`);
        console.log("");
        console.log("Configure ~/.config/piren/config.yml:");
        console.log("vault_root: " + result.vaultRoot);
        console.log("allowed_agents:");
        console.log(`  - ${result.agentName}`);
        console.log("");
        console.log("Then test with:");
        console.log(`PIREN_AGENT=${result.agentName} piren status`);
        console.log(`PIREN_AGENT=${result.agentName} piren run`);
    }
    else if (command === "run" || command === "worker" || command === "chat") {
        const exitCode = await spawnPiRun({ ...bootstrapOptions(parsed), extraArgs: piArgs, workerMode: command === "worker" });
        process.exit(exitCode);
    }
    else if (command === "gateway" || command === "web") {
        const opts = bootstrapOptions(parsed);
        const runCommand = await buildPiRunCommand({ ...opts, rpcMode: true });
        const context = await loadPirenContext(opts);
        const agentsReport = await listPirenAgents(opts);
        const targetBuilder = async (agent) => {
            const agentCommand = await buildPiRunCommand({ ...opts, cliAgent: agent, rpcMode: true });
            return { command: agentCommand.command, args: agentCommand.args, cwd: agentCommand.cwd, env: agentCommand.env };
        };
        // Resolve the auth token: --token > PIREN_TOKEN > token file. On a
        // non-localhost bind with no token found, auto-generate one, persist it,
        // and print it once so the steward can use it. On localhost, no token
        // means auth is optional (friction-free local dev).
        const bindHost = host ?? "127.0.0.1";
        const resolvedToken = await resolveGatewayToken({
            cliToken: token,
            envToken: process.env.PIREN_TOKEN,
            tokenPath: defaultTokenFilePath(),
            generate: !isLocalhostBind(bindHost),
        });
        // Fail-closed: refuse to start on a non-localhost bind without a token
        // rather than silently serving open. (With generate=true above this
        // never throws for non-localhost, but the guard is defense-in-depth and
        // also covers a future --no-generate flag.)
        assertAuthGate({ hostname: bindHost, token: resolvedToken.token });
        if (resolvedToken.source === "generated") {
            console.log(`Generated gateway auth token (saved to ${defaultTokenFilePath()}):`);
            console.log(`  ${resolvedToken.token}`);
            console.log("Store this token securely. It will not be printed again.");
            console.log("");
        }
        else if (resolvedToken.token !== "") {
            console.log(`Gateway auth: token from ${resolvedToken.source}.`);
            console.log("");
        }
        const server = new GatewayServer({
            target: { command: runCommand.command, args: runCommand.args, cwd: runCommand.cwd, env: runCommand.env },
            vaultRoot: context.vaultRoot,
            runnableAgents: agentsReport.runnableAgents,
            initialAgent: context.agentName,
            targetBuilder,
            authToken: resolvedToken.token !== "" ? resolvedToken.token : undefined,
            publicDir: resolvePublicDir(),
        });
        const handle = await server.start(port ?? 7317, bindHost);
        console.log(`Piren gateway listening on http://${handle.hostname}:${handle.port}`);
        const shutdown = async () => {
            try {
                await server.close();
            }
            catch (error) {
                console.error(error instanceof Error ? error.message : String(error));
            }
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
    else if (command === "telegram") {
        const opts = bootstrapOptions(parsed);
        const context = await loadPirenContext(opts);
        const agentsReport = await listPirenAgents(opts);
        const telegramConfig = context.config.telegram;
        const botToken = telegramConfig?.bot_token;
        const allowedChatIds = telegramConfig?.allowed_chat_ids ?? [];
        if (typeof botToken !== "string" || botToken.trim() === "") {
            throw new Error("Missing telegram.bot_token in ~/.config/piren/config.yml");
        }
        if (!Array.isArray(allowedChatIds) || allowedChatIds.length === 0) {
            throw new Error("Missing telegram.allowed_chat_ids in ~/.config/piren/config.yml");
        }
        const defaultAgent = telegramConfig?.default_agent ?? context.agentName;
        if (!agentsReport.runnableAgents.includes(defaultAgent)) {
            throw new Error(`Telegram default agent '${defaultAgent}' is not in the runnable set`);
        }
        const targetBuilder = async (agent) => {
            const agentCommand = await buildPiRunCommand({ ...opts, cliAgent: agent, rpcMode: true });
            return { command: agentCommand.command, args: agentCommand.args, cwd: agentCommand.cwd, env: agentCommand.env };
        };
        const api = new TelegramBotApiHttpClient(botToken.trim());
        const transport = new TelegramTransport({
            allowedChatIds,
            runnableAgents: agentsReport.runnableAgents,
            defaultAgent,
            targetBuilder,
            clientFactory: (target) => new PiRpcClient(target),
            api,
            feedback: telegramConfig?.feedback,
        });
        const controller = new AbortController();
        const shutdown = () => {
            controller.abort();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        console.log(`Piren Telegram transport running for ${allowedChatIds.length} allowlisted chat(s).`);
        await runTelegramPolling({
            api,
            transport,
            signal: controller.signal,
            onError: (error) => console.error(error.message),
        });
    }
    else if (command === "discord") {
        const opts = bootstrapOptions(parsed);
        const context = await loadPirenContext(opts);
        const agentsReport = await listPirenAgents(opts);
        const discordConfig = context.config.discord;
        const botToken = discordConfig?.bot_token;
        const allowedGuildIds = discordConfig?.allowed_guild_ids ?? [];
        const allowedChannelIds = discordConfig?.allowed_channel_ids ?? [];
        const allowedThreadIds = discordConfig?.allowed_thread_ids ?? [];
        if (typeof botToken !== "string" || botToken.trim() === "") {
            throw new Error("Missing discord.bot_token in ~/.config/piren/config.yml");
        }
        if (allowedGuildIds.length === 0 || allowedChannelIds.length === 0) {
            throw new Error("Missing discord.allowed_guild_ids and/or discord.allowed_channel_ids in ~/.config/piren/config.yml");
        }
        const defaultAgent = discordConfig?.default_agent ?? context.agentName;
        if (!agentsReport.runnableAgents.includes(defaultAgent)) {
            throw new Error(`Discord default agent '${defaultAgent}' is not in the runnable set`);
        }
        const targetBuilder = async (agent) => {
            const agentCommand = await buildPiRunCommand({ ...opts, cliAgent: agent, rpcMode: true });
            return { command: agentCommand.command, args: agentCommand.args, cwd: agentCommand.cwd, env: agentCommand.env };
        };
        const api = new DiscordBotApiHttpClient(botToken.trim());
        const transport = new DiscordTransport({
            allowedGuildIds,
            allowedChannelIds,
            allowedThreadIds: allowedThreadIds.length > 0 ? allowedThreadIds : undefined,
            runnableAgents: agentsReport.runnableAgents,
            defaultAgent,
            targetBuilder,
            clientFactory: (target) => new PiRpcClient(target),
            api,
            feedback: discordConfig?.feedback,
        });
        const gatewayUrl = "https://gateway.discord.gg/?v=10&encoding=json";
        // Intents: GUILDS (1) | GUILD_MESSAGES (512) | MESSAGE_CONTENT (32768) = 33281
        const DISCORD_INTENTS = 33281;
        console.log(`Piren Discord transport running for ${allowedChannelIds.length} allowlisted channel(s).`);
        const gateway = runDiscordGateway({
            botToken: botToken.trim(),
            applicationId: discordConfig?.application_id ?? "",
            intents: DISCORD_INTENTS,
            transport,
            socketFactory: () => createNativeDiscordGatewaySocket(gatewayUrl),
            onReady: () => console.log("Discord gateway ready."),
            onError: (error) => console.error(error.message),
        });
        let shuttingDown = false;
        const shutdown = () => {
            if (shuttingDown)
                return;
            shuttingDown = true;
            void gateway.close().then(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        // Block until shutdown; the gateway runs in the background.
        await new Promise(() => { });
    }
    else if (command === "doctor") {
        const report = await doctorPiren(bootstrapOptions(parsed));
        console.log(formatDoctorReport(report));
        if (!report.ok)
            process.exit(1);
    }
    else if (command === "agents") {
        if (parsed.fallback !== undefined) {
            const opts = bootstrapOptions(parsed);
            const report = await listPirenAgents(opts);
            const resolvedVaultRoot = report.vaultRoot ?? parsed.vaultRoot;
            if (!resolvedVaultRoot) {
                console.error("Could not resolve vault root. Pass --vault-root or set vault_root in ~/.config/piren/config.yml.");
                process.exit(2);
            }
            const candidateOptions = {};
            if (opts.configPath !== undefined)
                candidateOptions.configPath = opts.configPath;
            const candidates = await listFallbackCandidates(resolvedVaultRoot, parsed.fallback, candidateOptions);
            console.log(formatFallbackReport(parsed.fallback, candidates));
        }
        else {
            const report = await listPirenAgents(bootstrapOptions(parsed));
            console.log(formatAgentsReport(report));
        }
    }
    else if (command === "setup") {
        // Interactive wizard when run bare (no --apply, no --vault-root, no --agent).
        // Batch mode is preserved when any of those flags is present.
        const wantsInteractive = !parsed.apply && vaultRoot === undefined && agentName === undefined && agentDir === undefined;
        if (wantsInteractive && process.stdin.isTTY) {
            const prompter = new ReadlinePrompt();
            try {
                await runWizard(prompter, { log: (m) => console.log(m) });
            }
            finally {
                prompter.close();
            }
            // Explicit exit: the readline interface can keep the event loop alive
            // after the top-level await resolves, which Node reports as an unsettled
            // top-level await. The wizard is done, so exit cleanly.
            process.exit(0);
        }
        else {
            const setupOptions = {
                ...bootstrapOptions(parsed),
                apply: parsed.apply,
                ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
                ...(parsed.model !== undefined ? { model: parsed.model } : {}),
                ...(parsed.thinking !== undefined ? { thinking: parsed.thinking } : {}),
                ...(parsed.apiKey !== undefined ? { apiKey: parsed.apiKey } : {}),
            };
            const report = await setupPiren(setupOptions);
            console.log(formatSetupReport(report));
            if (report.checks.some((check) => check.status === "fail"))
                process.exit(1);
        }
    }
    else if (command === "service") {
        const [actionRaw, transportRaw] = positionals;
        if (!actionRaw || !transportRaw) {
            console.error("Usage: piren service <install|remove|start|stop|restart|status> <gateway|telegram|discord|scheduler>");
            process.exit(2);
        }
        const actionCheck = validateAction(actionRaw);
        if (!actionCheck.ok) {
            console.error(actionCheck.message);
            process.exit(2);
        }
        const transportCheck = validateTransport(transportRaw);
        if (!transportCheck.ok) {
            console.error(transportCheck.message);
            process.exit(2);
        }
        if (parsed.serviceMethod !== undefined) {
            const methodCheck = validateServiceMethod(parsed.serviceMethod);
            if (!methodCheck.ok) {
                console.error(methodCheck.message);
                process.exit(2);
            }
        }
        const action = actionRaw;
        const transport = transportRaw;
        // Resolve the context: vault + agent are needed for transport installs to
        // generate the right ExecStart command. The scheduler is NOT bound to one
        // agent (its loop reads local config on each tick), so it skips context
        // resolution and the vault/agent requirement. For remove/start/stop/
        // restart/status we only need the services dir, but loading context keeps
        // the command consistent for transports.
        const opts = bootstrapOptions(parsed);
        let resolvedVaultRoot = vaultRoot;
        let resolvedAgent = agentName;
        if (action === "install" && transport !== "scheduler") {
            try {
                const context = await loadPirenContext(opts);
                resolvedVaultRoot = resolvedVaultRoot ?? context.vaultRoot;
                resolvedAgent = resolvedAgent ?? context.agentName;
            }
            catch {
                // Bootstrap may fail on a fresh install; fall back to explicit flags.
            }
        }
        if (action === "install" && transport !== "scheduler" && (!resolvedVaultRoot || !resolvedAgent)) {
            console.error("service install requires a resolved vault and agent. Pass --vault-root and --agent, or run piren setup first.");
            process.exit(2);
        }
        const servicesDir = join(homedir(), ".config", "piren", "services");
        const pirenCommand = resolvePirenCommand({ explicit: process.argv[1] });
        const probe = {
            hasSystemdUser: async () => systemdUserInstalled(),
            hasTmux: async () => commandAvailable("tmux", ["-V"]),
            hasCrontab: async () => crontabInstalled(),
        };
        const manager = parsed.serviceMethod && parsed.serviceMethod !== "auto" ? parsed.serviceMethod : await detectServiceManager(probe);
        const deps = {
            writeFile: async (path, content, fileOpts) => {
                const { mkdir, writeFile, chmod } = await import("node:fs/promises");
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, content, "utf8");
                if (fileOpts?.executable)
                    await chmod(path, 0o755);
            },
            removeFile: async (path) => {
                const { rm } = await import("node:fs/promises");
                await rm(path, { force: true });
            },
            runCommand: (command) => runShell(command),
            log: (message) => console.log(message),
        };
        const report = await executeServiceAction({
            action,
            transport,
            manager,
            pirenCommand,
            vaultRoot: resolvedVaultRoot ?? "",
            agentName: resolvedAgent ?? "",
            servicesDir,
            deps,
        });
        console.log(formatServiceReport(report));
        // Record the service status in local config so `piren doctor` can report it.
        // This is best-effort: a config read/write failure must not fail the service
        // operation itself. Only record when files were actually generated (manager
        // is not "none"); when the manager is none, nothing was installed.
        if (report.ok && (action === "install" || action === "remove") && report.manager !== "none") {
            try {
                const { readFile, writeFile, mkdir } = await import("node:fs/promises");
                const configPathLocal = join(homedir(), ".config", "piren", "config.yml");
                let existing = "";
                try {
                    existing = await readFile(configPathLocal, "utf8");
                }
                catch {
                    existing = "";
                }
                const installed = action === "install";
                const updated = updateServiceStatusYaml(existing, transport, { installed, running: installed });
                await mkdir(dirname(configPathLocal), { recursive: true });
                await writeFile(configPathLocal, updated, "utf8");
            }
            catch {
                // Non-fatal: the service files were written; config status is advisory.
            }
        }
        if (!report.ok)
            process.exit(1);
    }
    else if (command === "ask") {
        const message = positionals.join(" ");
        if (!message) {
            console.error("Ask requires a message. Usage: piren ask \"Hello, how are you?\"");
            process.exit(2);
        }
        const opts = bootstrapOptions(parsed);
        const runCommand = await buildPiRunCommand({ ...opts, rpcMode: true });
        await askAgent({ command: runCommand.command, args: runCommand.args, cwd: runCommand.cwd, env: runCommand.env }, message, (token) => process.stdout.write(token));
        console.log();
    }
    else if (command === "clean") {
        const report = await cleanPiren({
            force: parsed.force ?? false,
            configDir: join(homedir(), ".config", "piren"),
            stateDir: join(homedir(), ".local", "state", "piren"),
        });
        console.log(formatCleanReport(report));
        if (report.errors.length > 0)
            process.exit(1);
    }
    else if (command === "version") {
        // Resolve package.json relative to this module's location: from source
        // thisDir is <repo>/src, from compiled dist it is <repo>/dist/src. Either
        // way the package.json is two levels up.
        const packageJsonPath = join(thisDir, "..", "..", "package.json");
        console.log(readVersion(packageJsonPath));
    }
    else if (command === "update") {
        const report = await executePirenUpdate({ runCommand: runCommandWithArgs });
        console.log(formatUpdateReport(report));
        if (!report.ok)
            process.exit(1);
    }
    else if (command === "scheduler") {
        if (parsed.dryRun) {
            const output = await schedulerDryRun({});
            console.log(output);
        }
        else if (parsed.once) {
            const result = await schedulerOnce({
                executors: createSchedulerExecutors({
                    runner: createAskRunner(),
                }),
            });
            console.log(result.summary);
            if (!result.executed && result.noWork) {
                // No work is not an error; exit 0 so --once is safe to run in a
                // loop/cron without non-zero noise.
            }
        }
        else {
            // Bare `piren scheduler`: explicit opt-in loop around the S4 one-shot
            // primitive (ADR-0029 / O7 S5). Reads local scheduler config once at
            // startup, then calls schedulerOnce once per tick, sleeping between
            // ticks. Stops cleanly on SIGINT/SIGTERM without starting a new tick.
            // No scheduler polling is added to run/chat/worker/gateway/transports.
            const config = await readYamlConfig(DEFAULT_CONFIG_PATH);
            const schedulerConfig = resolveSchedulerConfig(config);
            const enabledAgents = resolveEnabledAgents(config);
            const executors = createSchedulerExecutors({ runner: createAskRunner() });
            const controller = createSchedulerLoopController();
            const sleep = createRealSchedulerLoopSleep();
            process.on("SIGINT", () => controller.requestShutdown("SIGINT"));
            process.on("SIGTERM", () => controller.requestShutdown("SIGTERM"));
            try {
                await runSchedulerLoop({
                    configPath: DEFAULT_CONFIG_PATH,
                    schedulerConfig,
                    enabledAgents,
                    schedulerOnce,
                    executors,
                    sleep,
                    controller,
                    log: (message) => console.log(message),
                });
            }
            finally {
                // Defense-in-depth: clear any pending sleep timer before exit.
                sleep.cancel();
            }
            process.exit(0);
        }
    }
    else if (command === "agent") {
        await runAgentCommand({
            subcommand: positionals[0],
            nameArg1: positionals[1],
            nameArg2: positionals[2],
            opts: bootstrapOptions(parsed),
            explicitVaultRoot: vaultRoot,
            force,
            yes,
        });
    }
    else if (command === "package") {
        await runPackageCommand({
            subcommand: positionals[0],
            agentName: positionals[1],
            opts: bootstrapOptions(parsed),
            explicitVaultRoot: vaultRoot,
            forceCliAgent: agentName,
        });
    }
    else if (command === "group") {
        await runGroupCommand({
            positionals,
            opts: bootstrapOptions(parsed),
            explicitVaultRoot: vaultRoot,
            force,
        });
    }
    else if (command === "cron") {
        await runCronCommand({
            positionals,
            opts: bootstrapOptions(parsed),
            explicitVaultRoot: vaultRoot,
            forceCliAgent: agentName,
            force,
        });
    }
    else if (command === "skill") {
        await runSkillCommand({
            positionals,
            opts: bootstrapOptions(parsed),
            explicitVaultRoot: vaultRoot,
            forceCliAgent: agentName,
            force,
        });
    }
    else if (command === "task") {
        await runTaskCommand({
            positionals,
            opts: bootstrapOptions(parsed),
            explicitVaultRoot: vaultRoot,
            forceCliAgent: agentName,
        });
    }
    else {
        const context = await loadPirenContext(bootstrapOptions(parsed));
        console.log(`Piren ${command}`);
        console.log(`agent_name: ${context.agentName}`);
        console.log(`agent_dir: ${context.agentDir}`);
        console.log(`vault_root: ${context.vaultRoot}`);
        console.log(`allowed_agents: ${context.allowedAgents.length ? context.allowedAgents.join(", ") : "<not set>"}`);
        console.log(`excluded_agents: ${context.excludedAgents.length ? context.excludedAgents.join(", ") : "<not set>"}`);
    }
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
async function runAgentCommand(args) {
    const { parse: parseYaml } = await import("yaml");
    const { readFile, writeFile, mkdir, access, rm, cp } = await import("node:fs/promises");
    const configPath = join(homedir(), ".config", "piren", "config.yml");
    // Resolve vault root: explicit --vault-root wins, else read from config.yml.
    let vaultRoot = args.explicitVaultRoot;
    let existingConfig = "";
    try {
        existingConfig = await readFile(configPath, "utf8");
    }
    catch {
        existingConfig = "";
    }
    if (!vaultRoot) {
        try {
            const parsed = parseYaml(existingConfig);
            const root = parsed?.vault_root;
            if (typeof root === "string" && root.trim() !== "")
                vaultRoot = root;
        }
        catch {
            // malformed config; ignore
        }
    }
    if (!vaultRoot) {
        console.error("Could not resolve vault root. Pass --vault-root or set vault_root in " + configPath + ".");
        process.exit(2);
    }
    const sub = args.subcommand;
    const piDefaultModel = await readPiDefaultModel(join(homedir(), ".pi", "agent"));
    const piDefaultAgentConfigContent = piDefaultModel ? buildAgentConfigYaml({ model: piDefaultModel }) : undefined;
    // Shared deps: real filesystem operations. scaffoldAgentDir reuses the
    // init.ts team-dir layout (inbox/outbox/devices/logs/sessions/skills + identity files).
    const deps = {
        exists: async (path) => {
            try {
                await access(path);
                return true;
            }
            catch {
                return false;
            }
        },
        scaffoldAgentDir: async (root, agentName) => {
            // Scaffold ONLY the new agent's team/ dir, not the whole vault. Using
            // initVault here would trip its "vault file already exists" guard when
            // adding a second agent to an existing vault.
            const result = await scaffoldAgentDirectory({
                vaultRoot: root,
                agentName,
                force: args.force,
                ...(piDefaultAgentConfigContent !== undefined ? { agentConfigContent: piDefaultAgentConfigContent } : {}),
            });
            return result.agentDir;
        },
        copyDir: async (src, dest) => {
            await cp(src, dest, { recursive: true });
        },
        removeDir: async (path) => {
            await rm(path, { recursive: true, force: true });
        },
        log: (message) => console.log(message),
    };
    if (sub === "list" || sub === undefined) {
        await printAgentList(vaultRoot, existingConfig);
        return;
    }
    if (sub === "add") {
        const name = args.nameArg1;
        if (!name) {
            console.error("Usage: piren agent add <name>");
            process.exit(2);
        }
        const nameCheck = validateAgentName(name);
        if (!nameCheck.ok) {
            console.error(nameCheck.message ?? "Invalid agent name.");
            process.exit(2);
        }
        const result = await executeAddAgent({
            vaultRoot,
            agentName: name,
            existingConfig,
            force: args.force,
            deps,
        });
        if (result.error) {
            console.error(result.error);
            process.exit(1);
        }
        console.log(`Added agent '${name}' at ${result.scaffoldedDir}.`);
        if (result.configUpdated) {
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, result.updatedConfig, "utf8");
            console.log(`Permitted '${name}' in ${configPath}.`);
        }
        else {
            console.log(`'${name}' was already permitted; no config change.`);
        }
        console.log("");
        console.log(`Next: piren --vault-root ${vaultRoot} --agent ${name} run`);
        return;
    }
    if (sub === "clone") {
        const source = args.nameArg1;
        const target = args.nameArg2;
        if (!source || !target) {
            console.error("Usage: piren agent clone <source> <name>");
            process.exit(2);
        }
        const targetCheck = validateAgentName(target);
        if (!targetCheck.ok) {
            console.error(targetCheck.message ?? "Invalid target agent name.");
            process.exit(2);
        }
        const result = await executeCloneAgent({
            vaultRoot,
            sourceAgent: source,
            targetAgent: target,
            existingConfig,
            deps,
        });
        if (result.error) {
            console.error(result.error);
            process.exit(1);
        }
        console.log(`Cloned '${source}' to '${target}' at ${result.targetDir}.`);
        if (result.configUpdated) {
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, result.updatedConfig, "utf8");
            console.log(`Permitted '${target}' in ${configPath}.`);
        }
        return;
    }
    if (sub === "remove") {
        const name = args.nameArg1;
        if (!name) {
            console.error("Usage: piren agent remove <name>");
            process.exit(2);
        }
        // Permission is ALWAYS dropped; the vault dir is deleted only after a
        // confirm prompt (or --yes to skip the prompt and confirm non-interactively).
        const dirPath = agentDirPath(vaultRoot, name);
        let confirmedDeleteDir = false;
        const dirExists = await deps.exists(dirPath);
        if (dirExists) {
            if (args.yes) {
                confirmedDeleteDir = true;
            }
            else {
                const prompt = new ReadlinePrompt();
                confirmedDeleteDir = await prompt.confirm(`Delete the agent directory ${dirPath} and all its contents? (Identity and memory will be lost.)`, false);
                prompt.close();
            }
        }
        const result = await executeRemoveAgent({
            vaultRoot,
            agentName: name,
            existingConfig,
            confirmedDeleteDir,
            deps,
        });
        if (result.configUpdated) {
            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, result.updatedConfig, "utf8");
            console.log(`Removed '${name}' from allowed_agents in ${configPath}.`);
        }
        else {
            console.log(`'${name}' was not in allowed_agents; no config change.`);
        }
        if (result.dirRemoved) {
            console.log(`Deleted vault directory ${dirPath}.`);
        }
        else if (dirExists && !confirmedDeleteDir) {
            console.log(`Vault directory left in place (not confirmed): ${dirPath}`);
            console.log("Re-run `piren agent remove " + name + "` and confirm to delete it.");
        }
        return;
    }
    console.error(`Unknown agent subcommand '${sub}'. Use: add, remove, clone, list.`);
    process.exit(2);
}
/** Render the agent list for `piren agent` / `piren agent list`. */
async function printAgentList(vaultRoot, existingConfig) {
    const { parse: parseYaml } = await import("yaml");
    const { join } = await import("node:path");
    const { readdir, access } = await import("node:fs/promises");
    let allowed = [];
    let excluded = [];
    try {
        const parsed = parseYaml(existingConfig);
        if (parsed && Array.isArray(parsed.allowed_agents)) {
            allowed = parsed.allowed_agents.filter((x) => typeof x === "string");
        }
        if (parsed && Array.isArray(parsed.excluded_agents)) {
            excluded = parsed.excluded_agents.filter((x) => typeof x === "string");
        }
    }
    catch {
        // ignore malformed config
    }
    console.log(`vault_root: ${vaultRoot}`);
    console.log("");
    console.log("Agents (vault team/ directories):");
    let vaultAgents = [];
    try {
        const teamDir = join(vaultRoot, "team");
        await access(teamDir);
        const entries = await readdir(teamDir, { withFileTypes: true });
        vaultAgents = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b));
    }
    catch {
        // team dir missing
    }
    if (vaultAgents.length === 0) {
        console.log("  <none> — add one with: piren agent add <name>");
    }
    else {
        for (const agent of vaultAgents) {
            const isAllowed = allowed.includes(agent);
            const isExcluded = excluded.includes(agent);
            const tag = isExcluded ? "[excluded]" : isAllowed ? "[allowed]" : "[vault-only]";
            console.log(`  ${tag} ${agent}`);
        }
    }
    console.log("");
    console.log(`allowed_agents: ${allowed.length ? allowed.join(", ") : "<not set>"}`);
}
async function realManifestReader(vaultRoot, relativePath) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
        return await readFile(join(vaultRoot, relativePath), "utf8");
    }
    catch {
        return null;
    }
}
/**
 * Read and parse a single manifest file from the vault. Returns null when
 * the file does not exist or cannot be parsed as a manifest.
 */
async function readManifest(vaultRoot, relativePath, reader) {
    const content = await reader(vaultRoot, relativePath);
    if (content === null)
        return null;
    let source;
    if (relativePath === "packages.yml") {
        source = { kind: "shared" };
    }
    else if (relativePath.startsWith("agent-groups/") && relativePath.endsWith("/packages.yml")) {
        const group = relativePath.slice("agent-groups/".length, -("/packages.yml".length));
        source = { kind: "group", group };
    }
    else if (relativePath.startsWith("team/") && relativePath.endsWith("/packages.yml")) {
        const agent = relativePath.slice("team/".length, -("/packages.yml".length));
        source = { kind: "agent", agent };
    }
    else {
        return null;
    }
    const manifest = parsePackageManifest(content);
    return { source, manifest };
}
/**
 * Resolve effective packages for an agent by reading vault manifests.
 */
async function resolveEffectiveForAgent(vaultRoot, agentName, reader) {
    const manifestEntries = [];
    // 1. Shared manifest
    const shared = await readManifest(vaultRoot, "packages.yml", reader);
    if (shared)
        manifestEntries.push(shared);
    // 2. Group manifests (the agent might belong to multiple groups)
    let groups = [];
    try {
        groups = await resolveAgentGroups(vaultRoot, agentName);
    }
    catch {
        // No groups or unparseable config — skip group manifests.
    }
    for (const group of groups) {
        const groupManifest = await readManifest(vaultRoot, `agent-groups/${group}/packages.yml`, reader);
        if (groupManifest)
            manifestEntries.push(groupManifest);
    }
    // 3. Agent manifest
    const agentManifest = await readManifest(vaultRoot, `team/${agentName}/packages.yml`, reader);
    if (agentManifest)
        manifestEntries.push(agentManifest);
    return mergeEffectivePackages(manifestEntries);
}
async function runPackageCommand(args) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { parse: parseYaml } = await import("yaml");
    const sub = args.subcommand;
    if (!sub || !["list", "explain", "doctor"].includes(sub)) {
        console.error("Usage: piren package <list|explain|doctor> [--agent <agent>]");
        process.exit(2);
    }
    // Resolve vault root from explicit flag or local config.
    const configPath = join(homedir(), ".config", "piren", "config.yml");
    let existingConfig = "";
    try {
        existingConfig = await readFile(configPath, "utf8");
    }
    catch {
        existingConfig = "";
    }
    let vaultRoot = args.explicitVaultRoot;
    if (!vaultRoot) {
        try {
            const parsedCfg = parseYaml(existingConfig);
            const root = parsedCfg?.vault_root;
            if (typeof root === "string" && root.trim() !== "")
                vaultRoot = root;
        }
        catch {
            // Ignore malformed config.
        }
    }
    if (!vaultRoot) {
        console.error("Could not resolve vault root. Pass --vault-root or set vault_root in " + configPath + ".");
        process.exit(2);
    }
    // Resolve agent: explicit positionals[1] (after subcommand) beats --agent flag.
    let targetAgent = args.agentName ?? args.forceCliAgent;
    // For list and explain, agent is required.
    if ((sub === "list" || sub === "explain") && !targetAgent) {
        console.error(`piren package ${sub} requires an agent. Usage: piren package ${sub} --agent <agent>`);
        process.exit(2);
    }
    // For doctor without an explicit agent, list all agents in the vault.
    if (sub === "doctor" && !targetAgent) {
        const { readdir: readdirFs, access: accessFs } = await import("node:fs/promises");
        const teamDir = join(vaultRoot, "team");
        let agentNames = [];
        try {
            await accessFs(teamDir);
            const entries = await readdirFs(teamDir, { withFileTypes: true });
            agentNames = entries
                .filter((e) => e.isDirectory() && !e.name.startsWith("."))
                .map((e) => e.name)
                .sort();
        }
        catch {
            // No team dir.
        }
        if (agentNames.length === 0) {
            console.log("No agents found in vault. Doctor requires at least one agent.");
            process.exit(2);
        }
        // Run doctor for all agents
        const reader = realManifestReader;
        const localPackages = parseLocalPackagesFromConfig(existingConfig, parseYaml);
        const blockedPackages = parseBlockedPackagesFromConfig(existingConfig, parseYaml);
        let anyIssues = false;
        for (const agentName of agentNames) {
            const output = await formatAgentPackageDoctor(vaultRoot, agentName, localPackages, reader, blockedPackages);
            console.log(output);
            console.log("");
            if (output.includes("MISSING-FROM-LOCAL-CONFIG") || output.includes("DECLARED-BUT-NOT-INSTALLED") || output.includes("RECOMMENDED-MISSING") || output.includes("BLOCKED-BY-POLICY")) {
                anyIssues = true;
            }
        }
        if (anyIssues)
            process.exit(1);
        return;
    }
    if (!targetAgent) {
        console.error("No agent specified. Pass --agent or use `piren package doctor` to run for all agents.");
        process.exit(2);
    }
    const reader = realManifestReader;
    if (sub === "list") {
        const effective = await resolveEffectiveForAgent(vaultRoot, targetAgent, reader);
        console.log(formatPackageList(effective, targetAgent));
    }
    else if (sub === "explain") {
        const effective = await resolveEffectiveForAgent(vaultRoot, targetAgent, reader);
        console.log(formatPackageExplain(effective, targetAgent));
    }
    else if (sub === "doctor") {
        const localPackages = parseLocalPackagesFromConfig(existingConfig, parseYaml);
        const blockedPackages = parseBlockedPackagesFromConfig(existingConfig, parseYaml);
        const output = await formatAgentPackageDoctor(vaultRoot, targetAgent, localPackages, reader, blockedPackages);
        console.log(output);
        // Exit non-zero if there are issues
        if (output.includes("MISSING-FROM-LOCAL-CONFIG") || output.includes("DECLARED-BUT-NOT-INSTALLED") || output.includes("RECOMMENDED-MISSING") || output.includes("BLOCKED-BY-POLICY")) {
            process.exit(1);
        }
    }
}
function parseLocalPackagesFromConfig(existingConfig, parseYaml) {
    try {
        const parsed = parseYaml(existingConfig);
        if (parsed && Array.isArray(parsed.packages)) {
            return parsed.packages.filter((x) => typeof x === "string");
        }
    }
    catch {
        // ignore
    }
    return [];
}
/**
 * Read the `package_policy.blocked` list from local config.
 * This is a read-only policy field; the CLI never mutates it or applies it.
 */
function parseBlockedPackagesFromConfig(existingConfig, parseYaml) {
    try {
        const parsed = parseYaml(existingConfig);
        if (!parsed)
            return [];
        const policy = parsed.package_policy;
        if (policy && typeof policy === "object" && !Array.isArray(policy)) {
            const blocked = policy.blocked;
            if (Array.isArray(blocked)) {
                return blocked.filter((x) => typeof x === "string");
            }
        }
    }
    catch {
        // ignore
    }
    return [];
}
async function formatAgentPackageDoctor(vaultRoot, targetAgent, localPackages, reader, blockedPackages) {
    const effective = await resolveEffectiveForAgent(vaultRoot, targetAgent, reader);
    const { createRequire } = await import("node:module");
    const nodeRequire = createRequire(import.meta.url);
    const diagnosed = diagnosePackages(effective, localPackages, (name) => {
        try {
            nodeRequire.resolve(name);
            return true;
        }
        catch {
            return false;
        }
    }, blockedPackages);
    return formatPackageDoctor(diagnosed, targetAgent);
}
/**
 * Dispatch `piren group <list|show|create|add-agent|remove-agent|fallback set|validate>`.
 *
 * Group configs are vault-owned (`agent-groups/<group>/config.yml`); this
 * command never mutates local `~/.config/piren/config.yml`. All mutations go
 * through the pure core in `src/group-config.ts`, which writes files identical
 * in structure to hand-written ones so `parseGroupConfigs`, `piren agents`,
 * and `piren doctor` observe them unchanged.
 */
async function runGroupCommand(args) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { parse: parseYaml } = await import("yaml");
    const sub = args.positionals[0];
    // Resolve vault root from explicit flag or local config.
    const configPath = join(homedir(), ".config", "piren", "config.yml");
    let existingConfig = "";
    try {
        existingConfig = await readFile(configPath, "utf8");
    }
    catch {
        existingConfig = "";
    }
    let vaultRoot = args.explicitVaultRoot;
    if (!vaultRoot) {
        try {
            const parsedCfg = parseYaml(existingConfig);
            const root = parsedCfg?.vault_root;
            if (typeof root === "string" && root.trim() !== "")
                vaultRoot = root;
        }
        catch {
            // Ignore malformed config.
        }
    }
    if (!vaultRoot) {
        console.error("Could not resolve vault root. Pass --vault-root or set vault_root in " + configPath + ".");
        process.exit(2);
    }
    const deps = createRealGroupWriteDeps();
    // `fallback set` is a two-word subcommand: handle it before the switch so
    // the positional offsets line up (group = positionals[2], agent = [3],
    // candidates = positionals.slice(4)).
    if (sub === "fallback") {
        const action = args.positionals[1];
        if (action !== "set") {
            console.error("Usage: piren group fallback set <group> <agent> <candidate...>");
            process.exit(2);
        }
        const group = args.positionals[2];
        const agent = args.positionals[3];
        const candidates = args.positionals.slice(4);
        if (!group || !agent) {
            console.error("Usage: piren group fallback set <group> <agent> <candidate...>");
            process.exit(2);
        }
        await setFallbackOrder(deps, vaultRoot, group, agent, candidates);
        console.log(`Set fallback order for '${agent}' in group '${group}': ${candidates.length > 0 ? candidates.join(", ") : "<empty>"}.`);
        return;
    }
    switch (sub) {
        case "list": {
            // Reuse the existing read-only parser so `list` observes exactly what
            // `piren agents` and `piren doctor` observe (acceptance criterion #8).
            const groups = await parseGroupConfigs(vaultRoot);
            const entries = [...groups.entries()].map(([name, config]) => ({ name, config }));
            console.log(formatGroupList(entries));
            return;
        }
        case "show": {
            const group = args.positionals[1];
            if (!group) {
                console.error("Usage: piren group show <group>");
                process.exit(2);
            }
            const config = await readGroupConfig(deps, vaultRoot, group);
            if (config === null) {
                console.error(`Agent group '${group}' does not exist.`);
                process.exit(1);
            }
            console.log(formatGroupConfig(group, config));
            return;
        }
        case "create": {
            const group = args.positionals[1];
            if (!group) {
                console.error("Usage: piren group create <group> [--force]");
                process.exit(2);
            }
            await createGroup(deps, vaultRoot, group, { force: args.force });
            console.log(`Created group '${group}' at ${join(vaultRoot, "agent-groups", group)}.`);
            return;
        }
        case "add-agent": {
            const group = args.positionals[1];
            const agent = args.positionals[2];
            if (!group || !agent) {
                console.error("Usage: piren group add-agent <group> <agent>");
                process.exit(2);
            }
            const result = await addAgentToGroup(deps, vaultRoot, group, agent);
            if (result.added) {
                console.log(`Added '${agent}' to group '${group}'.`);
            }
            else {
                console.log(`Agent '${agent}' is already a member of group '${group}' (no change).`);
            }
            return;
        }
        case "remove-agent": {
            const group = args.positionals[1];
            const agent = args.positionals[2];
            if (!group || !agent) {
                console.error("Usage: piren group remove-agent <group> <agent>");
                process.exit(2);
            }
            const result = await removeAgentFromGroup(deps, vaultRoot, group, agent);
            if (result.removed) {
                console.log(`Removed '${agent}' from group '${group}'.`);
            }
            else {
                console.log(`Agent '${agent}' was not a member of group '${group}' (no change).`);
            }
            return;
        }
        case "validate": {
            const issues = await validateGroups(deps, vaultRoot);
            console.log(formatValidationReport(issues));
            if (issues.some((i) => i.severity === "error"))
                process.exit(1);
            return;
        }
        default: {
            console.error(`Unknown group subcommand '${sub ?? ""}'. Usage: piren group <list|show|create|add-agent|remove-agent|fallback set|validate>`);
            process.exit(2);
        }
    }
}
async function runCronCommand(args) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { parse: parseYaml } = await import("yaml");
    const sub = args.positionals[0];
    const configPath = join(homedir(), ".config", "piren", "config.yml");
    let existingConfig = "";
    try {
        existingConfig = await readFile(configPath, "utf8");
    }
    catch {
        existingConfig = "";
    }
    let vaultRoot = args.explicitVaultRoot;
    if (!vaultRoot) {
        try {
            const parsedCfg = parseYaml(existingConfig);
            const root = parsedCfg?.vault_root;
            if (typeof root === "string" && root.trim() !== "")
                vaultRoot = root;
        }
        catch {
            // Ignore malformed config.
        }
    }
    if (!vaultRoot) {
        console.error("Could not resolve vault root. Pass --vault-root or set vault_root in " + configPath + ".");
        process.exit(2);
    }
    const deps = createRealCronWriteDeps();
    const opts = args.opts;
    let agent = args.forceCliAgent ?? opts.cliAgent;
    if (sub === "list") {
        if (!agent) {
            // Resolve agent from config or environment.
            agent = opts.env?.PIREN_AGENT ?? "";
            if (!agent) {
                console.error("No agent specified. Pass --agent or set PIREN_AGENT.");
                process.exit(2);
            }
        }
        const { listCronJobs } = await import("./cron.js");
        const result = await listCronJobs({ vaultRoot, agentName: agent });
        console.log(formatCronList(result.jobs));
        return;
    }
    if (sub === "show") {
        const idOrPath = args.positionals[1];
        if (!idOrPath) {
            console.error("Usage: piren cron show <id-or-path>");
            process.exit(2);
        }
        const job = await readCronJobFile(deps, vaultRoot, idOrPath);
        console.log(formatCronShow(job));
        return;
    }
    if (sub === "create" || sub === "create-script") {
        const id = args.positionals[1];
        if (!id) {
            console.error("Usage: piren cron " + sub + " <id> --agent <agent> --schedule <expr>");
            process.exit(2);
        }
        if (!agent) {
            console.error("piren cron " + sub + " requires --agent <agent>.");
            process.exit(2);
        }
        // Read --schedule from positionals or from flags. The parser doesn't have
        // --schedule / --body / --script flags, so we parse them from the raw argv.
        const rawArgv = process.argv.slice(2);
        function findFlagValue(flag) {
            const idx = rawArgv.indexOf(flag);
            if (idx === -1)
                return undefined;
            return rawArgv[idx + 1];
        }
        const schedule = findFlagValue("--schedule");
        if (!schedule) {
            console.error("piren cron " + sub + " requires --schedule <expr>.");
            process.exit(2);
        }
        if (sub === "create-script") {
            const script = findFlagValue("--script");
            if (!script) {
                console.error("piren cron create-script requires --script <vault-path>.");
                process.exit(2);
            }
            await createScriptCronJob(deps, vaultRoot, id, agent, schedule, script, { force: args.force });
            console.log("Created script-mode cron job '" + id + "' for agent '" + agent + "'.");
        }
        else {
            const bodyFile = findFlagValue("--body");
            let bodyPath;
            if (bodyFile !== undefined) {
                bodyPath = join(vaultRoot, bodyFile);
            }
            await createCronJob(deps, vaultRoot, id, agent, schedule, bodyPath, { force: args.force });
            console.log("Created cron job '" + id + "' for agent '" + agent + "'.");
        }
        return;
    }
    if (sub === "enable" || sub === "disable") {
        const idOrPath = args.positionals[1];
        if (!idOrPath) {
            console.error("Usage: piren cron " + sub + " <id-or-path>");
            process.exit(2);
        }
        if (sub === "enable") {
            await enableCronJob(deps, vaultRoot, idOrPath);
            console.log("Enabled cron job '" + idOrPath + "'.");
        }
        else {
            await disableCronJob(deps, vaultRoot, idOrPath);
            console.log("Disabled cron job '" + idOrPath + "'.");
        }
        return;
    }
    if (sub === "runs") {
        if (!agent) {
            agent = opts.env?.PIREN_AGENT ?? "";
            if (!agent) {
                console.error("No agent specified. Pass --agent or set PIREN_AGENT.");
                process.exit(2);
            }
        }
        const jobId = args.positionals[1];
        const { listCronRuns } = await import("./cron.js");
        const result = await listCronRuns({ vaultRoot, agentName: agent, ...(jobId !== undefined ? { jobId } : {}) });
        console.log(formatCronRuns(result.runs));
        return;
    }
    if (sub === "validate") {
        const issues = await validateCronJobs(deps, vaultRoot);
        console.log(formatCronValidationReport(issues));
        if (issues.some((i) => i.severity === "error"))
            process.exit(1);
        return;
    }
    // Unknown subcommand
    console.error("Usage: piren cron <list|show|create|create-script|enable|disable|runs|validate> [args]");
    process.exit(2);
}
// ---------------------------------------------------------------------------
// Service lifecycle helpers (shell probes + command runner)
// ---------------------------------------------------------------------------
/** Run a command and resolve true if it exits 0 within 5s. Used for detection. */
function commandAvailable(command, args) {
    return new Promise((resolvePromise) => {
        execFile(command, args, { timeout: 5000 }, (error) => {
            resolvePromise(!error);
        });
    });
}
/**
 * Detect whether cron is installed by invoking `crontab -l`. Unlike
 * `commandAvailable`, this routes the raw exit code + signal through
 * `crontabAvailableFromInvocation`, because vixie cron / Debian's `cron` exit 1
 * when the user has no crontab yet. A bare `exit 0` check would read that as
 * "cron not installed" and break DietPi / stripped-down systems into the "none"
 * path instead of the intended tmux-cron fallback.
 */
function crontabInstalled() {
    return new Promise((resolvePromise) => {
        execFile("crontab", ["-l"], { timeout: 5000 }, (error, _stdout, _stderr) => {
            // No error means exit 0 (a crontab exists). On a non-zero exit, execFile
            // yields an error whose .code is the numeric exit code for a command that
            // ran but failed; ENOENT (string) means the binary itself is missing.
            if (!error) {
                resolvePromise(crontabAvailableFromInvocation({ exitCode: 0, signal: null }));
                return;
            }
            const code = typeof error.code === "number" ? error.code : null;
            const signal = error.signal ?? null;
            resolvePromise(crontabAvailableFromInvocation({ exitCode: code, signal }));
        });
    });
}
/**
 * Detect whether the systemd user session can run Piren services by invoking
 * `systemctl --user is-system-running`. Unlike `commandAvailable`, this routes
 * the raw exit code + signal through `systemdUserAvailableFromInvocation`,
 * because `is-system-running` exits 1 when the session is "degraded",
 * "starting", or "maintenance" - all of which still run user services fine.
 * A bare `exit 0` check read "degraded" as "systemd not available" and broke
 * `piren service install` on otherwise healthy homelab machines.
 */
function systemdUserInstalled() {
    return new Promise((resolvePromise) => {
        execFile("systemctl", ["--user", "is-system-running"], { timeout: 5000 }, (error, stdout, stderr) => {
            if (!error) {
                resolvePromise(systemdUserAvailableFromInvocation({ exitCode: 0, signal: null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
                return;
            }
            const code = typeof error.code === "number" ? error.code : null;
            const signal = error.signal ?? null;
            resolvePromise(systemdUserAvailableFromInvocation({ exitCode: code, signal, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        });
    });
}
/** Run a shell command string and return its exit code and captured output. */
function runShell(command) {
    return new Promise((resolvePromise) => {
        execFile("sh", ["-c", command], { timeout: 30000 }, (error, stdout, stderr) => {
            const exitCode = error ? (error.errno === undefined ? 1 : -1) : 0;
            // execFile sets exitCode via the error's `code` for non-zero exits; normalize.
            const normalizedExit = error && typeof error.code === "number" ? error.code : exitCode;
            resolvePromise({ exitCode: normalizedExit < 0 ? 1 : normalizedExit, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
}
/** Run a command without shell interpolation. Used by `piren update`. */
function runCommandWithArgs(command, args) {
    return new Promise((resolvePromise) => {
        execFile(command, args, { timeout: 120000 }, (error, stdout, stderr) => {
            const fallbackExit = error ? 1 : 0;
            const exitCode = error && typeof error.code === "number" ? error.code : fallbackExit;
            resolvePromise({ exitCode, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    });
}
async function runSkillCommand(args) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { parse: parseYaml } = await import("yaml");
    const sub = args.positionals[0];
    // Resolve vault root from explicit flag or local config.
    const configPath = join(homedir(), ".config", "piren", "config.yml");
    let existingConfig = "";
    try {
        existingConfig = await readFile(configPath, "utf8");
    }
    catch {
        existingConfig = "";
    }
    let vaultRoot = args.explicitVaultRoot;
    if (!vaultRoot) {
        try {
            const parsedCfg = parseYaml(existingConfig);
            const root = parsedCfg?.vault_root;
            if (typeof root === "string" && root.trim() !== "")
                vaultRoot = root;
        }
        catch {
            // Ignore malformed config.
        }
    }
    if (!vaultRoot) {
        console.error("Could not resolve vault root. Pass --vault-root or set vault_root in " + configPath + ".");
        process.exit(2);
    }
    const deps = createRealSkillCliDeps();
    let agent = args.forceCliAgent ?? args.opts.cliAgent;
    // Read additional flags from raw argv for --scope, --from, --to, --group.
    const rawArgv = process.argv.slice(2);
    function findRawFlag(flag) {
        const idx = rawArgv.indexOf(flag);
        if (idx === -1)
            return undefined;
        return rawArgv[idx + 1];
    }
    if (sub === "list") {
        const scopeRaw = findRawFlag("--scope");
        const groupFilter = findRawFlag("--group");
        const agentFilter = agent ?? findRawFlag("--agent");
        const all = await scanAllSkills(deps, vaultRoot);
        const opts = {};
        if (agentFilter !== undefined)
            opts.agent = agentFilter;
        if (groupFilter !== undefined)
            opts.group = groupFilter;
        if (scopeRaw !== undefined) {
            if (scopeRaw === "shared")
                opts.scope = "shared";
            else if (scopeRaw === "group")
                opts.scope = "group";
            else if (scopeRaw === "agent")
                opts.scope = "agent";
        }
        const filtered = await filterSkills(deps, vaultRoot, all, opts);
        console.log(formatSkillList(filtered));
        return;
    }
    if (sub === "show") {
        const name = args.positionals[1];
        if (!name) {
            console.error("Usage: piren skill show <name> [--agent <agent>]");
            process.exit(2);
        }
        const result = await showSkill(deps, vaultRoot, name, agent);
        if (result === null) {
            console.error(`Skill '${name}' not found.`);
            process.exit(1);
        }
        console.log(formatSkillShow(result));
        return;
    }
    if (sub === "explain") {
        const name = args.positionals[1];
        if (!name || !agent) {
            console.error("Usage: piren skill explain <name> --agent <agent>");
            process.exit(2);
        }
        const result = await explainSkill(deps, vaultRoot, name, agent);
        if (result === null) {
            console.error(`Skill '${name}' not found.`);
            process.exit(1);
        }
        console.log(formatSkillExplain(result));
        return;
    }
    if (sub === "create") {
        const name = args.positionals[1];
        const scopeRaw = findRawFlag("--scope");
        if (!name || !scopeRaw) {
            console.error("Usage: piren skill create <name> --scope shared|group:<group>|agent:<agent> [--force]");
            process.exit(2);
        }
        const scope = parseScope(scopeRaw);
        if (scope === null) {
            console.error(`Invalid scope: ${scopeRaw}. Use shared, group:<name>, or agent:<name>.`);
            process.exit(2);
        }
        await createSkill(deps, vaultRoot, name, scope, { force: args.force });
        console.log(`Created skill '${name}' at ${formatScope(scope)}.`);
        return;
    }
    if (sub === "move") {
        const name = args.positionals[1];
        const fromRaw = findRawFlag("--from");
        const toRaw = findRawFlag("--to");
        if (!name || !fromRaw || !toRaw) {
            console.error("Usage: piren skill move <name> --from <scope> --to <scope> [--force]");
            process.exit(2);
        }
        const from = parseScope(fromRaw);
        const to = parseScope(toRaw);
        if (from === null) {
            console.error(`Invalid --from scope: ${fromRaw}.`);
            process.exit(2);
        }
        if (to === null) {
            console.error(`Invalid --to scope: ${toRaw}.`);
            process.exit(2);
        }
        const result = await moveSkill(deps, vaultRoot, name, from, to, { force: args.force });
        console.log(`Moved skill '${name}' from ${result.fromPath} to ${result.toPath}.`);
        return;
    }
    if (sub === "promote") {
        const name = args.positionals[1];
        const fromRaw = findRawFlag("--from");
        const toRaw = findRawFlag("--to");
        if (!name || !fromRaw || !toRaw) {
            console.error("Usage: piren skill promote <name> --from agent:<agent> --to shared|group:<group> [--force]");
            process.exit(2);
        }
        const from = parseScope(fromRaw);
        const to = parseScope(toRaw);
        if (from === null || from.kind !== "agent" || from.agent === undefined) {
            console.error(`Invalid --from scope: ${fromRaw}. Must be agent:<agent>.`);
            process.exit(2);
        }
        if (to === null || (to.kind !== "shared" && to.kind !== "group")) {
            console.error(`Invalid --to scope: ${toRaw}. Must be shared or group:<group>.`);
            process.exit(2);
        }
        const toTarget = to.kind === "shared" ? "shared" : { kind: "group", group: to.group };
        const result = await promoteSkill(deps, vaultRoot, name, from.agent, toTarget, { force: args.force });
        console.log(`Promoted skill '${name}' from ${result.fromPath} to ${result.toPath}.`);
        return;
    }
    if (sub === "demote") {
        const name = args.positionals[1];
        const fromRaw = findRawFlag("--from");
        const toRaw = findRawFlag("--to");
        if (!name || !fromRaw || !toRaw) {
            console.error("Usage: piren skill demote <name> --from shared|group:<group> --to agent:<agent> [--force]");
            process.exit(2);
        }
        const from = parseScope(fromRaw);
        const to = parseScope(toRaw);
        if (from === null || (from.kind !== "shared" && from.kind !== "group")) {
            console.error(`Invalid --from scope: ${fromRaw}. Must be shared or group:<group>.`);
            process.exit(2);
        }
        if (to === null || to.kind !== "agent" || to.agent === undefined) {
            console.error(`Invalid --to scope: ${toRaw}. Must be agent:<agent>.`);
            process.exit(2);
        }
        const fromTarget = from.kind === "shared" ? "shared" : { kind: "group", group: from.group };
        const result = await demoteSkill(deps, vaultRoot, name, fromTarget, to.agent, { force: args.force });
        console.log(`Demoted skill '${name}' from ${result.fromPath} to ${result.toPath}.`);
        return;
    }
    if (sub === "conflicts") {
        const conflicts = await listConflicts(deps, vaultRoot, agent);
        console.log(formatSkillConflicts(conflicts));
        if (conflicts.length > 0)
            process.exit(1);
        return;
    }
    if (sub === "validate") {
        const issues = await validateSkills(deps, vaultRoot);
        console.log(formatSkillValidation(issues));
        if (issues.length > 0)
            process.exit(1);
        return;
    }
    // Unknown subcommand
    console.error("Usage: piren skill <list|show|explain|create|move|promote|demote|conflicts|validate> [args]");
    process.exit(2);
}
async function runTaskCommand(args) {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { hostname } = await import("node:os");
    const { parse: parseYaml } = await import("yaml");
    const sub = args.positionals[0];
    // Resolve vault root from explicit flag or local config (same as cron/skill).
    const configPath = join(homedir(), ".config", "piren", "config.yml");
    let existingConfig = "";
    try {
        existingConfig = await readFile(configPath, "utf8");
    }
    catch {
        existingConfig = "";
    }
    let vaultRoot = args.explicitVaultRoot;
    if (!vaultRoot) {
        try {
            const parsedCfg = parseYaml(existingConfig);
            const root = parsedCfg?.vault_root;
            if (typeof root === "string" && root.trim() !== "")
                vaultRoot = root;
        }
        catch {
            // Ignore malformed config.
        }
    }
    if (!vaultRoot) {
        console.error("Could not resolve vault root. Pass --vault-root or set vault_root in " + configPath + ".");
        process.exit(2);
    }
    const deps = createRealTaskCliDeps();
    const opts = args.opts;
    const cliAgent = args.forceCliAgent ?? opts.cliAgent;
    // Read additional flags from raw argv for --body/--result/--device/--priority.
    // The parser does not know these flags, so their values would otherwise leak
    // into positionals; we read them authoritatively here instead.
    const rawArgv = process.argv.slice(2);
    function findFlagValue(flag) {
        const idx = rawArgv.indexOf(flag);
        if (idx === -1)
            return undefined;
        return rawArgv[idx + 1];
    }
    if (sub === "list") {
        const agent = cliAgent ?? opts.env?.PIREN_AGENT;
        if (!agent) {
            console.error("No agent specified. Pass --agent or set PIREN_AGENT.");
            process.exit(2);
        }
        const result = await listInboxTasks({ vaultRoot, agentName: agent });
        const rows = result.tasks.map((task) => ({
            id: task.id,
            path: task.path,
            title: task.title,
            from: task.from,
            to: task.to,
            status: task.status,
            priority: "normal",
            created: task.created,
            updated: task.updated,
        }));
        console.log(formatTaskList(rows));
        return;
    }
    if (sub === "send") {
        const to = args.positionals[1];
        const title = args.positionals[2];
        if (!to || !title) {
            console.error("Usage: piren task send <agent> <title> [--body <vault-file>] [--priority normal|high|urgent]");
            process.exit(2);
        }
        const priorityRaw = findFlagValue("--priority");
        let priority = "normal";
        if (priorityRaw !== undefined) {
            if (!isValidCliPriority(priorityRaw)) {
                console.error(`Invalid --priority '${priorityRaw}'. Use one of: ${CLI_PRIORITIES.join(", ")}.`);
                process.exit(2);
            }
            priority = priorityRaw;
        }
        const bodyFile = findFlagValue("--body");
        let body = "";
        if (bodyFile !== undefined) {
            body = await readVaultFile(deps, vaultRoot, bodyFile);
        }
        // Default sender attribution for human-issued CLI tasks. The steward is
        // the human operator; createInboxTask only requires the recipient agent
        // directory to exist, so this does not require a team/steward/ directory.
        const result = await createInboxTask({
            vaultRoot,
            from: "steward",
            to,
            title,
            body,
            priority,
        });
        console.log(`Created task ${result.path} (id: ${result.taskId}).`);
        return;
    }
    if (sub === "show") {
        const input = args.positionals[1];
        if (!input) {
            console.error("Usage: piren task show <path-or-id> [--agent <agent>]");
            process.exit(2);
        }
        const resolved = await resolveTaskIdOrPath(deps, vaultRoot, input, cliAgent);
        const detail = await readTaskDetail(deps, vaultRoot, resolved.path);
        console.log(formatTaskDetail(detail));
        return;
    }
    if (sub === "claim") {
        const input = args.positionals[1];
        if (!input) {
            console.error("Usage: piren task claim <path> [--device <id>] [--agent <agent>]");
            process.exit(2);
        }
        const resolved = await resolveTaskIdOrPath(deps, vaultRoot, input, cliAgent);
        if (cliAgent !== undefined && cliAgent !== resolved.agentName) {
            console.error(`Task belongs to agent '${resolved.agentName}', not '${cliAgent}'.`);
            process.exit(2);
        }
        const deviceRaw = findFlagValue("--device");
        const deviceId = deviceRaw ?? sanitizeDeviceId(hostname());
        const result = await claimInboxTask({
            vaultRoot,
            agentName: resolved.agentName,
            taskPath: resolved.path,
            deviceId,
        });
        console.log(`Claimed task ${result.originalPath} -> ${result.path} for device '${result.deviceId}'.`);
        return;
    }
    if (sub === "complete" || sub === "cancel") {
        const input = args.positionals[1];
        if (!input) {
            console.error(`Usage: piren task ${sub} <path-or-id> [--result <vault-file>] [--agent <agent>]`);
            process.exit(2);
        }
        const resolved = await resolveTaskIdOrPath(deps, vaultRoot, input, cliAgent);
        if (cliAgent !== undefined && cliAgent !== resolved.agentName) {
            console.error(`Task belongs to agent '${resolved.agentName}', not '${cliAgent}'.`);
            process.exit(2);
        }
        const status = sub === "complete" ? "completed" : "cancelled";
        const resultFile = findFlagValue("--result");
        const resultContent = resultFile !== undefined ? await readVaultFile(deps, vaultRoot, resultFile) : undefined;
        const result = await updateInboxTaskStatus({
            vaultRoot,
            taskPath: resolved.path,
            status,
            ...(resultContent !== undefined ? { result: resultContent } : {}),
        });
        console.log(`Marked task ${result.path} as ${result.status}.`);
        return;
    }
    // Unknown subcommand
    console.error("Usage: piren task <list|send|show|claim|complete|cancel> [args]");
    process.exit(2);
}
//# sourceMappingURL=cli.js.map