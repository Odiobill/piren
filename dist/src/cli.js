#!/usr/bin/env node
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initVault } from "./init.js";
import { spawnPiRun, buildPiRunCommand } from "./run.js";
import { formatSetupReport, setupPiren } from "./setup.js";
import { GatewayServer } from "./gateway-http.js";
import { TelegramBotApiHttpClient, TelegramTransport, runTelegramPolling } from "./telegram-transport.js";
import { DiscordBotApiHttpClient, DiscordTransport, runDiscordGateway, createNativeDiscordGatewaySocket } from "./discord-transport.js";
import { PiRpcClient } from "./gateway-rpc.js";
import { askAgent } from "./ask.js";
import { cleanPiren, formatCleanReport } from "./clean.js";
import { readVersion } from "./version.js";
import { resolveGatewayToken, assertAuthGate, isLocalhostBind, defaultTokenFilePath } from "./gateway-auth.js";
import { parseArgs, bootstrapOptions, KNOWN_COMMANDS, } from "./parse-args.js";
import { loadPirenContext } from "./bootstrap.js";
import { formatAgentsReport, listPirenAgents } from "./agents.js";
import { doctorPiren, formatDoctorReport } from "./doctor.js";
const thisDir = dirname(fileURLToPath(import.meta.url));
// Resolve the public directory (frontend static files) relative to this
// module's location. From source: src/ -> ../public. From compiled dist:
// dist/src/ -> ../public = dist/public. The build script copies public/
// to dist/public/ so the path works in both environments.
function resolvePublicDir() {
    return join(thisDir, "..", "public");
}
const parsed = parseArgs(process.argv.slice(2));
const { agentDir, agentName, command, force, vaultRoot, piArgs, port, host, token, positionals } = parsed;
if (!KNOWN_COMMANDS.includes(command)) {
    console.error("Usage: piren [init|status|agents|doctor|setup|run|worker|gateway|web|telegram|discord|ask|clean|version] [--vault-root /path/to/vault] [--agent thor] [--agent-dir /path/to/vault/team/agent] [--port 7317] [--host 127.0.0.1] [--force] [-- pi-args...]");
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
        const report = await listPirenAgents(bootstrapOptions(parsed));
        console.log(formatAgentsReport(report));
    }
    else if (command === "setup") {
        const report = await setupPiren({ ...bootstrapOptions(parsed), apply: parsed.apply });
        console.log(formatSetupReport(report));
        if (report.checks.some((check) => check.status === "fail"))
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
//# sourceMappingURL=cli.js.map