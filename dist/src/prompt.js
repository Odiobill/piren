/**
 * Readline-based interactive prompt for the setup wizard.
 *
 * Thin, injectable adapter. The wizard runner takes a `WizardPrompt` interface
 * so tests drive it with a fake prompter and the real readline implementation
 * is only used by the CLI.
 *
 * Lines are buffered through a persistent `line` listener instead of
 * sequential `rl.question()` calls: when stdin is piped, a whole script of
 * answers can arrive in a single chunk, and `rl.question()` would drop every
 * line after the first (its one-shot listener is only attached while a
 * question is pending). Buffering keeps interactive TTY behavior identical
 * while making scripted/non-TTY input work.
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
export class ReadlinePrompt {
    rl;
    buffer = [];
    waiters = [];
    open = true;
    constructor(rl) {
        this.rl = rl ?? createInterface({ input, output, terminal: false });
        this.rl.on("line", (line) => {
            const waiter = this.waiters.shift();
            if (waiter) {
                waiter(line);
            }
            else {
                this.buffer.push(line);
            }
        });
        this.rl.on("close", () => {
            this.open = false;
        });
    }
    /** Write the prompt text and resolve with the next buffered (or future) line. */
    nextLine(promptText) {
        // Once stdin ends, readline closes the interface and prompt() would
        // throw; buffered lines must remain answerable after close.
        if (this.open) {
            try {
                this.rl.setPrompt(promptText);
                this.rl.prompt();
            }
            catch {
                this.open = false;
            }
        }
        const buffered = this.buffer.shift();
        if (buffered !== undefined)
            return Promise.resolve(buffered);
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }
    async text(message, defaultValue) {
        const hint = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
        const answer = (await this.nextLine(`${message}${hint}: `)).trim();
        if (answer === "" && defaultValue !== undefined)
            return defaultValue;
        return answer;
    }
    async secret(message) {
        // node:readline/promises has no mute-on-type helper without the legacy
        // readline module. For a CLI wizard, echoing the key on the local terminal
        // is acceptable; Pi's own `pi` login also reads from stdin. We do NOT log
        // the key anywhere else.
        const answer = (await this.nextLine(`${message}: `)).trim();
        return answer;
    }
    async confirm(message, defaultValue) {
        const hint = defaultValue === true ? " [Y/n]" : defaultValue === false ? " [y/N]" : " [y/n]";
        const answer = (await this.nextLine(`${message}${hint}: `)).trim().toLowerCase();
        if (answer === "" && defaultValue !== undefined)
            return defaultValue;
        return answer === "y" || answer === "yes";
    }
    async select(message, options, defaultIndex) {
        const lines = [message];
        options.forEach((option, index) => {
            const marker = defaultIndex === index ? " (default)" : "";
            lines.push(`${index + 1}. ${option}${marker}`);
        });
        while (true) {
            const answer = (await this.nextLine(lines.join("\n") + "\nEnter number: ")).trim();
            if (answer === "" && defaultIndex !== undefined)
                return defaultIndex;
            const num = Number(answer);
            if (Number.isInteger(num) && num >= 1 && num <= options.length) {
                return num - 1;
            }
            await this.nextLine(`Invalid choice '${answer}'. Press Enter to retry.\n`);
        }
    }
    async list(message, defaults) {
        const hint = defaults && defaults.length > 0 ? ` [${defaults.join(", ")}]` : "";
        const answer = (await this.nextLine(`${message}${hint}: `)).trim();
        if (answer === "" && defaults)
            return defaults;
        return answer
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
    }
    close() {
        this.rl.close();
    }
}
//# sourceMappingURL=prompt.js.map